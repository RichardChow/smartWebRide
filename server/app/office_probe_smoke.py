from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
from typing import TextIO
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from .environment_status import EnvironmentStatusService, MockEnvironmentProbe, NullEnvironmentProbe
from .environment_status import load_environment_configs
from .models import EnvironmentConfig, EnvironmentStatus
from .office_environment_probe import CommandResult, OfficeEnvironmentProbe, SubprocessCommandRunner, jenkins_probe_url, load_office_probe_config, ne_ip_regex, render_argv
from .slave_registry import SlaveRegistry


SERVER_HOST_KEY_RE = re.compile(r"Server host key:\s+(\S+)\s+(SHA256:\S+)")


def status_payload(statuses: list[EnvironmentStatus]) -> list[dict]:
    return [status.model_dump() for status in statuses]


def has_known_external_signal(statuses: list[EnvironmentStatus]) -> bool:
    for status in statuses:
        for signal in status.signals:
            if signal.source != "smartWebRide" and signal.status != "unknown":
                return True
    return False


def format_status_lines(statuses: list[EnvironmentStatus]) -> list[str]:
    lines: list[str] = []
    for status in statuses:
        lines.append(f"{status.environmentId}: {status.status} ({status.severity}) - {status.summary}")
        for signal in status.signals:
            lines.append(f"  - {signal.source}: {signal.status} ({signal.severity}) - {signal.summary}")
        if status.neSessions:
            lines.append(f"  - neSessions: {len(status.neSessions)}")
            for session in status.neSessions:
                raw_suffix = f" raw={session.raw}" if session.raw else ""
                lines.append(f"    {session.targetIp} {session.user} {session.sourceIp}{raw_suffix}".rstrip())
    return lines


def fingerprint_keyscan_line(line: str) -> str | None:
    parts = line.split()
    if len(parts) < 3 or line.startswith("#"):
        return None
    try:
        key_bytes = base64.b64decode(parts[2].encode("ascii"), validate=True)
    except (binascii.Error, ValueError):
        return None
    digest = base64.b64encode(hashlib.sha256(key_bytes).digest()).decode("ascii").rstrip("=")
    return f"{parts[0]} {parts[1]} SHA256:{digest}"


def collect_ssh_keyscan(host: str, timeout_seconds: int, runner: SubprocessCommandRunner | None = None) -> tuple[list[str], list[str]]:
    active_runner = runner or SubprocessCommandRunner()
    try:
        result = active_runner.run(["ssh-keyscan", "-T", str(timeout_seconds), host], timeout_seconds + 2)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return [], [f"ssh-keyscan failed: {exc}"]
    if result.returncode != 0 and not result.stdout.strip():
        return [], [result.stderr.strip() or f"ssh-keyscan returned {result.returncode}"]
    key_lines = [line.strip() for line in result.stdout.splitlines() if line.strip() and not line.startswith("#")]
    fingerprints = [fingerprint for line in key_lines if (fingerprint := fingerprint_keyscan_line(line))]
    return fingerprints, key_lines


def collect_ssh_handshake_hostkey(
    host: str,
    user: str,
    timeout_seconds: int,
    runner: SubprocessCommandRunner | None = None,
) -> tuple[list[str], list[str]]:
    active_runner = runner or SubprocessCommandRunner()
    target = f"{user}@{host}" if user else host
    argv = [
        "ssh",
        "-vvv",
        "-o",
        "BatchMode=yes",
        "-o",
        f"ConnectTimeout={timeout_seconds}",
        "-o",
        "StrictHostKeyChecking=ask",
        target,
        "true",
    ]
    try:
        result = active_runner.run(argv, timeout_seconds + 4)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return [], [f"ssh handshake probe failed: {exc}"]
    output_lines = [line.strip() for line in f"{result.stdout}\n{result.stderr}".splitlines() if line.strip()]
    fingerprints = []
    for line in output_lines:
        match = SERVER_HOST_KEY_RE.search(line)
        if match:
            fingerprints.append(f"{host} {match.group(1)} {match.group(2)}")
    diagnostics = [
        line
        for line in output_lines
        if "Server host key:" in line
        or "Host key verification failed" in line
        or "kex_exchange_identification" in line
        or "closed by remote host" in line
        or "timed out" in line
        or "Permission denied" in line
        or "Connection" in line
        or "known_hosts" in line
    ]
    return fingerprints, diagnostics or output_lines[-10:]


def tcp_connect_check(host: str, port: int, timeout_seconds: int) -> dict:
    try:
        with socket.create_connection((host, port), timeout=timeout_seconds):
            return {"status": "ok", "host": host, "port": port}
    except OSError as exc:
        return {"status": "error", "host": host, "port": port, "error": f"{type(exc).__name__}: {exc}"}


def endpoint_from_url(url: str) -> tuple[str, int]:
    parsed = urlparse(url)
    if not parsed.hostname:
        return "", 0
    if parsed.port:
        return parsed.hostname, parsed.port
    return parsed.hostname, 443 if parsed.scheme == "https" else 80


def jenkins_http_check(settings: dict, url: str, timeout_seconds: int, urlopen_func=urlopen) -> dict:
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "smartWebRide-smoke/1.0"})
    user_env = str(settings.get("userEnv") or "")
    token_env = str(settings.get("tokenEnv") or "")
    user = os.environ.get(user_env, "") if user_env else ""
    token = os.environ.get(token_env, "") if token_env else ""
    if user and token:
        encoded = base64.b64encode(f"{user}:{token}".encode("utf-8")).decode("ascii")
        request.add_header("Authorization", f"Basic {encoded}")
    try:
        with urlopen_func(request, timeout=timeout_seconds) as response:
            snippet = response.read(160).decode("utf-8", "replace").replace("\n", " ")
            return {
                "status": "ok",
                "httpStatus": getattr(response, "status", 200),
                "reason": getattr(response, "reason", "OK"),
                "bodySnippet": snippet,
            }
    except HTTPError as exc:
        snippet = exc.read(160).decode("utf-8", "replace").replace("\n", " ")
        return {"status": "http_error", "httpStatus": exc.code, "reason": exc.reason, "bodySnippet": snippet}
    except Exception as exc:
        return {"status": "error", "error": f"{type(exc).__name__}: {exc}"}


def office_probe_plan(configs: list[EnvironmentConfig], probe_config: dict) -> list[dict]:
    jenkins = probe_config.get("jenkins") if isinstance(probe_config.get("jenkins"), dict) else {}
    robot = probe_config.get("robot") if isinstance(probe_config.get("robot"), dict) else {}
    ne = probe_config.get("ne") if isinstance(probe_config.get("ne"), dict) else {}
    plan: list[dict] = []
    for config in configs:
        item = {
            "environmentId": config.environmentId,
            "testBedIp": config.testBedIp,
            "jenkinsUrl": jenkins_probe_url(jenkins, config) if jenkins.get("baseUrl") else "",
            "robotArgv": render_argv(robot["argv"], config) if isinstance(robot.get("argv"), list) else [],
            "neArgv": render_argv(ne["argv"], config, {"neIpRegex": ne_ip_regex(config)}) if isinstance(ne.get("argv"), list) else [],
        }
        plan.append(item)
    return plan


def office_config_check(configs: list[EnvironmentConfig], probe_config: dict, environ: dict[str, str] | None = None) -> list[dict]:
    active_environ = environ if environ is not None else os.environ
    checks: list[dict] = []
    timeout_raw = probe_config.get("timeoutSeconds", 5)
    try:
        timeout_seconds = int(timeout_raw)
    except (TypeError, ValueError):
        timeout_seconds = 0
    checks.append(
        {
            "name": "timeoutSeconds",
            "status": "ok" if timeout_seconds > 0 else "error",
            "value": timeout_raw,
            "summary": "timeoutSeconds is positive." if timeout_seconds > 0 else "timeoutSeconds must be a positive integer.",
        }
    )

    jenkins = probe_config.get("jenkins") if isinstance(probe_config.get("jenkins"), dict) else {}
    base_url = str(jenkins.get("baseUrl") or "")
    host, port = endpoint_from_url(base_url) if base_url else ("", 0)
    checks.append(
        {
            "name": "jenkins.baseUrl",
            "status": "ok" if host and port else "error",
            "value": base_url,
            "summary": f"Jenkins endpoint resolves to {host}:{port}." if host and port else "Jenkins baseUrl is missing or invalid.",
        }
    )
    for key in ("userEnv", "tokenEnv"):
        env_name = str(jenkins.get(key) or "")
        if not env_name:
            checks.append({"name": f"jenkins.{key}", "status": "warning", "summary": f"jenkins.{key} is not configured; Jenkins request will be anonymous."})
            continue
        placeholder = "<jenkins-user>" if key == "userEnv" else "<jenkins-api-token-or-password>"
        checks.append(
            {
                "name": f"env.{env_name}",
                "status": "ok" if active_environ.get(env_name) else "warning",
                "summary": f"{env_name} is set." if active_environ.get(env_name) else f"{env_name} is not set; Jenkins request will be anonymous.",
                "exportHint": "" if active_environ.get(env_name) else f"export {env_name}='{placeholder}'",
            }
        )

    for section in ("robot", "ne"):
        settings = probe_config.get(section) if isinstance(probe_config.get(section), dict) else {}
        argv = settings.get("argv")
        checks.append(
            {
                "name": f"{section}.argv",
                "status": "ok" if isinstance(argv, list) and bool(argv) else "error",
                "summary": f"{section}.argv has {len(argv)} item(s)." if isinstance(argv, list) and bool(argv) else f"{section}.argv must be a non-empty list.",
            }
        )

    plan = office_probe_plan(configs, probe_config)
    for item in plan:
        checks.append(
            {
                "name": f"environment.{item['environmentId']}",
                "status": "ok",
                "testBedIp": item["testBedIp"],
                "summary": "Rendered Jenkins URL, Robot argv, and NE argv for this environment.",
                "jenkinsUrl": item["jenkinsUrl"],
                "robotArgv": item["robotArgv"],
                "neArgv": item["neArgv"],
            }
        )
    return checks


def config_check_has_errors(report: list[dict]) -> bool:
    return any(item.get("status") == "error" for item in report)


def format_config_check_lines(report: list[dict]) -> list[str]:
    lines: list[str] = []
    for item in report:
        detail = item.get("summary", "")
        value = item.get("value")
        value_suffix = f" value={value}" if value else ""
        lines.append(f"[{item['status']}] {item['name']}{value_suffix} - {detail}".rstrip())
        if item.get("exportHint"):
            lines.append(f"  Hint: {item['exportHint']}")
        if item.get("jenkinsUrl"):
            lines.append(f"  Jenkins URL: {item['jenkinsUrl']}")
        if item.get("robotArgv"):
            lines.append(f"  Robot argv: {json.dumps(item['robotArgv'], ensure_ascii=False)}")
        if item.get("neArgv"):
            lines.append(f"  NE argv: {json.dumps(item['neArgv'], ensure_ascii=False)}")
    return lines


def select_environment_configs(configs: list[EnvironmentConfig], environment_ids: list[str] | None) -> tuple[list[EnvironmentConfig], list[str]]:
    if not environment_ids:
        return configs, []
    wanted = set(environment_ids)
    selected = [config for config in configs if config.environmentId in wanted]
    found = {config.environmentId for config in selected}
    missing = [environment_id for environment_id in environment_ids if environment_id not in found]
    return selected, missing


def office_preflight(
    configs: list[EnvironmentConfig],
    probe_config: dict,
    runner: SubprocessCommandRunner | None = None,
    tcp_checker=tcp_connect_check,
    urlopen_func=urlopen,
) -> list[dict]:
    timeout_seconds = int(probe_config.get("timeoutSeconds") or 5)
    jenkins = probe_config.get("jenkins") if isinstance(probe_config.get("jenkins"), dict) else {}
    plan_by_id = {item["environmentId"]: item for item in office_probe_plan(configs, probe_config)}
    report: list[dict] = []
    for config in configs:
        plan = plan_by_id[config.environmentId]
        checks = []
        if plan["jenkinsUrl"]:
            host, port = endpoint_from_url(plan["jenkinsUrl"])
            checks.append({"name": "jenkinsTcp", **tcp_checker(host, port, timeout_seconds)})
            checks.append({"name": "jenkinsHttp", "url": plan["jenkinsUrl"], **jenkins_http_check(jenkins, plan["jenkinsUrl"], timeout_seconds, urlopen_func)})
        else:
            checks.append({"name": "jenkins", "status": "skipped", "reason": "not configured"})

        checks.append({"name": "testBedSshTcp", **tcp_checker(config.testBedIp, 22, timeout_seconds)})
        fingerprints, diagnostics = collect_ssh_handshake_hostkey(config.testBedIp, "root", timeout_seconds, runner)
        checks.append(
            {
                "name": "testBedSshHandshake",
                "status": "ok" if fingerprints else "error",
                "fingerprints": fingerprints,
                "diagnostics": diagnostics,
            }
        )
        report.append({**plan, "checks": checks})
    return report


def preflight_has_errors(report: list[dict]) -> bool:
    return any(check.get("status") not in {"ok", "skipped"} for item in report for check in item.get("checks", []))


def format_preflight_lines(report: list[dict]) -> list[str]:
    lines: list[str] = []
    for item in report:
        lines.append(f"{item['environmentId']} ({item['testBedIp']})")
        lines.append(f"  Jenkins URL: {item['jenkinsUrl'] or '<not configured>'}")
        lines.append(f"  Robot argv: {json.dumps(item['robotArgv'], ensure_ascii=False)}")
        lines.append(f"  NE argv: {json.dumps(item['neArgv'], ensure_ascii=False)}")
        for check in item["checks"]:
            detail = check.get("error") or check.get("reason") or "; ".join(check.get("diagnostics", [])[:3])
            suffix = f" - {detail}" if detail else ""
            lines.append(f"  [{check['status']}] {check['name']}{suffix}")
    return lines


def format_office_probe_plan(plan: list[dict]) -> list[str]:
    lines: list[str] = []
    for item in plan:
        lines.append(f"{item['environmentId']} ({item['testBedIp']})")
        lines.append(f"  Jenkins URL: {item['jenkinsUrl'] or '<not configured>'}")
        lines.append(f"  Robot argv: {json.dumps(item['robotArgv'], ensure_ascii=False)}")
        lines.append(f"  NE argv: {json.dumps(item['neArgv'], ensure_ascii=False)}")
    return lines


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a read-only smartWebRide office environment probe smoke check.")
    parser.add_argument("--environments-config", default=None, help="Path to environments.json. Defaults to SWR_ENVIRONMENTS_CONFIG or built-in AT Regression mapping.")
    parser.add_argument("--environment-id", action="append", default=[], help="Limit the command to one environmentId. Can be provided multiple times.")
    parser.add_argument("--office-probe-config", default=None, help="Path to office-probe.json. Defaults to SWR_OFFICE_PROBE_CONFIG.")
    parser.add_argument("--probe", choices=["office", "mock", "null"], default="office", help="Probe provider to use.")
    parser.add_argument("--check-config", action="store_true", help="Validate office probe config and required env vars without network or SSH access.")
    parser.add_argument("--dry-run", action="store_true", help="Print rendered Jenkins URL and argv commands without executing probes.")
    parser.add_argument("--preflight", action="store_true", help="Run read-only Jenkins and SSH connectivity diagnostics without Robot/NE probe commands.")
    parser.add_argument("--ssh-keyscan-host", default="", help="Print SSH host key fingerprints for manual known_hosts verification, then exit.")
    parser.add_argument("--ssh-keyscan-timeout", type=int, default=5, help="Timeout in seconds for --ssh-keyscan-host.")
    parser.add_argument("--ssh-handshake-host", default="", help="Run a read-only SSH handshake and print the server host key fingerprint, then exit.")
    parser.add_argument("--ssh-handshake-user", default="root", help="SSH user for --ssh-handshake-host.")
    parser.add_argument("--ssh-handshake-timeout", type=int, default=8, help="Timeout in seconds for --ssh-handshake-host.")
    parser.add_argument("--json", action="store_true", help="Print full EnvironmentStatus JSON.")
    parser.add_argument(
        "--require-known",
        action="store_true",
        help="Exit non-zero unless at least one Jenkins/Robot/NE signal is known.",
    )
    return parser


def probe_from_name(name: str, office_probe_config: str | None):
    if name == "mock":
        return MockEnvironmentProbe()
    if name == "null":
        return NullEnvironmentProbe()
    return OfficeEnvironmentProbe(probe_config=load_office_probe_config(office_probe_config))


def main(
    argv: list[str] | None = None,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
    runner: SubprocessCommandRunner | None = None,
) -> int:
    args = build_parser().parse_args(argv)
    selected_configs, missing_environment_ids = select_environment_configs(load_environment_configs(args.environments_config), args.environment_id)
    if missing_environment_ids:
        stderr.write(f"Unknown environmentId(s): {', '.join(missing_environment_ids)}\n")
        return 2
    if args.ssh_keyscan_host:
        fingerprints, key_lines_or_errors = collect_ssh_keyscan(args.ssh_keyscan_host, args.ssh_keyscan_timeout, runner)
        if not fingerprints:
            stderr.write("\n".join(key_lines_or_errors))
            stderr.write("\n")
            return 2
        stdout.write("SSH host key fingerprints:\n")
        stdout.write("\n".join(fingerprints))
        stdout.write("\n\nRaw ssh-keyscan lines:\n")
        stdout.write("\n".join(key_lines_or_errors))
        stdout.write("\n")
        return 0
    if args.ssh_handshake_host:
        fingerprints, diagnostics = collect_ssh_handshake_hostkey(
            args.ssh_handshake_host,
            args.ssh_handshake_user,
            args.ssh_handshake_timeout,
            runner,
        )
        if not fingerprints:
            stderr.write("\n".join(diagnostics))
            stderr.write("\n")
            return 2
        stdout.write("SSH handshake host key fingerprints:\n")
        stdout.write("\n".join(fingerprints))
        stdout.write("\n\nDiagnostics:\n")
        stdout.write("\n".join(diagnostics))
        stdout.write("\n")
        return 0
    if args.check_config:
        probe_config = load_office_probe_config(args.office_probe_config)
        report = office_config_check(selected_configs, probe_config)
        if args.json:
            stdout.write(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            stdout.write("\n".join(format_config_check_lines(report)))
        stdout.write("\n")
        return 2 if config_check_has_errors(report) else 0
    if args.dry_run:
        probe_config = load_office_probe_config(args.office_probe_config)
        plan = office_probe_plan(selected_configs, probe_config)
        if args.json:
            stdout.write(json.dumps(plan, ensure_ascii=False, indent=2))
        else:
            stdout.write("\n".join(format_office_probe_plan(plan)))
        stdout.write("\n")
        return 0
    if args.preflight:
        probe_config = load_office_probe_config(args.office_probe_config)
        report = office_preflight(selected_configs, probe_config, runner)
        if args.json:
            stdout.write(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            stdout.write("\n".join(format_preflight_lines(report)))
        stdout.write("\n")
        return 2 if preflight_has_errors(report) else 0
    service = EnvironmentStatusService(
        config_path=args.environments_config,
        configs=selected_configs,
        probe=probe_from_name(args.probe, args.office_probe_config),
        ttl_seconds=0,
    )
    statuses = service.list_statuses(SlaveRegistry())
    if args.json:
        stdout.write(json.dumps(status_payload(statuses), ensure_ascii=False, indent=2))
        stdout.write("\n")
    else:
        stdout.write("\n".join(format_status_lines(statuses)))
        stdout.write("\n")
    if args.require_known and not has_known_external_signal(statuses):
        stderr.write("No known Jenkins/Robot/NE signal was collected. Check office probe config and trex201 reachability.\n")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

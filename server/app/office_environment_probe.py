from __future__ import annotations

import base64
import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .environment_status import EnvironmentProbeSnapshot
from .models import EnvironmentConfig, EnvironmentSession, EnvironmentSignal


DEFAULT_TIMEOUT_SECONDS = 5
DEFAULT_CONFIG_PATH = "server/config/office-probe.json"
JENKINS_TREE = "tree=building,result,number,displayName,url"
JENKINS_HEADERS = {"Accept": "application/json", "User-Agent": "smartWebRide-smoke/1.0"}


@dataclass
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


class SubprocessCommandRunner:
    def run(self, argv: list[str], timeout_seconds: int) -> CommandResult:
        completed = subprocess.run(
            argv,
            capture_output=True,
            check=False,
            text=True,
            timeout=timeout_seconds,
        )
        return CommandResult(completed.returncode, completed.stdout, completed.stderr)


def load_office_probe_config(config_path: str | None = None) -> dict[str, Any]:
    path = Path(config_path or os.environ.get("SWR_OFFICE_PROBE_CONFIG", DEFAULT_CONFIG_PATH))
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def render_template(value: str, config: EnvironmentConfig, extra: dict[str, str] | None = None) -> str:
    replacements = {
        "environmentId": config.environmentId,
        "jobName": config.jobName,
        "displayName": config.displayName,
        "testBedIp": config.testBedIp,
        "envFile": config.envFile,
        "slaveId": config.slaveId,
        **(extra or {}),
    }
    rendered = value
    for key, replacement in replacements.items():
        rendered = rendered.replace(f"{{{key}}}", replacement)
    return rendered


def render_argv(template: list[Any], config: EnvironmentConfig, extra: dict[str, str] | None = None) -> list[str]:
    return [render_template(str(item), config, extra) for item in template]


def jenkins_probe_url(settings: dict[str, Any], config: EnvironmentConfig) -> str:
    base_url = str(settings["baseUrl"]).rstrip("/")
    template = str(settings.get("jobUrlTemplate") or f"{{baseUrl}}/job/{{jobName}}/lastBuild/api/json?{JENKINS_TREE}")
    return render_template(template.replace("{baseUrl}", base_url), config)


def first_lines(value: str, limit: int = 5) -> list[str]:
    return [line.strip() for line in value.splitlines() if line.strip()][:limit]


def ne_ip_regex(config: EnvironmentConfig) -> str:
    return "|".join(re.escape(device.ip) for device in config.neDevices)


def command_failure_summary(label: str, result: CommandResult) -> str:
    if result.returncode < 0:
        reason = result.stderr.strip() or f"return code {result.returncode}"
        return f"{label} office probe failed: {reason}"
    return f"{label} office probe returned {result.returncode}."


class OfficeEnvironmentProbe:
    def __init__(
        self,
        probe_config: dict[str, Any] | None = None,
        runner: SubprocessCommandRunner | None = None,
        urlopen_func: Callable[..., Any] | None = None,
    ) -> None:
        self.config = probe_config if probe_config is not None else load_office_probe_config()
        self.runner = runner or SubprocessCommandRunner()
        self.urlopen = urlopen_func or urlopen
        self.timeout_seconds = int(self.config.get("timeoutSeconds") or DEFAULT_TIMEOUT_SECONDS)

    def collect(self, config: EnvironmentConfig) -> EnvironmentProbeSnapshot:
        signals = [
            self._collect_jenkins_signal(config),
            self._collect_robot_signal(config),
            self._collect_ne_signal(config),
        ]
        complete = all(signal.status != "unknown" for signal in signals)
        return EnvironmentProbeSnapshot(
            complete=complete,
            configured=self._is_configured(),
            signals=signals,
            ne_sessions=self._sessions_from_ne_signal(config, signals[-1]),
        )

    def _is_configured(self) -> bool:
        jenkins = self.config.get("jenkins")
        robot = self.config.get("robot")
        ne = self.config.get("ne")
        return (
            (isinstance(jenkins, dict) and bool(jenkins.get("baseUrl")))
            or (isinstance(robot, dict) and isinstance(robot.get("argv"), list))
            or (isinstance(ne, dict) and isinstance(ne.get("argv"), list))
        )

    def _collect_jenkins_signal(self, config: EnvironmentConfig) -> EnvironmentSignal:
        settings = self.config.get("jenkins")
        if not isinstance(settings, dict) or not settings.get("baseUrl"):
            return EnvironmentSignal(source="jenkins", status="unknown", severity="unknown", summary="Jenkins office probe is not configured.")

        url = jenkins_probe_url(settings, config)
        request = Request(url, headers=JENKINS_HEADERS)
        user_env = str(settings.get("userEnv") or "")
        token_env = str(settings.get("tokenEnv") or "")
        user = os.environ.get(user_env, "") if user_env else ""
        token = os.environ.get(token_env, "") if token_env else ""
        if user and token:
            encoded = base64.b64encode(f"{user}:{token}".encode("utf-8")).decode("ascii")
            request.add_header("Authorization", f"Basic {encoded}")
        try:
            with self.urlopen(request, timeout=self.timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
            return EnvironmentSignal(
                source="jenkins",
                status="unknown",
                severity="unknown",
                summary=f"Jenkins office probe failed: {type(exc).__name__}: {exc}",
                detail={"url": url},
            )
        if bool(payload.get("building")):
            build = payload.get("number", "")
            name = payload.get("displayName", "")
            summary = f"Jenkins job {config.jobName} build {build or name or 'latest'} is running."
            return EnvironmentSignal(source="jenkins", status="busy", severity="busy", summary=summary, detail=payload)
        return EnvironmentSignal(
            source="jenkins",
            status="free",
            severity="free",
            summary=f"Jenkins job {config.jobName} is not running.",
            detail={key: payload.get(key) for key in ("number", "displayName", "result", "url")},
        )

    def _collect_robot_signal(self, config: EnvironmentConfig) -> EnvironmentSignal:
        settings = self.config.get("robot")
        if not isinstance(settings, dict) or not isinstance(settings.get("argv"), list):
            return EnvironmentSignal(source="robot", status="unknown", severity="unknown", summary="Robot office probe is not configured.")
        argv = render_argv(settings["argv"], config)
        result = self._run(argv)
        if result is None:
            return EnvironmentSignal(source="robot", status="unknown", severity="unknown", summary="Robot office probe failed.", detail={"argv": argv})
        lines = first_lines(result.stdout)
        if result.returncode == 0 and lines:
            return EnvironmentSignal(
                source="robot",
                status="busy",
                severity="busy",
                summary=f"Robot process detected on {config.testBedIp}.",
                detail={"argv": argv, "lines": lines},
            )
        if result.returncode in {0, 1}:
            return EnvironmentSignal(source="robot", status="free", severity="free", summary=f"No Robot process detected on {config.testBedIp}.")
        return EnvironmentSignal(
            source="robot",
            status="unknown",
            severity="unknown",
            summary=command_failure_summary("Robot", result),
            detail={"argv": argv, "stderr": result.stderr.strip(), "stdout": first_lines(result.stdout)},
        )

    def _collect_ne_signal(self, config: EnvironmentConfig) -> EnvironmentSignal:
        settings = self.config.get("ne")
        if not isinstance(settings, dict) or not isinstance(settings.get("argv"), list):
            return EnvironmentSignal(source="ne", status="unknown", severity="unknown", summary="NE session office probe is not configured.")
        regex = ne_ip_regex(config)
        if not regex:
            return EnvironmentSignal(source="ne", status="free", severity="free", summary="No NE devices are configured.")
        argv = render_argv(settings["argv"], config, {"neIpRegex": regex})
        result = self._run(argv)
        if result is None:
            return EnvironmentSignal(source="ne", status="unknown", severity="unknown", summary="NE session office probe failed.", detail={"argv": argv})
        lines = first_lines(result.stdout, 20)
        matched = [line for line in lines if any(device.ip in line for device in config.neDevices)]
        if result.returncode == 0 and matched:
            return EnvironmentSignal(
                source="ne",
                status="busy",
                severity="warning",
                summary=f"{len(matched)} NE session line(s) detected.",
                detail={"argv": argv, "lines": matched},
            )
        if result.returncode in {0, 1}:
            return EnvironmentSignal(source="ne", status="free", severity="free", summary="No NE login/session signal detected.")
        return EnvironmentSignal(
            source="ne",
            status="unknown",
            severity="unknown",
            summary=command_failure_summary("NE session", result),
            detail={"argv": argv, "stderr": result.stderr.strip(), "stdout": first_lines(result.stdout)},
        )

    def _run(self, argv: list[str]) -> CommandResult | None:
        if not argv:
            return None
        try:
            return self.runner.run(argv, self.timeout_seconds)
        except subprocess.TimeoutExpired as exc:
            return CommandResult(-1, "", f"Command timed out after {exc.timeout} seconds.")
        except OSError as exc:
            return CommandResult(-1, "", f"{type(exc).__name__}: {exc}")

    def _sessions_from_ne_signal(self, config: EnvironmentConfig, signal: EnvironmentSignal) -> list[EnvironmentSession]:
        lines = signal.detail.get("lines", []) if isinstance(signal.detail, dict) else []
        if not isinstance(lines, list):
            return []
        sessions: list[EnvironmentSession] = []
        for line in lines:
            raw = str(line)
            target = next((device.ip for device in config.neDevices if device.ip in raw), "")
            if target:
                sessions.append(EnvironmentSession(targetIp=target, protocol="ssh", raw=raw))
        return sessions

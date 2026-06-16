import subprocess
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from server.app import main as app_main
from server.app.auth import AuthenticatedUser
from server.app.environment_status import EnvironmentProbeSnapshot, EnvironmentStatusService, MockEnvironmentProbe, load_environment_configs
from server.app.models import EnvironmentSignal
from server.app.office_environment_probe import CommandResult, OfficeEnvironmentProbe
from server.app.office_probe_smoke import collect_ssh_handshake_hostkey, collect_ssh_keyscan, fingerprint_keyscan_line, main as office_probe_smoke_main, office_preflight, preflight_has_errors
from server.app.slave_registry import SlaveRegistry


class FakeJenkinsResponse:
    def __init__(self, payload: str, status: int = 200, reason: str = "OK"):
        self.payload = payload
        self.status = status
        self.reason = reason

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self, size=-1):
        data = self.payload.encode("utf-8")
        return data if size is None or size < 0 else data[:size]


class FakeOfficeRunner:
    def __init__(self, results):
        self.results = results
        self.calls = []

    def run(self, argv, timeout_seconds):
        self.calls.append((argv, timeout_seconds))
        return self.results[argv[0]]


class FailingJenkinsUrlopen:
    def __init__(self, exc):
        self.exc = exc
        self.requests = []

    def __call__(self, request, timeout):
        self.requests.append(request)
        raise self.exc


class FakeKeyscanRunner:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def run(self, argv, timeout_seconds):
        self.calls.append((argv, timeout_seconds))
        return self.result


class TimeoutOfficeRunner:
    def run(self, argv, timeout_seconds):
        raise subprocess.TimeoutExpired(argv, timeout_seconds)


class CountingProbe:
    def __init__(self):
        self.calls = []

    def collect(self, config):
        self.calls.append(config.environmentId)
        return EnvironmentProbeSnapshot(
            complete=True,
            signals=[
                EnvironmentSignal(source="jenkins", status="free", severity="free", summary="Jenkins idle."),
                EnvironmentSignal(source="robot", status="free", severity="free", summary="Robot absent."),
                EnvironmentSignal(source="ne", status="free", severity="free", summary="NE absent."),
            ],
        )


class UnknownConfiguredProbe:
    def collect(self, config):
        return EnvironmentProbeSnapshot(
            complete=False,
            configured=True,
            signals=[
                EnvironmentSignal(source="jenkins", status="unknown", severity="unknown", summary="Jenkins failed."),
                EnvironmentSignal(source="robot", status="unknown", severity="unknown", summary="Robot failed."),
                EnvironmentSignal(source="ne", status="unknown", severity="unknown", summary="NE failed."),
            ],
        )


class EnvironmentStatusTest(unittest.TestCase):
    def test_loads_default_at_regression_environments(self):
        configs = load_environment_configs("__missing__.json")

        self.assertEqual([config.environmentId for config in configs], ["233_setup", "234_setup", "249_setup"])
        self.assertEqual(configs[0].neDevices[0].ip, "200.200.18.101")
        self.assertEqual(configs[1].neDevices[2].ip, "200.200.105.151")
        self.assertEqual(configs[2].neDevices[3].type, "NPT1100")

    def test_loads_environment_config_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "environments.json"
            config.write_text(
                """
                {
                  "environments": [
                    {
                      "environmentId": "lab_setup",
                      "jobName": "lab_setup",
                      "displayName": "Lab",
                      "testBedIp": "172.18.98.10",
                      "envFile": "lab.xlsx",
                      "neDevices": [
                        { "ip": "200.200.1.1", "type": "NPT" }
                      ]
                    }
                  ]
                }
                """,
                encoding="utf-8",
            )

            configs = load_environment_configs(str(config))

        self.assertEqual(configs[0].environmentId, "lab_setup")
        self.assertEqual(configs[0].neDevices[0].ip, "200.200.1.1")

    def test_null_probe_returns_unknown_instead_of_claiming_free(self):
        service = EnvironmentStatusService(config_path="__missing__.json")

        status = service.list_statuses(SlaveRegistry())[0]

        self.assertEqual(status.status, "unknown")
        self.assertEqual(status.severity, "unknown")
        self.assertIn("probe is not configured", status.summary)

    def test_configured_probe_with_unknown_signals_reports_probe_ran(self):
        service = EnvironmentStatusService(config_path="__missing__.json", probe=UnknownConfiguredProbe())

        status = service.list_statuses(SlaveRegistry())[0]

        self.assertEqual(status.status, "unknown")
        self.assertEqual(status.severity, "unknown")
        self.assertIn("probe ran", status.summary)

    def test_mock_probe_marks_233_as_jenkins_running(self):
        service = EnvironmentStatusService(config_path="__missing__.json", probe=MockEnvironmentProbe())

        statuses = {status.environmentId: status for status in service.list_statuses(SlaveRegistry())}

        self.assertEqual(statuses["233_setup"].status, "jenkins_running")
        self.assertEqual(statuses["233_setup"].neSessions[0].targetIp, "200.200.18.101")
        self.assertEqual(statuses["234_setup"].status, "free")

    def test_smartwebride_lock_is_a_signal_when_slave_is_linked(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "environments.json"
            config.write_text(
                """
                {
                  "environments": [
                    {
                      "environmentId": "lab_setup",
                      "jobName": "lab_setup",
                      "displayName": "Lab",
                      "testBedIp": "172.18.98.10",
                      "envFile": "lab.xlsx",
                      "slaveId": "vm1",
                      "neDevices": []
                    }
                  ]
                }
                """,
                encoding="utf-8",
            )
            registry = SlaveRegistry()
            registry.mark_agent_online("vm1", "test-agent")
            registry.lock("vm1", "Humphrey", "humphrey@example.com")
            service = EnvironmentStatusService(config_path=str(config), probe=MockEnvironmentProbe())

            status = service.list_statuses(registry)[0]

        self.assertEqual(status.status, "smartwebride_held")
        self.assertIn("Humphrey", status.summary)

    def test_office_probe_marks_jenkins_build_running(self):
        runner = FakeOfficeRunner({
            "robot-probe": CommandResult(1, ""),
            "ne-probe": CommandResult(1, ""),
        })
        probe = OfficeEnvironmentProbe(
            probe_config={
                "jenkins": {"baseUrl": "http://jenkins.example"},
                "robot": {"argv": ["robot-probe", "{testBedIp}"]},
                "ne": {"argv": ["ne-probe", "{neIpRegex}"]},
            },
            runner=runner,
            urlopen_func=lambda request, timeout: FakeJenkinsResponse('{"building": true, "number": 395, "displayName": "#395"}'),
        )
        service = EnvironmentStatusService(config_path="__missing__.json", probe=probe)

        status = service.list_statuses(SlaveRegistry())[0]

        self.assertEqual(status.status, "jenkins_running")
        self.assertEqual(status.severity, "busy")
        self.assertIn("395", status.summary)
        self.assertEqual(runner.calls[0][0], ["robot-probe", "172.18.98.233"])
        self.assertIn("200\\.200\\.18\\.101", runner.calls[1][0][1])

    def test_office_probe_jenkins_failure_includes_exception_type_and_user_agent(self):
        runner = FakeOfficeRunner({
            "robot-probe": CommandResult(1, ""),
            "ne-probe": CommandResult(1, ""),
        })
        failing_urlopen = FailingJenkinsUrlopen(ConnectionResetError("reset by peer"))
        probe = OfficeEnvironmentProbe(
            probe_config={
                "jenkins": {"baseUrl": "http://jenkins.example"},
                "robot": {"argv": ["robot-probe", "{testBedIp}"]},
                "ne": {"argv": ["ne-probe", "{neIpRegex}"]},
            },
            runner=runner,
            urlopen_func=failing_urlopen,
        )
        service = EnvironmentStatusService(config_path="__missing__.json", probe=probe)

        status = service.list_statuses(SlaveRegistry())[0]

        jenkins_signal = next(signal for signal in status.signals if signal.source == "jenkins")
        self.assertEqual(jenkins_signal.status, "unknown")
        self.assertIn("ConnectionResetError: reset by peer", jenkins_signal.summary)
        self.assertEqual(failing_urlopen.requests[0].headers["User-agent"], "smartWebRide-smoke/1.0")

    def test_office_probe_reports_robot_and_ne_sessions(self):
        runner = FakeOfficeRunner({
            "robot-probe": CommandResult(0, "2659786 00:10 robot -A arg.txt\n"),
            "ne-probe": CommandResult(0, "ESTAB 0 0 172.18.98.233:45678 200.200.18.101:22\n"),
        })
        probe = OfficeEnvironmentProbe(
            probe_config={
                "jenkins": {"baseUrl": "http://jenkins.example"},
                "robot": {"argv": ["robot-probe", "{testBedIp}"]},
                "ne": {"argv": ["ne-probe", "{neIpRegex}"]},
            },
            runner=runner,
            urlopen_func=lambda request, timeout: FakeJenkinsResponse('{"building": false, "number": 395, "result": "SUCCESS"}'),
        )
        service = EnvironmentStatusService(config_path="__missing__.json", probe=probe)

        status = service.list_statuses(SlaveRegistry())[0]

        self.assertEqual(status.status, "manual_robot_active")
        self.assertEqual(status.neSessions[0].targetIp, "200.200.18.101")
        self.assertEqual(status.signals[2].source, "robot")
        self.assertEqual(status.signals[2].status, "busy")

    def test_empty_office_probe_config_reports_not_configured(self):
        probe = OfficeEnvironmentProbe(probe_config={})
        service = EnvironmentStatusService(config_path="__missing__.json", probe=probe)

        status = service.list_statuses(SlaveRegistry())[0]

        self.assertEqual(status.status, "unknown")
        self.assertIn("probe is not configured", status.summary)

    def test_office_probe_reports_command_timeout_details(self):
        probe = OfficeEnvironmentProbe(
            probe_config={
                "jenkins": {},
                "robot": {"argv": ["robot-probe", "{testBedIp}"]},
                "ne": {"argv": ["ne-probe", "{neIpRegex}"]},
            },
            runner=TimeoutOfficeRunner(),
        )
        service = EnvironmentStatusService(config_path="__missing__.json", probe=probe)

        status = service.list_statuses(SlaveRegistry())[0]

        robot_signal = next(signal for signal in status.signals if signal.source == "robot")
        self.assertEqual(robot_signal.status, "unknown")
        self.assertEqual(robot_signal.summary, "Robot office probe failed: Command timed out after 5 seconds.")
        self.assertEqual(robot_signal.detail["stderr"], "Command timed out after 5 seconds.")
        self.assertEqual(robot_signal.detail["stdout"], [])

    def test_environment_status_service_caches_probe_results_inside_ttl(self):
        now = 100.0
        probe = CountingProbe()
        service = EnvironmentStatusService(config_path="__missing__.json", probe=probe, ttl_seconds=10, clock=lambda: now)

        first = service.list_statuses(SlaveRegistry())
        second = service.list_statuses(SlaveRegistry())

        self.assertIs(first, second)
        self.assertEqual(len(probe.calls), 3)

    def test_environment_status_service_refreshes_after_ttl_or_invalidate(self):
        current_time = [100.0]
        probe = CountingProbe()
        service = EnvironmentStatusService(config_path="__missing__.json", probe=probe, ttl_seconds=10, clock=lambda: current_time[0])

        service.list_statuses(SlaveRegistry())
        current_time[0] = 111.0
        service.list_statuses(SlaveRegistry())
        service.invalidate_cache()
        service.list_statuses(SlaveRegistry())

        self.assertEqual(len(probe.calls), 9)

    def test_environment_status_service_can_probe_only_selected_configs(self):
        configs = load_environment_configs("__missing__.json")
        probe = CountingProbe()
        service = EnvironmentStatusService(configs=[configs[0]], probe=probe, ttl_seconds=0)

        statuses = service.list_statuses(SlaveRegistry())

        self.assertEqual([status.environmentId for status in statuses], ["233_setup"])
        self.assertEqual(probe.calls, ["233_setup"])


class EnvironmentRouteTest(unittest.IsolatedAsyncioTestCase):
    async def test_environment_route_returns_configured_statuses(self):
        old_service = app_main.environment_status_service
        try:
            app_main.environment_status_service = EnvironmentStatusService(config_path="__missing__.json", probe=MockEnvironmentProbe())
            user = AuthenticatedUser(email="humphrey@example.com", display_name="Humphrey")

            statuses = await app_main.list_environment_statuses(user)

            self.assertEqual(len(statuses), 3)
            self.assertEqual(statuses[0].environmentId, "233_setup")
        finally:
            app_main.environment_status_service = old_service


class OfficeProbeSmokeTest(unittest.TestCase):
    def test_smoke_dry_run_prints_rendered_office_probe_plan(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "office-probe.json"
            config.write_text(
                """
                {
                  "jenkins": {
                    "baseUrl": "http://jenkins.example",
                    "jobUrlTemplate": "{baseUrl}/job/{jobName}/lastBuild/api/json"
                  },
                  "robot": {
                    "argv": ["ssh", "root@{testBedIp}", "ps robot"]
                  },
                  "ne": {
                    "argv": ["ssh", "root@{testBedIp}", "ss | grep -E '{neIpRegex}'"]
                  }
                }
                """,
                encoding="utf-8",
            )
            stdout = StringIO()
            stderr = StringIO()

            exit_code = office_probe_smoke_main(["--dry-run", "--office-probe-config", str(config)], stdout=stdout, stderr=stderr)

        output = stdout.getvalue()
        self.assertEqual(exit_code, 0)
        self.assertIn("233_setup (172.18.98.233)", output)
        self.assertIn("http://jenkins.example/job/233_setup/lastBuild/api/json", output)
        self.assertIn('"root@172.18.98.233"', output)
        self.assertIn("200\\\\.200\\\\.18\\\\.101", output)
        self.assertEqual(stderr.getvalue(), "")

    def test_environment_id_filter_limits_smoke_command_scope(self):
        stdout = StringIO()
        stderr = StringIO()

        exit_code = office_probe_smoke_main(
            ["--dry-run", "--office-probe-config", "server/config/office-probe.example.json", "--environment-id", "233_setup"],
            stdout=stdout,
            stderr=stderr,
        )

        output = stdout.getvalue()
        self.assertEqual(exit_code, 0)
        self.assertIn("233_setup", output)
        self.assertNotIn("234_setup", output)
        self.assertEqual(stderr.getvalue(), "")

    def test_unknown_environment_id_fails_fast(self):
        stdout = StringIO()
        stderr = StringIO()

        exit_code = office_probe_smoke_main(["--dry-run", "--environment-id", "missing_setup"], stdout=stdout, stderr=stderr)

        self.assertEqual(exit_code, 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("Unknown environmentId(s): missing_setup", stderr.getvalue())

    def test_check_config_warns_when_optional_jenkins_env_vars_are_missing(self):
        stdout = StringIO()
        stderr = StringIO()

        with patch.dict("os.environ", {}, clear=True):
            exit_code = office_probe_smoke_main(
                ["--check-config", "--office-probe-config", "server/config/office-probe.example.json", "--environment-id", "233_setup"],
                stdout=stdout,
                stderr=stderr,
            )

        output = stdout.getvalue()
        self.assertEqual(exit_code, 0)
        self.assertIn("[warning] env.SWR_JENKINS_USER", output)
        self.assertIn("[warning] env.SWR_JENKINS_TOKEN", output)
        self.assertIn("Jenkins request will be anonymous", output)
        self.assertIn("export SWR_JENKINS_USER='<jenkins-user>'", output)
        self.assertIn("export SWR_JENKINS_TOKEN='<jenkins-api-token-or-password>'", output)
        self.assertIn("environment.233_setup", output)
        self.assertNotIn("environment.234_setup", output)
        self.assertEqual(stderr.getvalue(), "")

    def test_check_config_passes_when_required_jenkins_env_vars_are_set(self):
        stdout = StringIO()
        stderr = StringIO()

        with patch.dict("os.environ", {"SWR_JENKINS_USER": "chen.lin", "SWR_JENKINS_TOKEN": "token"}, clear=True):
            exit_code = office_probe_smoke_main(
                ["--check-config", "--office-probe-config", "server/config/office-probe.example.json", "--environment-id", "233_setup"],
                stdout=stdout,
                stderr=stderr,
            )

        output = stdout.getvalue()
        self.assertEqual(exit_code, 0)
        self.assertIn("[ok] env.SWR_JENKINS_USER", output)
        self.assertIn("[ok] env.SWR_JENKINS_TOKEN", output)
        self.assertNotIn("token", output)
        self.assertIn("http://10.91.90.109:8080/jenkins/job/233_setup/lastBuild/api/json", output)
        self.assertNotIn("environment.234_setup", output)
        self.assertEqual(stderr.getvalue(), "")

    def test_preflight_reports_jenkins_tcp_http_and_ssh_handshake(self):
        configs = load_environment_configs("__missing__.json")[:1]
        runner = FakeKeyscanRunner(
            CommandResult(
                255,
                "",
                "debug1: Server host key: ecdsa-sha2-nistp256 SHA256:abc123\nHost key verification failed.",
            )
        )

        def tcp_checker(host, port, timeout_seconds):
            return {"status": "ok", "host": host, "port": port}

        report = office_preflight(
            configs,
            {
                "timeoutSeconds": 3,
                "jenkins": {
                    "baseUrl": "http://jenkins.example:8080",
                    "jobUrlTemplate": "{baseUrl}/job/{jobName}/api/json",
                },
                "robot": {"argv": ["ssh", "root@{testBedIp}", "ps robot"]},
                "ne": {"argv": ["ssh", "root@{testBedIp}", "ss | grep -E '{neIpRegex}'"]},
            },
            runner=runner,
            tcp_checker=tcp_checker,
            urlopen_func=lambda request, timeout: FakeJenkinsResponse('{"name":"233_setup"}'),
        )

        self.assertFalse(preflight_has_errors(report))
        self.assertEqual(report[0]["checks"][0]["name"], "jenkinsTcp")
        self.assertEqual(report[0]["checks"][1]["httpStatus"], 200)
        self.assertEqual(report[0]["checks"][2]["name"], "testBedSshTcp")
        self.assertEqual(report[0]["checks"][3]["fingerprints"], ["172.18.98.233 ecdsa-sha2-nistp256 SHA256:abc123"])

    def test_preflight_marks_remote_closed_ssh_as_error(self):
        configs = load_environment_configs("__missing__.json")[:1]
        runner = FakeKeyscanRunner(
            CommandResult(
                255,
                "",
                "debug1: Connection established.\nkex_exchange_identification: Connection closed by remote host",
            )
        )

        def tcp_checker(host, port, timeout_seconds):
            return {"status": "ok", "host": host, "port": port}

        report = office_preflight(
            configs,
            {
                "jenkins": {"baseUrl": "http://jenkins.example"},
                "robot": {"argv": ["robot-probe", "{testBedIp}"]},
                "ne": {"argv": ["ne-probe", "{neIpRegex}"]},
            },
            runner=runner,
            tcp_checker=tcp_checker,
            urlopen_func=lambda request, timeout: FakeJenkinsResponse("{}"),
        )

        self.assertTrue(preflight_has_errors(report))
        handshake = report[0]["checks"][3]
        self.assertEqual(handshake["status"], "error")
        self.assertIn("kex_exchange_identification: Connection closed by remote host", handshake["diagnostics"])

    def test_keyscan_line_fingerprint_uses_openssh_sha256_format(self):
        line = "100.115.246.23 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICr4DpExNlNQOXngC9hBxiI7XL+qrcRh0eSphMp4xTIR"

        fingerprint = fingerprint_keyscan_line(line)

        self.assertEqual(fingerprint, "100.115.246.23 ssh-ed25519 SHA256:ahL4MCRQPdx+48qBKsWhJFuvAGFH/X4wYC4Qqes7AHs")

    def test_keyscan_smoke_prints_fingerprint_and_raw_key_without_writing_known_hosts(self):
        stdout = StringIO()
        stderr = StringIO()
        key_line = "100.115.246.23 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICr4DpExNlNQOXngC9hBxiI7XL+qrcRh0eSphMp4xTIR\n"
        runner = FakeKeyscanRunner(CommandResult(0, key_line, ""))

        exit_code = office_probe_smoke_main(["--ssh-keyscan-host", "100.115.246.23"], stdout=stdout, stderr=stderr, runner=runner)

        self.assertEqual(exit_code, 0)
        self.assertEqual(runner.calls[0][0], ["ssh-keyscan", "-T", "5", "100.115.246.23"])
        self.assertIn("SHA256:ahL4MCRQPdx+48qBKsWhJFuvAGFH/X4wYC4Qqes7AHs", stdout.getvalue())
        self.assertIn(key_line.strip(), stdout.getvalue())
        self.assertEqual(stderr.getvalue(), "")

    def test_collect_ssh_keyscan_reports_errors(self):
        runner = FakeKeyscanRunner(CommandResult(1, "", "network unreachable"))

        fingerprints, errors = collect_ssh_keyscan("100.115.246.23", 5, runner)

        self.assertEqual(fingerprints, [])
        self.assertEqual(errors, ["network unreachable"])

    def test_handshake_probe_extracts_server_host_key_without_known_hosts_write(self):
        stdout = StringIO()
        stderr = StringIO()
        runner = FakeKeyscanRunner(
            CommandResult(
                255,
                "",
                "\n".join(
                    [
                        'debug3: hostkeys_foreach: reading file "C:/Users/Administrator/.ssh/known_hosts"',
                        "debug1: Server host key: ecdsa-sha2-nistp256 SHA256:VxJmSge8wfEU1p2Rb75erjvwwxFP7t40rEVEqfHW3vQ",
                        "Host key verification failed.",
                    ]
                ),
            )
        )

        exit_code = office_probe_smoke_main(["--ssh-handshake-host", "100.115.246.23"], stdout=stdout, stderr=stderr, runner=runner)

        self.assertEqual(exit_code, 0)
        self.assertEqual(runner.calls[0][0][:4], ["ssh", "-vvv", "-o", "BatchMode=yes"])
        self.assertIn("100.115.246.23 ecdsa-sha2-nistp256 SHA256:VxJmSge8wfEU1p2Rb75erjvwwxFP7t40rEVEqfHW3vQ", stdout.getvalue())
        self.assertIn("Host key verification failed.", stdout.getvalue())
        self.assertEqual(stderr.getvalue(), "")

    def test_collect_ssh_handshake_reports_timeout_errors(self):
        class RaisingRunner:
            def run(self, argv, timeout_seconds):
                raise subprocess.TimeoutExpired(argv, timeout_seconds)

        fingerprints, diagnostics = collect_ssh_handshake_hostkey("100.115.246.23", "root", 8, RaisingRunner())

        self.assertEqual(fingerprints, [])
        self.assertIn("ssh handshake probe failed", diagnostics[0])

    def test_handshake_probe_reports_remote_closed_diagnostics(self):
        runner = FakeKeyscanRunner(
            CommandResult(
                255,
                "",
                "\n".join(
                    [
                        "debug1: Connection established.",
                        "kex_exchange_identification: Connection closed by remote host",
                    ]
                ),
            )
        )

        fingerprints, diagnostics = collect_ssh_handshake_hostkey("172.18.98.233", "root", 8, runner)

        self.assertEqual(fingerprints, [])
        self.assertIn("kex_exchange_identification: Connection closed by remote host", diagnostics)

    def test_smoke_command_can_require_known_signal(self):
        stdout = StringIO()
        stderr = StringIO()

        exit_code = office_probe_smoke_main(["--probe", "mock", "--require-known"], stdout=stdout, stderr=stderr)

        self.assertEqual(exit_code, 0)
        self.assertIn("233_setup: jenkins_running", stdout.getvalue())
        self.assertEqual(stderr.getvalue(), "")

    def test_smoke_command_fails_when_required_signals_are_unknown(self):
        stdout = StringIO()
        stderr = StringIO()

        exit_code = office_probe_smoke_main(["--probe", "null", "--require-known"], stdout=stdout, stderr=stderr)

        self.assertEqual(exit_code, 2)
        self.assertIn("233_setup: unknown", stdout.getvalue())
        self.assertIn("No known Jenkins/Robot/NE signal", stderr.getvalue())

    def test_smoke_environment_id_filter_limits_real_probe_output(self):
        stdout = StringIO()
        stderr = StringIO()

        exit_code = office_probe_smoke_main(["--probe", "mock", "--environment-id", "233_setup"], stdout=stdout, stderr=stderr)

        output = stdout.getvalue()
        self.assertEqual(exit_code, 0)
        self.assertIn("233_setup: jenkins_running", output)
        self.assertNotIn("234_setup", output)
        self.assertNotIn("249_setup", output)
        self.assertEqual(stderr.getvalue(), "")


if __name__ == "__main__":
    unittest.main()

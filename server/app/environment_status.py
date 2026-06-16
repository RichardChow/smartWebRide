from __future__ import annotations

import json
import os
import time
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from .models import EnvironmentConfig, EnvironmentSession, EnvironmentSignal, EnvironmentStatus
from .slave_registry import SlaveRegistry


DEFAULT_ENVIRONMENTS: list[dict] = [
    {
        "environmentId": "233_setup",
        "jobName": "233_setup",
        "displayName": "AT Regression 233",
        "testBedIp": "172.18.98.233",
        "envFile": "233_trex_env.xlsx",
        "slaveId": "233",
        "neDevices": [
            {"ip": "200.200.18.101", "type": "NPT1800"},
            {"ip": "200.200.13.132", "type": "NPT1300"},
            {"ip": "200.200.122.201", "type": "NPT1022"},
            {"ip": "200.200.15.150", "type": "NPT1050i"},
        ],
    },
    {
        "environmentId": "234_setup",
        "jobName": "234_setup",
        "displayName": "AT Regression 234",
        "testBedIp": "172.18.98.234",
        "envFile": "234_trex_env.xlsm",
        "slaveId": "234",
        "neDevices": [
            {"ip": "200.200.125.129", "type": "NPT1250"},
            {"ip": "200.200.24.224", "type": "NPT2400A"},
            {"ip": "200.200.105.151", "type": "NPT1050i"},
            {"ip": "200.200.112.213", "type": "NPT1012D"},
        ],
    },
    {
        "environmentId": "249_setup",
        "jobName": "249_setup",
        "displayName": "AT Regression 249",
        "testBedIp": "172.18.98.249",
        "envFile": "249_breakout_env.xlsx",
        "slaveId": "249",
        "neDevices": [
            {"ip": "200.200.23.231", "type": "NPT2300"},
            {"ip": "200.200.21.210", "type": "NPT2100A"},
            {"ip": "200.200.122.209", "type": "NPT1022B"},
            {"ip": "200.200.11.114", "type": "NPT1100"},
        ],
    },
]


DEFAULT_STATUS_TTL_SECONDS = 15


@dataclass
class EnvironmentProbeSnapshot:
    complete: bool = False
    configured: bool = False
    signals: list[EnvironmentSignal] = field(default_factory=list)
    ne_sessions: list[EnvironmentSession] = field(default_factory=list)


class EnvironmentProbe:
    def collect(self, config: EnvironmentConfig) -> EnvironmentProbeSnapshot:
        raise NotImplementedError


class NullEnvironmentProbe(EnvironmentProbe):
    def collect(self, config: EnvironmentConfig) -> EnvironmentProbeSnapshot:
        return EnvironmentProbeSnapshot(
            complete=False,
            signals=[
                EnvironmentSignal(
                    source="jenkins",
                    status="unknown",
                    severity="unknown",
                    summary="Jenkins probe is not configured.",
                ),
                EnvironmentSignal(
                    source="robot",
                    status="unknown",
                    severity="unknown",
                    summary="Robot/test-bed probe is not configured.",
                ),
                EnvironmentSignal(
                    source="ne",
                    status="unknown",
                    severity="unknown",
                    summary="NE session probe is not configured.",
                ),
            ],
        )


class MockEnvironmentProbe(EnvironmentProbe):
    def collect(self, config: EnvironmentConfig) -> EnvironmentProbeSnapshot:
        if config.environmentId == "233_setup":
            return EnvironmentProbeSnapshot(
                complete=True,
                configured=True,
                signals=[
                    EnvironmentSignal(
                        source="jenkins",
                        status="busy",
                        severity="busy",
                        summary="Mock Jenkins build is running.",
                        detail={"buildNumber": 395, "displayName": "V10.2.00244", "progress": 99},
                    ),
                    EnvironmentSignal(
                        source="robot",
                        status="warning",
                        severity="warning",
                        summary="Mock manual Robot process looks stale.",
                        detail={"pid": 2659786, "cwd": "/root/debug/tyl_debug"},
                    ),
                    EnvironmentSignal(source="ne", status="busy", severity="warning", summary="Mock NE login sessions detected."),
                ],
                ne_sessions=[
                    EnvironmentSession(targetIp="200.200.18.101", user="admin", sourceIp="172.18.98.119", protocol="ssh"),
                    EnvironmentSession(targetIp="200.200.13.132", user="admin", sourceIp="172.18.98.119", protocol="ssh"),
                ],
            )
        return EnvironmentProbeSnapshot(
            complete=True,
            configured=True,
            signals=[
                EnvironmentSignal(source="jenkins", status="free", severity="free", summary="Mock Jenkins is idle."),
                EnvironmentSignal(source="robot", status="free", severity="free", summary="Mock Robot process is absent."),
                EnvironmentSignal(source="ne", status="free", severity="free", summary="Mock NE sessions are absent."),
            ],
        )


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_environment_configs(config_path: str | None = None) -> list[EnvironmentConfig]:
    path = Path(config_path or os.environ.get("SWR_ENVIRONMENTS_CONFIG", "server/config/environments.json"))
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        items = data.get("environments", data)
    else:
        items = deepcopy(DEFAULT_ENVIRONMENTS)
    return [EnvironmentConfig(**item) for item in items]


def probe_from_env() -> EnvironmentProbe:
    probe_name = os.environ.get("SWR_ENVIRONMENT_PROBE", "").strip().lower()
    if probe_name == "mock":
        return MockEnvironmentProbe()
    if probe_name == "office":
        from .office_environment_probe import OfficeEnvironmentProbe

        return OfficeEnvironmentProbe()
    return NullEnvironmentProbe()


class EnvironmentStatusService:
    def __init__(
        self,
        config_path: str | None = None,
        probe: EnvironmentProbe | None = None,
        ttl_seconds: float | None = None,
        clock: Callable[[], float] | None = None,
        configs: list[EnvironmentConfig] | None = None,
    ) -> None:
        self.configs = list(configs) if configs is not None else load_environment_configs(config_path)
        self.probe = probe or probe_from_env()
        self.ttl_seconds = self._resolve_ttl(ttl_seconds)
        self.clock = clock or time.monotonic
        self._cache: list[EnvironmentStatus] | None = None
        self._cache_expires_at = 0.0

    def list_statuses(self, registry: SlaveRegistry | None = None) -> list[EnvironmentStatus]:
        now = self.clock()
        if self._cache is not None and now < self._cache_expires_at:
            return self._cache
        updated_at = utc_now_iso()
        statuses = [self._build_status(config, updated_at, registry) for config in self.configs]
        if self.ttl_seconds > 0:
            self._cache = statuses
            self._cache_expires_at = now + self.ttl_seconds
        return statuses

    def invalidate_cache(self) -> None:
        self._cache = None
        self._cache_expires_at = 0.0

    def _resolve_ttl(self, ttl_seconds: float | None) -> float:
        if ttl_seconds is not None:
            return max(0.0, ttl_seconds)
        raw = os.environ.get("SWR_ENVIRONMENT_STATUS_TTL_SECONDS", "").strip()
        if not raw:
            return float(DEFAULT_STATUS_TTL_SECONDS)
        try:
            return max(0.0, float(raw))
        except ValueError:
            return float(DEFAULT_STATUS_TTL_SECONDS)

    def _build_status(self, config: EnvironmentConfig, updated_at: str, registry: SlaveRegistry | None) -> EnvironmentStatus:
        snapshot = self.probe.collect(config)
        signals = [self._smartwebride_signal(config, registry), *snapshot.signals]
        status, severity, summary = self._derive_status(signals, snapshot.ne_sessions, snapshot.complete, snapshot.configured)
        return EnvironmentStatus(
            environmentId=config.environmentId,
            jobName=config.jobName,
            displayName=config.displayName or config.environmentId,
            testBedIp=config.testBedIp,
            envFile=config.envFile,
            neDevices=config.neDevices,
            status=status,
            severity=severity,
            summary=summary,
            updatedAt=updated_at,
            signals=signals,
            neSessions=snapshot.ne_sessions,
        )

    def _smartwebride_signal(self, config: EnvironmentConfig, registry: SlaveRegistry | None) -> EnvironmentSignal:
        if not registry:
            return EnvironmentSignal(source="smartWebRide", status="unknown", severity="unknown", summary="smartWebRide registry is unavailable.")
        candidate_ids = [config.slaveId, config.environmentId, config.jobName, config.testBedIp]
        slave = next((registry.get(slave_id) for slave_id in candidate_ids if slave_id and registry.get(slave_id)), None)
        if not slave:
            return EnvironmentSignal(source="smartWebRide", status="unknown", severity="unknown", summary="No linked smartWebRide slave is registered.")
        if slave.processSignal != "none":
            return EnvironmentSignal(
                source="smartWebRide",
                status="busy",
                severity="busy",
                summary=f"smartWebRide Agent reports {slave.processSignal}.",
                detail={"slaveId": slave.slaveId, "activeRunId": slave.activeRunId},
            )
        if slave.holderEmail:
            return EnvironmentSignal(
                source="smartWebRide",
                status="busy",
                severity="warning",
                summary=f"smartWebRide is held by {slave.holder}.",
                detail={"slaveId": slave.slaveId, "holder": slave.holder, "holderEmail": slave.holderEmail},
            )
        if slave.agentVersion:
            return EnvironmentSignal(source="smartWebRide", status="free", severity="free", summary="smartWebRide linked slave is idle.")
        return EnvironmentSignal(source="smartWebRide", status="unknown", severity="unknown", summary="smartWebRide linked slave is offline.")

    def _derive_status(
        self,
        signals: list[EnvironmentSignal],
        ne_sessions: list[EnvironmentSession],
        probe_complete: bool,
        probe_configured: bool,
    ) -> tuple[str, str, str]:
        jenkins = self._source_signal(signals, "jenkins")
        robot = self._source_signal(signals, "robot")
        smart = self._source_signal(signals, "smartWebRide")
        if jenkins and jenkins.status == "busy":
            return "jenkins_running", "busy", jenkins.summary
        if robot and robot.status == "busy":
            return "manual_robot_active", "busy", robot.summary
        if robot and robot.status == "warning":
            return "manual_robot_stale", "warning", robot.summary
        if ne_sessions:
            return "login_only", "warning", f"{len(ne_sessions)} NE session(s) detected."
        if smart and smart.status == "busy":
            return "smartwebride_held", smart.severity, smart.summary
        if not probe_complete and not probe_configured:
            return "unknown", "unknown", "Office probe is not configured; real occupancy is unknown."
        if not probe_complete:
            return "unknown", "unknown", "Office probe ran, but real occupancy is still unknown."
        if all(signal.status in {"free", "unknown"} for signal in signals):
            return "free", "free", "No active Jenkins, Robot, NE, or smartWebRide signal detected."
        return "unknown", "unknown", "Environment status is inconclusive."

    def _source_signal(self, signals: list[EnvironmentSignal], source: str) -> EnvironmentSignal | None:
        return next((signal for signal in signals if signal.source == source), None)

from __future__ import annotations

import json
import os
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .models import SlaveInfo


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


LOCK_TTL = timedelta(minutes=5)


DEFAULT_SLAVES: dict[str, SlaveInfo] = {
    "vm1": SlaveInfo(
        slaveId="vm1",
        name="VM1 main debug node",
        host="192.0.2.11",
        system="Linux / sample",
        agentVersion="offline",
        mode="offline",
        allowedRoots=["/tmp/swr-debug", "/opt/robot/cases"],
    ),
    "vm2": SlaveInfo(
        slaveId="vm2",
        name="VM2 content node",
        host="192.0.2.12",
        system="Linux / sample",
        agentVersion="offline",
        mode="offline",
        allowedRoots=["/tmp/swr-debug", "/opt/robot/suites"],
    ),
    "richardpc": SlaveInfo(
        slaveId="richardpc",
        name="richardpc local preview",
        host="127.0.0.1",
        system="Windows",
        connectionMode="local-agent",
        agentVersion="offline",
        mode="offline",
        allowedRoots=["B:/workspace/smartWebRide/sample_data/Case"],
    ),
}


def load_slaves_from_config(config_path: str | None = None) -> dict[str, SlaveInfo]:
    path = Path(config_path or os.environ.get("SWR_SLAVES_CONFIG", "server/config/slaves.json"))
    if not path.exists():
        return deepcopy(DEFAULT_SLAVES)

    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get("slaves", data)
    slaves: dict[str, SlaveInfo] = {}
    for item in items:
        slave = SlaveInfo(**item)
        slaves[slave.slaveId] = slave
    return slaves


class SlaveRegistry:
    def __init__(self, config_path: str | None = None) -> None:
        self._slaves = load_slaves_from_config(config_path)

    def list_slaves(self) -> list[SlaveInfo]:
        for slave in self._slaves.values():
            self._sweep(slave)
        return list(self._slaves.values())

    def get(self, slave_id: str) -> SlaveInfo | None:
        return self._slaves.get(slave_id)

    def _is_expired(self, slave: SlaveInfo) -> bool:
        if not slave.holderEmail or not slave.expiresAt:
            return False
        try:
            return utc_now() > datetime.fromisoformat(slave.expiresAt)
        except ValueError:
            return False

    def _recompute_mode(self, slave: SlaveInfo) -> None:
        if not slave.agentVersion:
            slave.mode = "offline"
        elif slave.processSignal != "none":
            slave.mode = "running"
        elif slave.holderEmail:
            slave.mode = "held"
        else:
            slave.mode = "idle"

    def _sweep(self, slave: SlaveInfo) -> None:
        # 自动过期门控：仅当交互锁已过期且无后台活跃（processSignal == none）时才释放锁。
        if slave.holderEmail and self._is_expired(slave) and slave.processSignal == "none":
            slave.holder = ""
            slave.holderEmail = ""
            slave.expiresAt = ""
            slave.manualHoldReason = ""
        self._recompute_mode(slave)

    def mark_agent_online(
        self,
        slave_id: str,
        version: str,
        allowed_roots: list[str] | None = None,
        python_version: str = "",
        robot_version: str = "",
    ) -> SlaveInfo:
        slave = self._slaves.setdefault(
            slave_id,
            SlaveInfo(slaveId=slave_id, name=slave_id, host=slave_id, system="unknown"),
        )
        slave.agentVersion = version
        slave.pythonVersion = python_version
        slave.robotVersion = robot_version
        slave.heartbeatAt = utc_now().isoformat()
        if allowed_roots:
            slave.allowedRoots = allowed_roots
        self._recompute_mode(slave)
        return slave

    def mark_agent_offline(self, slave_id: str) -> None:
        slave = self._slaves.get(slave_id)
        if not slave:
            return
        slave.agentVersion = ""
        slave.pythonVersion = ""
        slave.robotVersion = ""
        slave.activeRunId = ""
        slave.processSignal = "none"
        self._recompute_mode(slave)

    def mark_agent_seen(
        self,
        slave_id: str,
        version: str = "",
        allowed_roots: list[str] | None = None,
        python_version: str = "",
        robot_version: str = "",
    ) -> None:
        slave = self._slaves.get(slave_id)
        if not slave or not slave.agentVersion:
            return
        if version:
            slave.agentVersion = version
        if python_version:
            slave.pythonVersion = python_version
        if robot_version:
            slave.robotVersion = robot_version
        if allowed_roots:
            slave.allowedRoots = allowed_roots
        slave.heartbeatAt = utc_now().isoformat()
        self._recompute_mode(slave)

    def lock(self, slave_id: str, holder: str, holder_email: str, reason: str = "") -> SlaveInfo:
        slave = self._require(slave_id)
        self._sweep(slave)
        if not slave.agentVersion:
            raise ValueError("slave is offline")
        if slave.holderEmail and slave.holderEmail != holder_email:
            raise ValueError(f"slave is held by {slave.holder}")
        slave.holder = holder
        slave.holderEmail = holder_email
        slave.manualHoldReason = reason
        slave.heartbeatAt = utc_now().isoformat()
        slave.expiresAt = (utc_now() + LOCK_TTL).isoformat()
        self._recompute_mode(slave)
        return slave

    def unlock(self, slave_id: str, holder_email: str) -> SlaveInfo:
        slave = self._require(slave_id)
        if slave.holderEmail and slave.holderEmail != holder_email:
            raise ValueError(f"slave is held by {slave.holder}")
        slave.holder = ""
        slave.holderEmail = ""
        slave.expiresAt = ""
        slave.manualHoldReason = ""
        self._recompute_mode(slave)
        return slave

    def can_write(self, slave_id: str, holder_email: str) -> bool:
        # 该 holder 当前是否持有有效（未过期）写锁。先 sweep 清掉过期锁。
        slave = self._slaves.get(slave_id)
        if not slave:
            return False
        self._sweep(slave)
        return bool(holder_email) and slave.holderEmail == holder_email

    def renew(self, slave_id: str, holder_email: str) -> None:
        # 终端 WS 活跃续租：仅持有人本人可续，holder 不匹配静默忽略。
        slave = self._slaves.get(slave_id)
        if not slave or slave.holderEmail != holder_email:
            return
        slave.expiresAt = (utc_now() + LOCK_TTL).isoformat()
        slave.heartbeatAt = utc_now().isoformat()

    def takeover(self, slave_id: str, new_holder: str, new_holder_email: str, reason: str = "") -> tuple[str, str, SlaveInfo]:
        # 强制接管：无视原持有人与过期，直接转锁。调用方需先关掉原持有人 session。
        slave = self._require(slave_id)
        self._sweep(slave)
        if not slave.agentVersion:
            raise ValueError("slave is offline")
        prev_holder = slave.holder
        prev_holder_email = slave.holderEmail
        slave.holder = new_holder
        slave.holderEmail = new_holder_email
        slave.manualHoldReason = reason
        slave.heartbeatAt = utc_now().isoformat()
        slave.expiresAt = (utc_now() + LOCK_TTL).isoformat()
        self._recompute_mode(slave)
        return prev_holder, prev_holder_email, slave

    def update_activity(self, slave_id: str, robot_running: bool, run_id: str = "") -> None:
        # 后台活跃信号（Center 轮询 Agent 得到）：写 processSignal/activeRunId，刷新过期门控与 mode。
        slave = self._slaves.get(slave_id)
        if not slave:
            return
        slave.processSignal = "robot" if robot_running else "none"
        slave.activeRunId = run_id if robot_running else ""
        self._sweep(slave)

    def _require(self, slave_id: str) -> SlaveInfo:
        slave = self._slaves.get(slave_id)
        if not slave:
            raise KeyError(slave_id)
        return slave

from __future__ import annotations

import os
import sys
from pathlib import Path

ROBOT_NAMES = {"robot", "rebot", "robot.py"}


def _norm(path: str) -> str:
    return path.replace("\\", "/").rstrip("/")


class ActivityService:
    """检测该 slave 上是否有 Robot/Python 测试进程在运行。

    判定信号（任一命中即 robotRunning=True）：
    - 进程 argv0 的 basename 属于 robot 家族（robot / rebot），或 cmdline 含 `robot.run`；
    - python 进程且 cmdline 含 `robot`，且其 cwd 落在某个 allowedRoot 下。
    Linux 走 /proc；其它平台（如 Windows 本机预览）暂返回非活跃。
    """

    def __init__(self, roots: list[str]) -> None:
        self.roots = [_norm(r) for r in roots]

    def scan(self) -> dict:
        if not sys.platform.startswith("linux") or not os.path.isdir("/proc"):
            return {"robotRunning": False, "runId": "", "processes": []}

        matched: list[dict] = []
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                raw = Path(f"/proc/{entry}/cmdline").read_bytes()
            except (OSError, PermissionError):
                continue
            if not raw:
                continue
            argv = [part for part in raw.decode("utf-8", "replace").split("\x00") if part]
            if not argv:
                continue
            if not self._is_robot_process(argv, entry):
                continue
            matched.append({"pid": int(entry), "cmd": " ".join(argv)[:200]})

        return {
            "robotRunning": bool(matched),
            "runId": str(matched[0]["pid"]) if matched else "",
            "processes": matched,
        }

    def _is_robot_process(self, argv: list[str], pid: str) -> bool:
        argv0_base = os.path.basename(argv[0])
        if argv0_base in ROBOT_NAMES:
            return True
        joined = " ".join(argv)
        if "robot.run" in joined:
            return True
        if "python" in argv0_base and "robot" in joined:
            return self._cwd_under_roots(pid)
        # 形如 `sudo /opt/venv/bin/robot ...`：带路径的 robot 可执行文件作为参数，
        # 用 '/' 排除 `grep robot` 这类把 robot 当普通字符串的命令。
        return any("/" in token and os.path.basename(token) in ROBOT_NAMES for token in argv[1:3])

    def _cwd_under_roots(self, pid: str) -> bool:
        if not self.roots:
            return False
        try:
            cwd = _norm(os.readlink(f"/proc/{pid}/cwd"))
        except (OSError, PermissionError):
            return False
        return any(cwd == root or cwd.startswith(root + "/") for root in self.roots)

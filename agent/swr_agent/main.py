from __future__ import annotations

import argparse
import asyncio
import json
import os
import platform
import shutil
import subprocess
import sys
from dataclasses import dataclass
from urllib.parse import urlencode

import websockets

from .activity_service import ActivityService
from .file_service import FileService
from .pty_service import PtyService

CONNECT_TIMEOUT_SECONDS = 10
PING_INTERVAL_SECONDS = 20
PING_TIMEOUT_SECONDS = 10
CLOSE_TIMEOUT_SECONDS = 5
DISPATCH_TIMEOUT_SECONDS = 45
HEARTBEAT_INTERVAL_SECONDS = 5
ROBOT_VERSION_TIMEOUT_SECONDS = 8
ROBOT_VERSION_UNAVAILABLE = "未安装"


@dataclass(frozen=True)
class RuntimeInfo:
    python_version: str
    robot_version: str


def run_robot_version_command(command: list[str]) -> str:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=ROBOT_VERSION_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ROBOT_VERSION_UNAVAILABLE
    output = (result.stdout or result.stderr).strip()
    if not output:
        return ROBOT_VERSION_UNAVAILABLE
    first_line = output.splitlines()[0].strip()
    if first_line.startswith("Robot Framework "):
        return first_line
    return ROBOT_VERSION_UNAVAILABLE


def detect_robot_version() -> str:
    module_version = run_robot_version_command([sys.executable, "-m", "robot", "--version"])
    if module_version != ROBOT_VERSION_UNAVAILABLE:
        return module_version
    robot_bin = shutil.which("robot")
    if robot_bin:
        return run_robot_version_command([robot_bin, "--version"])
    return ROBOT_VERSION_UNAVAILABLE


def detect_runtime_info() -> RuntimeInfo:
    return RuntimeInfo(python_version=platform.python_version(), robot_version=detect_robot_version())


class SmartWebRideAgent:
    def __init__(self, center_url: str, slave_id: str, roots: list[str], version: str = "swr-agent-dev", runtime_info: RuntimeInfo | None = None) -> None:
        self.center_url = center_url.rstrip("/")
        self.slave_id = slave_id
        self.roots = roots
        self.version = version
        self.runtime_info = runtime_info or detect_runtime_info()
        self.websocket = None
        self.send_lock = asyncio.Lock()
        self.file_service = FileService(roots)
        self.pty_service = PtyService(self.send_terminal_output, self.send_terminal_cwd)
        self.activity_service = ActivityService(roots)

    async def run_forever(self) -> None:
        query = urlencode(self.agent_status_payload(query_roots=True))
        url = f"{self.center_url}/api/agent/connect/{self.slave_id}?{query}"
        while True:
            try:
                async with websockets.connect(
                    url,
                    open_timeout=CONNECT_TIMEOUT_SECONDS,
                    ping_interval=PING_INTERVAL_SECONDS,
                    ping_timeout=PING_TIMEOUT_SECONDS,
                    close_timeout=CLOSE_TIMEOUT_SECONDS,
                ) as websocket:
                    self.websocket = websocket
                    heartbeat_task = asyncio.create_task(self.send_heartbeat_loop())
                    receive_task = asyncio.create_task(self.receive_loop(websocket))
                    try:
                        done, pending = await asyncio.wait(
                            {heartbeat_task, receive_task},
                            return_when=asyncio.FIRST_EXCEPTION,
                        )
                        for task in pending:
                            task.cancel()
                        if pending:
                            await asyncio.gather(*pending, return_exceptions=True)
                        for task in done:
                            if not task.cancelled() and task.exception():
                                raise task.exception()
                    finally:
                        heartbeat_task.cancel()
                        receive_task.cancel()
                        await asyncio.gather(heartbeat_task, receive_task, return_exceptions=True)
                        await self.pty_service.close_all()
                        self.websocket = None
            except Exception as exc:
                print(f"[smartWebRide Agent] disconnected: {exc}", flush=True)
                await asyncio.sleep(3)

    async def receive_loop(self, websocket) -> None:
        async for message in websocket:
            await self.handle_message(json.loads(message))

    async def send_heartbeat_loop(self) -> None:
        while self.websocket:
            await self.send_event("agent.heartbeat", self.agent_status_payload(query_roots=False))
            await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)

    def agent_status_payload(self, query_roots: bool = False) -> dict:
        roots: str | list[str] = "|".join(self.roots) if query_roots else self.roots
        return {
            "slaveId": self.slave_id,
            "version": self.version,
            "roots": roots,
            "pythonVersion": self.runtime_info.python_version,
            "robotVersion": self.runtime_info.robot_version,
        }

    async def handle_message(self, message: dict) -> None:
        request_id = message.get("requestId")
        message_type = message.get("type")
        payload = message.get("payload") or {}
        try:
            result = await asyncio.wait_for(self.dispatch(message_type, payload), timeout=DISPATCH_TIMEOUT_SECONDS)
            await self.send_response(request_id, result)
        except asyncio.TimeoutError:
            await self.send_response(request_id, {"error": f"agent dispatch timed out: {message_type}"})
        except Exception as exc:
            await self.send_response(request_id, {"error": str(exc)})

    async def dispatch(self, message_type: str, payload: dict) -> dict:
        if message_type == "terminal.open":
            agent_session_id = await self.pty_service.open(
                payload.get("shell") or "/bin/sh",
                payload.get("cwd") or self.roots[0],
                payload.get("argv"),
                payload.get("sessionId"),
            )
            return {"agentSessionId": agent_session_id}
        if message_type == "terminal.input":
            await self.pty_service.input(payload["agentSessionId"], payload.get("data", ""))
            return {"ok": True}
        if message_type == "terminal.resize":
            await self.pty_service.resize(payload["agentSessionId"], int(payload.get("cols", 80)), int(payload.get("rows", 24)))
            return {"ok": True}
        if message_type == "terminal.close":
            await self.pty_service.close(payload["agentSessionId"])
            return {"ok": True}
        if message_type == "file.list":
            return self.file_service.list(payload.get("path") or self.roots[0])
        if message_type == "file.read":
            return self.file_service.read(payload["path"])
        if message_type == "file.write":
            if payload.get("encoding") == "base64":
                return self.file_service.write_base64(payload["path"], payload.get("content", ""))
            return self.file_service.write(payload["path"], payload.get("content", ""))
        if message_type == "file.mkdir":
            return self.file_service.mkdir(payload["path"], bool(payload.get("parents", False)))
        if message_type == "system.activity":
            return self.activity_service.scan()
        raise ValueError(f"unknown message type: {message_type}")

    async def send_response(self, request_id: str | None, payload: dict) -> None:
        if not request_id:
            return
        await self.send_event("response", {"requestId": request_id, "payload": payload})

    async def send_terminal_output(self, session_id: str, data: str) -> None:
        if not self.websocket:
            return
        await self.send_event("terminal.output", {"sessionId": session_id, "data": data})

    async def send_terminal_cwd(self, session_id: str, cwd: str) -> None:
        if not self.websocket:
            return
        await self.send_event("terminal.cwd", {"sessionId": session_id, "cwd": cwd})

    async def send_event(self, message_type: str, payload: dict) -> None:
        if not self.websocket:
            raise RuntimeError("agent websocket is not connected")
        message = {"type": message_type, **payload}
        async with self.send_lock:
            await self.websocket.send(json.dumps(message))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--center", default="ws://127.0.0.1:8008")
    parser.add_argument("--slave-id", required=True)
    parser.add_argument("--root", action="append", required=True)
    parser.add_argument("--version", default="swr-agent-dev")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    venv_bin = os.path.dirname(sys.executable)
    os.environ["PATH"] = venv_bin + os.pathsep + os.environ.get("PATH", "")
    agent = SmartWebRideAgent(args.center, args.slave_id, args.root, args.version)
    asyncio.run(agent.run_forever())


if __name__ == "__main__":
    main()

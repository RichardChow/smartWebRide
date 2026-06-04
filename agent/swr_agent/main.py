from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from urllib.parse import urlencode

import websockets

from .activity_service import ActivityService
from .file_service import FileService
from .pty_service import PtyService


class SmartWebRideAgent:
    def __init__(self, center_url: str, slave_id: str, roots: list[str], version: str = "swr-agent-dev") -> None:
        self.center_url = center_url.rstrip("/")
        self.slave_id = slave_id
        self.roots = roots
        self.version = version
        self.websocket = None
        self.send_lock = asyncio.Lock()
        self.file_service = FileService(roots)
        self.pty_service = PtyService(self.send_terminal_output, self.send_terminal_cwd)
        self.activity_service = ActivityService(roots)

    async def run_forever(self) -> None:
        query = urlencode({"version": self.version, "roots": "|".join(self.roots)})
        url = f"{self.center_url}/api/agent/connect/{self.slave_id}?{query}"
        while True:
            try:
                async with websockets.connect(url) as websocket:
                    self.websocket = websocket
                    async for message in websocket:
                        await self.handle_message(json.loads(message))
            except Exception as exc:
                print(f"[smartWebRide Agent] disconnected: {exc}")
                await asyncio.sleep(3)

    async def handle_message(self, message: dict) -> None:
        request_id = message.get("requestId")
        message_type = message.get("type")
        payload = message.get("payload") or {}
        try:
            result = await self.dispatch(message_type, payload)
            await self.send_response(request_id, result)
        except Exception as exc:
            await self.send_response(request_id, {"error": str(exc)})

    async def dispatch(self, message_type: str, payload: dict) -> dict:
        if message_type == "terminal.open":
            agent_session_id = await self.pty_service.open(
                payload.get("shell") or "/bin/sh",
                payload.get("cwd") or self.roots[0],
                payload.get("argv"),
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
        if not self.websocket or not request_id:
            return
        async with self.send_lock:
            await self.websocket.send(json.dumps({"type": "response", "requestId": request_id, "payload": payload}))

    async def send_terminal_output(self, session_id: str, data: str) -> None:
        if not self.websocket:
            return
        async with self.send_lock:
            await self.websocket.send(json.dumps({"type": "terminal.output", "sessionId": session_id, "data": data}))

    async def send_terminal_cwd(self, session_id: str, cwd: str) -> None:
        if not self.websocket:
            return
        async with self.send_lock:
            await self.websocket.send(json.dumps({"type": "terminal.cwd", "sessionId": session_id, "cwd": cwd}))


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

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, field

from fastapi import WebSocket


TerminalQueueItem = dict[str, str]


def build_terminal_argv(shell: str) -> list[str]:
    lowered = shell.lower()
    if "powershell" in lowered:
        return ["powershell.exe", "-NoLogo"]

    shell_name = shell.replace("\\", "/").rsplit("/", 1)[-1].lower()
    if shell_name == "bash":
        return [shell, "--login", "-i"]
    return [shell, "-i"]


@dataclass
class TerminalSession:
    session_id: str
    slave_id: str
    agent_session_id: str
    shell: str
    holder: str = ""
    output_queues: set[asyncio.Queue[TerminalQueueItem]] = field(default_factory=set)


class AgentConnection:
    def __init__(self, slave_id: str, websocket: WebSocket) -> None:
        self.slave_id = slave_id
        self.websocket = websocket
        self.pending: dict[str, asyncio.Future[dict]] = {}
        self.agent_to_center_session: dict[str, str] = {}
        self._send_lock = asyncio.Lock()

    async def request(self, message_type: str, payload: dict, timeout: float = 15) -> dict:
        request_id = uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict] = loop.create_future()
        self.pending[request_id] = future
        async with self._send_lock:
            await self.websocket.send_json({"type": message_type, "requestId": request_id, "payload": payload})
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            self.pending.pop(request_id, None)

    async def notify(self, message_type: str, payload: dict) -> None:
        request_id = uuid.uuid4().hex
        async with self._send_lock:
            await self.websocket.send_json({"type": message_type, "requestId": request_id, "payload": payload})

    def resolve(self, request_id: str, payload: dict) -> None:
        future = self.pending.get(request_id)
        if future and not future.done():
            future.set_result(payload)


class AgentHub:
    def __init__(self) -> None:
        self._agents: dict[str, AgentConnection] = {}
        self._sessions: dict[str, TerminalSession] = {}

    def is_online(self, slave_id: str) -> bool:
        return slave_id in self._agents

    def online_slave_ids(self) -> list[str]:
        return list(self._agents.keys())

    def attach_agent(self, slave_id: str, websocket: WebSocket) -> AgentConnection:
        connection = AgentConnection(slave_id, websocket)
        self._agents[slave_id] = connection
        return connection

    def detach_agent(self, slave_id: str, connection: AgentConnection | None = None) -> bool:
        current = self._agents.get(slave_id)
        if connection is not None and current is not connection:
            return False
        self._agents.pop(slave_id, None)
        closed = [sid for sid, session in self._sessions.items() if session.slave_id == slave_id]
        for sid in closed:
            self._sessions.pop(sid, None)
        return True

    async def handle_agent_message(self, connection: AgentConnection, message: str) -> None:
        data = json.loads(message)
        message_type = data.get("type")
        if message_type == "response":
            connection.resolve(str(data.get("requestId", "")), data.get("payload") or {})
            return
        if message_type == "terminal.output":
            agent_session_id = str(data.get("sessionId", ""))
            session_id = connection.agent_to_center_session.get(agent_session_id)
            if not session_id:
                return
            session = self._sessions.get(session_id)
            if not session:
                return
            output = str(data.get("data", ""))
            for queue in list(session.output_queues):
                await queue.put({"type": "output", "data": output})

    async def create_terminal_session(self, slave_id: str, shell: str, cwd: str, holder: str = "") -> TerminalSession:
        agent = self._require_agent(slave_id)
        session_id = uuid.uuid4().hex[:12]
        argv = build_terminal_argv(shell)
        response = await agent.request("terminal.open", {"sessionId": session_id, "shell": shell, "cwd": cwd, "argv": argv})
        agent_session_id = str(response.get("agentSessionId") or session_id)
        session = TerminalSession(session_id=session_id, slave_id=slave_id, agent_session_id=agent_session_id, shell=shell, holder=holder)
        self._sessions[session_id] = session
        agent.agent_to_center_session[agent_session_id] = session_id
        return session

    def get_terminal_session(self, session_id: str) -> TerminalSession | None:
        return self._sessions.get(session_id)

    async def terminal_input(self, session_id: str, data: str) -> None:
        session = self._require_session(session_id)
        agent = self._require_agent(session.slave_id)
        await agent.notify("terminal.input", {"agentSessionId": session.agent_session_id, "data": data})

    async def terminal_resize(self, session_id: str, cols: int, rows: int) -> None:
        session = self._require_session(session_id)
        agent = self._require_agent(session.slave_id)
        await agent.notify("terminal.resize", {"agentSessionId": session.agent_session_id, "cols": cols, "rows": rows})

    async def close_terminal_session(self, session_id: str, reason: str = "") -> None:
        session = self._sessions.pop(session_id, None)
        if not session:
            return
        if reason:
            for queue in list(session.output_queues):
                await queue.put({"type": "closed", "message": reason})
        agent = self._agents.get(session.slave_id)
        if agent:
            try:
                await agent.request("terminal.close", {"agentSessionId": session.agent_session_id}, timeout=5)
            except (RuntimeError, asyncio.TimeoutError):
                pass
            agent.agent_to_center_session.pop(session.agent_session_id, None)

    async def close_slave_sessions(self, slave_id: str, reason: str = "") -> list[str]:
        # 关掉该 slave 上的全部终端会话（释放 / 强制接管时拆 PTY，维持单写者）。
        target = [sid for sid, session in self._sessions.items() if session.slave_id == slave_id]
        for sid in target:
            await self.close_terminal_session(sid, reason)
        return target

    def list_slave_sessions(self, slave_id: str) -> list[TerminalSession]:
        return [session for session in self._sessions.values() if session.slave_id == slave_id]

    async def file_request(self, slave_id: str, action: str, payload: dict) -> dict:
        agent = self._require_agent(slave_id)
        return await agent.request(f"file.{action}", payload, timeout=20)

    async def activity_request(self, slave_id: str) -> dict:
        # 主动轮询 Agent 的后台活跃（Robot/Python 进程）。复用请求-响应通道。
        agent = self._require_agent(slave_id)
        return await agent.request("system.activity", {}, timeout=8)

    def _require_agent(self, slave_id: str) -> AgentConnection:
        agent = self._agents.get(slave_id)
        if not agent:
            raise RuntimeError(f"agent offline: {slave_id}")
        return agent

    def _require_session(self, session_id: str) -> TerminalSession:
        session = self._sessions.get(session_id)
        if not session:
            raise RuntimeError(f"terminal session not found: {session_id}")
        return session

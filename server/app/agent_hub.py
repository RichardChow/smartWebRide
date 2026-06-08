from __future__ import annotations

import asyncio
import json
import uuid
import time
from collections import deque
from dataclasses import dataclass, field

from fastapi import WebSocket


TerminalQueueItem = dict[str, str]
TERMINAL_HISTORY_MAX_CHUNKS = 5_000
TERMINAL_HISTORY_MAX_BYTES = 2 * 1024 * 1024
TERMINAL_INPUT_ACK_TIMEOUT_SECONDS = 3


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
    reusable: bool = True
    output_queues: set[asyncio.Queue[TerminalQueueItem]] = field(default_factory=set)
    created_at: float = field(default_factory=time.time)
    last_attached_at: float = 0.0
    last_detached_at: float = 0.0
    output_history: deque[TerminalQueueItem] = field(default_factory=deque)
    output_history_bytes: int = 0

    def mark_attached(self) -> None:
        self.last_attached_at = time.time()

    def mark_detached(self) -> None:
        self.last_detached_at = time.time()

    def append_history(self, event: TerminalQueueItem) -> None:
        if event.get("type") not in {"output", "cwd"}:
            return
        item = dict(event)
        size = sum(len(value.encode("utf-8", errors="ignore")) for value in item.values())
        self.output_history.append(item)
        self.output_history_bytes += size
        while len(self.output_history) > TERMINAL_HISTORY_MAX_CHUNKS or self.output_history_bytes > TERMINAL_HISTORY_MAX_BYTES:
            removed = self.output_history.popleft()
            self.output_history_bytes -= sum(len(value.encode("utf-8", errors="ignore")) for value in removed.values())

    def history_snapshot(self) -> list[TerminalQueueItem]:
        return [dict(event) for event in self.output_history]


class AgentConnection:
    def __init__(self, slave_id: str, websocket: WebSocket) -> None:
        self.slave_id = slave_id
        self.websocket = websocket
        self.pending: dict[str, asyncio.Future[dict]] = {}
        self.agent_to_center_session: dict[str, str] = {}
        self.orphan_terminal_events: dict[str, deque[TerminalQueueItem]] = {}
        self._send_lock = asyncio.Lock()
        self.connected_at = time.time()
        self.last_seen_at = self.connected_at
        self.last_error = ""
        self.request_failures = 0
        self.closed = False

    def mark_seen(self) -> None:
        self.last_seen_at = time.time()

    def mark_ok(self) -> None:
        self.last_error = ""
        self.request_failures = 0
        self.mark_seen()

    def mark_error(self, message: str, connection_failure: bool = True) -> None:
        self.last_error = message
        if connection_failure:
            self.request_failures += 1

    async def request(self, message_type: str, payload: dict, timeout: float = 15, fail_on_error: bool = True) -> dict:
        request_id = uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict] = loop.create_future()
        self.pending[request_id] = future
        try:
            async with self._send_lock:
                await self.websocket.send_json({"type": message_type, "requestId": request_id, "payload": payload})
            result = await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError as exc:
            message = f"agent request timed out: {self.slave_id} {message_type}"
            self.mark_error(message)
            raise RuntimeError(message) from exc
        except Exception as exc:
            message = f"agent request failed: {self.slave_id} {message_type}: {exc}"
            self.mark_error(message)
            raise RuntimeError(message) from exc
        finally:
            self.pending.pop(request_id, None)
        if fail_on_error and "error" in result:
            error = str(result.get("error") or "unknown agent error")
            message = f"agent request failed: {self.slave_id} {message_type}: {error}"
            self.mark_error(message, connection_failure=False)
            raise RuntimeError(message)
        self.mark_ok()
        return result

    async def notify(self, message_type: str, payload: dict) -> None:
        request_id = uuid.uuid4().hex
        try:
            async with self._send_lock:
                await self.websocket.send_json({"type": message_type, "requestId": request_id, "payload": payload})
        except Exception as exc:
            message = f"agent send failed: {self.slave_id} {message_type}: {exc}"
            self.mark_error(message)
            raise RuntimeError(message) from exc

    def resolve(self, request_id: str, payload: dict) -> bool:
        future = self.pending.get(request_id)
        if future and not future.done():
            future.set_result(payload)
            return True
        return False

    def record_orphan_response(self, request_id: str, payload: dict) -> None:
        if "error" not in payload:
            return
        error = str(payload.get("error") or "unknown agent error")
        self.mark_error(f"agent orphan response failed: {self.slave_id} {request_id}: {error}")

    def buffer_orphan_terminal_event(self, agent_session_id: str, event: TerminalQueueItem) -> None:
        if not agent_session_id:
            return
        events = self.orphan_terminal_events.setdefault(agent_session_id, deque(maxlen=100))
        events.append(event)

    def pop_orphan_terminal_events(self, agent_session_id: str) -> list[TerminalQueueItem]:
        events = self.orphan_terminal_events.pop(agent_session_id, deque())
        return [dict(event) for event in events]


class AgentHub:
    def __init__(self) -> None:
        self._agents: dict[str, AgentConnection] = {}
        self._sessions: dict[str, TerminalSession] = {}

    def is_online(self, slave_id: str) -> bool:
        return slave_id in self._agents

    def online_slave_ids(self) -> list[str]:
        return list(self._agents.keys())

    def list_agent_connections(self) -> list[AgentConnection]:
        return list(self._agents.values())

    def is_connection_stale(self, connection: AgentConnection, stale_seconds: float) -> bool:
        return time.time() - connection.last_seen_at > stale_seconds

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

    async def close_agent_connection(self, connection: AgentConnection, reason: str = "") -> None:
        connection.closed = True
        try:
            await connection.websocket.close()
        except Exception:
            pass

    async def handle_agent_message(self, connection: AgentConnection, message: str) -> dict | None:
        data = json.loads(message)
        connection.mark_seen()
        message_type = data.get("type")
        if message_type == "agent.heartbeat":
            return data
        if message_type == "response":
            request_id = str(data.get("requestId", ""))
            payload = data.get("payload") or {}
            if not connection.resolve(request_id, payload):
                connection.record_orphan_response(request_id, payload)
            return
        if message_type == "terminal.output":
            agent_session_id = str(data.get("sessionId", ""))
            session_id = connection.agent_to_center_session.get(agent_session_id)
            output = str(data.get("data", ""))
            event = {"type": "output", "data": output}
            if not session_id:
                connection.buffer_orphan_terminal_event(agent_session_id, event)
                return
            session = self._sessions.get(session_id)
            if not session:
                connection.buffer_orphan_terminal_event(agent_session_id, event)
                return
            await self._publish_terminal_event(session, event)
            return
        if message_type == "terminal.cwd":
            agent_session_id = str(data.get("sessionId", ""))
            session_id = connection.agent_to_center_session.get(agent_session_id)
            cwd = str(data.get("cwd", ""))
            event = {"type": "cwd", "data": cwd}
            if not session_id:
                connection.buffer_orphan_terminal_event(agent_session_id, event)
                return
            session = self._sessions.get(session_id)
            if not session:
                connection.buffer_orphan_terminal_event(agent_session_id, event)
                return
            await self._publish_terminal_event(session, event)
        return None

    async def _publish_terminal_event(self, session: TerminalSession, event: TerminalQueueItem) -> None:
        session.append_history(event)
        for queue in list(session.output_queues):
            await queue.put(event)

    async def create_terminal_session(self, slave_id: str, shell: str, cwd: str, holder: str = "", reusable: bool = True) -> TerminalSession:
        agent = self._require_agent(slave_id)
        session_id = uuid.uuid4().hex[:12]
        argv = build_terminal_argv(shell)
        session = TerminalSession(session_id=session_id, slave_id=slave_id, agent_session_id=session_id, shell=shell, holder=holder, reusable=reusable)
        self._sessions[session_id] = session
        agent.agent_to_center_session[session_id] = session_id
        try:
            response = await agent.request("terminal.open", {"sessionId": session_id, "shell": shell, "cwd": cwd, "argv": argv})
            agent_session_id = str(response.get("agentSessionId") or "")
            if not agent_session_id:
                raise RuntimeError(f"agent terminal.open returned no agentSessionId: {slave_id}")
            if agent_session_id != session_id:
                agent.agent_to_center_session.pop(session_id, None)
                session.agent_session_id = agent_session_id
                agent.agent_to_center_session[agent_session_id] = session_id
            pop_orphan_events = getattr(agent, "pop_orphan_terminal_events", None)
            if pop_orphan_events:
                for event in pop_orphan_events(agent_session_id):
                    await self._publish_terminal_event(session, event)
        except Exception:
            self._sessions.pop(session_id, None)
            agent.agent_to_center_session.pop(session_id, None)
            raise
        return session

    def get_terminal_session(self, session_id: str) -> TerminalSession | None:
        return self._sessions.get(session_id)

    def find_reusable_terminal_session(self, slave_id: str, holder: str) -> TerminalSession | None:
        if not holder:
            return None
        candidates = [
            session
            for session in self._sessions.values()
            if session.slave_id == slave_id and session.holder == holder and session.reusable
        ]
        return max(candidates, key=lambda session: session.created_at, default=None)

    def list_terminal_sessions(self) -> list[TerminalSession]:
        return list(self._sessions.values())

    async def terminal_input(self, session_id: str, data: str) -> None:
        session = self._require_session(session_id)
        agent = self._require_agent(session.slave_id)
        await agent.request(
            "terminal.input",
            {"agentSessionId": session.agent_session_id, "data": data},
            timeout=TERMINAL_INPUT_ACK_TIMEOUT_SECONDS,
        )

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
        return await agent.request(f"file.{action}", payload, timeout=20, fail_on_error=False)

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

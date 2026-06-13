from __future__ import annotations

import asyncio
import json
import posixpath
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .agent_hub import AgentHub
from .auth import (
    AuthError,
    AuthService,
    AuthenticatedUser,
    cookie_secure_enabled,
    session_cookie_name,
    session_id_from_cookie_header,
    session_ttl_seconds,
)
from .models import AuthUserResponse, FileListResponse, FileMkdirRequest, FileReadResponse, FileWriteRequest, LockRequest, LoginRequest, SlaveInfo, TakeoverRequest, TerminalSessionResponse
from .slave_registry import SlaveRegistry

ACTIVITY_POLL_INTERVAL = 12
LOCK_RENEW_INTERVAL = 60
AGENT_HEALTH_INTERVAL = 5
AGENT_STALE_SECONDS = 20
AGENT_MAX_REQUEST_FAILURES = 1

app = FastAPI(title="smartWebRide Center", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_origin_regex=r"https?://[^/]+:517[0-9]",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

registry = SlaveRegistry()
hub = AgentHub()
auth_service = AuthService()

# 内存态审计（重启即丢，MVP 足够）：记录强制接管等高影响操作。
AUDIT: list[dict] = []


def default_terminal_cwd(roots: list[str]) -> str:
    for root in roots:
        normalized = root.replace("\\", "/").rstrip("/")
        if normalized.startswith("/home/") and normalized.count("/") == 2:
            return root
    return roots[0] if roots else "."


def normalize_remote_path(value: str) -> str:
    normalized = value.strip().replace("\\", "/")
    if not normalized:
        return ""
    if len(normalized) >= 2 and normalized[1] == ":":
        drive = normalized[:2].lower()
        rest = posixpath.normpath(normalized[2:] or "/")
        if rest == ".":
            rest = "/"
        if not rest.startswith("/"):
            rest = f"/{rest}"
        return f"{drive}{rest}".rstrip("/") or f"{drive}/"
    normalized = posixpath.normpath(normalized)
    if normalized == ".":
        return ""
    return normalized.rstrip("/") or "/"


def is_allowed_terminal_cwd(cwd: str, roots: list[str]) -> bool:
    normalized = normalize_remote_path(cwd)
    if not normalized:
        return False
    if not roots:
        return normalized in {".", "/"}
    for root in roots:
        allowed = normalize_remote_path(root)
        if not allowed:
            continue
        if allowed == "/":
            return normalized.startswith("/")
        if normalized == allowed or normalized.startswith(f"{allowed}/"):
            return True
    return False


def auth_user_response(user: AuthenticatedUser) -> AuthUserResponse:
    return AuthUserResponse(email=user.email, displayName=user.display_name, roles=list(user.roles))


async def get_current_user(request: Request) -> AuthenticatedUser:
    user = auth_service.get_session_user(request.cookies.get(session_cookie_name()))
    if not user:
        raise HTTPException(status_code=401, detail="authentication required")
    return user


def get_websocket_user(websocket: WebSocket) -> AuthenticatedUser | None:
    session_id = session_id_from_cookie_header(websocket.headers.get("cookie"))
    return auth_service.get_session_user(session_id)


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True}


@app.post("/api/auth/login", response_model=AuthUserResponse)
async def login(request: LoginRequest, response: Response) -> AuthUserResponse:
    try:
        user = auth_service.authenticate(request.email, request.password)
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    response.set_cookie(
        key=session_cookie_name(),
        value=auth_service.create_session(user),
        httponly=True,
        samesite="lax",
        secure=cookie_secure_enabled(),
        max_age=session_ttl_seconds(),
        path="/",
    )
    return auth_user_response(user)


@app.get("/api/auth/me", response_model=AuthUserResponse)
async def me(user: AuthenticatedUser = Depends(get_current_user)) -> AuthUserResponse:
    return auth_user_response(user)


@app.post("/api/auth/logout")
async def logout(request: Request, response: Response) -> dict:
    auth_service.delete_session(request.cookies.get(session_cookie_name()))
    response.delete_cookie(key=session_cookie_name(), path="/")
    return {"ok": True}


@app.get("/api/slaves", response_model=list[SlaveInfo])
async def list_slaves(_user: AuthenticatedUser = Depends(get_current_user)) -> list[SlaveInfo]:
    return registry.list_slaves()


async def _refresh_slave_activity(slave_id: str) -> SlaveInfo | None:
    try:
        result = await hub.activity_request(slave_id) if hub.is_online(slave_id) else {"robotRunning": False}
    except Exception:
        result = {"robotRunning": False}
    registry.update_activity(slave_id, bool(result.get("robotRunning")), str(result.get("runId", "")))
    return registry.get(slave_id)


@app.post("/api/slaves/{slave_id}/lock", response_model=SlaveInfo)
async def lock_slave(slave_id: str, request: LockRequest, user: AuthenticatedUser = Depends(get_current_user)) -> SlaveInfo:
    try:
        return registry.lock(slave_id, user.display_name, user.email, request.manualHoldReason)
    except KeyError:
        raise HTTPException(status_code=404, detail="slave not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.delete("/api/slaves/{slave_id}/lock", response_model=SlaveInfo)
async def unlock_slave(slave_id: str, user: AuthenticatedUser = Depends(get_current_user)) -> SlaveInfo:
    try:
        slave = registry.unlock(slave_id, user.email)
    except KeyError:
        raise HTTPException(status_code=404, detail="slave not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    # 释放 = 放弃该 slave：拆掉其全部 PTY，维持单写者不变量。
    await hub.close_slave_sessions(slave_id)
    return slave


@app.post("/api/slaves/{slave_id}/lock/takeover", response_model=SlaveInfo)
async def takeover_slave(slave_id: str, request: TakeoverRequest, user: AuthenticatedUser = Depends(get_current_user)) -> SlaveInfo:
    slave = registry.get(slave_id)
    if not slave:
        raise HTTPException(status_code=404, detail="slave not found")
    was_running = slave.mode == "running" or slave.processSignal != "none"
    takeover_reason = request.reason.strip()
    close_reason = f"已被 {user.display_name} 强制接管"
    if takeover_reason:
        close_reason = f"{close_reason}：{takeover_reason}"
    # 先杀前持有人全部 session（杜绝双写者），再转锁。
    await hub.close_slave_sessions(slave_id, close_reason)
    try:
        prev_holder, prev_holder_email, slave = registry.takeover(slave_id, user.display_name, user.email, takeover_reason)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    AUDIT.append({
        "ts": datetime.now(timezone.utc).isoformat(),
        "action": "takeover",
        "slaveId": slave_id,
        "from": prev_holder,
        "fromEmail": prev_holder_email,
        "to": user.display_name,
        "toEmail": user.email,
        "reason": takeover_reason,
        "wasRunning": was_running,
    })
    return slave


@app.get("/api/slaves/{slave_id}/audit")
async def list_audit(slave_id: str, _user: AuthenticatedUser = Depends(get_current_user)) -> dict:
    return {"entries": [item for item in AUDIT if item["slaveId"] == slave_id]}


@app.post("/api/slaves/{slave_id}/terminal/sessions", response_model=TerminalSessionResponse)
async def create_terminal_session(
    slave_id: str,
    mode: str = "reuse",
    cwd: str = "",
    user: AuthenticatedUser = Depends(get_current_user),
) -> TerminalSessionResponse:
    slave = registry.get(slave_id)
    if not slave:
        raise HTTPException(status_code=404, detail="slave not found")
    if not hub.is_online(slave_id):
        raise HTTPException(status_code=503, detail="agent offline")
    if not registry.can_write(slave_id, user.email):
        raise HTTPException(status_code=409, detail=f"slave is held by {slave.holder or 'another user'}")
    if mode not in {"reuse", "new"}:
        raise HTTPException(status_code=400, detail="terminal session mode must be reuse or new")
    if mode == "reuse":
        session = hub.find_reusable_terminal_session(slave_id, user.email)
        if session:
            return TerminalSessionResponse(id=session.session_id, slaveId=slave_id, shell=session.shell, readOnly=False)
    shell = "powershell.exe" if "windows" in slave.system.lower() else "/bin/bash"
    target_cwd = cwd.strip() or default_terminal_cwd(slave.allowedRoots)
    if not is_allowed_terminal_cwd(target_cwd, slave.allowedRoots):
        raise HTTPException(status_code=400, detail="terminal cwd is outside allowed roots")
    try:
        session = await hub.create_terminal_session(
            slave_id,
            shell=shell,
            cwd=target_cwd,
            holder=user.display_name,
            holder_email=user.email,
            reusable=mode == "reuse",
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return TerminalSessionResponse(id=session.session_id, slaveId=slave_id, shell=shell, readOnly=False)


@app.delete("/api/terminal/{session_id}")
async def close_terminal_session(session_id: str, user: AuthenticatedUser = Depends(get_current_user)) -> dict:
    session = hub.get_terminal_session(session_id)
    if session and session.holder_email and session.holder_email != user.email:
        raise HTTPException(status_code=403, detail="terminal session belongs to another user")
    await hub.close_terminal_session(session_id)
    return {"ok": True}


@app.websocket("/api/terminal/{session_id}")
async def terminal_ws(websocket: WebSocket, session_id: str) -> None:
    await websocket.accept()
    user = get_websocket_user(websocket)
    if not user:
        await websocket.send_json({"type": "error", "message": "authentication required"})
        await websocket.close()
        return
    session = hub.get_terminal_session(session_id)
    if not session:
        await websocket.send_json({"type": "error", "message": "terminal session not found"})
        await websocket.close()
        return
    if session.holder_email != user.email or not registry.can_write(session.slave_id, user.email):
        await websocket.send_json({"type": "error", "message": "terminal session belongs to another user"})
        await websocket.close()
        return
    queue: "asyncio.Queue[dict[str, str]]" = asyncio.Queue()
    for event in session.history_snapshot():
        queue.put_nowait(event)
    session.output_queues.add(queue)
    session.mark_attached()

    async def pump_output() -> None:
        while True:
            event = await queue.get()
            if event.get("type") == "closed":
                await websocket.send_json({"type": "closed", "message": event.get("message", "terminal session closed")})
                await websocket.close()
                break
            if event.get("type") == "cwd":
                await websocket.send_json({"type": "cwd", "data": event.get("data", "")})
                continue
            await websocket.send_json({"type": "output", "data": event.get("data", "")})

    output_task = asyncio.create_task(pump_output())
    try:
        while True:
            raw = await websocket.receive_text()
            message = json.loads(raw)
            msg_type = message.get("type")
            try:
                if msg_type == "input":
                    # 顺序 await：保证击键/resize 按到达顺序转发给 Agent，
                    # 不再用 fire-and-forget 的 create_task（多任务竞争 send_lock 会乱序）。
                    await hub.terminal_input(session_id, str(message.get("data", "")))
                elif msg_type == "resize":
                    await hub.terminal_resize(session_id, int(message.get("cols", 80)), int(message.get("rows", 24)))
                elif msg_type == "close":
                    await hub.close_terminal_session(session_id)
                    await websocket.close()
                    break
            except RuntimeError as exc:
                # Agent 掉线或会话已关闭：通知前端但不让整个 WS 崩溃。
                await websocket.send_json({"type": "error", "message": str(exc)})
    except WebSocketDisconnect:
        pass
    except RuntimeError as exc:
        if "WebSocket is not connected" not in str(exc):
            raise
    finally:
        output_task.cancel()
        session.output_queues.discard(queue)
        session.mark_detached()


@app.get("/api/slaves/{slave_id}/files", response_model=FileListResponse)
async def list_files(slave_id: str, path: str = Query("/"), user: AuthenticatedUser = Depends(get_current_user)) -> FileListResponse:
    payload = await _file_request(slave_id, "list", {"path": path}, user)
    return FileListResponse(**payload)


@app.get("/api/slaves/{slave_id}/files/read", response_model=FileReadResponse)
async def read_file(slave_id: str, path: str = Query(...), user: AuthenticatedUser = Depends(get_current_user)) -> FileReadResponse:
    payload = await _file_request(slave_id, "read", {"path": path}, user)
    return FileReadResponse(**payload)


@app.put("/api/slaves/{slave_id}/files/write")
async def write_file(slave_id: str, request: FileWriteRequest, user: AuthenticatedUser = Depends(get_current_user)) -> dict:
    return await _file_request(slave_id, "write", request.model_dump(), user)


@app.post("/api/slaves/{slave_id}/files/mkdir")
async def make_directory(slave_id: str, request: FileMkdirRequest, user: AuthenticatedUser = Depends(get_current_user)) -> dict:
    return await _file_request(slave_id, "mkdir", request.model_dump(), user)


async def _file_request(slave_id: str, action: str, payload: dict, user: AuthenticatedUser) -> dict:
    slave = registry.get(slave_id)
    if not slave:
        raise HTTPException(status_code=404, detail="slave not found")
    if not registry.can_write(slave_id, user.email):
        raise HTTPException(status_code=409, detail=f"slave is held by {slave.holder or 'another user'}")
    try:
        result = await hub.file_request(slave_id, action, payload)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@app.websocket("/api/agent/connect/{slave_id}")
async def agent_connect(
    websocket: WebSocket,
    slave_id: str,
    version: str = Query("swr-agent-dev"),
    pythonVersion: str = Query(""),
    robotVersion: str = Query(""),
) -> None:
    await websocket.accept()
    roots_header = websocket.query_params.get("roots", "")
    roots = [root for root in roots_header.split("|") if root]
    registry.mark_agent_online(slave_id, version, roots or None, pythonVersion, robotVersion)
    connection = hub.attach_agent(slave_id, websocket)
    try:
        while True:
            message = await websocket.receive_text()
            agent_status = await hub.handle_agent_message(connection, message)
            if agent_status and agent_status.get("type") == "agent.heartbeat":
                heartbeat_roots = agent_status.get("roots")
                roots_payload = heartbeat_roots if isinstance(heartbeat_roots, list) else None
                registry.mark_agent_seen(
                    slave_id,
                    version=str(agent_status.get("version") or ""),
                    allowed_roots=[str(root) for root in roots_payload] if roots_payload else None,
                    python_version=str(agent_status.get("pythonVersion") or ""),
                    robot_version=str(agent_status.get("robotVersion") or ""),
                )
            else:
                registry.mark_agent_seen(slave_id)
    except WebSocketDisconnect:
        pass
    finally:
        if hub.detach_agent(slave_id, connection):
            registry.mark_agent_offline(slave_id)


async def _poll_activity_once() -> None:
    for slave_id in hub.online_slave_ids():
        await _refresh_slave_activity(slave_id)


async def _activity_poll_loop() -> None:
    while True:
        await _poll_activity_once()
        await asyncio.sleep(ACTIVITY_POLL_INTERVAL)


async def _terminal_session_renew_loop() -> None:
    while True:
        for session in hub.list_terminal_sessions():
            if session.holder_email:
                registry.renew(session.slave_id, session.holder_email)
        await asyncio.sleep(LOCK_RENEW_INTERVAL)


async def _agent_health_loop() -> None:
    while True:
        for connection in hub.list_agent_connections():
            stale = hub.is_connection_stale(connection, AGENT_STALE_SECONDS)
            unhealthy = connection.request_failures >= AGENT_MAX_REQUEST_FAILURES
            if not stale and not unhealthy:
                continue
            reason = connection.last_error or "agent heartbeat stale"
            await hub.close_agent_connection(connection, reason)
            if hub.detach_agent(connection.slave_id, connection):
                registry.mark_agent_offline(connection.slave_id)
        await asyncio.sleep(AGENT_HEALTH_INTERVAL)


@app.on_event("startup")
async def _start_background_tasks() -> None:
    asyncio.create_task(_activity_poll_loop())
    asyncio.create_task(_terminal_session_renew_loop())
    asyncio.create_task(_agent_health_loop())

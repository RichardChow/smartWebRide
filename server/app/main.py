from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .agent_hub import AgentHub
from .models import FileListResponse, FileMkdirRequest, FileReadResponse, FileWriteRequest, LockRequest, SlaveInfo, TakeoverRequest, TerminalSessionResponse
from .slave_registry import SlaveRegistry

ACTIVITY_POLL_INTERVAL = 12
LOCK_RENEW_INTERVAL = 60

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

# 内存态审计（重启即丢，MVP 足够）：记录强制接管等高影响操作。
AUDIT: list[dict] = []


def default_terminal_cwd(roots: list[str]) -> str:
    for root in roots:
        normalized = root.replace("\\", "/").rstrip("/")
        if normalized.startswith("/home/") and normalized.count("/") == 2:
            return root
    return roots[0] if roots else "."


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True}


@app.get("/api/slaves", response_model=list[SlaveInfo])
async def list_slaves() -> list[SlaveInfo]:
    return registry.list_slaves()


@app.post("/api/slaves/{slave_id}/lock", response_model=SlaveInfo)
async def lock_slave(slave_id: str, request: LockRequest) -> SlaveInfo:
    try:
        return registry.lock(slave_id, request.holder, request.manualHoldReason)
    except KeyError:
        raise HTTPException(status_code=404, detail="slave not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.delete("/api/slaves/{slave_id}/lock", response_model=SlaveInfo)
async def unlock_slave(slave_id: str, holder: str = Query(...)) -> SlaveInfo:
    try:
        slave = registry.unlock(slave_id, holder)
    except KeyError:
        raise HTTPException(status_code=404, detail="slave not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    # 释放 = 放弃该 slave：拆掉其全部 PTY，维持单写者不变量。
    await hub.close_slave_sessions(slave_id)
    return slave


@app.post("/api/slaves/{slave_id}/lock/takeover", response_model=SlaveInfo)
async def takeover_slave(slave_id: str, request: TakeoverRequest) -> SlaveInfo:
    slave = registry.get(slave_id)
    if not slave:
        raise HTTPException(status_code=404, detail="slave not found")
    was_running = slave.mode == "running" or slave.processSignal != "none"
    takeover_reason = request.reason.strip()
    close_reason = f"已被 {request.newHolder} 强制接管"
    if takeover_reason:
        close_reason = f"{close_reason}：{takeover_reason}"
    # 先杀前持有人全部 session（杜绝双写者），再转锁。
    await hub.close_slave_sessions(slave_id, close_reason)
    try:
        prev_holder, slave = registry.takeover(slave_id, request.newHolder, takeover_reason)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    AUDIT.append({
        "ts": datetime.now(timezone.utc).isoformat(),
        "action": "takeover",
        "slaveId": slave_id,
        "from": prev_holder,
        "to": request.newHolder,
        "reason": takeover_reason,
        "wasRunning": was_running,
    })
    return slave


@app.get("/api/slaves/{slave_id}/audit")
async def list_audit(slave_id: str) -> dict:
    return {"entries": [item for item in AUDIT if item["slaveId"] == slave_id]}


@app.post("/api/slaves/{slave_id}/terminal/sessions", response_model=TerminalSessionResponse)
async def create_terminal_session(slave_id: str, holder: str = Query(...)) -> TerminalSessionResponse:
    slave = registry.get(slave_id)
    if not slave:
        raise HTTPException(status_code=404, detail="slave not found")
    if not hub.is_online(slave_id):
        raise HTTPException(status_code=503, detail="agent offline")
    if not registry.can_write(slave_id, holder):
        raise HTTPException(status_code=409, detail=f"slave is held by {slave.holder or 'another user'}")
    shell = "powershell.exe" if "windows" in slave.system.lower() else "/bin/bash"
    cwd = default_terminal_cwd(slave.allowedRoots)
    try:
        session = await hub.create_terminal_session(slave_id, shell=shell, cwd=cwd, holder=holder)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return TerminalSessionResponse(id=session.session_id, slaveId=slave_id, shell=shell, readOnly=False)


@app.delete("/api/terminal/{session_id}")
async def close_terminal_session(session_id: str) -> dict:
    await hub.close_terminal_session(session_id)
    return {"ok": True}


@app.websocket("/api/terminal/{session_id}")
async def terminal_ws(websocket: WebSocket, session_id: str) -> None:
    await websocket.accept()
    session = hub.get_terminal_session(session_id)
    if not session:
        await websocket.send_json({"type": "error", "message": "terminal session not found"})
        await websocket.close()
        return
    queue: "asyncio.Queue[dict[str, str]]" = asyncio.Queue()
    session.output_queues.add(queue)

    async def pump_output() -> None:
        while True:
            event = await queue.get()
            if event.get("type") == "closed":
                await websocket.send_json({"type": "closed", "message": event.get("message", "terminal session closed")})
                await websocket.close()
                break
            await websocket.send_json({"type": "output", "data": event.get("data", "")})

    async def renew_lock() -> None:
        # 终端 WS 活跃才续租：连接期间持续推后锁过期，断开即停 → 过 TTL 自动空闲（Q2）。
        while True:
            registry.renew(session.slave_id, session.holder)
            await asyncio.sleep(LOCK_RENEW_INTERVAL)

    output_task = asyncio.create_task(pump_output())
    renew_task = asyncio.create_task(renew_lock())
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
    finally:
        output_task.cancel()
        renew_task.cancel()
        session.output_queues.discard(queue)


@app.get("/api/slaves/{slave_id}/files", response_model=FileListResponse)
async def list_files(slave_id: str, path: str = Query("/")) -> FileListResponse:
    payload = await _file_request(slave_id, "list", {"path": path})
    return FileListResponse(**payload)


@app.get("/api/slaves/{slave_id}/files/read", response_model=FileReadResponse)
async def read_file(slave_id: str, path: str = Query(...)) -> FileReadResponse:
    payload = await _file_request(slave_id, "read", {"path": path})
    return FileReadResponse(**payload)


@app.put("/api/slaves/{slave_id}/files/write")
async def write_file(slave_id: str, request: FileWriteRequest) -> dict:
    return await _file_request(slave_id, "write", request.model_dump())


@app.post("/api/slaves/{slave_id}/files/mkdir")
async def make_directory(slave_id: str, request: FileMkdirRequest) -> dict:
    return await _file_request(slave_id, "mkdir", request.model_dump())


async def _file_request(slave_id: str, action: str, payload: dict) -> dict:
    slave = registry.get(slave_id)
    if not slave:
        raise HTTPException(status_code=404, detail="slave not found")
    try:
        result = await hub.file_request(slave_id, action, payload)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@app.websocket("/api/agent/connect/{slave_id}")
async def agent_connect(websocket: WebSocket, slave_id: str, version: str = Query("swr-agent-dev")) -> None:
    await websocket.accept()
    roots_header = websocket.query_params.get("roots", "")
    roots = [root for root in roots_header.split("|") if root]
    registry.mark_agent_online(slave_id, version, roots or None)
    connection = hub.attach_agent(slave_id, websocket)
    try:
        while True:
            message = await websocket.receive_text()
            await hub.handle_agent_message(connection, message)
    except WebSocketDisconnect:
        pass
    finally:
        if hub.detach_agent(slave_id, connection):
            registry.mark_agent_offline(slave_id)


async def _poll_activity_once() -> None:
    for slave_id in hub.online_slave_ids():
        try:
            result = await hub.activity_request(slave_id)
        except Exception:
            result = {"robotRunning": False}
        registry.update_activity(slave_id, bool(result.get("robotRunning")), str(result.get("runId", "")))


async def _activity_poll_loop() -> None:
    while True:
        await _poll_activity_once()
        await asyncio.sleep(ACTIVITY_POLL_INTERVAL)


@app.on_event("startup")
async def _start_background_tasks() -> None:
    asyncio.create_task(_activity_poll_loop())

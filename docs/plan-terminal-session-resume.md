# Plan - 刷新/关闭后的可恢复终端会话

> Phase 2 Planning。本计划只修 terminal session 生命周期；不动 SFTP、同屏分屏、颜色高亮、Agent PTY 内部、文件编辑、强制接管 UI。

## 实现路径

1. `server/app/agent_hub.py`
   - 给 `TerminalSession` 增加内存态历史 buffer 和 attach 时间字段。
   - 在 `terminal.output` / `terminal.cwd` 到达 Center 时，先写入 session buffer，再 fan-out 给当前浏览器 queue。
   - 增加按 `(slave_id, holder)` 查找可恢复 session 的方法。
   - 增加列出全部 session 的只读方法，供 Center 后台续租使用。
   - 保持 `close_terminal_session` 和 `close_slave_sessions` 的破坏性语义不变。

2. `server/app/main.py`
   - `POST /api/slaves/{slave_id}/terminal/sessions?holder=...` 先查可恢复 session；有则返回旧 session，没有才创建新 PTY。
   - `terminal_ws` attach 后先 replay session buffer，再接 live queue。
   - `terminal_ws` 断开时只 detach 当前浏览器 queue，不再因最后一个 queue 断开而关闭 PTY。
   - 增加后台 session 锁续租循环：只要 Center 仍持有该用户 live terminal session，就继续 `registry.renew(slave_id, holder)`。

3. `src/components/TerminalView.tsx`
   - 保持当前调用 `createTerminalSession` 的入口不变，让后端复用旧 session，避免新增 UI 或新增前端 API。
   - WebSocket 收到 history replay 时继续按现有 `output` / `cwd` 处理，不新增消息类型。
   - 不改 `+` 分屏、SFTP、RemoteFileEditor、xterm resize 防抖逻辑。

4. 测试
   - 后端测试覆盖：
     - output/cwd 写入 buffer，attach 可 replay；
     - 按 holder 复用同 slave 的 session；
     - `close_slave_sessions` 仍会关闭目标 slave session 并通知浏览器 reason。
   - 前端测试保持现有 TerminalView 行为不变：仍调用 `createTerminalSession`，由后端负责复用。

## 需要修改/新增的文件路径

- `server/app/agent_hub.py`
- `server/app/main.py`
- `server/tests/test_agent_hub.py`
- `docs/research-terminal-session-resume.md`
- `docs/plan-terminal-session-resume.md`

不计划修改：

- `agent/swr_agent/*`
- `src/components/SftpSidebar.tsx`
- `src/components/RemoteFileEditor.tsx`
- `src/styles.css`
- `src/App.tsx`
- `src/lib/terminalApi.ts`

## 关键代码片段

`AgentHub` 侧复用 session：

```python
def find_reusable_terminal_session(self, slave_id: str, holder: str) -> TerminalSession | None:
    candidates = [
        session for session in self._sessions.values()
        if session.slave_id == slave_id and session.holder == holder
    ]
    return max(candidates, key=lambda session: session.created_at, default=None)
```

`terminal_ws` 断开改为 detach：

```python
finally:
    output_task.cancel()
    session.output_queues.discard(queue)
    session.mark_detached()
```

后台续租从浏览器 WS 迁到 live session：

```python
async def _terminal_session_renew_loop() -> None:
    while True:
        for session in hub.list_terminal_sessions():
            if session.holder:
                registry.renew(session.slave_id, session.holder)
        await asyncio.sleep(LOCK_RENEW_INTERVAL)
```

## 权衡取舍

- 方案 A：新增 `GET /terminal/sessions` 查询接口，再由前端决定复用。
  - 优点：契约更显式。
  - 缺点：需要新增前端 API 和状态分支，改动面更大。

- 方案 B：复用现有 `POST /terminal/sessions`，后端内部先返回已有 session。
  - 优点：前端几乎不动，最符合“其他功能不要动”。
  - 缺点：`POST` 语义从“总是创建”变成“获取或创建”。
  - 本次选择：方案 B。

- Buffer 方案 A：只保留 chunk 数，例如 5,000 个 chunk。
  - 优点：实现简单。
  - 缺点：如果单 chunk 很大，内存不可控。

- Buffer 方案 B：同时限制 chunk 数和总字节数。
  - 优点：内存更可控。
  - 缺点：代码略多。
  - 本次选择：方案 B，默认最多 5,000 chunk 且约 2 MB。

## 风险与验证

- 风险：用户关闭浏览器但不释放 Slave，会保留 PTY 和锁。
  - 控制：本轮只保留内存态 session；Center/Agent 重启后仍会清空。未来再单独设计 detached expiry。

- 风险：多标签 attach 同一个 session 时都能输入。
  - 控制：本轮不新增多标签写入治理，行为与同一 session 多浏览器 queue 的现有模型一致；如需唯一写入，另起设计。

- 风险：history replay 与 live output 顺序错乱。
  - 控制：attach 时先把 snapshot 放入该 queue，再启动 pump；后续 live output 进入同一 queue。

- 验证命令：
  - `npm.cmd run typecheck`
  - `npm.cmd run test -- --run src/components/TerminalView.test.tsx`
  - `npm.cmd run test:py`
  - `npm.cmd run build`

## 接口保护清单

- 不改 REST 路径。
- 不改 Agent message 名称和 payload。
- 不改文件 API schema。
- 不改 `buildTerminalWsUrl(sessionId)`。
- 不改 `createTerminalSession(slaveId, holder)` 前端函数签名。
- 不改 `TerminalView` 的同屏分屏 props/state 结构。
- 不改 `registry.can_write(slave_id, holder)` 调用契约。

## 优雅性复核

- 更简单路径：只删除 `terminal_ws finally` 里的 `close_terminal_session`。
  - 结论：不够。虽然 PTY 不会被杀，但刷新后前端没有 session id，也无法恢复输出。

- 更小改动路径：只把 session id 放入 `sessionStorage`。
  - 结论：不够。跨浏览器关闭后恢复不可靠，且无法解决输出历史。

- 当前路径：后端 get-or-create + 内存 buffer。
  - 结论：改动集中在 Center terminal session 生命周期，前端保持原入口，是当前最窄可行方案。

## Checklist

- [x] 文档：中文 research 与 plan 落盘。
  - 验证：文件内容为中文，范围清晰。
- [x] 后端：`TerminalSession` 增加 bounded history 与 attach/detach 元数据。
  - 验证：单测可断言 history snapshot。
- [x] 后端：`POST /terminal/sessions` 复用当前 holder 的 live session。
  - 验证：同一 holder 重复请求返回相同 session id。
- [x] 后端：WebSocket detach 不销毁 PTY，attach replay history。
  - 验证：单测覆盖 output/cwd buffer 与 queue replay。
- [x] 后端：live terminal session 后台续租锁。
  - 验证：Python 单测或现有 registry renew 测试保持通过。
- [x] 验证：运行 typecheck、TerminalView 测试、Python 测试、build。
  - 验证：全部通过；VM1 runtime smoke 已确认同一 holder 复用 session id 且 history replay 命中 marker，释放后 vm1/vm2 回到 idle。

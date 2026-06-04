# Research - 刷新/关闭后的可恢复终端会话

> Phase 1 Research only。此阶段不实现。已深度阅读 Center registry、AgentHub 终端 session 存储、浏览器 WebSocket attach 生命周期、前端 TerminalView 创建流程、Agent PTY 行为及其细节。

## 问题

- 当前认可的产品方向已经不同于 `docs/research-session-lifecycle.md`：浏览器刷新、F5 或误关浏览器，不应该自动销毁用户的终端 session。
- 终端 console 输出属于 Robot/debug 上下文的一部分。页面刷新后，新页面应该能重新 attach，并恢复最近的 console 输出。
- 显式动作仍保持现有语义：关闭 terminal session、释放 Slave、强制接管，仍是销毁/清理点。
- 如果浏览器消失后 Robot/debug 进程仍在运行，Slave 应继续显示上一个 holder，并提示进程仍在运行。
- 本任务不触碰其他 SmartSSH 功能：SFTP、同屏分屏、颜色高亮、占用标签、强制接管、文件编辑都不在范围内。

## 当前实现事实

- `src/components/TerminalView.tsx` 进入可写 slave 且本地没有 tab 时，总是调用 `createTerminalSession(slaveId, currentUser)`。
- 前端没有 resume/list API。F5 后 React state 丢失，前端不知道旧的 Center `session_id`。
- `server/app/main.py::create_terminal_session` 总是通过 `hub.create_terminal_session` 创建新的 Agent PTY。
- `server/app/main.py::terminal_ws` 把浏览器 WebSocket 生命周期当成终端 session 生命周期。`finally` 中移除浏览器 queue 后，如果没有 queue，会调用 `hub.close_terminal_session(session_id)`。
- `server/app/agent_hub.py::TerminalSession` 目前只保存 `session_id`、`slave_id`、`agent_session_id`、`shell`、`holder`、`output_queues`。
- `AgentHub` 当前没有 output history buffer、attached-client 计数、last-attached 时间，也没有按 holder 查找可恢复 session 的能力。
- `AgentHub.close_terminal_session` 会移除 Center session，并向 Agent 发送 `terminal.close`，从而销毁远端 PTY。
- `AgentHub.close_slave_sessions` 被释放/接管复用，用于关闭某个 slave 的全部 PTY。这个破坏性行为应保持不变。
- 锁续租目前在浏览器 terminal WebSocket task 中。若浏览器断开后 session 继续保留，锁续租语义需要迁移或重新定义。

## 当前状态流

1. 用户进入 idle 或当前账号已占用的 slave。
2. 前端创建 terminal session。
3. Center 打开 Agent PTY，并在内存中保存 `TerminalSession`。
4. 浏览器 attach 到 `/api/terminal/{session_id}`。
5. Agent 发送 `terminal.output`；Center 只 fan-out 给当前已 attach 的浏览器 queue。
6. 浏览器刷新导致 WebSocket 关闭。
7. 当前代码移除最后一个 queue，关闭 Center session，发送 `terminal.close` 给 Agent，并丢失 console 输出。
8. 新页面不知道旧 session id，只能创建新的 PTY。

## 目标状态流

1. 用户进入 idle 或当前账号已占用的 slave。
2. 前端按 `(slaveId, holder)` 请求一个可恢复 terminal session。
3. Center 若存在该用户的 live session，则返回旧 session；否则才创建新 PTY。
4. 浏览器 WebSocket attach 只代表视图连接，不代表 PTY 生命周期。
5. attach 后，Center 先 replay 最近 buffer，再继续推 live output。
6. 浏览器刷新或误关只 detach，不关闭 PTY。
7. 显式关闭、释放、强制接管仍关闭 Center session 和 Agent PTY。
8. 如果 Robot/debug 进程仍活跃，`/api/slaves` 继续报告之前的 holder 和 running 状态。

## 边界决策

浏览器 attach/detach 必须与 terminal/PTTY 生命周期分离：

- Detach：浏览器 WebSocket 关闭，只移除当前 queue。
- Resume：浏览器用已有 Center session 重新打开 WebSocket，并接收历史输出。
- Destroy：显式关闭 terminal、释放 Slave、强制接管、Agent 断开，或未来明确的过期策略。

这是生命周期修正，不是 UI 重设计。

## 候选契约补充

仅作为研究结论，具体实现以 plan 为准。

- 给 `TerminalSession` 增加可恢复元数据：`created_at`、`last_attached_at`、`last_detached_at`、`output_buffer`、`cwd`，必要时增加 `closed_reason`。
- 增加按当前 holder 复用 session 的 API，例如：
  - `GET /api/slaves/{slave_id}/terminal/sessions?holder=Humphrey`
  - 或让 `POST /api/slaves/{slave_id}/terminal/sessions?holder=Humphrey` 在创建前优先返回已有 session。
- terminal WebSocket attach 时，服务端先发送 history，再发送 live output。
- `DELETE /api/terminal/{session_id}` 保持破坏性关闭。
- `DELETE /api/slaves/{slave_id}/lock` 继续通过 `hub.close_slave_sessions` 做破坏性释放。

## 接口保护清单

本任务不允许改变以下行为：

- `hub.close_slave_sessions(slave_id, reason)` 仍是释放/接管时的清理路径。
- `hub.close_terminal_session(session_id, reason)` 在显式调用时仍是破坏性关闭。
- `/api/slaves/{slave_id}/files*` 文件 API 不动。
- Agent 文件、PTY input、resize、cwd、颜色高亮行为不动。
- 同屏分屏 `+` 行为不动。
- `registry.can_write(slave_id, holder)` 仍是写权限判断入口。
- 本轮不引入数据库或持久化存储，除非 Humphrey 明确扩大范围。

## 风险

- PTY 泄漏：detached session 未来需要明确过期策略，否则误关浏览器会留下长期 shell。
- 锁续租：如果浏览器 WS 不再承担 session 生命周期，续租不能只依赖浏览器 attach。
- 输出内存：console history 必须按 chunk 数或字节数设上限。
- 多标签 attach：两个浏览器标签可能 attach 同一个 session。可以允许同时查看，但是否都能输入需要控制。
- Agent 重连：当前 `detach_agent` 会丢弃该 slave 的 Center session。若 Agent 重启，除非做 Agent 侧持久化，否则无法恢复旧 PTY。
- Robot 前台进程：如果 Robot 跑在 PTY 前台，浏览器关闭后保留 PTY 会保留该进程；显式释放/接管仍会终止它。

## 待确认问题

- detached shell 的过期时间：30 分钟、2 小时，还是直到释放前永不过期？
- buffer 大小：保留最近 5,000 个 chunk、最近 2 MB，还是其他上限？
- 恢复交互：进入当前账号占用的 slave 时自动 reattach，还是先显示“继续终端”选择？
- 重复 attach：第二个 tab 应该可读写、只读，还是抢占唯一可写 attach？

## 回滚点

- 恢复 `terminal_ws` 最后一个连接断开即关闭 session 的行为。
- 移除 session lookup/reuse API 或复用分支。
- 删除 output buffer，回到只 fan-out live queue。
- 改动集中在 Center/frontend session 生命周期文件，避免影响 SFTP、同屏分屏和 Agent 终端内部逻辑。

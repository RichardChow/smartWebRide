# Research: 首页 hero 图接入与预览路径

## 0. 研究范围

本轮只做调研与候选资产保存，不替换当前首页，不改运行代码，不改 Center/Agent/Terminal 行为。

需要 deeply / in great details 阅读并确认：

- 当前首页入口、状态流和组件边界。
- 生成 hero 图是否适合作为 smartWebRide 入口视觉。
- 如何让 Humphrey 看到新效果，同时保存当前项目现状。
- 后续若进入实现，应走哪个预览路径，避免直接覆盖默认首页。

## 1. 当前项目现状快照

- 当前基线 commit：`e02aca1`。
- 当前分支：`main`，本地领先 `origin/main` 1 个 commit。
- 当前工作区：无未提交代码改动；`docs/` 与 `rules/` 被 `.gitignore` 忽略。
- 当前首页入口：`src/App.tsx` 默认 `activeView === 'slaves'` 时渲染 `SlaveStatusHome`。
- 当前首页组件：`src/components/SlaveStatusHome.tsx`。
- 当前首页样式：`src/styles.css` 中 `.slave-status-home`、`.slave-command-band`、`.slave-card`、`.slave-policy-line` 等样式段。
- 当前首页产品定位：只做 Slave 状态入口，保留“选择调试环境”工作流，不暴露 RIDE Workspace、项目选择或营销式 landing。

本轮候选图已保存：

- 源图：`C:\Users\Administrator\.codex\generated_images\019e9789-173b-7a51-92a6-d5b7b67ec820\ig_0b7d5095aedcd961016a276e5a5fdc81949976277e2423d0a7.png`
- 项目本地调研副本：`docs/assets/smartwebride-hero-candidate-20260609.png`
- 尺寸：`1672 x 941`，约 16:9，适合 hero 背景或预览背景。

## 2. 当前首页关键调用链路

### 2.1 数据流

`App.tsx`

1. 初始化 `slaveSessions`，优先使用 `src/data/mockRuntime.ts`。
2. 当 `activeView === 'slaves'` 时轮询 `listSlaves()`。
3. 将 `sessions/currentUser/statusMessage/onEnterSlave/onReleaseSlave/onForceTakeover` 传给 `SlaveStatusHome`。
4. 用户点“连接终端/继续终端/查看状态”后，`App.enterSlave()` 决定是否锁定 slave 并切换到 terminal。
5. 用户点“释放 Slave”后，`App.releaseSlaveLock()` 切回首页并释放锁。
6. 用户强制接管时，`App.forceTakeoverSlave()` 以 API 返回状态为权威并进入 terminal。

### 2.2 状态流约束

- 首页不是静态 landing，它是调试环境选择控制台。
- 默认 `/` 必须保持可用，不能为了 hero 图牺牲密度和可扫描性。
- `SlaveStatusHome` 的按钮语义不能改：
  - 空闲：连接终端。
  - 当前账号持锁：继续终端 / 释放 Slave。
  - 他人占用：查看状态 / 强制接管。
  - 离线：不可连接。
- `TerminalView` 与 `TerminalSessionPane` 不应因首页视觉实验受影响。

## 3. 视觉适配判断

生成图优点：

- 氛围符合 smartWebRide 当前方向：Web SSH、VM slave、Robot Framework debug、运维控制台。
- 16:9 构图适合第一屏背景，且左上有较多可放标题的空间。
- 深色控制台视觉能强化“调试环境入口”，比纯白表格更有产品感。

需要控制的风险：

- 不能把入口页改成营销 hero。用户来这里是选 slave，不是读产品介绍。
- 背景图有较强视觉信息，如果直接铺满默认首页，可能降低 slave 卡片可读性。
- 当前首页已经是信息密度较高的运维控制台，hero 图只能作为背景气氛或预览页引导，不能压过操作区。
- 生成图包含伪 UI 文本，不能让它与真实按钮、状态、版本号混淆。

## 4. 推荐方案

### 方案 A：直接把图接入当前默认首页

做法：

- 将图片移入 `src/assets/hero/` 或 `public/assets/`。
- 在 `.slave-command-band` 或 `.slave-status-home` 加背景图。
- 当前 `/` 直接变为带图首页。

优点：

- 改动少，立刻能看到效果。

缺点：

- 直接影响当前稳定入口。
- 如果视觉不满意，需要回滚默认首页。
- 与“等 Humphrey 看效果同意后再完全加入项目”的要求冲突。

结论：不推荐本轮采用。

### 方案 B：新增预览路径 `/preview/home-hero`（推荐）

做法：

- 保留当前 `/` 不变。
- 新增 `HomeHeroPreview` 或 `SlaveStatusHomeHeroPreview` 组件。
- 在 `App.tsx` 最外层根据 `window.location.pathname === '/preview/home-hero'` 渲染预览版首页。
- 预览版复用同一批 `sessions/currentUser/statusMessage/onEnterSlave/...` props，确保按钮和数据流仍走真实逻辑。
- 预览版只改首屏视觉编排：hero 图作为背景或上半屏视觉层，Slave 卡片仍可扫描。

优点：

- 当前首页现状被保存。
- Humphrey 可以打开独立 URL 看效果。
- 预览版如果不满意，删除路径即可，不影响 `/`。
- 复用真实数据与按钮回调，比纯静态 mock 更接近最终体验。

缺点：

- 需要新增一个组件和少量 `App.tsx` path 判断。
- 需要补测试覆盖默认 `/` 不变、预览路径可渲染。

结论：推荐作为下一步 implementation plan。

### 方案 C：只做静态 HTML / 图片说明页

做法：

- 在 `docs/` 放静态说明或截图，不改前端项目。

优点：

- 完全不影响项目代码。

缺点：

- 看不到真实数据、按钮、响应式效果。
- 不能验证图和当前 Slave 卡片是否协调。

结论：只适合作为本轮 research，不适合作为下一步验收。

## 5. 推荐预览页设计方向

预览页仍然应该是“环境选择控制台”，不是“产品首页”。

建议布局：

1. 顶部保留现有 `topbar`。
2. `/preview/home-hero` 内部使用深色第一屏 band。
3. hero 图作为右侧或全宽背景层，叠加低透明度遮罩，避免干扰真实状态文本。
4. 左侧标题仍是 `选择调试 Slave`，文案保持短：
   - `选择一台可用 slave，进入 Web SSH 调试 Robot Framework。`
5. 状态统计放在 hero band 内，但必须保持可读。
6. Slave 卡片列表仍是主工作区，不放到玻璃大卡片里，不做嵌套卡片。
7. 移动端不强行展示大图；建议图做淡背景或裁切到上方，卡片优先。

## 6. 接口保护清单

预览方案不允许改动：

- `/api/slaves`
- `/api/slaves/{slave_id}/lock`
- `/api/slaves/{slave_id}/terminal/sessions`
- `/api/terminal/{session_id}`
- `SlaveSession` 数据结构，除非后续有明确新字段需求。
- `TerminalView` / `TerminalSessionPane` 生命周期。
- `onEnterSlave` / `onReleaseSlave` / `onForceTakeover` 调用语义。
- 默认 `/` 首页行为。

允许改动：

- 新增预览组件。
- 新增预览样式。
- 新增 hero 图片 asset。
- `App.tsx` 增加只读 pathname 分支，用于选择默认首页或预览首页。

## 7. 风险点与回滚点

风险点：

- hero 图压低信息可读性。
- 预览路径误改默认首页。
- `App.tsx` pathname 分支让测试变复杂。
- 图片进入 bundle 后增加体积。

回滚点：

- 删除预览组件和样式。
- 删除 hero asset。
- 删除 `App.tsx` pathname 分支。
- 默认 `/` 不变，因此不需要回滚业务流程。

## 8. 验证建议

如果进入下一步计划和实现，至少验证：

- `npm.cmd run typecheck`
- `npm.cmd run test -- --run src/App.test.tsx src/components/SlaveStatusHome.test.tsx`
- `npm.cmd run test -- --run`
- `npm.cmd run build`
- Browser 验证：
  - `/` 仍是当前首页。
  - `/preview/home-hero` 显示新视觉预览。
  - 1280x720 无遮挡。
  - 390x844 无横向溢出，slave 卡片优先可读。

## 9. 结论

这张 hero 图适合 smartWebRide，但不应直接接入默认首页。

推荐下一阶段新增 `/preview/home-hero` 预览路径，复用真实 `SlaveStatusHome` 数据流和操作回调，在预览路径中实验 hero 图与新首屏视觉。Humphrey 看过效果并确认后，再把预览方案收敛进默认 `/` 首页；若不满意，删除预览路径即可，不影响当前项目状态。

## 10. 后续反馈归档（2026-06-09）

Humphrey 已确认该方向仍未达到当前目标，不作为现阶段默认首页方案。

保留策略：

- `/preview/home-hero` 保留为备用探索页。
- 当前默认 `/` 首页不变。
- 该探索页可作为未来真实 smart ride / smart RIDE 工作台方向的视觉参考。
- 后续若继续开发真实 smart ride 首页，应重新规划信息架构，而不是简单把本预览页合入默认首页。

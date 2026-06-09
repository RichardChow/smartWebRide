# Plan: 首页 hero 图预览路径

## 0. 当前结论（2026-06-09）

Humphrey 视觉反馈：当前预览仍未达到“真实 smart ride 首页”的目标。

处理决定：

- 保留 `/preview/home-hero`，作为后续真实 smart ride 方向的备用探索页。
- 不把该预览页合入默认 `/` 首页。
- 默认 `/` 继续使用当前稳定的 Slave 状态入口。
- 本次提交只保存探索页、候选图和文档，方便后续继续迭代或删除。

## 1. 实现路径

目标：把生成的 hero 图做成可浏览的预览首页，但不替换默认 `/` 首页。

1. 保存项目可引用资产。
   - 从 `docs/assets/smartwebride-hero-candidate-20260609.png` 复制到 `src/assets/smartwebride-hero-candidate-20260609.png`。
   - 这样 Vite 可以通过 import 引用图片。

2. 新增预览组件。
   - 新增 `src/components/HomeHeroPreview.tsx`。
   - 组件接收与 `SlaveStatusHome` 相同的关键 props：`sessions/currentUser/statusMessage/onEnterSlave/onReleaseSlave/onForceTakeover`。
   - 预览页只改变视觉首屏，真实 Slave 列表操作仍复用 `SlaveStatusHome`。

3. 新增预览路径。
   - 在 `App.tsx` 读取 `window.location.pathname`。
   - 当路径是 `/preview/home-hero` 且 `activeView === 'slaves'` 时渲染 `HomeHeroPreview`。
   - 默认 `/` 继续渲染原 `SlaveStatusHome`。
   - 进入 terminal 后仍渲染原 `TerminalView`，不新增 terminal 预览行为。

4. 新增样式。
   - 在 `src/styles.css` 增加 `.home-hero-preview` 相关样式。
   - hero 图放在预览页上方，不遮盖 Slave 卡片文字。
   - 保持入口页是“选择调试 Slave”，不是营销 landing。
   - 移动端优先保证 slave 卡片可读，hero 图弱化为背景氛围。

5. 补测试。
   - `src/App.test.tsx` 覆盖默认 `/` 不显示 hero 预览文案。
   - 覆盖 `/preview/home-hero` 显示预览页，并仍可点击“连接终端”。
   - 不新增对 Center/Agent API 的测试范围。

## 2. 修改文件清单

- `src/assets/smartwebride-hero-candidate-20260609.png`
- `src/components/HomeHeroPreview.tsx`
- `src/App.tsx`
- `src/App.test.tsx`
- `src/styles.css`
- `docs/plan-home-hero-preview.md`

## 3. 关键代码片段

`App.tsx` 分支：

```tsx
const isHomeHeroPreview = window.location.pathname === '/preview/home-hero';
const HomeComponent = isHomeHeroPreview ? HomeHeroPreview : SlaveStatusHome;
```

预览组件：

```tsx
<section className="home-hero-panel">
  <img src={heroImage} alt="" aria-hidden="true" />
  <div>
    <p className="eyebrow">Preview / Web SSH Robot Debug</p>
    <h1>选择调试 Slave</h1>
  </div>
</section>
<SlaveStatusHome ... />
```

## 4. 方案取舍

### 方案 A：直接替换默认 `/`

优点：视觉改动最直接。

缺点：会破坏“先选环境”的稳定入口，也不符合 Humphrey 要先看效果再完全加入项目的要求。

### 方案 B：新增 `/preview/home-hero`（采用）

优点：默认首页不动；Humphrey 可以看真实数据效果；预览失败时删除路径即可。

缺点：多一个临时组件和 path 分支。

当前状态：已采用并保留，但暂不作为当前产品首页方案。

### 方案 C：只保留 research，不做可运行预览

优点：最保守。

缺点：Humphrey 看不到真实页面效果，无法判断是否同意完全加入项目。

## 5. 风险与验证

风险：

- 图片进入 bundle 后增大体积。
- 新 path 分支影响默认首页测试。
- 深色 hero 与现有白色卡片风格割裂。

验证：

- `npm.cmd run typecheck`
- `npm.cmd run test -- --run src/App.test.tsx src/components/SlaveStatusHome.test.tsx`
- `npm.cmd run test -- --run`
- `npm.cmd run build`
- Browser 验证：
  - `/` 仍显示默认首页，不出现预览 hero 文案。
  - `/preview/home-hero` 显示 hero 图和真实 slave 列表。
  - 1280x720 无遮挡。
  - 390x844 无横向溢出。

## 6. 接口保护清单

不允许改动：

- `/api/slaves`
- `/api/slaves/{slave_id}/lock`
- `/api/slaves/{slave_id}/terminal/sessions`
- `/api/terminal/{session_id}`
- `SlaveSession` schema
- `TerminalView` / `TerminalSessionPane` 生命周期
- 默认 `/` 首页语义
- `onEnterSlave` / `onReleaseSlave` / `onForceTakeover` 调用语义

允许改动：

- 新增预览组件。
- 新增预览路径。
- 新增预览样式。
- 新增 hero 图片 asset。

## 7. 优雅性复核

更简单的路径是把图片直接塞进 `SlaveStatusHome`，但这会让默认首页承担视觉实验风险。

当前方案只增加一个薄预览层，复用现有 `SlaveStatusHome` 和 App 数据流。它不是长期架构变化，而是一个审阅面；等 Humphrey 确认后，可以把预览层收敛成默认首页，也可以整段删除。

## 8. Checklist

- [x] T1 复制 hero 图片到 `src/assets/`。验证：build 能解析图片。
- [x] T2 新增 `HomeHeroPreview` 组件，复用 `SlaveStatusHome` 操作 props。验证：组件在预览路径渲染真实列表。
- [x] T3 `App.tsx` 增加 `/preview/home-hero` 分支，默认 `/` 不变。验证：App 测试。
- [x] T4 新增预览样式。验证：Browser 桌面/窄屏。
- [x] T5 补测试并跑完整验证。验证：typecheck/test/build 全绿。
- [x] T6 根据 Humphrey 反馈归档为备用探索页，不合入默认首页。验证：文档与预览页文案均标明备用。

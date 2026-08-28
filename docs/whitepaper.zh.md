# Loom 设计白皮书

**智能体时代的 Web 框架 —— 在 DeepSeek Harness 之上**

| | |
|---|---|
| 版本 | v0.1-draft |
| 日期 | 2026-08-15 |
| 状态 | 设计阶段（无实现代码；每条 API 均给出到内核机制的映射与验证状态） |
| 工作名 | Loom（织机：把会话之线织成界面之布。命名候选见附录 A） |
| 内核 | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`，v0.1 开发者预览） |

---

## 0. 摘要

Loom 是一个 TypeScript Web 框架，把**智能体（agent）作为 Web 应用的第一等公民**——就像 FastAPI 把"声明式路由 + 类型校验"带进 API 开发一样，Loom 把"声明式能力 + 事件溯源会话 + 界面投影"带进智能体应用开发。

一句话架构：

> **开发者声明能力（工具/智能体/投影/策略/通道），内核（DeepSeek Harness）执行并持久化一切，前端从会话事件流做类型化投影。**

它不与 DeepSeek Harness 并排造轮子。Harness 已经解决了最难的部分——微内核插件体系、append-only 会话日志、模型适配、工具管线、审批与权限、多智能体隔离。Loom 站在其上，补齐的只是**Web 开发者的声明式体验层**。

本白皮书的每一条 API 草案都附有"到 harness 机制的精确映射"。其中标注 ✅ 的映射路径已在我们完成的两个真实原型（shop-demo、gis-bridge，见 §7）中验证通过。

---

## 1. 问题定义

### 1.1 request/response 范式的三重不适配

传统 Web 框架（FastAPI/Express/Next.js API routes）的原子操作是 `请求 → 处理器 → 响应`。这个模型在智能体应用上有三处结构性断裂：

**时间尺度断裂。** HTTP 请求的生命周期是毫秒到秒；一个 agent 回合（turn）的生命周期是几十秒到几十分钟——多步推理、工具执行、人工审批都在其中。把长回合塞进请求生命周期，意味着刷新页面杀死任务、代理超时杀死任务、断网杀死任务。正确的心智模型是：**请求只是"投递一条意图"，回合在请求之外存活**。

**状态归属断裂。** REST 假设无状态，状态是应用自己往数据库里塞的附带品。Agent 有天然的、连续的、必须完整重建的状态——模型上下文。传统做法（聊天记录表 + 自己发明状态机）是在重新发明 harness 已经解决的问题：事件的顺序追加、表面的折叠投影、上下文的压缩、会话的分叉与恢复。这些不应该是每个应用的重造项目，而应该是框架的地基。

**权力模型断裂。** 传统 Web 的 auth 回答"谁可以调这个接口"。智能体应用需要回答的是："这个具体动作——修改这 3000 个商品描述、执行这段 shell、花掉这 5 块钱——**要不要人批准**"。粒度是工具级、参数级、预算级的，而且答案必须被持久记录（审计）。这不是中间件能补的，这是执行模型的一部分。

### 1.2 "四不像"解剖：一个真实案例

以我们亲手改造前的 AI-GIS 平台（Next.js 15 + OpenLayers + ECharts，本仓库之外的真实项目）为例：

- 界面专业：地图、图表面板、任务管理、三个"数字员工"选择器
- 聊天面板的"AI"是 `mockStreamResponse`——预先写死的文案，按 30ms/字模拟打字
- 地图、图表、任务列表与"AI"零连接——都是静态摆设

根因不是缺功能，是缺架构：**agent 被关在聊天框里**。它没有工具（碰不到业务数据）、没有事件流（页面看不到它在做什么）、没有会话（刷新即失忆）。这就是"传统 Web + Agent 四不像"的完整解剖。

改造后（§7 的 gis-bridge 原型）：同一句"查询地类占比并画饼图、聚焦最大村"，agent 依次调用 `gis_query_land_types` → `gis_render_pie_chart` → `gis_focus_map`，工具结果作为会话事件流回前端，饼图真实渲染、地图真实飞行、任务面板真实滚动。**界面没有为 AI 加一个假按钮，而是把界面的数据源换成了会话事件流。**这就是本白皮书要框架化的东西。

### 1.3 现有方案为什么都不彻底

- **UI 流式 SDK**（Vercel AI SDK 等）：把 agent 当"一段流式文本"，前端绑定到 token 流。token 流是呈现细节不是事实——刷新即丢、无法审计、工具副作用不可见。无持久会话，无权力模型。
- **编排框架**（Mastra、LangGraph.js）：解决"agent 怎么跑"（工作流、记忆、评测），不解决"Web 应用怎么以 agent 为中枢重组"。Web 层仍是传统框架 + 手写胶水，恰是四不像的病灶。
- **持久执行平台**（Temporal/Restate/Inngest）：架构思想最接近（事件溯源 + 重放），但没有模型/工具/审批词汇，DX 面向基础设施工程师，且把"业务能力"留在框架之外。

空位：**没有人把"声明式 Web DX"和"事件溯源的 agent 内核"焊接成一个整体。** Loom 补这个位。

---

## 2. 三个旁证：业界正在独立收敛到同一架构

以下三个方向互不相识，却在 2026 年指向同一组结论。

### 2.1 持久执行：事件溯源是 agent 的正确事务基座

Temporal 官方论述：agent 的执行历史就是"过去决策的记录"，事件历史 + 确定性重放让崩溃恢复、重试、检查点**隐式免费**（[Durable Execution meets AI](https://temporal.io/blog/durable-execution-meets-ai-why-temporal-is-the-perfect-foundation-for-ai)、[Of course you can build dynamic AI agents with Temporal](https://temporal.io/blog/of-course-you-can-build-dynamic-agents-with-temporal)）。

**Harness 已经内置了这一点，且更严格**：会话日志是唯一事实来源，"模型可见 ⟺ 已落日志"（`AGENTS.md:107`），并有运行时不变量在每次请求前断言请求可从日志逐字节重建（`packages/core/agent-loop/src/invariant.ts:21-54`）。Temporal 需要你自建工作流词汇；harness 的词汇（turn/step/tool-call/审批）就是为 agent 设计的。

### 2.2 服务端状态投影：LiveView 证明了"UI 不拥有状态"

Phoenix LiveView 的核心主张：状态唯一权威在服务端，前端经 WebSocket 接收投影（[Dashbit: client and server state](https://dashbit.co/blog/web-apps-have-client-and-server-state)）。它消灭了 SPA 最痛的状态同步双写。它的已知弱点是**断线重连**——视图 diff 无法自描述地恢复（[Software Mansion 的分析](https://swmansion.com/blog/the-problem-of-reconnects-in-phoenix-live-view/)）。

**Loom 的投影对象比视图 diff 更适合恢复**：会话事件的 `seq` 严格连续单调（`packages/core/session/src/index.ts:628-630`），断线重连 = `?since=<seq>` 重放。日志是自描述的权威，投影永远可以重建——LiveView 的重连难题在事件溯源面前消失。

### 2.3 生成式 UI：Vercel AI SDK 验证了产品形态，但路线不同

Vercel AI SDK 的 Generative UI（[官方文档](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces)）让 LLM 通过工具调用"生成界面"——方向正确：**界面动作应该来自工具调用**。但它走的是提示词级渲染（模型产出标记/组件选择），非确定性、不可回放。

**Loom 采用 harness 已验证的确定性路线**：工具返回 canonical JSON 值，UI 以"渲染意图卡片"（card intent：generic/terminal/diff/search/web，`docs/cookbook/adding-a-tool.md:71-83`）确定性投影。模型决定**调用什么**，不决定**怎么渲染**。同一份卡片描述在回放时逐像素重现——这是审计和调试的前提。

### 2.4 收敛点

| 旁证 | 贡献的结论 | Harness/Loom 对应 |
|---|---|---|
| Temporal | 事件历史 + 重放 = 免费持久化 | 会话日志 + deriveMessages |
| LiveView | 状态在服务端，UI 是投影 | session/event → 前端投影 |
| Generative UI | 界面动作来自工具调用 | tool/call 事件 + card intent |

---

## 3. 六条核心公理

以下公理继承自 harness 并升华为 Loom 的框架承诺。每条附内核出处。

**A1 一份声明，三张面孔。**
一次工具声明同时产出：模型可调用的工具 schema、带校验的 HTTP API、前端类型化客户端。就像 FastAPI 的一个装饰器同时产出路由 + 校验 + OpenAPI。内核基础：工具注册即入提示词装配（`docs/cookbook/adding-a-tool.md:38`），schema 白名单投影（`packages/core/tools/src/index.ts:1234-1267`）。

**A2 Transcript is the contract（会话记录即契约）。**
模型看到的一切必须能从会话日志重建。由此免费获得：时间旅行调试、完整审计、会话分叉、从真实会话抽评测集。出处：`AGENTS.md:107`、`.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md`。

**A3 UI 是日志的类型化投影。**
前端不拥有业务状态，只订阅会话事件的投影。刷新 = 重放；断线 = `since=seq` 续传；多端 = 同一日志的多个投影。出处：官方 UI 集成路径即此（`docs/architecture.md:121`"drive ctx.agents and render from session/event"）。

**A4 能力三件套（capability seam）。**
每个能力 = Service Definition（契约）+ Provider（实现）+ Consumer（消费，通常是模型可见工具）。换 provider 不动模型侧契约。出处：`docs/glossary.md:9`、`.agents/notes/implemented/architecture/2026-06-13-capability-seams.md`。Loom 的所有声明器都产出到 Service Definition 的依赖，永不绑具体 provider（`packages/README.md:67`）。

**A5 权力走口子，数据决定。**
干预执行只有固定数量的拦截点（`agent/pre-step`、`agent/request`、`agent/request-error`、`agent/turn-stopping` + `tools/pre-execute`、`tools/execute`、`tools/post-execute`，`docs/architecture.md:84`），每个口子的权力边界是文档化的公共契约。终场判定"数据决定而非监听器顺序决定"（`docs/subsystems/core.md:996`）。没有后门：想影响模型可见内容，唯一通道是写日志。

**A6 一切可组合、可热插拔。**
运行中的应用 = 启动时按层序组合的插件树（profile → bundle → patch），无特权内核；每个 agent 有独立作用域（`docs/subsystems/scope.md`）；配置改动经 HMR 热重组。出处：`docs/architecture.md:11-37`。

---

## 4. 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│ L5 应用层      AI-GIS 平台 / 电商运营台 / 你的产品            │
│               （业务工具、persona、投影、页面组件）           │
├─────────────────────────────────────────────────────────────┤
│ L4 投影与客户端层  useAgentSession / useProjection / useTool │
│               SSE 协议 · card 渲染 · typed client（生成）     │
├─────────────────────────────────────────────────────────────┤
│ L3 声明层（Loom 本体） defineApp · app.tool · app.agent      │
│               app.projection · app.policy · app.channel      │
│               （声明 → cordis 插件 + 路由 + 注册的编译器）     │
├─────────────────────────────────────────────────────────────┤
│ L2 内核层      DeepSeek Harness（既有，不改）                 │
│   session 日志 · agent-loop · tools 管线 · llm 适配 ·         │
│   scope · approval/permission · compaction · subagent ·      │
│   presets · persistence(jsonl/sqlite) · webserver            │
├─────────────────────────────────────────────────────────────┤
│ L1 框架基座    Cordis（vendored：IoC + 事件 + 效果系统）      │
└─────────────────────────────────────────────────────────────┘
```

**依赖规则（继承内核铁律）**：
- L3 只依赖 L2 的 **Service Definitions**（`ctx.tools`、`ctx.agents`、`ctx.webServer`……），永不 import 具体 provider（`packages/README.md:67`）——保证 Loom 应用可换掉任何实现。
- L4 与 L3 之间是**纯协议**（SSE + 生成的 client），前端框架无关（React/Vue/Svelte 皆可）。
- 服务器与浏览器是两个类型世界（内核因 Context 声明合并冲突被迫双 program，`docs/development.md:56`）；Loom 沿用该边界，前端只见生成的类型，不见内核类型。

---

## 5. 核心 API 草案与内核映射

> 以下 TypeScript 为**接口草案**（非实现）。映射表标注：✅ = 已在 §7 原型中验证；🔬 = 机制存在但组合方式需 M1 实现时确认。

### 5.1 应用定义

```typescript
import { defineApp } from '@loom-sdk/web'

const app = defineApp('gis-platform', {
  model: 'deepseek-v4-flash',          // 默认模型路由（可按 agent 覆盖）
  persistence: 'jsonl',                 // jsonl | sqlite（内核两个后端）
})

export default app   // `loom dev` 启动：组合为 harness profile + bundle patch
```

| 声明 | 映射到内核机制 | 状态 |
|---|---|---|
| `defineApp` | 生成一个 bundle（`dsh.bundle.patch` 声明，`docs/user/develop/basic/publish.md:36-43`）叠在 `dsh-base` 之上；`loom dev` = `dsh web --patch <生成的 overlay>` | ✅（gis-bridge 以手工 overlay 验证同路径） |
| `persistence` | `session-persistence-jsonl` / `sqlite` 两个既有 provider | ✅ |
| `provider` / `providers`（M11） | 一行切换模型提供方：缺省 `deepseek-official`（dsh-llm-deepseek 现状），`ollama`/`openrouter`/`openai-compatible` 组合为 `dsh-llm-pi-ai` 多路由（route 键即 provider 名，机密只经 apiKeyEnv 引用；非 catalog 路由 models 目录自动含默认与 agent 覆盖模型）——见 docs/providers.zh.md | ✅ |

### 5.2 工具：一份声明，三张面孔

```typescript
const queryLandTypes = app.tool('query_land_types')
  .input({ region: z.string().optional() })
  .output(z.object({
    totalAreaSqm: z.number(),
    items: z.array(z.object({
      village: z.string(), landType: z.string(),
      areaSqm: z.number(), ratioPct: z.number(),
    })),
  }))
  .card('generic', { title: '地类面积查询' })      // UI 渲染意图（可选）
  .http('GET', '/api/land-types')                   // 第二张面孔：HTTP API（可选）
  .execute(async ({ region }, exec) => {            // exec.signal 必须遵守
    return landTypes.query(region)
  })
```

产出三张面孔：
1. **模型工具**：自动进入提示词装配（对模型可见名/描述/参数 schema）
2. **HTTP API**：`GET /api/land-types?region=...`，参数按同一 schema 校验
3. **类型化客户端**：`import { tools } from './loom/client'` → `tools.queryLandTypes({region})`，输入输出类型由同一 schema 推导

| 声明 | 映射到内核机制 | 状态 |
|---|---|---|
| `.input/.output/.execute` | `ctx.tools.register(defineTool({...}))`——DSL 校验参数、canonical JSON 输出契约、`output.render` 投影（`docs/cookbook/adding-a-tool.md:17-36`） | ✅（shop-demo/gis-bridge 均用此契约） |
| `.card(...)` | `presentCall`/`presentResult` 渲染意图，纯函数保证回放重现（`docs/cookbook/adding-a-tool.md:71-90`） | ✅（内核工具已用；Loom 声明化） |
| `.http(...)` | `ctx.webServer.register({kind:'exact', path, handler})`，handler 拥有完整响应生命周期（`packages/host/webserver/src/index.ts:94`） | ✅（gis-bridge 的 /~gis/* 路由验证） |
| `app.mcp(...)`（M10） | 外部 MCP 服务器工具接入：`mcp__<server>__<rawName>` 注册（dsh-mcp-client：重连退避/世代回滚/HMR），**照常过策略/审批/预算管线**；机密只经 envRef/headerRefs 引用——见 docs/mcp.zh.md | ✅ |
| typed client 生成 | 从注册 schema 白名单投影生成 TS（`wireSchemas` 只白名单 name/description/parameters，`packages/core/tools/src/index.ts:1234-1267`）；类型推导先例：Code Mode 的 `ToolArgsMap`/`ToolOutputMap`（`docs/cookbook/adding-a-tool.md:63`） | 🔬 |

### 5.3 智能体：声明即路由

```typescript
app.agent('data-analyst', {
  persona: '数据分析数字员工……先查数再结论，主动画图与聚焦地图',
  tools: [queryLandTypes, renderPieChart, focusMap],
  model: 'deepseek-v4-flash',
  policy: { writes: 'approve' },       // 见 5.5
})
// 自动获得：
//   POST /agents/data-analyst/sessions          → { sessionId }
//   POST /agents/data-analyst/sessions/:id/messages
//   GET  /agents/data-analyst/sessions/:id/events   (SSE)
//   POST /agents/data-analyst/sessions/:id/fork
```

| 声明 | 映射到内核机制 | 状态 |
|---|---|---|
| 静态声明（启动即存在） | 声明式 agent 条目（loop 自己的 config 启动，`docs/subsystems/core.md:24`） | 🔬 |
| 按需创建（HTTP 路由触发） | `ctx.agents.create({ setup })`：setup 里经 `agentCtx` 注册 persona prompt section（per-agent 作用域，`docs/subsystems/core.md:49`）；事务性创建失败即回滚 | ✅（gis-bridge 正是此路径） |
| persona | system-prompt section（agent 作用域可覆盖全局，`docs/subsystems/core.md:169`） | ✅ |
| 会话自动持久化/恢复 | persistence provider + `ctx.agents.resume` | ✅（headless 验证 resume 路径） |
| `fork` 路由 | `ctx.sessions.fork(source, boundary?)`，必须切在完整 turn 边界（`docs/architecture.md:126`） | 🔬 |
| 每 agent 不同工具集 | `ctx.tools` 的 scoped 注册 + `tools.restrict`（`docs/subsystems/tools.md`） | 🔬 |

**Preset 关系**：静态、预组合的 agent 形态用内核 preset 表达（目录 + `agent.cordis.yml`，空会话可 `recompose`，`packages/preset/agent-presets/README.md`）；Loom 的 `app.agent` 覆盖"应用内声明、HTTP 寻址"的动态形态。两者同源（都是 cordis 组合），不冲突。

### 5.4 投影：会话事件 → 应用状态

```typescript
app.projection('workspace', {
  init: { chart: null, focus: null, tasks: [] },
  apply(state, event) {
    switch (event.type) {
      case 'tool/call':    return { ...state, tasks: [...state.tasks, task(event)] }
      case 'tool/result':  return applyResult(state, event)   // chart/focus 落位
      case 'turn/end':     return { ...state, tasks: settle(state.tasks) }
    }
  },
})
// 前端：const workspace = useProjection(sessionId, 'workspace')
```

| 声明 | 映射到内核机制 | 状态 |
|---|---|---|
| 纯 `init/apply/view` 投影单元 | session-projection seam：按 committed events 驱动纯函数并缓存 watermark（`packages/session/session-projection/src/index.ts:37-86`） | 🔬（内核机制在；Loom 把投影结果推到线上） |
| 事件转发 | `ctx.on('session/event', (session, event) => ...)` 全局订阅（无标签监听器收到全部会话，`packages/core/session/src/index.ts:76`），白名单过滤（绝不转发 `request/header`——含完整系统提示词） | ✅（gis-bridge 已实现） |
| 投影在服务端算还是前端算 | 两者皆可：事件白名单直发（前端算，gis-bridge 现状）或服务端投影后发（省流量）；M1 以前者为默认 | 设计决策 |

### 5.5 策略：权力即声明

```typescript
app.policy({
  default: 'allow-read',
  rules: [
    { tool: '*',            effect: 'ask' },       // 默认：需要审批
    { tool: 'query_*',      effect: 'allow' },      // 只读查询放行
    { tool: 'update_*',     effect: 'approve', notify: 'operator' },
    { budget: 'per-session-tokens', max: 200_000, effect: 'stop' },
  ],
})
```

| 声明 | 映射到内核机制 | 状态 |
|---|---|---|
| `allow/deny/ask` | `tools/pre-execute` waterfall 的三种裁决（`docs/cookbook/extension-cookbook.md:24-31`）；`ask` 路由进审批缝 | ✅（机制在，规则编译器 🔬） |
| 审批 | `ctx.approval.request`：一次一单，answerer 缺席**fail-closed**，成对 `approval/asked`/`decided` 审计事件（`packages/interaction/user-approval/README.md`） | ✅ |
| 三档权限预设 | permission-presets：`read-only`/`workspace-write`/`danger-full-access`（`packages/interaction/permission-presets/README.md`） | ✅ |
| 预算（M9） | `app.policy({ budgets: [...] })`：每会话 `tool-calls`（glob 计数）与 `session-tokens`（assistant 消息 usage 四桶求和）两类量化预算，超限 fail-closed 拒绝或转人工审批（复用审批门）；拒绝理由模型可见（工具错误文本）+ `loom/budget-exceeded` SSE 合成事件 + health 可观测面。语义移植自 omnigent 治理层 spend-cap（DENY 短路/fail-closed/计尝试不计成功）；v1 边界：计数器内存态，重启清零（会话日志保留完整审计）——`packages/web/src/budget.ts` + `examples/gis/tests/budget.e2e.test.ts`（无 key 驱动） | ✅ |
| 超时/防重复 | guard 组：timeout-policy、repeat-tool-reminder（`packages/guard/`） | ✅（既有插件） |

### 5.6 通道：一个 agent，多个入口

```typescript
app.channel.webhook('/hooks/github', { agent: 'data-analyst', map: githubIssueToIntent })
app.channel.sse()          // 默认开启（前端）
// 规划中（依赖内核/社区既有件）：
// app.channel.acp()       // packages/acp：自动化专用 Agent Client Protocol
// app.channel.jsonrpc()   // examples/jsonrpc-agent：进程内嵌 SDK 场景
```

| 声明 | 映射到内核机制 | 状态 |
|---|---|---|
| webhook 通道 | webserver exact 路由 → `agent.followup()`（`Agent` 统一入口，`send/followup/steer/inject` 语义见 `docs/subsystems/core.md:114-141`） | 🔬（路由与 followup 均已验证，映射器需实现） |
| ACP / JSON-RPC | 内核既有面（`packages/acp/`、`examples/jsonrpc-agent/`） | ✅（内核侧现成） |

### 5.7 前端 hooks（React 参考实现）

```typescript
const { sessionId, send, status } = useAgentSession('data-analyst')
const workspace = useProjection(sessionId, 'workspace')
const chart = useToolResult(sessionId, 'render_pie_chart')   // 订阅特定工具的结果
```

| 声明 | 映射 | 状态 |
|---|---|---|
| SSE 订阅 + `since=seq` 断线重连 | 事件 `seq` 严格连续单调（`packages/core/session/src/index.ts:628-630`）；`EventSource` 原生 reconnect + since 参数补放 | ✅（gis-bridge 已实现 since 语义） |
| 流式文本 | `assistant/chunk`（token 级保真，`packages/core/session/src/types.ts:266`）投影 text-delta | ✅ |

---

## 6. 前端协议（v1 草案）

**传输**：SSE（`text/event-stream`；webserver handler 明确支持长连接，`packages/host/webserver/src/index.ts:32`）。

**事件信封**：

```jsonc
{ "seq": 128, "agent": "data-analyst", "type": "tool/call",
  "name": "gis_render_pie_chart", "arguments": { "title": "地类占比", "items": [...] } }
```

**白名单**（v1）：`turn/start`、`turn/end`、`user/message`、`assistant/chunk`（仅 text-delta 投影）、`assistant/message`、`tool/call`、`tool/result`（内容预览截断）。**永不转发**：`request/header`（含完整系统提示词与工具 schema——信息量巨大且敏感）。

**一致性规则**：`seq` 是唯一顺序权威；客户端丢弃 `seq <= 已见最大值` 的事件；重连携带 `?since=<maxSeq>`；服务端从内存日志补放后转入实时。

**卡片渲染**：工具结果可携带渲染意图（内核 card 体系），前端按意图选卡片组件，无匹配则回退 generic 卡片——与内核 UI 插件的降级策略一致（`docs/cookbook/adding-a-tool.md:69`）。

**类型化客户端**：M4 从工具注册表生成（§5.2 映射行），前端编译期即知 `tools.queryLandTypes` 的入出类型。

---

## 7. 从原型到框架：gis-bridge 提炼表

我们已完成两个真实原型，全部机制走通。Loom 的本质 = 把下表左列"手写"提炼为右列"声明"。

| 手写（gis-bridge / shop-demo 中已验证） | Loom 声明 |
|---|---|
| 插件包 + named exports + `file:///` 挂载 overlay（shop-demo `cordis.yml`） | `defineApp()` 生成 bundle 与挂载 |
| `defineTool` 手写 4 个工具 + 手写 output schema/render（gis-bridge `plugin/src/index.js`） | `app.tool().input().output().card().http()` |
| 手写 `/~gis/sessions` 路由 + `ctx.agents.create` + setup 里按 agentType 注册 persona section | `app.agent('id', {persona, tools})` + 自动路由 |
| 手写 `/messages` 路由 + `agent.followup` | 自动 |
| 手写 SSE：白名单过滤 + since 补放 + text-delta 投影 + 工具事件投影 | `app.projection()` + 默认 SSE 通道 |
| 前端 `agentBridge.ts`：createSession/sendMessage/streamEvents + zustand store | `useAgentSession` / `useProjection` hooks |
| 前端 ChartPanel/MapViewer 手动订阅 store | 投影声明 + card 组件库 |
| 无审批（demo 有意省略） | `app.policy({...})` |
| next.config.js 手写 rewrites 代理 | `loom dev` 自带同源服务或生成配置 |

两个原型同时验证了工程事实：Windows 开发可行（便携 Node 方案）、`deepseek-v4-flash` 默认路由在 base bundle 已钉死（`packages/bundle/base/cordis.patch.yml:63-67`）、真实闭环（一句话 → 查库 → 改库 → 报告）端到端跑通。

---

## 8. 竞品矩阵（截至 2026-08 调研）

| 维度 | Loom（设计） | Mastra | LangGraph.js | Vercel AI SDK | Temporal + 自配 Web |
|---|---|---|---|---|---|
| 事件溯源持久会话 | ✅ 内核原生 | 检查点（图级） | 检查点 | ❌ | ✅ |
| 模型可见⟺落日志（可重建） | ✅ 不变量强制 | ❌ | ❌ | ❌ | N/A |
| 审批/权限/预算 | ✅ 内核缝 | 部分 | ❌ | ❌ | 人工活动（重） |
| UI 投影协议（SSE+seq+card） | ✅ | ❌（带 UI 集成） | ❌ | 流式 hooks（token 级） | ❌ |
| 热组合（HMR/无特权内核） | ✅ Cordis | ❌ | ❌ | ❌ | 部分 |
| 一份声明三张面孔 | ✅ 核心主张 | ❌ | ❌ | 部分（tool→UI） | ❌ |
| Web DX（路由/校验/文档） | ✅ 本体 | 部分 | ❌ | ✅（UI 层） | ❌ |
| 多智能体 | ✅ subagent 体系 | ✅ | 图编排 | 基础 | 自建 |

来源：[Mastra vs LangGraph.js 对比](https://developersdigest.tech/blog/mastra-vs-langgraph-js-2026)、[LangChain 框架综述](https://www.langchain.com/resources/ai-agent-frameworks)、[AgentMail 2026 实测](https://www.agentmail.to/blog/best-ai-agent-frameworks-2026)、[Vercel AI SDK 文档](https://ai-sdk.dev/docs/introduction)。谨慎声明：矩阵基于公开资料与文档的定性判断，各项目快速演进中。

**差异化一句话**：Mastra/LangGraph 帮你*跑 agent*，Vercel AI SDK 帮你*渲染流*，Loom 帮你*以 agent 为中枢构建整个 Web 应用*——且底座的事务性（A2）与权力模型（A5）来自经过源码级验证的内核，而非框架自补。

---

## 9. 安全与治理

- **审批 fail-closed**：无 answerer 或 answerer 故障 = 拒绝（`packages/interaction/user-approval/README.md`）。Loom 默认策略：写类工具 `approve`、读类 `allow`，应用可覆盖。
- **审计**：A2 公理直接给出——审批成对事件、工具调用/结果、请求头快照全部在日志；审计 = 读日志，不需要第二套系统。
- **预算**：token-meter 度量（§#3 解读：锚点+增量）+ 回合终止钩子。
- **沙箱**：进程级约束走 `ctx.sandbox` seam（bwrap/Landlock/Seatbelt/Windows ACL）；Loom 的工具默认不持 shell，需要时声明 sandbox 行（内核 `sandbox-local` provider）。
- **部署边界（明确写出）**：内核 webserver v1 **无 TLS、无认证、无 origin 策略**，默认仅绑 127.0.0.1（`packages/host/webserver/README.md`）。Loom 生产部署假设前置反向代理终结 TLS 与身份认证；M2 提供 channel 层认证钩子（把外部身份映射为 agent 会话身份）。

---

## 10. 路线图

| 阶段 | 交付 | 验收标准 | 依赖的内核机制 |
|---|---|---|---|
| **M1 框架包 MVP** | `@loom-sdk/web`：defineApp/tool/agent/projection(SSE) + React hooks；shop-demo 与 GIS 平台用声明式重写 | 两个应用零手写桥运行；`loom dev` 一条命令起服务 | 已验证全部机制（§7） |
| **M2 策略与回放** | app.policy 编译器 + 回放调试器（时间旅行：任意 seq 重建投影） | 写工具触发审批 UI；回放与实时投影逐事件一致 | approval seam、sessions.fork、jsonl 重放 |
| **M3 通道与多智能体** | webhook 通道、子智能体声明（`app.agent.spawn`）、多 agent 页面编排 | GitHub issue → agent 自动处理的完整链路 | subagent providers、jobs、schedule |
| **M4 客户端生成与评测** | typed client 生成器 + 从会话日志抽取评测集 | CI 中对真实 transcript 回放断言 | Code Mode 类型推导先例、persistence 查询 |

版本策略：跟随内核 major（内核 v0.x 期明确 breaking，`README.md:11`）；Loom 在 v0.x 期同样不承诺稳定 API。

---

## 11. 开源工程规划

- **命名与 scope**：不占用 `@deepseek-ai` scope（DeepSeek 官方保留）；使用自有 scope（如 `@loom-sdk/*`），把 `@deepseek-ai/dsh-*` 声明为 **peerDependencies**——遵循内核惯例（`@deepseek-ai/cordis` 是每个 harness 包的 peer dep，`AGENTS.md:100`）。
- **生态对接**：Loom 生成的插件遵守 dsh 插件形态，可加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic 进入内核插件生态。
- **许可证**：MIT（与内核一致）。
- **文档**：中英双语，与内核文档风格对齐（直接、具体、不堆比喻）；本白皮书为设计基线，此后变更走 ADR。
- **CI**：typecheck + vitest 单测 + 基于真实原型的 keyless 快照测试（内核测试哲学：模型可见行为变更须附可运行示例的快照，`docs/testing.md`）；CI 跑内核 HEAD 版以提前暴露 breaking。
- **贡献指南要点**：Windows 开发路径（便携 Node）、`pnpm` 版本由内核 packageManager 钉住、演示仓库两个参考应用。

---

## 12. 风险与开放问题

| 风险 | 应对 |
|---|---|
| 内核 v0.1 期 breaking（`SESSION_FORMAT_VERSION=0` 无迁移承诺） | CI 跑内核 HEAD；Loom 钉 minor；破坏发生时按内核"foundation over blast radius"姿态同步重命名 |
| SSE 扇出：每会话每连接一个长连接 | M1 观测；M3 评估内核 webserver 上的广播/多路复用扩展（upstream 贡献） |
| 多租户与认证 | M2 channel 层钩子（§9）；单进程多 preset 组合已可行（scope 隔离） |
| 浏览器离线 | 投影可缓存（IndexedDB）但一致性语义（离线期间的事件缺口补放）待设计 |
| `request/header` 泄露风险 | 协议层白名单硬编码排除；lint 规则禁止新增未审计事件类型直发 |
| 单进程内存日志上限 | 内核 compaction（表面 replace）已有；超大会话走 sqlite 后端 + 查询 |

**开放问题**（欢迎讨论）：投影默认前端算还是服务端算的取舍；`app.agent` 动态创建与 preset 静态组合的边界；typed client 的生成时机（build 时 vs dev watch）。

---

## 附录 A：命名候选

| 候选 | 寓意 | 备注 |
|---|---|---|
| **Loom**（当前） | 织机：把会话之线织成界面之布 | 直观呼应"投影"公理 |
| Facet | 一份声明三张面孔（宝石切面） | 呼应 A1 公理 |
| Relay | 接力：waterfall 语义 + 通道语义 | 与既有项目重名较多 |

## 附录 B：术语表（沿用内核定义，`docs/glossary.md`）

- **turn / step**：回合 = 从领取输入到"谁也不欠谁"；步 = 一次模型请求 + 其工具执行
- **session log / surface**：append-only 事件日志；其上产生模型消息的有序视图
- **seam（能力缝）**：Service Definition + Provider + Consumer 三件套
- **preset**：目录化的 per-session 智能体组合（`agent.cordis.yml`）
- **profile / bundle / patch**：运行实例的层序组合机制
- **waterfall / serial / parallel / emit**：四类事件分发模式

---

*本白皮书中所有对 DeepSeek Harness 的引用基于其 v0.1 开发者预览源码（2026-08 快照），文件路径均相对仓库根。*

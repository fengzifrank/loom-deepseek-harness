# Loom

**智能体原生的 Web 框架 —— 智能体时代的 FastAPI，构建于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 之上。**

[English](README.md) | 中文

> 状态：**M8 已交付** —— 声明式框架 + 策略编译器（审批闭环）+ 时间旅行回放调试器 + webhook 通道 + 多智能体协作（子智能体）+ DX 层（类型化入参、schemastery 输出、单命令 dev/build/start、脚手架、热重载、React 组件库）+ `loom client` 类型化客户端生成与 `loom eval` transcript 评测 + `loom openapi` / `loom import-openapi` 双轨 OpenAPI 互通 + Python 工具桥（loom-py）+ 记忆与多用户（会话重启恢复、匿名+本地账号隔离、mem0 式两阶段提取 + SQLite FTS5 召回的 loom memory）+ **路径记忆（失败触发召回可重验任务路径 + 置信度衰减）与插件生态（消费 session-query / frontend-static；生产 dsh-python-tools / dsh-web-approval-answerer）**，已对真实 DeepSeek API 端到端验证。设计见[白皮书](docs/whitepaper.zh.md)，Python 工具见[docs/python-tools.zh.md](docs/python-tools.zh.md)，认证见[docs/auth.zh.md](docs/auth.zh.md)，记忆见[docs/memory.zh.md](docs/memory.zh.md)，路径记忆见[docs/path-memory.zh.md](docs/path-memory.zh.md)，插件生态见[docs/plugin-ecosystem.zh.md](docs/plugin-ecosystem.zh.md)。

## 状态总览

| 能力 | 阶段 | 状态 |
|---|---|---|
| defineApp / tool / agent / projection 声明器、`loom dev`、React hooks（useAgentSession/useProjection）、SSE 协议（`?since` 断线补放） | M1 | ✅ |
| `app.policy()` 编译器——allow/deny/approve 经 `tools/pre-execute` 裁决；审批经 SSE 卡片 + HTTP 答复闭环（fail-closed，默认 5 分钟超时=拒绝） | M2 | ✅ |
| 时间旅行回放：有界事件读取（`?to=`）、`POST /sessions/:id/fork` 在 turn 边界分叉（内核强制校验） | M2 | ✅ |
| `.http()` 第二张面孔——工具 → HTTP 端点，经内核工具管线执行（含策略） | M2 | ✅ |
| `app.channel.webhook()`——带签名 webhook 入口（HMAC-SHA256 + timingSafeEqual），payload→任务 map，sessionKey 会话复用，`202 {sessionId}` | M3 | ✅ |
| `app.subagent()`——多智能体协作，编译为按父 agent 作用域注册的 `subagent` 委派工具（persona → 内核 per-child persona、tools → toolFilter）；子会话走既有 SSE 端点直播，前端父/子双流并屏 | M3 | ✅ |
| 测试（vitest：单测 + 无 key 冒烟 + 真 key 审批链与委派/webhook e2e）与 GitHub Actions CI | M3 | ✅ |
| 类型化声明器：`.input()` 字面量经 InferToolArgs 推导入参类型、`.output(z.object({...}))` schemastery 重载、声明期守门（output 空根 / 数组缺 items / 工具引用悬空） | DX | ✅ |
| 单命令工作流：`loom dev` 一条命令起服务+Vite（含热重载：保存 loom.app.ts → 预检 → 优雅重启，失败保旧。预检只做模块级导入——语法/声明期错误保旧进程，组合层/cordis 装配错误在重启后才暴露，属已知窗口）；`loom build` / `loom start`（dist 与 API 同端口）；`loom new <name>` 脚手架；`@loom-sdk/web/react-ui` 组件库（ChatStream / ApprovalCard / ToolCard / DebugPanel / MultiAgentPanel） | DX | ✅ |
| `loom client [-o src/loom.client.ts]`——从 AppSpec 生成类型化客户端：确定性输出的一个 TS 文件，`loomTools` 入参经 InferToolArgs、返回经新增的 InferToolOutput（output DSL→TS 条件映射，与入参对称），GET query / POST JSON 按 `.http()` 声明；agent id 为字面量联合；`loomSessions`（createSession / sendMessage / streamEvents：SSE → AsyncIterable）；未声明 `.http()` 的工具生成说明注释；快照单测 + CI 新鲜度门（`git diff --exit-code`） | M4 | ✅ |
| `loom eval [dir=evals]`——transcript 评测：真实会话日志即评测夹具。`--slim` 把原始 `.loom/sessions/<id>/session.jsonl` 折叠成精简夹具（assistant/chunk 增量折叠、turn/step/user/tool/approval/loom-* 原样保留）；`defineEval({ name, fixture, assert })` 提供 byType/byTool/turns/orderOf/text 视图与 expect 断言辅助（toolCalled / toolFailed / turnEnded / approvalFlow / textIncludes）；纯本地重放，零网络零 key；gis 应用带 5 个真实夹具（审批允许/拒绝、委派链、webhook、基础查询） | M4 | ✅ |
| `loom openapi [-o openapi.json]`——从 AppSpec 导出 OpenAPI 3.1.0 文档（确定性：无时间戳、键序稳定，同一声明字节相同）；`dslToJsonSchema` 与 runtime 同语义（required 移位、object 封闭、`type:'json'` → `{}`）；GET/HEAD/DELETE 逐字段 query 参数（复杂值标 `x-loom-query-json` 扩展）；POST/PUT/PATCH requestBody；500 形状如实文档化；运行时活文档 `GET {prefix}/openapi.json` 与生成物同源；快照单测 + CI 新鲜度门 | M5 | ✅ |
| `loom import-openapi <url\|file> [--base] [--include glob] [--tag]`——把任意外部 OpenAPI 3.x JSON 文档反向生成 `loom.openapi.ts`（`registerImportedTools(app)` 一行接入）；`jsonSchemaToDsl` 反向转换器：$ref 展开 / allOf 浅合并 / 可空联合落标量 / 不覆盖部分诚实降级为 json + WARN 注释；路径参数转必填输入字段；execute 生成真 fetch（signal 透传、非 2xx 抛错带响应体前 200 字符）；写操作给 policy approve 建议注释；securitySchemes 生成 token 注入位；自举往返 e2e（gis 活文档 → 导入 → 真调 57351531.17，零 key） | M5 | ✅ |
| 路由治理：`.http()` 路由推导收敛到唯一的 `httpRouteOf`（runtime 注册 / health 清单 / client 生成器 / openapi 生成器四处共用）；自定义 path 含 `{` 声明期 throw | M5 | ✅ |
| **Python 工具桥**：`app.python({ command })` ——spawn Python 子进程按 loom-py 协议（stdio JSON Lines，自定轻协议见 docs/python-tools.zh.md）握手，`@tool` 清单注册为模型可见的代理工具；类型注解→JSON Schema 自动推断（pydantic 可用则增强）；`jsonSchemaToDsl` 复用 M5 转换器（required 下沉/诚实降级）；异常→结构化错误（类型+traceback 最内帧）；取消尽力而为（tools/cancel 通知）；崩溃自动重启（间隔 1s，上限 3 次 fail-loud）；`loom_py` 纯标准库零依赖 + `python -m loom_py.selftest` 自测；假子进程集成测试不依赖真 Python 永远可跑 | M6 | ✅ |
| **会话持久化恢复**：sidecar 会话索引（`.loom/sessions-index.json`，原子写）+ 惰性 resume——服务重启后路由遇未命中 sessionId 先查索引再 `agents.resume`（persona/作用域工具与创建时相同），历史完整重放、同 sessionId 续聊；`GET /agents/:id/sessions` 会话列表（title=首条用户消息前 30 字）；前端 `useAgentSession` 会话持久化（localStorage）+ `SessionList` 组件（点击继续/新建） | M7 | ✅ |
| **多用户**：`app.auth()` 一行声明——匿名 UUID（x-loom-user）+ 本地账号（scrypt + HMAC token，零依赖）；无身份 POST 401、会话按 userId 隔离（不匹配 404 不泄露）、审批仅属主；SSE 支持 `?token=`/`?user=` query（EventSource 不能带头）；CORS 白名单可选；`useLoomAuth` + `AuthPanel` | M7 | ✅ |
| **loom memory**：`app.memory()` + `app.agent(id, {memory:true})`——`.loom/memory.db`（node:sqlite FTS5，零新依赖，中文 bigram 分词，user_version 门禁）；写路径 mem0 式两阶段（提取候选 → FTS 相似 → ADD/UPDATE/DELETE/NOOP 决策，每会话串行队列，失败仅告警）；读路径首条消息 FTS top-K 注入（source form:'recall' 防注入框）；模型工具 memory_search/write/forget；`GET/PUT/DELETE /~loom/memories` + `MemoryPanel` | M7 | ✅ |
| **路径记忆**：`app.agent(id, { memory: { paths: true } })` 窄门控——任务型 agent 记 `kind:'path'` 记忆（目标 + 工具序列 + 参数形状策略 + 结局，`toolSequenceSignature` 签名去重）；失败 turn（error/blocked）触发 FTS `search(userId, query, k, 'path')` 检索并经召回管道注入"待重验路径"（防注入框，明示先重跑只读步骤）；同会话下一次 turn 结算回写（completed → verified_at 刷新 + confidence +0.1，error/blocked → ×0.5，<0.3 软删），verified_at 超 30 天检索降权（惰性）；被拒路径也记（降权）；MemoryPanel 显示 confidence + verified_at——设计与实现见 [docs/path-memory.zh.md](docs/path-memory.zh.md)；e2e 证据链见 `examples/gis/tests/path-memory.e2e.test.ts`（无 key 确定性段 + 带 key 闭环：失败 → 注入 → completed → 0.8→0.9） | M8 | ✅ |
| **插件生态**：消费——`dsh-session-query-sqlite` + `dsh-tool-session-query`（模型面 session_search，带 key e2e）与 `dsh-host-frontend-static`（替换 loom start 手写 SPA fallback；403/200/405 语义已验证）；生产——`dsh-python-tools`（Python 桥自 web 抽出，含 jsonSchemaToDsl）与 `dsh-web-approval-answerer`（SSE 审批 answerer：留档重发/并发 409/超时 fail-closed）两个 workspace 包（`dsh-plugin` 关键字、MIT、中英 README、独立单测；本阶段不发布 npm）；所有 `@deepseek-ai/*` 依赖钉精确 `0.1.0-rc.6`——见 [docs/plugin-ecosystem.zh.md](docs/plugin-ecosystem.zh.md) | M8 | ✅ |
| ACP 通道接入等后续演进 | Next | ⏳ |

## 一段话讲清

传统 Web 框架以 HTTP 请求为原子；智能体应用需要更大的原子：**持久会话**。Loom 让会话事件日志成为唯一事实来源——模型上下文、界面、审计轨迹、评测数据集，全部是同一份日志的*投影*。你声明能力（工具/智能体/投影/策略/通道），Harness 内核执行并持久化一切，前端经 SSE 渲染类型化投影。

## 一份声明，三张面孔

FastAPI 的洞见：一个装饰器同时得到运行时、校验、文档。Loom 的等价物：

```typescript
import z from '@deepseek-ai/schemastery'

const app = defineApp('gis-platform', { model: 'deepseek-v4-flash' })

app.tool('query_land_types')
  .input({ region: { type: 'string', description: '可选的村庄名过滤词' } })
  .output(z.object({ totalAreaSqm: z.number(), items: z.array(z.object({ village: z.string(), areaSqm: z.number() })) }))
  .card('generic', { title: '地类面积查询' })
  .http('GET')
  .execute(async (args, exec) => landTypes.query(args.region))
  // args 的类型由 .input() 字面量推导（region?: string），内核已校验——
  // 不再需要手工 typeof 检查；.output(z.object(...)) 的 required 由可选性自动推导
```

一次声明 → ① 模型可见的工具 ② 带校验的 HTTP 端点 ③ 前端类型化客户端。

```typescript
app.agent('data-analyst', {
  persona: '数据分析数字员工……',
  tools: [queryLandTypes, renderPieChart, focusMap],
  policy: { writes: 'approve' },
})
// 自动获得：POST /agents/data-analyst/sessions、.../messages、
//          GET .../events (SSE)、POST .../fork
```

UI 不是挂在页面上的聊天框——它是会话事件流的投影：

```typescript
const { send } = useAgentSession('data-analyst')
const workspace = useProjection(sessionId, 'workspace')  // 图表、地图聚焦、任务列表
```

## 为什么是现在，为什么站在内核上

2026 年，三条独立的技术线索汇聚到同一架构：

| 线索 | 证明了什么 | Loom/Harness 对应 |
|---|---|---|
| [Temporal 式持久执行](https://temporal.io/blog/durable-execution-meets-ai-why-temporal-is-the-perfect-foundation-for-ai) | 事件历史 + 重放 = 免费检查点 | append-only 会话日志、请求逐字节可重建 |
| [Phoenix LiveView](https://dashbit.co/blog/web-apps-have-client-and-server-state) | 状态在服务端，UI 是投影 | 会话事件 → 类型化投影、`?since=<seq>` 断线续传 |
| [生成式 UI](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces) | 界面动作来自工具调用 | 确定性 card 意图，从日志回放 |

Mastra、LangGraph 帮你*跑 agent*；Vercel AI SDK 帮你*渲染流*。Loom 帮你*以 agent 为中枢构建整个 Web 应用*——事务性保证（"模型可见 ⟺ 已落日志"）、审批/策略口子、热插拔组合，全部继承自 Harness 微内核。

## 架构

```
L5  你的应用               （业务工具、persona、页面）
L4  投影与客户端层          useAgentSession · useProjection · SSE · 类型化客户端
L3  声明层（Loom 本体）     defineApp · tool · agent · projection · policy · channel
L2  DeepSeek Harness 内核  会话日志 · agent-loop · 工具管线 · llm 适配 · 审批 · scope
L1  Cordis（vendored）      IoC + 类型化事件 + 可逆效果
```

Loom 只依赖内核的 Service Definitions，永不绑定具体 provider——下层实现（模型适配器、沙箱、持久化后端）随时可换。

## 路线图

| 阶段 | 交付 |
|---|---|
| M1 | 框架包 MVP：声明器 + React hooks；两个参考应用（电商运营、AI-GIS）声明式重写 |
| M2 | 策略编译器 + 时间旅行回放调试器 |
| M3 | 通道（webhook；ACP 规划中）、多智能体页面、子智能体 |
| M4 | 类型化客户端生成 + 基于会话记录的评测——✅ 已交付 |
| M5 | OpenAPI 双轨互通（`loom openapi` 导出 / `loom import-openapi` 导入）+ 路由规则治理（`httpRouteOf`）——✅ 已交付 |
| M6 | Python 工具桥（loom-py）：内核保持 TS，Python 成为一等工具作者语言——✅ 已交付 |
| M7 | 记忆与多用户：会话重启恢复 + 匿名/本地账号隔离 + loom memory（两阶段提取 + FTS 召回）——✅ 已交付 |
| M8 | 路径记忆（失败触发召回 + 重验衰减）+ 插件生态（消费 session-query/frontend-static，生产 dsh-python-tools/dsh-web-approval-answerer）——✅ 已交付 |

## 文档

- [学习使用指南（HTML，浏览器直接打开）](docs/learn.html) —— 零依赖单页文档：是什么/为什么、10 分钟上手、第一个应用逐行讲解、API 速查、FAQ
- [Python 工具上手（loom-py，M6）](docs/python-tools.zh.md) —— 安装、@tool 装饰器、类型注解→JSON Schema 推断规则表、协议、取消与错误语义、stdout 污染警告、已知边界
- [路径记忆设计与实现（M8）](docs/path-memory.zh.md) —— 记录形态、失败触发召回、重验衰减、与 skill 体系的划界
- [插件生态（M8）](docs/plugin-ecosystem.zh.md) —— Loom 消费/生产了哪些 dsh-plugin、钉版纪律
- [认证与多用户（M7）](docs/auth.zh.md) —— 匿名/本地账号、token、SSE query 参数、访问规则矩阵、生产反代建议与 TLS 责任边界
- [loom memory（M7）](docs/memory.zh.md) —— 声明/门控/成本、两阶段提取与召回注入、模型工具、HTTP 路由、mem0/MCP/session-query 开源适配配方
- [路径记忆设计（M8）](docs/path-memory.zh.md) —— slim 转录引用 + 工具图签名 + 结局 + verifiedAt 衰减重验
- [设计白皮书](docs/whitepaper.zh.md) —— 完整设计：公理、分层架构、API 到内核的映射表、竞品矩阵、风险

## 示例

- [`examples/gis`](examples/gis/loom.app.ts) —— 国土 GIS 数字员工平台（白皮书 §7 的声明式重写；5 工具 + 3 智能体 + 子智能体 + webhook + Python 桥 + 记忆）
- [`examples/legacy-erp`](examples/legacy-erp/README.zh.md) —— 老系统对接：2018 年的进销存 ERP 三路接入（OpenAPI 一键导入 / 手写包装 / 只读直连库），下单走审批、库存真实扣减、全程可回放
- [`examples/fastapi-admin`](examples/fastapi-admin/README.zh.md) —— 老系统对接·旗舰实录：真实开源项目 FastapiAdmin（1k★，FastAPI+SQLAlchemy+Redis）原样跑起来接进 Loom——OpenAPI 导入 15 工具 + JWT 登录桥（401 自愈）+ 写操作审批，老系统一行不改

### 老系统对接

企业里最多的不是绿地，是存量。Loom 按"老系统还剩什么"分三路接入：有 OpenAPI 文档的一条 `loom import-openapi` 生成工具声明（覆盖不了的 schema 诚实降级留 WARN），没写进文档的接口手写十几行包装，连 API 都没有的用 node:sqlite 只读直连库对账。写操作（如创建订单）在 policy 里配 `approve` 即得人工审批卡——真实扣减老系统库存，被拒不编造成功。完整决策表、启动步骤与演示话术见 [`examples/legacy-erp`](examples/legacy-erp/README.zh.md)（离线模拟，CI 可跑）；真实系统的对接实录见 [`examples/fastapi-admin`](examples/fastapi-admin/README.zh.md)——真实开源项目 FastapiAdmin（1k★）一行不改接进 Loom 的完整过程，含 JWT 登录桥、"文档与实现偏差"活例与 anyOf 可空联合的框架级修复。

## 审批与回放调试（M2）

**权力即声明。** `app.policy({...})` 编译为内核 `tools/pre-execute` 裁决（可重排的策略层）：`allow` 放行、`deny` 拒绝、`approve` 返回内核的 `ask` 裁决——内核工具管线路由进 `ctx.approval.request`（会话日志自动落 `approval/asked`/`approval/decided` 审计对）。Loom 注册的 answerer 把待审批项经该会话 SSE 推 `loom/approval-asked` 卡片，等待 HTTP 答复或超时（默认 5 分钟，超时=拒绝——fail-closed）：

```typescript
app.policy({
  default: 'allow',
  rules: [
    { tool: 'gis_update_*', effect: 'approve' },   // 真实落盘写：需要人工审批
    { tool: 'gis_query_*',  effect: 'allow' },      // 只读查询放行
  ],
})
```

规则按声明顺序求值，**后声明覆盖先声明**。浏览器聊天流里会出现审批卡片（工具/参数预览/允许/拒绝按钮）；允许则执行写操作，拒绝则工具以 `the user rejected tool "..."` 失败。SSE 断线重连/页面刷新后，仍挂起的审批卡会按原 `approvalId` 幂等重发（前端按 id 去重，未决审批不丢失）；并发答复同一审批只认第一次（后到的答复 409 `ALREADY_DECIDED`）。

```bash
# 任意客户端答复一条挂起中的审批：
curl -X POST -H "content-type: application/json" \
  -d '{"decision":"allowed-once"}' \
  "http://127.0.0.1:4620/~loom/sessions/<sessionId>/approvals/<approvalId>"
```

**时间旅行。** 会话是 append-only 日志，任意时刻可重读、可分叉：

```bash
# 有界区间读取（读完即收）：
curl -N "http://127.0.0.1:4620/~loom/sessions/<sessionId>/events?since=-1&to=42"

# 在完整 turn 边界分叉（切在未完成 turn 内会被内核拒绝 → 400 OPEN_TURN）：
curl -X POST -H "content-type: application/json" \
  -d '{"atSeq":42}' \
  "http://127.0.0.1:4620/~loom/sessions/<sessionId>/fork"
# → { "sessionId": "session-gis-platform-fork-…", "forkedFrom": "…", "atSeq": 42 }
```

示例应用带"回放调试"面板：拖动滑块到任意 seq，查看该时刻折叠出的 workspace 状态，并可从该点分叉。分叉会话是只读回放视图（内核不允许在已存在的 live 会话上再挂 agent）。

## 工具 → HTTP API（第二张面孔）

`.http(method, path?)` 把同一工具挂成 HTTP 端点（缺省路径 `/~loom/api/<toolName>`）。请求经内核工具管线（`ctx.tools.execute`）执行——schema 校验与声明的策略同样生效：

```bash
curl "http://127.0.0.1:4620/~loom/api/gis_query_land_types?region=连河村"
# → { "totalAreaSqm": 57351531.17, "items": [...], "queriedAt": "…" }   （响应头 x-loom-exec: pipeline）
```

## 通道与多智能体（M3）

**Webhook 入口。** `app.channel.webhook(path, opts)` 声明一条入站路由：声明了 `secret` 时 runtime 校验 `x-loom-signature`（原始请求体的 HMAC-SHA256 十六进制，`timingSafeEqual` 恒时比较）——缺头/格式错/不匹配分别返回形状清晰的 401 `{ error, code }`；随后把 JSON payload 经 `map` 映射成任务文本（抛错或返回非字符串 → 400，不建会话），按 `sessionKey` 命中复用/未命中新建会话，异步交给 agent 干活并立即答 `202 {sessionId}`：

```typescript
app.channel.webhook('/hooks/demo', {
  agent: 'data-analysis',
  map: payload => `【webhook】${String(payload.text)}`,
  secret: 'whsec_loom_demo',                    // 声明即要求 x-loom-signature
  sessionKey: payload => String(payload.topic), // 同 key 复用同一会话
})
```

```bash
BODY='{"text":"查询连河村的地类面积，给出一句汇总","topic":"village-lianhe"}'
SIG=$(node -e "const c=require('crypto');console.log(c.createHmac('sha256','whsec_loom_demo').update(process.argv[1]).digest('hex'))" "$BODY")
curl -X POST -H "content-type: application/json" -H "x-loom-signature: $SIG" \
  -d "$BODY" "http://127.0.0.1:4620/~loom/hooks/demo"
# → HTTP 202 { "sessionId": "session-gis-platform-hook-village-lianhe-…", "agentId": "data-analysis", "reused": false }

curl -N "http://127.0.0.1:4620/~loom/sessions/<sessionId>/events?since=-1"   # agent 进度走既有 SSE
# 签名错误 → 401 { code: "SIGNATURE_MISMATCH" }；map 抛错 → 400 { code: "MAP_FAILED" }（不建会话）
```

签名防篡改**不防重放**（无时间戳/nonce 窗口）：同一签名请求重发会再次入列。需要防重放的部署请在 `map` 内校验 payload 自带的时间戳/幂等键，或置于带该能力的反向代理之后；并发同 `sessionKey` 的请求经服务端去重——只会建一个会话，其余复用（响应 `reused` 标记）。

**子智能体。** `app.subagent(id, opts)` 编译为一个**只在 visibleTo 父 agent 作用域注册**的 `subagent` 委派工具（不在名单里的父根本看不到它；工具执行时二次校验，只能 spawn 声明过的子规格）。每次委派经内核 subagent 服务缝（组合自动加入 `dsh-subagent` + 进程内 spawn provider）：`persona` 编译为内核 per-child persona，`tools` 编译为子的 toolFilter allow-list，子的 provider/model 同父。子会话与父会话同在 SessionStore——runtime 登记子会话并向父流推 `loom/subagent-started {spec, childSessionId}`，既有 `GET /sessions/:id/events` 端点直接开子会话直播，前端父/子双流并屏：

```typescript
app.subagent('researcher', {
  persona: '数据核对研究员：只负责查证与核对，给结论配证据',
  tools: ['gis_query_land_types'],   // 子可见工具（编译为内核 toolFilter）
  visibleTo: ['data-analysis'],      // 哪些父 agent 能委派它
})
```

对父说「让研究员核对连河村和太平河村的地类数据，然后汇总差异」：父流出现 `tool/call(subagent)` → 子会话直播（自己的 turn 与工具调用）→ 父收到结果 → 父汇总收尾。示例应用的"多智能体"面板同屏渲染两条流，子完成后回落折叠。

## 类型化客户端与 transcript 评测（M4）

**`loom client`——第三张面孔长出代码。** 一条命令读取应用声明，生成类型化客户端（`src/loom.client.ts`，头部 AUTO-GENERATED，字节确定性）。声明了 `.http()` 的工具变成类型化 fetch 封装——入参来自 `InferToolArgs`，返回来自新增的 `InferToolOutput`（与内核转换器一致的 DSL→TS 条件映射：标了 `required: true` 才必填）——改声明后重新生成，过期的调用点全部在编译期报错。agent id 是字面量联合类型；`streamEvents` 把投影 SSE 包成 `AsyncIterable`：

```typescript
import { loomTools, loomSessions } from './src/loom.client'

const r = await loomTools.gis_query_land_types({ region: '连河村' })   // r.totalAreaSqm: number → 57351531.17
const { sessionId } = await loomSessions.createSession('data-analysis')
await loomSessions.sendMessage('data-analysis', sessionId, '查询所有村庄的地类占比')
for await (const event of loomSessions.streamEvents('data-analysis', sessionId)) { /* seq 有序 */ }
```

**`loom eval`——真实 transcript 即评测集。** 会话日志本来就是事实来源，评测就是**纯重放**：`loom eval --slim <session.jsonl> -o fixtures/x.jsonl` 把原始日志蒸馏成精简夹具（assistant/chunk 折叠，tool/approval/turn 事件保留），每个 `evals/*.eval.ts` 对它声明断言。零 key、零网络——审批闭环、委派链、webhook 入口的智能体行为回归在 CI 里免费获得，评测集随真实使用自动生长：

```typescript
export default defineEval({
  name: 'approval-allowed',
  fixture: 'fixtures/approval-allowed.jsonl',
  assert(ev) {
    ev.expect.toolCalled('gis_update_land_note')      // 模型确实调了写工具
    if (ev.expect.approvalFlow().outcome !== 'allowed-once') throw new Error('期望允许')
    ev.expect.turnEnded('completed')                   // turn 正常收场
  },
})
```

```bash
pnpm client          # 重新生成 examples/gis/src/loom.client.ts（CI 对其 git diff --exit-code）
pnpm eval:gis        # loom eval evals → 5/5 重放断言通过，零网络零 key
```

## OpenAPI 互通（M5）

**双轨互通：出得去，进得来。** OpenAPI 是 API 世界的通用语——`loom openapi` 把 Loom 声明导出成 OpenAPI 3.1.0 文档（任何代码生成器/网关/测试工具可直接消费），`loom import-openapi` 把任意外部 OpenAPI 文档反向生成 Loom 工具声明（一行接入，外部 API 立即获得模型面孔 + HTTP 面孔 + 策略/审批）。与 FastAPI 互补：已有 FastAPI 服务？导出它的 openapi.json 直接挂进 Loom；用 Loom 搭的服务？一行命令把 API 面孔交付给任何 OpenAPI 客户端。

```bash
# 出：导出应用声明的 OpenAPI 3.1.0 文档（确定性：同一声明 → 字节相同）
pnpm openapi:gis               # 生成 examples/gis/openapi.json（CI 对其 git diff --exit-code）
curl http://127.0.0.1:4620/~loom/openapi.json | head    # 运行时活文档，与生成物同源

# 进：导入外部 OpenAPI 文档（URL 或本地 JSON）→ 生成 loom.openapi.ts
pnpm exec loom import-openapi https://petstore.example.com/openapi.json
pnpm exec loom import-openapi ./fastapi-openapi.json -o loom.openapi.ts --base http://127.0.0.1:8000
```

```typescript
// loom.app.ts 里一行接入（生成的模块是 AUTO-GENERATED 工具声明 + 真 fetch execute）：
import { registerImportedTools } from './loom.openapi'
const app = defineApp('gis-platform', { model: 'deepseek-v4-flash' })
registerImportedTools(app)        // 外部 API 变成 Loom 工具：策略/审批/投影照常生效
```

- **导出即运行时校验**：`dslToJsonSchema` 与 runtime 同一套语义——字段级 `required` 提升为 JSON Schema 顶层 `required`，object 补 `additionalProperties: false`（文档写什么，内核就校验什么）；GET/HEAD/DELETE 的复杂 query 值标 `x-loom-query-json` 扩展（JSON 编码字符串，与服务端 parseScalar 对称）；`500` 响应如实文档化 `{ok:false, error, tool}` 形状。
- **导入诚实降级**：本地 `$ref` 展开、allOf 浅合并、可空联合落标量；anyOf 混合分支/format/min·max 约束等 Loom DSL 不覆盖的部分**降级为 `{type:'json'}` 或裸类型并在对应行上方留 `// WARN(openapi-import)` 注释**——宁可少承诺，不可静默错 schema。路径参数 `{id}` 转必填输入字段；写操作（POST/PUT/PATCH/DELETE）声明上方给 `app.policy` 配 approve 的建议注释；securitySchemes 检测后生成 `LOOM_IMPORT_TOKEN` 认证注入位。
- **自举往返已验证**：`examples/gis/tests/openapi-roundtrip.e2e.test.ts` 起 gis 服务 → fetch 活文档 → 导入生成 → tsx 动态 import → 注册 mini app → 直调 execute（region='连河村'）→ 断言 `totalAreaSqm === 57351531.17`——零 key、真端点、真数据。
- **路由治理**：`.http()` 工具的路由推导收敛到唯一的 `httpRouteOf`（runtime 注册、health 清单、client 生成器、openapi 生成器四处共用）；自定义 path 含 `{` 在声明期即 throw（路径参数暂不支持，请转为 query/body 输入字段）。

## Python 工具桥（M6）

**内核保持 TypeScript，Python 成为一等工具作者语言。** 统计计算、数据科学、既有
Python 资产——直接用 Python 写工具，一行声明挂进应用：模型立即看得见、调得到，
策略/审批照常生效。完整上手（安装/装饰器/推断规则表/取消与错误语义/stdout 污染
警告/已知边界）见 [docs/python-tools.zh.md](docs/python-tools.zh.md)。

```python
# py_tools.py（纯标准库；类型注解自动推断 JSON Schema）
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages" / "loom-py"))
from loom_py import tool, run

@tool("统计全镇村庄占比的均值与标准差", output_schema={
    "type": "object",
    "properties": {"meanRatioPct": {"type": "number"}, "stdRatioPct": {"type": "number"}},
    "required": ["meanRatioPct", "stdRatioPct"],
})
def gis_area_stats(precision: int = 2) -> dict:
    ...   # statistics 模块算标准差

run()   # 末尾进入 stdio 协议主循环
```

```typescript
// loom.app.ts 里一行接入
app.python({ command: 'python py_tools.py' })   // spawn 子进程握手 → 清单注册为代理工具
```

- **自定轻协议**（loom-py v1，stdio JSON Lines）：TS 桥 spawn 子进程 → `initialize`
  握手 → `tools/list` 清单 → `tools/call` 转发 `{name,args,callId}` → `{value}|{error}`；
  取消是尽力而为的 `tools/cancel` 通知。清单校验（name 合法/必填/重复拒绝）与
  jsonSchema→DSL 转换复用 M5 的 `jsonSchemaToDsl`（required 下沉、诚实降级）。
- **进程韧性**：异常→结构化错误（类型 + traceback 最内帧，内核转 isError 工具结果，
  模型可自行纠正）；进程退出→在途调用清晰失败 + 1s 后自动重启（上限 3 次，超出
  unavailable + fail-loud 日志）；握手失败→boot 直接失败。
- **零依赖纪律**：`loom_py` 包纯标准库（pydantic 仅"可用则增强"schema 推断），
  `python -m loom_py.selftest` 一条命令自测；假子进程集成测试（node 模拟 python
  stdio）不依赖真 Python，CI 永远可跑。
- **与 OpenAPI 导入的关系**：互补——`loom import-openapi` 挂**已有 HTTP 服务**
  （任何语言的文档），`app.python` 让**新业务逻辑直接用 Python 写**（无 HTTP 面，
  子进程往返零网络）。同一应用可同时用。
- **v1 边界**：Python 工具仅模型面孔（无 `.http()`/客户端生成/OpenAPI 导出）；
  全部 agent 共享；单桥；stdout 只允许协议行（print 会污染协议，调试写 stderr）。

## 记忆与多用户（M7）

**重启不失忆。** 会话创建即登记 sidecar 索引；服务重启后路由遇到未命中的
sessionId 先查索引、再 `agents.resume`（persona 与作用域工具跟创建时完全相同），
历史完整重放、同一个 sessionId 直接续聊。前端 `SessionList` 列出历史会话，
点击继续、按钮新建；`useAgentSession` 把会话 id 存在 localStorage，刷新页面
自动重连重放。

**一行声明多用户。** `app.auth()` 后：匿名访客自动获得 UUID，`POST
/~loom/auth/register|login` 可注册本地账号（scrypt + HMAC token，零第三方依赖）；
无身份的写请求 401，会话与记忆按 userId 隔离（他人的 → 404 不泄露存在性），
审批答复仅属主。SSE 支持 `?token=`/`?user=` query（EventSource 不能带头）。

**loom memory：记住用户，回答像老朋友。** `app.memory()` + agent 级
`memory: true` 显式开启（提取花 token，默认关）：

```ts
app.auth()
app.memory({ extraction: { maxPerTurn: 3 } })
app.agent('data-analysis', { persona: '…', tools: […], memory: true })
```

- **写路径**（mem0 v2 两阶段）：turn 完成后每会话串行异步跑——先提取候选
  `{kind, content}`，再对照 FTS 相似记忆决策 ADD/UPDATE/DELETE/NOOP，落
  `.loom/memory.db`（node:sqlite FTS5，零新依赖，中文 bigram 分词）；
- **读路径**：会话首条用户消息时 FTS top-K 召回，包在防注入框里以
  `form:'recall'` 注入下个 pre-step（不额外唤醒模型）；
- **模型工具**：memory_search / memory_write / memory_forget（forget 建议
  policy 配 approve）；
- **面板**：`MemoryPanel` 搜索/编辑/删除自己的记忆。

详见 [docs/auth.zh.md](docs/auth.zh.md) 与 [docs/memory.zh.md](docs/memory.zh.md)。

## 测试与 CI

```bash
pnpm test          # 单测 + 无 key 冒烟 + 审批/委派/客户端/OpenAPI 往返/Python 桥/QA 矩阵 e2e（e2e 无 DEEPSEEK_API_KEY 时自跳过；Python 真链测试无 python 时自跳过；假子进程测试永远可跑）
pnpm test:unit     # 纯函数单测（策略编译器、compose、SSE 投影、聊天折叠、webhook/子智能体编译器、客户端生成器、openapi 导出/导入生成器、评测、python 桥协议/清单/映射）
pnpm test:e2e      # 真 key 审批链 + 委派链/webhook 链 + 生成客户端实调真实服务 + Python 工具链
pnpm eval:gis      # transcript 评测（零网络零 key）
pnpm openapi:gis   # 重新生成 examples/gis/openapi.json
pnpm typecheck
```

CI 在 `.github/workflows/ci.yml`（pnpm + Node 24 + 冻结锁表安装 + 构建 + 类型检查 + 测试 + 类型化客户端新鲜度门与 OpenAPI 导出新鲜度门（`loom client` / `loom openapi` 生成后 `git diff --exit-code` 必须无 diff）+ transcript 评测 + vite 构建；配置了 `DEEPSEEK_API_KEY` secret 时额外跑真 key e2e，不打印 key）。**推送到 GitHub 后 CI 自动生效。**

## 插件生态与钉版（M8）

Loom 在 dsh-plugin 生态中既是**消费者**也是**生产者**——详见 [docs/plugin-ecosystem.zh.md](docs/plugin-ecosystem.zh.md)：

- **消费**（全部钉精确 `0.1.0-rc.6`）：`dsh-session-query-sqlite` + `dsh-tool-session-query`（模型面 session_search 会话历史检索，带 key e2e 证明模型真实调用）与 `dsh-host-frontend-static`（`loom start` 的生产静态服务，占 webserver 的 SPA fallback 单席；已验证：同端口 `/` 200、SPA 回落 200、health 200、穿越 403、非 GET 405）。评估未接入：`dsh-session-log-export`（浏览器 /export ZIP 命令，与 Loom 程序化 --slim 管线非同构）。
- **生产**（workspace 包，本阶段不发布 npm）：[`dsh-python-tools`](../packages/python-tools)——Python 工具桥（含 openapi-import 复用的 jsonSchemaToDsl 转换器）；[`dsh-web-approval-answerer`](../packages/web-approval-answerer)——SSE 审批 answerer（重连留档重发、并发 409、超时 fail-closed）。两包均带 `dsh-plugin` 关键字、MIT、中英 README、独立单测；compose 从 `@loom-sdk/web` 的依赖关系解析入口 URL，应用侧无需声明依赖。
- **钉版纪律**：所有 `@deepseek-ai/*` 依赖一律写死精确版本。事实：这些包的 npm `latest` dist-tag 目前普遍指向旧的 `0.0.1-rc.x`（rc.1/rc.3/rc.5），浮动解析会静默装到半年前的版本。升级（如未来的 rc.7）是事件不是漂移：整批同升 + 全量 e2e 通过才合入，禁止混版。

## 许可证

[MIT](LICENSE)

## 快速开始

需要 Node.js ≥ 22.13（node:sqlite 稳定免 flag 的下界，M7 起 memory 依赖它）与 pnpm ≥ 10。仓库根目录执行：

```bash
pnpm install
pnpm build:sdk                 # tsc 编译 @loom-sdk/web

cd examples/gis
# 在 .env 写入你的密钥：DEEPSEEK_API_KEY=sk-...
pnpm loom dev                  # 一条命令：智能体服务（4620）+ Vite 前端（5173）
                               #   --no-web 跳过前端；保存 loom.app.ts 即热重启服务
```

生产同样是同一形态——一个进程一个端口：

```bash
pnpm loom build                # vite build → dist/
pnpm loom start                # dist/ 与 API 同端口（4620，SPA fallback）
```

从零生成一个新应用也是一条命令（在有 loom 可执行文件的目录，如 examples/gis）：

```bash
pnpm exec loom new ../my-app   # 生成 loom.app.ts + 前端骨架
cd ../my-app && pnpm i && pnpm loom dev
```

打开 http://localhost:5173，选择一个数字员工（数据分析 / 数据治理 / 专题报告），输入如“查询所有村庄的地类面积占比，画出饼图，聚焦最大村”——聊天流里会依次出现工具卡片（查询 → 饼图 → 地图聚焦），workspace 投影同步驱动右侧饼图与聚焦面板。体验多智能体协作输入“让研究员核对连河村和太平河村的地类数据，然后汇总差异”——“多智能体”面板同屏直播父会话与研究员的子会话。体验 Python 工具桥输入“用 Python 统计各村占比的均值和标准差”——模型调用 `gis_area_stats`（examples/gis/py_tools.py，statistics 模块算标准差），回复里出现 Python 算出的真实数字（均值 5.31%、标准差 3.83%）。

不开 UI 的接口自检：

```bash
curl http://127.0.0.1:4620/~loom/health
curl -X POST http://127.0.0.1:4620/~loom/agents/data-analysis/sessions
# → { "sessionId": "session-gis-platform-…", "agentId": "data-analysis" }
curl -N "http://127.0.0.1:4620/~loom/agents/data-analysis/sessions/<sessionId>/events?since=-1"   # SSE
curl -X POST -H "content-type: application/json" \
  -d '{"text":"查询所有村庄的地类面积占比，画出饼图，聚焦最大村"}' \
  "http://127.0.0.1:4620/~loom/agents/data-analysis/sessions/<sessionId>/messages"
```

整个应用声明在 `examples/gis/loom.app.ts`（5 工具 + 3 智能体 + 1 投影 + 1 策略 + 1 子智能体 + 1 webhook 通道）；`loom dev` 把这份声明合成为 DeepSeek Harness 组合（`.loom/cordis.yml`，声明了策略时自动加入 user-approval 审批缝，声明了任一子智能体时自动加入 subagent 服务缝 + spawn provider）并启动。

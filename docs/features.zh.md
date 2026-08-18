# Loom 能力详解（features.zh.md）

> 本页内容原为 README 首页章节，为让首页以图为主而迁至此处。配合 [图解手册](diagrams.zh.md) 食用更佳。

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


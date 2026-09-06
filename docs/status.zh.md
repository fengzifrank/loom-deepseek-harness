# Loom 状态与路线图（status.zh.md）

> 状态总览与里程碑详情。当前一句话：**M1-M13 全量交付，测试全绿，已开源。**

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
| **插件生态**：消费——`dsh-session-query-sqlite` + `dsh-tool-session-query`（模型面 session_search，带 key e2e）与 `dsh-host-frontend-static`（替换 loom start 手写 SPA fallback；403/200/405 语义已验证）；生产——`dsh-python-tools`（Python 桥自 web 抽出，含 jsonSchemaToDsl）与 `dsh-web-approval-answerer`（SSE 审批 answerer：留档重发/并发 409/超时 fail-closed）两个 workspace 包（`dsh-plugin` 关键字、MIT、中英 README、独立单测；本阶段不发布 npm）；所有 `@deepseek-ai/*` 依赖钉精确 `0.1.1-rc.1`——见 [docs/plugin-ecosystem.zh.md](docs/plugin-ecosystem.zh.md) | M8 | ✅ |
| **预算治理**：`app.policy({ budgets: [...] })` 量化预算——每会话 `tool-calls`（glob 模式计数，计尝试不计成功，被拒的调用也计数防试探绕过）与 `session-tokens`（assistant 消息 usage 四桶 input/output/cacheRead/cacheWrite 求和）；超限 fail-closed 拒绝（deny）或转人工审批（approve，复用审批门），拒绝理由以工具错误文本模型可见 + `loom/budget-exceeded` SSE 合成事件（每条预算首越限广播一次）+ health 可观测面；策略裁决后预算检查（deny 预算覆盖 allow 策略，approve 预算把放行升级为审批）；v1 边界：计数器内存态重启清零（会话日志保留完整审计）。语义移植自 omnigent 治理层 spend-cap——`packages/web/src/budget.ts`、e2e `examples/gis/tests/budget.e2e.test.ts`（无 key：.http() 面 3 次调用 200/200/403 + 持续 fail-closed） | M9 | ✅ |
| **模型网关**：`defineApp(name, { provider, providers })` 一行切换模型提供方——预设 `deepseek-official`（缺省，字节级向后兼容）/`ollama`（内网本地，农业 FDE 私有化）/`openrouter`（云端聚合）/`openai-compatible`（vLLM 自建，覆盖自定义路由名）；组合层 `dsh-llm-deepseek` ⇄ `dsh-llm-pi-ai` 多路由自动切换（route 键 = agent-default-model provider 名）；非 catalog 路由 models 目录自动含应用默认 model + 各 agent model 覆盖；无凭据路由自动带匿名 Authorization 占位头（pi-ai OpenAI 兼容协议强制要求 key 或头其一）；凭据只经 apiKeyEnv 引用（机密不进 yml）；声明期收口（未知预设/缺 baseURL/空目录/非法协议 boot 前抛错）——见 [docs/providers.zh.md](docs/providers.zh.md)；e2e `examples/gis/tests/gateway.e2e.test.ts`（mock OpenAI 兼容服务器跑通完整轮次，零 DEEPSEEK key） | M11 | ✅ |
| **MCP 桥接**：`app.mcp(serverName, { transport, ... })` 接入 Model Context Protocol 生态——stdio 子进程 / streamable-http 远程端点，工具以 `mcp__<server>__<rawName>` 注册（Claude Code/Codex 同命名形，内核 dsh-mcp-client：断线退避重连 + 工具列表重同步 + 注册冲突世代回滚 + HMR）；**策略/审批/预算零成本组合**（MCP 工具就是普通工具，过同一 pre-execute 管线）；机密只经 envRef/headerRefs 环境变量名引用（生成 !!js process.env 展开，不进 yml）；声明期校验（serverName 命名约束/传输互斥字段/envRef 合法性）；v1 边界：全局工具层全部 agent 可见（与 Python 桥一致），无 per-server allowlist（policy glob 替代）——见 [docs/mcp.zh.md](docs/mcp.zh.md)；e2e `examples/gis/tests/mcp.e2e.test.ts`（本地 stdio echo 服务器：boot 注册证据 + 带 key 真实模型调用 mcp__echo__say 全链 SSE）；人用示例 `examples/mcp-demo`（filesystem 服务器 + 写审批 + 预算） | M10 | ✅ |
| **技能文件**：`app.skills({ dirs? })` 一行声明（缺省 `skills/`，相对 loom.app.ts）——`<name>/SKILL.md` / 平铺 `<name>.md`（frontmatter 必填 kebab-case name + description）成为模型可加载技能：会话首请求前收到目录摘要（digest 热刷新），按需调 `skill` 工具加载全文（每次加载重读，改正文即时生效）；组合接线内核三插件 dsh-skill / dsh-skill-filesystem / dsh-tool-skill，**隔离模式**（includeDefaultRoots: false，只扫应用声明目录——部署态自包含）；声明期校验（空目录数组/空字符串拒绝）——见 [docs/skills.zh.md](docs/skills.zh.md)；e2e `examples/gis/tests/skills.e2e.test.ts`（无 key 组合段 + 带 key：模型加载 greeting-guide 并按规范回答"施主…祝君安康"） | M12 | ✅ |
| **评估三级判定**：`loom eval` 从二元 pass/fail 升级为 `pass / pass-with-caveats / fail`（oci-agent fully_satisfactory/satisfactory_with_caveats/not_satisfactory 移植）——断言上下文新增 `ev.caveat('…')` 非阻断告警（blocker/warner 二分：断言抛错即 fail 且阻断优先，即使先记了告警；空告警消息 fail-closed）；CLI ✓/⚠/✗ 三态输出 + 汇总含保留计数（只有 fail 退出码 1）；`ok` 字段保持兼容（= verdict !== 'fail'），既有 evals 零改动 | M12 | ✅ |
| **演员-评论家模式**：oci-agent actor-critic 循环的 Loom 表达——critic 子智能体（`tools: []` 纯推理、只输出三级 satisfaction JSON）+ worker persona 承载修订纪律（not_satisfactory 必须修订再复核、最多一次防拉扯、caveats 如实转述）+ 落笔走审批门（LLM 写判定，代码做门禁）；离线孪生即上面的三级 eval——见 [docs/critic-pattern.zh.md](docs/critic-pattern.zh.md) 与示例 `examples/critic-demo`（处方草拟 → 复核 → 修订 → 审批归档） | M12 | ✅ |
| **Semantica 融合**：Loom（执行/策略/审批/预算）× semantica 0.6.8（知识图/判例/因果链/SHACL/溯源）——双路径接入：M6 桥（`examples/semantica-demo/py_tools.py`，7 个类型化 `agri_*` 工具，含 MCP 面没有的 SHACL/溯源；图单写者 graph.json，惰性初始化避开次线程 OpenMP 卡死）与 M10 MCP（`loom.mcp-app.ts` 零代码，15 个 `mcp__semantica__*`，独立 KG 文件）；决策入账挂审批门、判例检索阈值 0.05（中文词面相似度实测 ~0.18，默认 0.5 全灭）；`--selftest` 钉 API 名（README 与实际导出漂移的 fail-loud 保险）+ `semanticaReady()` 守卫（未装 venv 全自跳过）——见 [docs/semantica.zh.md](docs/semantica.zh.md)；e2e 三段：无 key（boot/pythonTools=7/组合行/协议直调命中种子判例+落盘）、带 key（判例→审批卡→allowed-once→decisionId→因果链四证据链）、MCP 变体（failOnStartupError 注册门） | M13 | ✅ |
| ACP 通道接入等后续演进 | Next | ⏳ |


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
| M9 | 预算治理（app.policy budgets：tool-calls / session-tokens 量化预算，超限 fail-closed 或转审批；语义移植自 omnigent 治理层）——✅ 已交付 |
| M11 | 模型网关（provider 一行切换 Ollama/OpenRouter/OpenAI 兼容；组合层接线 dsh-llm-pi-ai 多路由）——✅ 已交付 |
| M10 | MCP 桥接（app.mcp 声明器 + dsh-mcp-client 接线；工具过同一策略/审批/预算管线）——✅ 已交付 |
| M12 | 技能文件（app.skills + dsh-skill 三插件接线，SKILL.md 知识随应用走）+ 评估三级判定（pass/pass-with-caveats/fail，oci-agent 移植）+ 演员-评论家模式（critic 子智能体 + examples/critic-demo）——✅ 已交付 |
| M13 | Semantica 融合（双路径：M6 桥类型化 agri_* 工具 + M10 MCP 零代码；知识图/判例/因果/SHACL/溯源接入 Loom 治理管线；examples/semantica-demo）——✅ 已交付 |


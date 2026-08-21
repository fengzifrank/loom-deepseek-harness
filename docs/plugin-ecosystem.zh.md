# dsh-plugin 生态：Loom 的消费与生产（M8 Phase B）

> 状态：**已实施**（2026-08 交付）。本文回答三个问题：Loom 消费了内核生态
> 哪些官方插件；Loom 自己生产了哪些插件、为什么值得独立成包；以及贯穿两者
> 的供应链纪律——**为什么所有 `@deepseek-ai/*` 依赖一律钉精确版本**。

## 一、背景：生态扫描结论（调研事实）

接入生态前先摸底（2026-08 调研，结论已验证）：

- **规模**：GitHub 上与 DeepSeek Harness 内核同源生态（dsh-* / deepseek-harness
  topic）实际约 **6850 个仓库**——但绝大多数是内核本体、示例与应用层复刻，
  **可作为独立依赖消费的插件包**只有官方 `@deepseek-ai/dsh-*` 一个序列；
- **记忆方向**：搜到约 **226 个**"agent memory"相关项目，**没有与 Loom 同构
  的声明式、按 userId 隔离、FTS 召回 + 防注入框的记忆组件**——mem0/LangChain
  Memory 等均为库形态而非宿主插件，故 M7/M8 的 loom memory 选择自研而非适配；
- **Python 工具桥**：**空白**——没有把 Python 子进程工具清单桥进内核工具层
  的现成插件，`dsh-python-tools`（M8 抽出）是该生态位的第一件；
- **人审 answerer**：**空白**——内核有 `approval/request` 审批缝（dsh-user-approval），
  但"把审批缝路由成宿主 Web 前端审批卡"的 answerer 无先例，
  `dsh-web-approval-answerer`（M8 剥离）同样占生态位第一件；
- **rc 漂移风险**：官方包的 npm `latest` dist-tag 普遍**落后于实际可用版本**
  （2026-08-21 实测：dsh-tool-session-query / dsh-session-query /
  dsh-session-query-sqlite 的 latest 指向 0.0.1-rc.1，dsh-host-frontend-static
  指向 0.0.1-rc.3，dsh-session-log-export 指向 0.0.1-rc.5，连 dsh-app-boot 的
  latest 也只指向 0.1.0-rc.6，而 Loom 当前钉的是 `0.1.1-rc.1`，全部经由
  `next` dist-tag 发布）。
  不钉版装 `latest` 会装到半年前的旧版——这是钉版纪律的直接动因。

## 二、消费侧清单（Loom 组合里的官方插件）

`loom dev`/`loom start` 生成的 `cordis.yml` 中的官方件（全部钉 `0.1.1-rc.1`）：

| 插件 | 用途 | 引入阶段 |
| --- | --- | --- |
| `@deepseek-ai/cordis-plugin-logger-console` | 日志 | M1 |
| `@deepseek-ai/dsh-llm` + `dsh-llm-deepseek` | 模型接入（apiKeyEnv 每请求解析） | M1 |
| `@deepseek-ai/dsh-session` + `dsh-session-persistence-jsonl` | 会话日志持久化（.loom/sessions） | M1 |
| `@deepseek-ai/dsh-system-prompt` / `dsh-tools` / `dsh-agent` / `dsh-agent-default-model` / `dsh-agent-loop` | 内核运行时基座 | M1 |
| `@deepseek-ai/dsh-user-approval` | 审批缝（app.policy 声明时加入） | M2 |
| `@deepseek-ai/dsh-subagent` + `dsh-subagent-spawn-in-process` | 子智能体服务缝（app.subagent 声明时加入） | M3 |
| `@deepseek-ai/dsh-host-webserver` | 宿主 HTTP/SSE 服务 | M1 |
| `@deepseek-ai/dsh-session-query-sqlite` + `dsh-tool-session-query` | **会话历史查询**：ctx.sessionQuery（SQLite FTS5，索引落 .loom/session-query.db）+ 模型面工具 session_search / session_event_search / session_trace / session_event_trace / session_event_read | M8 B1 |
| `@deepseek-ai/dsh-host-frontend-static` | **生产静态服务**（loom start）：占用 webserver 的 SPA fallback 单席——穿越 403 / 未命中回落 index.html 200 / 非 GET\|HEAD 405；替代了 runtime 曾手写的 SPA fallback | M8 B1 |

**B1 接入证据**：

- session_search——`examples/gis/tests/session-query.e2e.test.ts`（带 key：
  会话 A 聊独特话题 → 会话 B 模型真实调用 session_search 命中；无 key：boot
  即激活 + 索引文件落盘）；
- frontend-static——`loom build && loom start` 实测同端口：
  `GET /` 200（text/html）、SPA 回落 `GET /villages/...` 200（index.html）、
  `GET /~loom/health` 200、非 GET 405、编码穿越 `..%5c` 403。

**评估过但不接入**：`@deepseek-ai/dsh-session-log-export`（0.1.1-rc.1 存在）。
它是浏览器侧 `/export` 聊天命令（Session log ZIP 下载，经 ApiProxy 宿主端点），
与 Loom `loom eval --slim` 的**程序化** slim 转录导出（纯函数管线，服务端读
jsonl 折叠成夹具）非同构——不适配，不替换，记录在此。

## 三、生产侧清单（Loom 产出的插件包）

M8 Phase B 把两个宿主内嵌实现抽成独立 workspace 包（**本阶段不发布 npm**；
包名已按生态惯例预留）：

| 包 | npm 名 | 内容 | 从哪剥离 |
| --- | --- | --- | --- |
| packages/python-tools | `dsh-python-tools` | Python 工具桥（loom-py v1 协议）：spawn 子进程握手，@tool 清单注册为代理工具；崩溃自动重启（上限 fail-loud）、超时/abort 尽力取消；含 `jsonSchemaToDsl` 反向转换器（M5 同一实现，openapi-import 复用） | web/src/python-bridge.ts（原处保留薄 re-export 兼容既有导入方） |
| packages/web-approval-answerer | `dsh-web-approval-answerer` | SSE 审批 answerer：approval/request → 宿主 SSE 审批卡 + 待审批留档重发（重连幂等）+ 答复裁决（并发 409 / 错会话 403 / 未知 404 / 非法 400）+ 超时 fail-closed | runtime.ts 内嵌实现（runtime 保留 HTTP 线形与身份门，语义全在插件） |

两包形态齐备：named exports（name/inject/apply/Config）、peerDependencies 钉
`@deepseek-ai/cordis ^4.0.1`、MIT、`keywords: ['dsh-plugin', …]`、中英 README、
独立单测（假子进程链 / mock 宿主桥，零 cordis 启动）。compose 经
`createRequire().resolve()` 从 `@loom-sdk/web` 的依赖关系解析入口
file:/// URL——应用侧无需直接声明依赖。

**为什么值得抽包**：Python 工具桥与人审 answerer 都是"内核无件、生态空白"
的能力（见扫描结论）——内嵌在 Loom 宿主里只有 Loom 应用能用；抽成 dsh-plugin
后，任何 DeepSeek Harness 应用（不止 Loom）都能直接消费。Loom 由纯消费者
变成生态生产者，同时自己的 web 包变小（react-ui 等仍留在宿主）。

## 四、供应链纪律（钉版策略）

1. **一律精确钉版**：所有 `@deepseek-ai/*` 依赖写死 `0.1.1-rc.1`（无 `^`/`~`）。
   事实依据：npm `latest` dist-tag 普遍指向旧版（0.0.1-rc.1/rc.3/rc.5，
   dsh-app-boot 也仅指 0.1.0-rc.6），浮动解析会**静默降级**到功能缺失的
   半年前版本；
2. **升级是事件，不是漂移**：升级（2026-08-21 已按此纪律完成
   0.1.0-rc.6 → 0.1.1-rc.1 整批同升，后续如 0.1.1-rc.2/正式版同理）必须
   整批同升 + 全量 e2e
   （`pnpm test`：单测 + 无 key 冒烟 + 带 key 审批链/委派/webhook/session_search/
   path-memory 全链），green 才合入；禁止只升个别包（内核件之间有协议耦合，
   混版是未定义行为）；
3. **自产包同理**：workspace 内 `dsh-python-tools` / `dsh-web-approval-answerer`
  以 `workspace:*` 被 `@loom-sdk/web` 引用，发布时需同步钉 cordis peer 下界，
  并过与官方件相同标准的 e2e；
4. **锁文件提交**：pnpm-lock.yaml 进库，任何依赖变更走 PR 审阅 diff。

## 五、对照表：生态位 → Loom 的选择

| 生态位 | 内核/生态已有 | Loom 的选择 | 理由 |
| --- | --- | --- | --- |
| 会话历史查询 | dsh-session-query-sqlite + dsh-tool-session-query（官方） | **消费** | 同构，直接用；e2e 证明模型面 session_search 可用 |
| 生产静态服务 | dsh-host-frontend-static（官方） | **消费** | 语义完整（403/200/405），替换手写 fallback |
| 会话日志导出（浏览器 ZIP） | dsh-session-log-export（官方） | 不接（不适配） | Loom 需要程序化 slim 管线，非浏览器下载命令 |
| 记忆 | mem0 等库形态（非插件） | **自研**（M7/M8） | 无同构声明式/按 userId 隔离/FTS+防注入框插件 |
| Python 工具桥 | 无 | **自研并抽包**（dsh-python-tools） | 生态空白；抽包后反哺生态 |
| 人审 answerer | 无 | **自研并抽包**（dsh-web-approval-answerer） | 生态空白；安全关键语义独立可审计 |

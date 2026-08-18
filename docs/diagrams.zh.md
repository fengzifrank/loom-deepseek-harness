# Loom 图解手册（diagrams.zh.md）

> 一图胜千言。本页用 **Mermaid** 精确表达架构与数据流（GitHub 原生渲染，源码可维护）；
> 两张"给人看"的手绘 SVG 概览图见 [docs/img/](img/)。
> 所有图都可以点开 mermaid 源码改——这本身就是"文档即代码"。

---

## 1. 五层架构：Loom 站在巨人肩膀上

```mermaid
flowchart TD
    L5["L5 你的应用<br/>业务工具 · persona · 投影 · 页面<br/><i>（gis / legacy-erp / fastapi-admin）</i>"]
    L4["L4 投影与客户端层<br/>useAgentSession · useProjection<br/>SSE 协议 · 类型化客户端"]
    L3["L3 声明层（Loom 本体）<br/>defineApp · tool · agent · projection<br/>policy · memory · python · channel"]
    L2["L2 DeepSeek Harness 内核<br/>会话日志 · agent-loop · 工具管线<br/>LLM 适配 · 审批 · 多智能体 · 持久化"]
    L1["L1 Cordis 框架基座<br/>IoC + 类型化事件 + 可逆副作用"]
    L5 --> L4 --> L3 --> L2 --> L1
```

**大白话**：你只写最上面一层（声明业务），下面四层都是现成的。依赖铁律：Loom 只依赖内核的 Service Definitions，永不绑具体实现——所以模型、沙箱、持久化随时可换。

---

## 2. 一份声明，三张面孔（A1 公理）

```mermaid
flowchart LR
    D["app.tool('query_land')<br/>.input() .output()<br/>.card() .http() .execute()"]
    D --> M["🎯 模型面孔<br/>agent 可调用<br/>schema 进提示词"]
    D --> H["🌐 HTTP 面孔<br/>GET /~loom/api/query_land<br/>走完整工具管线"]
    D --> C["📦 客户端面孔<br/>loom client 生成<br/>前端编译期类型检查"]
    style D fill:#1a2336,stroke:#4f8cff,color:#dbe4f3
```

**大白话**：写一次，得三个。后端改了工具签名 → 重新生成 → 前端**编译期**立刻报错。这就是 FastAPI"一个装饰器=路由+校验+文档"的智能体时代版本。

---

## 3. 一条消息的一生（核心时序）

```mermaid
sequenceDiagram
    autonumber
    participant U as 浏览器前端
    participant R as Loom runtime(:4645)
    participant L as 会话日志(唯一事实)
    participant A as Agent(回合循环)
    participant T as 工具管线
    U->>R: POST /agents/x/sessions/:id/messages
    R->>L: ① user/message 落日志(永不丢)
    R->>A: followup() 唤醒
    loop 每个 step
        A->>L: ② 从日志派生上下文 deriveMessages()
        A->>A: ③ 打给模型(deepseek-v4-flash)
        A->>L: ④ assistant/chunk 逐字落日志
        A->>T: ⑤ 模型要调工具
        T->>T: ⑥ 策略口子 allow/deny/approve
        T->>L: ⑦ tool/call + tool/result 落日志
    end
    A->>L: ⑧ turn/end(结局落日志)
    L-->>U: ⑨ SSE 直播全程(seq 连续编号)
    U->>U: ⑩ 投影：文字/卡片/图表/任务
```

**大白话**：前端只是传话筒+显示器；一切事实先进日志再流向任何地方——所以**刷新=重放、断线=按 seq 续传、事后=逐字节回放审计**。

---

## 4. 会话日志：唯一事实来源

```mermaid
flowchart LR
    LOG[("会话日志<br/>append-only 事件流<br/>seq 严格连续")]
    LOG --> D1["deriveMessages()<br/>→ 模型上下文"]
    LOG --> D2["SSE 投影<br/>→ 前端界面"]
    LOG --> D3["sessions.fork<br/>→ 从任意时刻分叉"]
    LOG --> D4["resume<br/>→ 重启恢复会话"]
    LOG --> D5["eval 夹具<br/>→ 回归测试资产"]
    LOG --> D6["审计<br/>→ 谁在何时做了什么"]
    style LOG fill:#1a2336,stroke:#7c5cff,color:#dbe4f3
```

**大白话**：六个消费者共享一份事实。这就是"transcript is the contract"——审计、调试、评测、分叉全是读日志，不需要第二套系统。

---

## 5. 审批闭环（fail-closed）

```mermaid
sequenceDiagram
    autonumber
    participant M as 模型
    participant P as 策略口子(tools/pre-execute)
    participant S as SSE
    participant H as 人类
    participant X as 工具执行
    M->>P: 调用 gis_update_land_note
    P->>P: 匹配规则 *_update_* → approve
    P->>S: loom/approval-asked(推审批卡)
    S->>H: 页面弹出[允许/拒绝]
    alt 人类点允许
        H->>X: POST allowed-once
        X->>X: 执行 → 真实写库
    else 人类点拒绝 或 5 分钟无应答
        X->>X: fail-closed → 工具失败, 数据分毫不动
    end
```

**大白话**：写操作必须过人这关；没人应答=自动拒绝（不是放行）。断线重连会**重发未决审批卡**（幂等，不复活已决卡）。

---

## 6. 记忆系统三层

```mermaid
flowchart TD
    subgraph 会话内记忆[第 1 层：会话内 - 内核原生]
        S1[会话日志+压缩+持久化<br/>重启可恢复 可分叉]
    end
    subgraph 语义记忆[第 2 层：跨会话语义 - app.memory]
        E[回合结束] --> EX[阶段一：提取候选事实]
        EX --> DEC[阶段二：与相似旧记忆比对<br/>ADD/UPDATE/DELETE/NOOP]
        DEC --> DB[(SQLite FTS5<br/>按用户隔离)]
        DB --> RE[新会话首条消息<br/>FTS top-K 召回]
        RE --> INJ[form:'recall' 注入<br/>防注入框包装]
    end
    subgraph 路径记忆[第 3 层：路径 - paths:true]
        FAIL[任务失败] --> SEARCH[检索历史成功路径]
        SEARCH --> PINJ[注入"待重验路径"]
        PINJ --> VERIFY[重验：先重跑只读步骤]
        VERIFY -->|成功| UP[confidence+0.1<br/>verified_at 刷新]
        VERIFY -->|失败| DOWN[confidence×0.5<br/>连续失败→软删]
    end
```

**大白话**：第 1 层白送；第 2 层记"事实偏好"（你说"记住我偏好中文报告"，下个会话它还记得）；第 3 层记"怎么做成过一件事"——失败时翻出旧路，但**必须重验才能复用**，路径会"风化"。

---

## 7. 多用户隔离

```mermaid
flowchart LR
    subgraph 用户们
        A[alice]
        B[bob]
        N[匿名 UUID]
    end
    A & B & N --> AUTH[resolveUser<br/>Bearer token / x-loom-user]
    AUTH --> OWN{会话归属校验}
    OWN -->|自己的| OK[正常读写]
    OWN -->|别人的| R404[404 会话不存在<br/>连存在都不泄露]
    AUTH --> MEM[记忆按 userId 隔离]
    AUTH --> APR[审批只认 owner]
```

**大白话**：三套资产（会话/审批/记忆）全部按人隔离。别人的东西不是"403 禁止"而是"404 不存在"——不告诉外人这里有个宝藏。

---

## 8. OpenAPI 双轨互通

```mermaid
flowchart TD
    subgraph 存量路[存量路：老系统进来]
        FA[FastAPI 老系统<br/>/openapi.json] --> IMP[loom import-openapi]
        IMP --> GEN[生成工具声明<br/>诚实降级+WARN]
        GEN --> REG[registerImportedTools 一行接入]
    end
    subgraph 新建路[新建路：Loom 走出去]
        DECL[.http() 工具声明] --> EXP[loom openapi]
        EXP --> DOC[OpenAPI 3.1.0 文档<br/>+ 运行时活文档端点]
        DOC --> ECO[Swagger/网关/<br/>其他 agent 框架]
    end
```

**大白话**：老系统不用改一行代码就能获得"模型面孔+审批"；你的 Loom 应用也能一键变成标准 OpenAPI 服务被全世界调用。

---

## 9. 三路老系统接入决策图

```mermaid
flowchart TD
    Q{你的老系统长什么样?}
    Q -->|有 API 且有 OpenAPI 文档| R1[路 1：loom import-openapi<br/>一键生成工具<br/>✅ fastapi-admin 实录]
    Q -->|有 API 但没文档| R2[路 2：手写工具包装<br/>10 行 fetch + 认证注入<br/>✅ legacy_relogin 登录桥]
    Q -->|连 API 都没有 只有数据库| R3[路 3：node:sqlite 只读直连<br/>✅ legacy-erp 库存审计]
    R1 & R2 & R3 --> G[统一享受：审批/日志/回放/记忆]
```

**大白话**：无论老系统多老，总有一条路进来。进来之后，治理能力一视同仁。

---

## 10. Python 工具桥

```mermaid
sequenceDiagram
    autonumber
    participant M as 模型
    participant TS as TS 桥接插件
    participant PY as Python 子进程(loom_py)
    Note over PY: 启动时：@tool 清单<br/>类型注解→JSON Schema
    TS->>PY: 握手 tools/list
    PY-->>TS: 工具清单
    TS->>M: 代理工具注册(模型可见)
    M->>TS: 调用 gis_area_stats
    TS->>PY: {name, args, callId}
    PY->>PY: statistics.stdev(...)
    PY-->>TS: {value} / {error}
    TS-->>M: 结果(照落会话日志)
    Note over TS,PY: 崩溃→自动重启(上限3) fail-loud
```

**大白话**：TS 写框架和前端，Python 写工具（geopandas/sklearn 随便用）——两种语言，同一个日志内核，审批照常生效。

---

## 11. 时间旅行回放调试

```mermaid
flowchart LR
    subgraph 调试面板
        LIST[事件流列表<br/>seq/type/name] --> SLIDE[滑块选任意 seq]
        SLIDE --> SNAP["此刻状态快照<br/>(纯函数折叠 events≤seq)"]
        SNAP --> FORK[从此点分叉按钮]
    end
    FORK --> F[POST fork {atSeq}]
    F -->|turn 边界| NEW[新会话:前缀逐事件一致]
    F -->|turn 中间| E400[400 OPEN_TURN+提示]
```

**大白话**：线上出问题，拖回去看"当时模型看到了什么"——不是模拟，是事实重放（请求可从日志逐字节重建）。

---

## 12. 插件生态：消费 + 生产

```mermaid
flowchart TD
    subgraph 消费[消费：用内核官方件]
        C1[tool-session-query<br/>模型搜历史会话]
        C2[frontend-static<br/>生产静态服务]
        C3[user-approval<br/>审批缝]
    end
    subgraph 生产[生产：回馈生态]
        P1[dsh-python-tools<br/>Python 工具桥<br/>社区空白]
        P2[dsh-web-approval-answerer<br/>SSE 人审桥<br/>内核刻意留白]
    end
    消费 --> LOOM[Loom]
    LOOM --> 生产
    生产 -.-> ECO[dsh-plugin 生态<br/>6850+ 仓库]
```

**大白话**：不只是拿，也给。我们抽出的两个插件包正是社区缺的位——这就是"万物皆插件"的另一半。

---

## 13. CI 六道门

```mermaid
flowchart LR
    A[pnpm install<br/>--frozen-lockfile] --> B[build:sdk]
    B --> C[typecheck×3]
    C --> D[test 全量]
    D --> E[client 新鲜度门<br/>git diff --exit-code]
    E --> F[openapi 新鲜度门]
    F --> G[eval:gis 5/5]
    G --> H{有 DEEPSEEK_API_KEY?}
    H -->|有| I[e2e 真 key 三链]
    H -->|无| J[自动跳过不红]
```

**大白话**：改了声明忘了重新生成客户端？CI 直接挂。会话行为变了？transcript 重放断言会抓到。

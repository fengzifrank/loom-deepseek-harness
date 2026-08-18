/**
 * Loom M1 公共类型：ToolSpec / AgentSpec / ProjectionSpec / AppSpec。
 *
 * 这些是"声明"形态——作者在 loom.app.ts 里写下的内容；runtime 插件
 * （./runtime.ts）负责把它们映射到 DeepSeek Harness 的内核机制
 * （defineTool / agents.create 的 setup / session-event 订阅）。
 * @module @loom-sdk/web
 */

/**
 * defineTool 的 parameters DSL 对象（透传给 @deepseek-ai/dsh-tools）。
 * 形如 `{ region: { type: 'string', description: '...' } }`；
 * 数组/嵌套对象节点同 defineTool 的 DSL（`type:'array'` + `items`，等）。
 */
export type ToolInputDSL = Record<string, unknown>

/**
 * defineTool 的 output.schema DSL 对象（透传）。形如
 * `{ type: 'object', properties: { totalAreaSqm: { type: 'number', required: true } } }`。
 */
export type ToolOutputDSL = Record<string, unknown>

// ---------------------------------------------------------------------------
// InferToolArgs：从 input DSL 字面量推导 execute 入参类型（类型级，零运行时成本）
// ---------------------------------------------------------------------------

/** DSL 属性表的字符串键。 */
type StringKeys<S> = Extract<keyof S, string>

/** DSL 属性表中标了 `required: true` 的键。 */
type RequiredKeys<S> = { [K in StringKeys<S>]: S[K] extends { required: true } ? K : never }[StringKeys<S>]

/** 推导深度计数器（防无限递归；到上限落 unknown）。 */
type NextDepth<D extends unknown[]> = [unknown, ...D]

/**
 * 推导一个 DSL 节点的值类型。比内核 InferValue 宽松两处：
 * - `{ type: 'object' }` 未写 additionalProperties 时按封闭对象（properties）推导；
 * - 无法识别的节点落 `unknown`（不是 never）——运行时校验兜底，作者不被类型卡死。
 */
type InferDslValue<S, D extends unknown[]> =
  D['length'] extends 12 ? unknown
    : S extends { type: 'string' } ? (S extends { const: infer C } ? C : S extends { enum: readonly (infer E)[] } ? E : string)
      : S extends { type: 'number' | 'integer' } ? (S extends { const: infer C } ? C : S extends { enum: readonly (infer E)[] } ? E : number)
        : S extends { type: 'boolean' } ? boolean
          : S extends { type: 'null' } ? null
            : S extends { type: 'array' }
              ? S extends { items: infer I } ? InferDslValue<I, NextDepth<D>>[] : unknown[]
              : S extends { type: 'object' }
                ? S extends { properties: infer P }
                  ? InferDslProperties<P, NextDepth<D>>
                  : Record<string, unknown>
                : S extends { type: 'json' } ? unknown
                  : S extends { oneOf: readonly unknown[] } ? InferDslValue<S['oneOf'][number], NextDepth<D>>
                    : unknown

/** 推导 DSL 属性表：required 必填，其余可选字段（Simplify 展平交叉，保 hover 可读与类型等价）。 */
type InferDslProperties<S, D extends unknown[]> = Simplify<
  & { [K in RequiredKeys<S>]: InferDslValue<S[K], D> }
  & { [K in Exclude<StringKeys<S>, RequiredKeys<S>>]?: InferDslValue<S[K], D> }
>

/** 展平交叉为单层映射类型（同态映射保留可选性）。 */
type Simplify<T> = { [K in keyof T]: T[K] }

/**
 * 从 `.input(dsl)` 的字面量 DSL 推导 `.execute(args)` 的入参类型。
 * `{ region: { type: 'string' } }` → `{ region?: string }`；
 * `{ title: { type: 'string', required: true }, items: { type: 'array', required: true, items: {...} } }`
 * → `{ title: string; items: {...}[] }`。
 */
export type InferToolArgs<T> = InferDslProperties<T, []>

/**
 * 从 `.output(dsl)` 的字面量 DSL **根节点**推导工具返回值类型（与 InferToolArgs
 * 对称；`loom client` 生成类型化客户端时用它标注每个工具函数的 Promise 返回）。
 *
 * 语义与内核转换器一致：字段标了 `required: true` 才必填，未标注 → 可选
 * （schemastery 侧 `z.string()` 默认必填、`required(false)` 可选，转换器已如实
 * 写入 `required: true` 标记，这里读的是同一份 DSL）。
 * `{ type: 'object', properties: { totalAreaSqm: { type: 'number', required: true },
 * items: { type: 'array', required: true, items: {...} } } }`
 * → `{ totalAreaSqm: number; items: {...}[] }`（根不是 object 时按节点本身推导）。
 */
export type InferToolOutput<O> = InferDslValue<O, []>

/**
 * 工具执行上下文（defineTool ToolRunContext 的 Loom 子集）。
 * `exec.signal` 是协作式取消信号，长任务必须遵守。
 */
export interface ToolExecContext {
  readonly signal?: AbortSignal
}

/** 工具执行函数：入参经 DSL 校验（execute 里拿精确类型），返回值必须符合 output 声明。 */
export type ToolExecute<A = Record<string, unknown>> = (args: A, exec: ToolExecContext) => Promise<unknown>

/** UI 渲染意图（v1 只实现 generic 卡片的标题透传）。 */
export interface ToolCardSpec {
  kind: 'generic'
  title?: string
}

/** 第二张面孔（HTTP API）声明（M2 生效：runtime 注册 exact 路由）。 */
export interface ToolHttpSpec {
  method: string
  /** 自定义路径（以 / 开头）；缺省由 runtime 用 /~loom/api/<toolName>。 */
  path?: string
}

/** 一个 Loom 工具的完整声明（app.tool(...).execute() 收集的产物）。 */
export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: ToolInputDSL
  readonly output: ToolOutputDSL
  readonly execute: ToolExecute
  readonly card?: ToolCardSpec
  /** 第二张面孔（M2 生效）。 */
  readonly http?: ToolHttpSpec
}

/**
 * 认证声明（M7 生效）：匿名 + 本地账号双模。声明后 runtime 启用
 * 身份解析（Bearer token / x-loom-user）、POST 401 门、会话归属隔离与
 * /~loom/auth 路由；未声明维持 M1-M6 的无身份形态。
 */
export interface AppAuthSpec {
  /** 目前仅 'anon-and-local'（默认）：匿名 UUID + 本地账号并存。 */
  mode?: 'anon-and-local'
  /** CORS 白名单；声明后按 Origin 回显（不再硬编码 *）。 */
  corsOrigins?: string[]
}

/**
 * 记忆声明（M7 生效）：app.memory() 打开 loom memory 能力（.loom/memory.db、
 * 模型工具、/~loom/memories 路由）；agent 还需各自 `app.agent(id, {memory:true})`
 * 显式开启（默认 false——提取花 token，省着用）。
 */
export interface AppMemorySpec {
  /**
   * 写路径开关（两阶段提取/决策）：true → 默认 maxPerTurn 5；
   * 对象 → {maxPerTurn}；缺省 false（不提取，只手工植入/工具写入 + 召回）。
   */
  extraction?: boolean | { maxPerTurn?: number }
  /** 读路径开关（首条消息 FTS 召回注入）：true → 默认 topK 5；对象 → {topK}；缺省开。 */
  recall?: boolean | { topK?: number }
}

/**
 * agent 级记忆开关（M7/M8）：true 打开提取+召回；对象形态 `{ paths: true }`
 * 额外开启 M8 路径记忆（记录任务执行路径、失败时检索注入待重验路径）——
 * 窄开关：不传 paths 的 agent 不记路径（防闲聊也记路径）。
 */
export interface AgentMemoryOptions {
  /** M8 路径记忆开关（默认 false）。 */
  paths?: boolean
}

/** 一个 Loom 智能体的声明（app.agent(id, opts) 收集的产物）。 */
export interface AgentSpec {
  readonly id: string
  /** persona 经 agents.create 的 setup 注册为 deployment:persona system-prompt section。 */
  readonly persona: string
  /** 该 agent 可见的工具名列表；缺省 = 应用全部工具（v1 经 agent 作用域注册实现）。 */
  readonly tools?: string[]
  /** 覆盖应用默认模型（provider 固定取部署级默认路由）。 */
  readonly model?: string
  /** loom memory 总开关（需 app.memory 声明；默认 false——提取花 token）。 */
  readonly memory?: boolean | AgentMemoryOptions
}

/** SSE 白名单事件投影后的载荷（seq 是唯一顺序权威）。 */
export interface ProjectionEvent {
  seq: number
  type: string
  [key: string]: unknown
}

/** 投影声明：init 为初始状态，apply 为纯函数（跑在浏览器，客户端折叠）。 */
export interface ProjectionSpec<S = unknown> {
  readonly name: string
  readonly init: S
  readonly apply: (state: S, event: ProjectionEvent) => S
}

/** 策略声明（M2 生效：编译为 tools/pre-execute 裁决 + 审批桥）。 */
export type PolicySpec = import('./policy.js').PolicySpec

/**
 * Webhook 通道声明（M3 生效：runtime 注册 exact 路由）。
 * 外部系统 POST 一个 JSON payload → map 得到任务文本 → 交给 agent（异步），
 * 立即返回 202 {sessionId}；进度走该会话既有 SSE。
 */
export interface WebhookChannelSpec {
  readonly kind: 'webhook'
  /** 路由路径（以 / 开头；实际挂载在 apiPrefix 下，如 /~loom/hooks/demo）。 */
  readonly path: string
  /** 目标 agent id。 */
  readonly agent: string
  /** payload → 任务文本；抛错或不返回字符串 → 400（不建会话）。 */
  readonly map: (payload: Record<string, unknown>) => string
  /** 声明了才校验 x-loom-signature 头（HMAC-SHA256(rawBody) 十六进制）。 */
  readonly secret?: string
  /** 同 key 复用会话；缺省每次新会话。 */
  readonly sessionKey?: (payload: Record<string, unknown>) => string
}

/**
 * 子智能体声明（M3 生效：编译为按父 agent 作用域注册的委派工具）。
 * 只有 visibleTo 里的父 agent 看得到 `subagent` 工具，且只能 spawn 声明过的
 * 子规格；子 agent 的 provider/model 同父（内核 spawn provider 默认继承）。
 */
export interface SubagentSpec {
  readonly id: string
  /** 子 agent 的 persona（内核 per-child persona 能力，遮蔽部署默认）。 */
  readonly persona: string
  /** 子可见工具名列表（编译为内核 toolFilter allow-list）；缺省 = 应用全部工具。 */
  readonly tools?: string[]
  /** 哪些父 agent 能委派它（空数组 = 无人可见，boot 时报错）。 */
  readonly visibleTo: string[]
}

/**
 * Python 工具桥声明（M6 生效：compose 加 python-bridge 行，spawn Python 子进程
 * 按 loom-py 协议握手，@tool 清单注册为代理工具——模型可见，全部 agent 共享）。
 */
export interface AppPythonSpec {
  readonly kind: 'python'
  /** Python 启动命令（按空格拆 argv，支持引号路径），如 'python py_tools.py'。 */
  readonly command: string
  /** 子进程工作目录（缺省继承当前进程）。 */
  readonly cwd?: string
  /** 附加环境变量（合并进 process.env 后传给子进程）。 */
  readonly env?: Record<string, string>
  /** 进程退出后的自动重启上限（间隔 1s；超出后 unavailable，fail-loud）。默认 3。 */
  readonly restartLimit?: number
  /** 单次工具调用的超时毫秒数。默认 120000。 */
  readonly callTimeoutMs?: number
}

/** 整个应用的声明形态。 */
export interface AppSpec {
  readonly name: string
  readonly model: string
  readonly port: number
  readonly apiPrefix: string
  readonly tools: ToolSpec[]
  readonly agents: AgentSpec[]
  readonly projections: ProjectionSpec[]
  /** 通道（M3 生效）。 */
  readonly channels: WebhookChannelSpec[]
  /** 子智能体（M3 生效）。 */
  readonly subagents: SubagentSpec[]
  /** Python 工具桥（M6 生效；v1 单桥，全部 agent 共享其工具）。 */
  python?: AppPythonSpec
  /** 策略（M2 生效）。 */
  policy?: PolicySpec
  /** 认证（M7 生效；未声明 = 无身份形态，向后兼容）。 */
  auth?: AppAuthSpec
  /** loom memory（M7 生效；agent 级再按 agent.memory 开关）。 */
  memory?: AppMemorySpec
}

/** defineApp 的可选参数。 */
export interface DefineAppOptions {
  /** 默认模型路由（可按 agent 覆盖）。默认 'deepseek-v4-flash'。 */
  model?: string
  /** loom dev 监听端口。默认 4620。 */
  port?: number
  /** API 前缀。默认 '/~loom'。 */
  apiPrefix?: string
}

/** defineApp 返回的应用对象：既是声明收集器，也是默认导出物。 */
export interface App {
  /** 应用名。 */
  readonly name: string
  /** 已收集的完整声明。 */
  readonly spec: AppSpec
  /** 声明一个工具，返回链式 builder。 */
  tool(name: string): ToolBuilder
  /** 声明一个智能体（自动获得 /agents/:id/sessions 路由）。 */
  agent(id: string, opts: { persona: string; tools?: string[]; model?: string; memory?: boolean | AgentMemoryOptions }): App
  /** 声明一个投影（会话事件 → 应用状态）。 */
  projection<S>(name: string, def: { init: S; apply: (state: S, event: ProjectionEvent) => S }): App
  /**
   * 声明 Python 工具桥（M6 生效）：spawn Python 子进程（loom-py 协议：
   * 脚本里 @tool 声明工具、末尾 run() 进入 stdio 主循环），握手后清单注册为
   * 代理工具——模型可见（全部 agent 共享；v1 无 .http()/客户端生成）。
   * 与 tool/agent 的声明顺序无关（Python 工具不参与 agent.tools 引用校验）。
   */
  python(opts: { command: string; cwd?: string; env?: Record<string, string>; restartLimit?: number; callTimeoutMs?: number }): App
  /**
   * 声明策略（M2 生效）：编译为 `tools/pre-execute` 裁决——
   * allow 放行 / deny 拒绝 / approve 走人工审批（SSE 审批卡片 + HTTP 答复，fail-closed）。
   */
  policy(policy: PolicySpec): App
  /**
   * 声明一个通道（M3 生效）。当前支持 webhook：
   * `app.channel.webhook('/hooks/demo', { agent, map, secret?, sessionKey? })`
   * → `POST {apiPrefix}/hooks/demo`（可校验 x-loom-signature）→ 202 {sessionId}。
   */
  channel: {
    webhook(path: string, opts: {
      agent: string
      map: (payload: Record<string, unknown>) => string
      secret?: string
      sessionKey?: (payload: Record<string, unknown>) => string
    }): App
  }
  /**
   * 声明一个子智能体（M3 生效）：编译为按父 agent 作用域注册的 `subagent`
   * 委派工具——只有 visibleTo 里的父 agent 看得到它，且只能 spawn 声明过的
   * 子规格（persona → 内核 per-child persona；tools → 内核 toolFilter）。
   */
  subagent(id: string, opts: {
    persona: string
    tools?: string[]
    visibleTo: string[]
  }): App
  /**
   * 声明认证（M7 生效）：`app.auth({ mode?, corsOrigins? })`——匿名 UUID +
   * 本地账号（POST /~loom/auth/register|login，scrypt + HMAC token，零依赖）。
   * 声明后：无身份的 POST 401；会话按 userId 隔离（不匹配 404 不泄露）；
   * SSE 支持 ?token=/?user= query（EventSource 不能带头）。
   */
  auth(opts?: { mode?: 'anon-and-local'; corsOrigins?: string[] }): App
  /**
   * 声明 loom memory（M7 生效）：`.loom/memory.db`（SQLite FTS5，零新依赖）+
   * 模型工具 memory_search/memory_write/memory_forget + /~loom/memories 路由。
   * extraction 默认关（两阶段提取花 token）；recall 默认开（topK=5）。
   * agent 级需 `app.agent(id, { memory: true })` 显式开启。
   * 建议在 policy 里给 memory_forget 配 approve（删除记忆是破坏性写）。
   */
  memory(opts?: { extraction?: boolean | { maxPerTurn?: number }; recall?: boolean | { topK?: number } }): App
}

/**
 * app.tool() 返回的链式 builder；`.execute()` 收尾并返回 App。
 * 泛型 `In` 是 `.input(dsl)` 的字面量 DSL 类型——`.execute(args)` 经
 * `InferToolArgs<In>` 拿到精确入参类型（string/number/数组/嵌套/可选字段）。
 */
export interface ToolBuilder<In = ToolInputDSL> {
  description(text: string): ToolBuilder<In>
  /** 输入：defineTool parameters DSL 对象（字面量类型全程携带）。 */
  input<const T extends ToolInputDSL>(dsl: T): ToolBuilder<T>
  /** 输出（schemastery 重载）：`.output(z.object({...}))` 自动转 JSON Schema，required 由可选性推导。 */
  output(schema: import('./schema.js').LoomZSchema): ToolBuilder<In>
  /** 输出（原生 JSON Schema DSL 入口，保留 M1-M3 兼容）。 */
  output<const O extends ToolOutputDSL>(dsl: O): ToolBuilder<In>
  /** UI 渲染意图；v1 只实现 'generic' 的标题透传。 */
  card(kind: 'generic', opts?: { title?: string }): ToolBuilder<In>
  /** 第二张面孔（M2 生效）：为该工具注册 HTTP 路由（缺省 /~loom/api/<toolName>）。 */
  http(method: string, path?: string): ToolBuilder<In>
  execute(fn: ToolExecute<InferToolArgs<In>>): App
}

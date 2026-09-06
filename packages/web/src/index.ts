/**
 * defineApp(name, opts) —— Loom 应用的声明入口。
 *
 * 用法（loom.app.ts）：
 * ```ts
 * import { defineApp } from '@loom-sdk/web'
 * const app = defineApp('gis-platform', { model: 'deepseek-v4-flash' })
 * app.tool('query_land_types').input({...}).output({...}).execute(fn)
 * app.agent('data-analyst', { persona: '…', tools: ['query_land_types'] })
 * app.projection('workspace', { init: {...}, apply: (s, e) => s })
 * export default app
 * ```
 * `loom dev` 导入本模块的 default 导出，compose 成 cordis 组合并启动。
 * @module @loom-sdk/web
 */

import type {
  AgentMemoryOptions,
  AgentSpec,
  App,
  AppAuthSpec,
  AppMemorySpec,
  AppPythonSpec,
  AppSkillsSpec,
  AppSpec,
  DefineAppOptions,
  LlmProviderOptions,
  McpServerSpec,
  PolicySpec,
  ProjectionEvent,
  ProjectionSpec,
  SubagentSpec,
  ToolBuilder,
  ToolExecContext,
  ToolExecute,
  ToolInputDSL,
  ToolOutputDSL,
  ToolSpec,
  WebhookChannelSpec,
} from './types.js'
import { assertPolicySpec } from './policy.js'
import type { LoomZSchema } from './schema.js'
import { isSchemastery, schemasteryToOutputDsl, warnInputDslIssues, warnOutputDslIssues } from './schema.js'
export { composeCordisYml } from './compose.js'
export type { ComposeOptions } from './compose.js'
export { PROVIDER_PRESETS, PROVIDER_PRESET_NAMES, resolveLlm } from './providers.js'
export type { ResolvedLlm, ResolvedLlmRoute } from './providers.js'

export type {
  AgentMemoryOptions,
  AgentSpec,
  App,
  AppAuthSpec,
  AppMemorySpec,
  AppPythonSpec,
  AppSpec,
  DefineAppOptions,
  InferToolArgs,
  InferToolOutput,
  LlmProviderOptions,
  McpServerSpec,
  PolicySpec,
  ProjectionEvent,
  ProjectionSpec,
  SubagentSpec,
  ToolBuilder,
  ToolCardSpec,
  ToolExecContext,
  ToolExecute,
  ToolHttpSpec,
  ToolInputDSL,
  ToolOutputDSL,
  ToolSpec,
  WebhookChannelSpec,
} from './types.js'
export { generateClient, pascalAlias } from './client-gen.js'
export type { GenerateClientOptions } from './client-gen.js'
export { generateOpenapi, dslToJsonSchema, openapiToJson, OPENAPI_DOC_VERSION } from './openapi-gen.js'
export type { OpenapiDocument } from './openapi-gen.js'
export { httpRouteOf } from './http-route.js'
export type { HttpRouteTool } from './http-route.js'
export {
  generateImportModule,
  jsonSchemaToDsl,
  validateOpenapiDocument,
  parseOpenapiSource,
  snakeCaseOperationName,
} from './openapi-import.js'
export type { GenerateImportOptions, ConvertContext, ImportWarning } from './openapi-import.js'
export {
  slimSessionLog,
  readEventsFile,
  buildEvalContext,
  defineEval,
  runEval,
} from './eval.js'
export type { EvalEvent, EvalToolCall, EvalTurnEnd, EvalExpect, EvalContext, EvalSpec, EvalResult } from './eval.js'
export {
  isSchemastery,
  schemasteryToDsl,
  schemasteryToOutputDsl,
  inputArrayIssues,
  outputRootIssues,
} from './schema.js'
export type { LoomZSchema } from './schema.js'
export {
  compilePolicy,
  globToRegExp,
  assertPolicySpec,
  POLICY_EFFECTS,
  BUDGET_KINDS,
  BUDGET_EFFECTS,
} from './policy.js'
export type { CompiledPolicy, PolicyEffect, PolicyRule, BudgetSpec } from './policy.js'
export { BudgetMeter, describeBudget } from './budget.js'
export type { BudgetUsage, BudgetExceeded } from './budget.js'
export {
  verifyWebhookSignature,
  applyWebhookMap,
  applyWebhookSessionKey,
  webhookSessionId,
} from './webhook.js'
export type { SignatureVerdict, SignatureFailure, MapVerdict, KeyVerdict } from './webhook.js'
export { compileSubagents, denyListForAgent } from './subagent.js'
export type { CompiledSubagents } from './subagent.js'
export {
  TOKEN_TTL_MS,
  ANON_ID_PATTERN,
  USERNAME_PATTERN,
  PASSWORD_MIN,
  atomicWriteJson,
  signToken,
  verifyToken,
  hashPassword,
  safeEqualHex,
  AccountStore,
  resolveIdentity,
  newAnonUserId,
} from './auth.js'
export type { AccountRecord, AccountsFile, LoomIdentity, AccountVerdict } from './auth.js'
export { SessionSidecarIndex, titleOf, TITLE_MAX } from './session-index.js'
export type { SessionIndexRecord, SessionIndexKind, SessionsIndexFile } from './session-index.js'
export { MemoryStore, MEMORY_KINDS, MEMORY_SCHEMA_VERSION, ftsNormalize, ftsMatchExpr } from './memory-store.js'
export {
  PATH_VERIFY_INCREMENT,
  PATH_FAIL_DECAY,
  PATH_SOFT_DELETE_BELOW,
  PATH_REJECTED_CONFIDENCE,
  PATH_DECAY_DAYS,
  nextConfidenceAfterFail,
  pathRankPenalty,
  toolSequenceSignature,
} from './memory-store.js'
export type { MemoryKind, MemoryRecord, MemoryUpsertInput, ExtractionLogRecord, PathUpsertInput, ToolCallShape } from './memory-store.js'
export {
  CANDIDATE_MAX_CHARS,
  PATH_CANDIDATE_MAX_CHARS,
  parseFirstJsonBlock,
  normalizeContent,
  parseExtraction,
  parseDecisions,
  applyDecisions,
  extractionSystemPrompt,
  extractionUserPrompt,
  decisionSystemPrompt,
  decisionUserPrompt,
  renderRecallContext,
  renderPathRecallContext,
  buildPathRecallMessage,
  shortSessionId,
} from './memory.js'
export type { MemoryCandidate, MemoryOperation, MemoryDecision, MemoryWriteOps, DecisionSummary } from './memory.js'
export {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  HANDSHAKE_TIMEOUT_MS,
  RESTART_INTERVAL_MS,
  DEFAULT_RESTART_LIMIT,
  DEFAULT_CALL_TIMEOUT_MS,
  LOOM_PYTHON_SERVICE,
  parsePythonCommand,
  encodeFrame,
  createLineDecoder,
  validateInitializeResult,
  validatePythonManifest,
  pythonEntryToToolDef,
  normalizePythonDsl,
  PythonBridge,
} from './python-bridge.js'
export type {
  PythonToolEntry,
  ProxyToolDefinition,
  PythonToolForwarder,
  BridgeLogger,
  PythonBridgeOptions,
  PythonBridgeStatus,
  PythonBridgeConfig,
  LoomPythonService,
} from './python-bridge.js'

/** 默认 API 前缀。 */
export const DEFAULT_API_PREFIX = '/~loom'
/** 默认监听端口。 */
export const DEFAULT_PORT = 4620
/** 默认模型路由。 */
export const DEFAULT_MODEL = 'deepseek-v4-flash'

/**
 * 声明一个 Loom 应用。收集 tool/agent/projection/policy 声明，
 * 供 `loom dev`（CLI）与 loom-runtime（cordis 插件）消费。
 */
export function defineApp(name: string, opts: DefineAppOptions = {}): App {
  const spec: {
    name: string
    model: string
    port: number
    apiPrefix: string
    tools: ToolSpec[]
    agents: AgentSpec[]
    projections: ProjectionSpec[]
    channels: WebhookChannelSpec[]
    subagents: SubagentSpec[]
    python?: AppPythonSpec
    policy?: PolicySpec
    auth?: AppAuthSpec
    memory?: AppMemorySpec
    provider?: string
    providers?: Record<string, LlmProviderOptions>
    mcps?: McpServerSpec[]
    skills?: AppSkillsSpec
  } = {
    name,
    model: opts.model ?? DEFAULT_MODEL,
    port: opts.port ?? DEFAULT_PORT,
    apiPrefix: opts.apiPrefix ?? DEFAULT_API_PREFIX,
    tools: [],
    agents: [],
    projections: [],
    channels: [],
    subagents: [],
    ...(opts.provider === undefined ? {} : { provider: opts.provider }),
    ...(opts.providers === undefined ? {} : { providers: { ...opts.providers } }),
    mcps: [],
  }

  const app: App = {
    name,
    spec: spec as AppSpec,

    tool(toolName: string): ToolBuilder {
      if (spec.tools.some(tool => tool.name === toolName)) {
        throw new Error(`defineApp(${name}): 重复的工具名 "${toolName}"`)
      }
      const partial: {
        name: string
        description?: string
        parameters?: ToolInputDSL
        output?: ToolOutputDSL
        card?: { kind: 'generic'; title?: string }
        http?: { method: string; path?: string }
      } = { name: toolName }

      // 泛型链经 any 落地：接口的静态泛型（ToolBuilder<In>）只约束作者侧调用，
      // 内部单例 builder 对所有 In 形状复用同一实现（运行时无类型）。
      const builder: ToolBuilder<any> = {
        description(text: string) {
          partial.description = text
          return builder
        },
        input<const T extends ToolInputDSL>(dsl: T) {
          warnInputDslIssues(toolName, dsl)
          partial.parameters = dsl
          return builder as unknown as ToolBuilder<T>
        },
        output(dslOrSchema: ToolOutputDSL | LoomZSchema) {
          const dsl: ToolOutputDSL = isSchemastery(dslOrSchema)
            ? schemasteryToOutputDsl(dslOrSchema)
            : (dslOrSchema as ToolOutputDSL)
          warnOutputDslIssues(toolName, dsl)
          partial.output = dsl
          return builder
        },
        card(kind: 'generic', cardOpts?: { title?: string }) {
          if (kind !== 'generic') {
            console.warn(`[loom] tool("${toolName}").card("${kind}")：v1 只实现 generic 卡片，已按 generic 处理`)
          }
          partial.card = { kind: 'generic', ...(cardOpts?.title === undefined ? {} : { title: cardOpts.title }) }
          return builder
        },
        http(method: string, path?: string) {
          if (path !== undefined && path.includes('{')) {
            // 声明期守门（M5）：路由是 exact 匹配（webServer 只支持 exact/prefix），
            // `{id}` 不会变成模式——路径参数请转为 query/body 输入字段（import 侧同规则）。
            throw new Error(
              `defineApp(${name}).tool("${toolName}").http("${method}", "${path}") 的 path 含路径参数`
              + '——路径参数暂不支持，请转为 query/body 输入字段（runtime 按精确路由匹配，不支持 {id} 模式）',
            )
          }
          partial.http = { method: method.toUpperCase(), ...(path === undefined ? {} : { path }) }
          return builder
        },
        execute(fn: ToolExecute<never>) {
          spec.tools.push({
            name: partial.name,
            description: partial.description ?? `Loom tool ${partial.name}`,
            parameters: partial.parameters ?? {},
            output: partial.output ?? { type: 'object' },
            execute: (args: Record<string, unknown>, exec: ToolExecContext) => fn(args as never, exec),
            ...(partial.card === undefined ? {} : { card: partial.card }),
            ...(partial.http === undefined ? {} : { http: partial.http }),
          } satisfies ToolSpec)
          return app
        },
      }
      return builder
    },

    agent(id: string, agentOpts: { persona: string; tools?: string[]; model?: string; provider?: string; memory?: boolean | AgentMemoryOptions }) {
      if (spec.agents.some(agent => agent.id === id)) {
        throw new Error(`defineApp(${name}): 重复的智能体 id "${id}"`)
      }
      // 声明期守门：tools 引用的工具必须已声明（工具声明先于引用它的 agent）。
      if (agentOpts.tools !== undefined) {
        for (const toolName of agentOpts.tools) {
          if (!spec.tools.some(tool => tool.name === toolName)) {
            throw new Error(
              `defineApp(${name}): 智能体 "${id}" 引用了未声明的工具 "${toolName}"`
              + '——工具须在引用它的 agent 之前 app.tool(...) 声明（拼写也请对照）',
            )
          }
        }
      }
      // memory 形状校验：boolean（M7 总开关）或 { paths?: boolean }（M8 窄门控——
      // 不传 paths 的 agent 不记路径）；其余形状一律拒绝。
      if (agentOpts.memory !== undefined) {
        const memory = agentOpts.memory
        if (typeof memory === 'boolean') {
          // ok
        } else if (memory !== null && typeof memory === 'object' && !Array.isArray(memory)) {
          const unknownKeys = Object.keys(memory).filter(key => key !== 'paths')
          if (unknownKeys.length > 0) {
            throw new Error(`defineApp(${name}).agent("${id}") 的 memory 只接受 paths 字段，收到未知字段 ${unknownKeys.join(', ')}`)
          }
          if (memory.paths !== undefined && typeof memory.paths !== 'boolean') {
            throw new Error(`defineApp(${name}).agent("${id}") 的 memory.paths 必须是布尔值，收到 ${JSON.stringify(memory.paths)}`)
          }
        } else {
          throw new Error(`defineApp(${name}).agent("${id}") 的 memory 必须是布尔值或 { paths?: boolean }（默认 false——提取花 token，显式开启），收到 ${JSON.stringify(memory)}`)
        }
      }
      spec.agents.push({
        id,
        persona: agentOpts.persona,
        ...(agentOpts.tools === undefined ? {} : { tools: [...agentOpts.tools] }),
        ...(agentOpts.model === undefined ? {} : { model: agentOpts.model }),
        ...(agentOpts.provider === undefined ? {} : { provider: agentOpts.provider }),
        ...(agentOpts.memory === undefined ? {} : { memory: typeof agentOpts.memory === 'boolean' ? agentOpts.memory : { ...agentOpts.memory } }),
      })
      return app
    },

    projection<S>(projectionName: string, def: { init: S; apply: (state: S, event: ProjectionEvent) => S }) {
      if (spec.projections.some(projection => projection.name === projectionName)) {
        throw new Error(`defineApp(${name}): 重复的投影名 "${projectionName}"`)
      }
      spec.projections.push({
        name: projectionName,
        init: def.init,
        apply: def.apply as ProjectionSpec['apply'],
      } as ProjectionSpec)
      return app
    },

    python(pyOpts: { command: string; cwd?: string; env?: Record<string, string>; restartLimit?: number; callTimeoutMs?: number }) {
      if (spec.python !== undefined) {
        throw new Error(`defineApp(${name}): 重复的 app.python(...) 声明——v1 只支持一个 Python 工具桥（command "${spec.python.command}"）`)
      }
      if (typeof pyOpts.command !== 'string' || pyOpts.command.trim() === '') {
        throw new Error(`defineApp(${name}).python() 的 command 必须是非空字符串（如 'python py_tools.py'），收到 ${JSON.stringify(pyOpts.command)}`)
      }
      if (pyOpts.cwd !== undefined && (typeof pyOpts.cwd !== 'string' || pyOpts.cwd.trim() === '')) {
        throw new Error(`defineApp(${name}).python() 的 cwd 必须是非空字符串，收到 ${JSON.stringify(pyOpts.cwd)}`)
      }
      if (pyOpts.env !== undefined) {
        if (pyOpts.env === null || typeof pyOpts.env !== 'object' || Array.isArray(pyOpts.env)) {
          throw new Error(`defineApp(${name}).python() 的 env 必须是字符串到字符串的对象`)
        }
        for (const [key, value] of Object.entries(pyOpts.env)) {
          if (typeof value !== 'string') {
            throw new Error(`defineApp(${name}).python() 的 env["${key}"] 必须是字符串，收到 ${JSON.stringify(value)}`)
          }
        }
      }
      if (pyOpts.restartLimit !== undefined && (!Number.isSafeInteger(pyOpts.restartLimit) || pyOpts.restartLimit < 0)) {
        throw new Error(`defineApp(${name}).python() 的 restartLimit 必须是非负整数，收到 ${JSON.stringify(pyOpts.restartLimit)}`)
      }
      if (pyOpts.callTimeoutMs !== undefined && (typeof pyOpts.callTimeoutMs !== 'number' || !Number.isFinite(pyOpts.callTimeoutMs) || pyOpts.callTimeoutMs <= 0)) {
        throw new Error(`defineApp(${name}).python() 的 callTimeoutMs 必须是正数（毫秒），收到 ${JSON.stringify(pyOpts.callTimeoutMs)}`)
      }
      spec.python = {
        kind: 'python',
        command: pyOpts.command.trim(),
        ...(pyOpts.cwd === undefined ? {} : { cwd: pyOpts.cwd }),
        ...(pyOpts.env === undefined ? {} : { env: { ...pyOpts.env } }),
        ...(pyOpts.restartLimit === undefined ? {} : { restartLimit: pyOpts.restartLimit }),
        ...(pyOpts.callTimeoutMs === undefined ? {} : { callTimeoutMs: pyOpts.callTimeoutMs }),
      }
      return app
    },

    policy(policy: PolicySpec) {
      assertPolicySpec(policy)
      spec.policy = policy
      return app
    },

    channel: {
      webhook(path: string, hookOpts: {
        agent: string
        map: (payload: Record<string, unknown>) => string
        secret?: string
        sessionKey?: (payload: Record<string, unknown>) => string
      }) {
        if (typeof path !== 'string' || !path.startsWith('/')) {
          throw new Error(`defineApp(${name}).channel.webhook() 的 path 必须是以 / 开头的字符串，收到 ${JSON.stringify(path)}`)
        }
        if (spec.channels.some(channel => channel.path === path)) {
          throw new Error(`defineApp(${name}).channel.webhook(): 重复的通道路径 "${path}"`)
        }
        if (typeof hookOpts.map !== 'function') throw new Error(`channel.webhook("${path}") 的 map 必须是函数`)
        if (hookOpts.secret !== undefined && (typeof hookOpts.secret !== 'string' || hookOpts.secret === '')) {
          throw new Error(`channel.webhook("${path}") 的 secret 必须是非空字符串`)
        }
        if (hookOpts.sessionKey !== undefined && typeof hookOpts.sessionKey !== 'function') {
          throw new Error(`channel.webhook("${path}") 的 sessionKey 必须是函数`)
        }
        spec.channels.push({
          kind: 'webhook',
          path,
          agent: hookOpts.agent,
          map: hookOpts.map,
          ...(hookOpts.secret === undefined ? {} : { secret: hookOpts.secret }),
          ...(hookOpts.sessionKey === undefined ? {} : { sessionKey: hookOpts.sessionKey }),
        })
        return app
      },
    },

    subagent(id: string, subOpts: { persona: string; tools?: string[]; visibleTo: string[] }) {
      if (spec.subagents.some(sub => sub.id === id)) {
        throw new Error(`defineApp(${name}): 重复的子智能体 id "${id}"`)
      }
      if (typeof subOpts.persona !== 'string' || subOpts.persona.trim() === '') {
        throw new Error(`subagent("${id}") 的 persona 必须是非空字符串`)
      }
      if (!Array.isArray(subOpts.visibleTo) || subOpts.visibleTo.length === 0) {
        throw new Error(`subagent("${id}") 的 visibleTo 必须是非空数组（至少一个父 agent 才能委派它）`)
      }
      // 声明期守门：子规格 tools 引用的工具必须已声明（与 agent.tools 同规）。
      if (subOpts.tools !== undefined) {
        for (const toolName of subOpts.tools) {
          if (!spec.tools.some(tool => tool.name === toolName)) {
            throw new Error(
              `defineApp(${name}): 子智能体 "${id}" 引用了未声明的工具 "${toolName}"`
              + '——工具须在引用它的 subagent 之前 app.tool(...) 声明',
            )
          }
        }
      }
      spec.subagents.push({
        id,
        persona: subOpts.persona,
        ...(subOpts.tools === undefined ? {} : { tools: [...subOpts.tools] }),
        visibleTo: [...subOpts.visibleTo],
      })
      return app
    },

    /**
     * 声明技能文件目录（M12）：目录里的 `<name>/SKILL.md` / `<name>.md` 成为
     * 模型可加载技能（会话开始收到目录摘要，模型按需调 skill 工具加载全文）。
     */
    skills(skillsOpts: { dirs?: string[] } = {}) {
      if (spec.skills !== undefined) {
        throw new Error(`defineApp(${name}): 重复的 app.skills(...) 声明`)
      }
      const dirs = skillsOpts.dirs ?? ['skills']
      if (!Array.isArray(dirs) || dirs.length === 0) {
        throw new Error(`defineApp(${name}).skills() 的 dirs 必须是非空字符串数组，收到 ${JSON.stringify(dirs)}`)
      }
      for (const dir of dirs) {
        if (typeof dir !== 'string' || dir.trim() === '') {
          throw new Error(`defineApp(${name}).skills() 的 dirs 每项必须是非空字符串（相对 loom.app.ts 或绝对路径），收到 ${JSON.stringify(dir)}`)
        }
      }
      spec.skills = { dirs: [...dirs] }
      return app
    },

    auth(authOpts: { mode?: 'anon-and-local'; corsOrigins?: string[] } = {}) {
      if (spec.auth !== undefined) {
        throw new Error(`defineApp(${name}): 重复的 app.auth(...) 声明`)
      }
      if (authOpts.mode !== undefined && authOpts.mode !== 'anon-and-local') {
        throw new Error(`defineApp(${name}).auth() 的 mode 目前只支持 "anon-and-local"，收到 ${JSON.stringify(authOpts.mode)}`)
      }
      if (authOpts.corsOrigins !== undefined) {
        if (!Array.isArray(authOpts.corsOrigins) || authOpts.corsOrigins.length === 0) {
          throw new Error(`defineApp(${name}).auth() 的 corsOrigins 必须是非空字符串数组（跨域白名单），收到 ${JSON.stringify(authOpts.corsOrigins)}`)
        }
        for (const origin of authOpts.corsOrigins) {
          if (typeof origin !== 'string' || !/^https?:\/\//.test(origin)) {
            throw new Error(`defineApp(${name}).auth() 的 corsOrigins 每项必须是 http(s):// 开头的源字符串，收到 ${JSON.stringify(origin)}`)
          }
        }
      }
      spec.auth = {
        ...(authOpts.mode === undefined ? {} : { mode: authOpts.mode }),
        ...(authOpts.corsOrigins === undefined ? {} : { corsOrigins: [...authOpts.corsOrigins!] }),
      }
      return app
    },

    /**
     * 声明一个 MCP 服务器（M10）：工具以 `mcp__<serverName>__<rawName>` 注册到全局
     * 工具层（v1 全部 agent 可见），策略/审批照常生效（`{ tool: 'mcp__github__*', effect: 'approve' }`）。
     * 机密只经 envRef/headerRefs 环境变量引用，不进声明与生成的 yml。
     */
    mcp(serverName: string, mcpOpts: {
      transport: 'stdio' | 'streamable-http'
      command?: string
      args?: readonly string[]
      env?: Record<string, string>
      envRef?: readonly string[]
      cwd?: string
      url?: string
      headers?: Record<string, string>
      headerRefs?: Record<string, string>
      toolCallTimeoutMs?: number
      failOnStartupError?: boolean
    }) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
        throw new Error(`defineApp(${name}).mcp() 的 serverName 必须匹配 [A-Za-z0-9_-]{1,32}（dsh-mcp-client 约定），收到 ${JSON.stringify(serverName)}`)
      }
      if (spec.mcps!.some(server => server.serverName === serverName)) {
        throw new Error(`defineApp(${name}).mcp(): 重复的 serverName "${serverName}"`)
      }
      if (mcpOpts.transport !== 'stdio' && mcpOpts.transport !== 'streamable-http') {
        throw new Error(`defineApp(${name}).mcp("${serverName}") 的 transport 必须是 "stdio" / "streamable-http"，收到 ${JSON.stringify(mcpOpts.transport)}`)
      }
      if (mcpOpts.transport === 'stdio') {
        if (typeof mcpOpts.command !== 'string' || mcpOpts.command.trim() === '') {
          throw new Error(`defineApp(${name}).mcp("${serverName}")：stdio 传输必须给 command（要 spawn 的可执行文件）`)
        }
        if (mcpOpts.url !== undefined) throw new Error(`defineApp(${name}).mcp("${serverName}")：stdio 传输不支持 url`)
      } else {
        if (typeof mcpOpts.url !== 'string' || !/^https?:\/\//.test(mcpOpts.url)) {
          throw new Error(`defineApp(${name}).mcp("${serverName}")：streamable-http 传输必须给 http(s):// 的 url`)
        }
        if (mcpOpts.command !== undefined) throw new Error(`defineApp(${name}).mcp("${serverName}")：streamable-http 传输不支持 command/args`)
      }
      for (const ref of mcpOpts.envRef ?? []) {
        if (typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
          throw new Error(`defineApp(${name}).mcp("${serverName}") 的 envRef 每项必须是环境变量名，收到 ${JSON.stringify(ref)}`)
        }
      }
      for (const [header, ref] of Object.entries(mcpOpts.headerRefs ?? {})) {
        if (typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
          throw new Error(`defineApp(${name}).mcp("${serverName}") 的 headerRefs.${header} 必须是环境变量名，收到 ${JSON.stringify(ref)}`)
        }
      }
      spec.mcps!.push({
        serverName,
        transport: mcpOpts.transport,
        ...(mcpOpts.command === undefined ? {} : { command: mcpOpts.command }),
        ...(mcpOpts.args === undefined ? {} : { args: [...mcpOpts.args] }),
        ...(mcpOpts.env === undefined ? {} : { env: { ...mcpOpts.env } }),
        ...(mcpOpts.envRef === undefined ? {} : { envRef: [...mcpOpts.envRef] }),
        ...(mcpOpts.cwd === undefined ? {} : { cwd: mcpOpts.cwd }),
        ...(mcpOpts.url === undefined ? {} : { url: mcpOpts.url }),
        ...(mcpOpts.headers === undefined ? {} : { headers: { ...mcpOpts.headers } }),
        ...(mcpOpts.headerRefs === undefined ? {} : { headerRefs: { ...mcpOpts.headerRefs } }),
        ...(mcpOpts.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: mcpOpts.toolCallTimeoutMs }),
        ...(mcpOpts.failOnStartupError === undefined ? {} : { failOnStartupError: mcpOpts.failOnStartupError }),
      })
      return app
    },

    memory(memoryOpts: { extraction?: boolean | { maxPerTurn?: number }; recall?: boolean | { topK?: number } } = {}) {
      if (spec.memory !== undefined) {
        throw new Error(`defineApp(${name}): 重复的 app.memory(...) 声明`)
      }
      const checkPositiveInt = (value: unknown, label: string): void => {
        if (value === undefined) return
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
          throw new Error(`defineApp(${name}).memory() 的 ${label} 必须是正整数，收到 ${JSON.stringify(value)}`)
        }
      }
      const checkToggle = (value: unknown, label: string): void => {
        if (value === undefined) return
        const allowed = label === 'extraction' ? ['maxPerTurn'] : ['topK']
        if (typeof value === 'boolean') return
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          const keys = Object.keys(value as Record<string, unknown>)
          const unknownKeys = keys.filter(key => !allowed.includes(key))
          if (unknownKeys.length > 0) {
            throw new Error(`defineApp(${name}).memory() 的 ${label} 只接受 ${allowed.join('/')} 字段，收到未知字段 ${unknownKeys.join(', ')}`)
          }
          return
        }
        throw new Error(`defineApp(${name}).memory() 的 ${label} 必须是布尔或对象（如 { ${allowed.join(': number, ')}: number }），收到 ${JSON.stringify(value)}`)
      }
      checkToggle(memoryOpts.extraction, 'extraction')
      checkToggle(memoryOpts.recall, 'recall')
      if (typeof memoryOpts.extraction === 'object' && memoryOpts.extraction !== null) {
        checkPositiveInt((memoryOpts.extraction as { maxPerTurn?: unknown }).maxPerTurn, 'extraction.maxPerTurn')
      }
      if (typeof memoryOpts.recall === 'object' && memoryOpts.recall !== null) {
        checkPositiveInt((memoryOpts.recall as { topK?: unknown }).topK, 'recall.topK')
      }
      spec.memory = {
        ...(memoryOpts.extraction === undefined ? {} : {
          extraction: typeof memoryOpts.extraction === 'boolean'
            ? memoryOpts.extraction
            : { ...(memoryOpts.extraction.maxPerTurn === undefined ? {} : { maxPerTurn: memoryOpts.extraction.maxPerTurn }) },
        }),
        ...(memoryOpts.recall === undefined ? {} : {
          recall: typeof memoryOpts.recall === 'boolean'
            ? memoryOpts.recall
            : { ...(memoryOpts.recall.topK === undefined ? {} : { topK: memoryOpts.recall.topK }) },
        }),
      }
      return app
    },
  }

  return app
}

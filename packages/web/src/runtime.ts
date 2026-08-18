/**
 * loom-runtime —— Loom 的 cordis 运行时插件（examples/gis-bridge 的泛化）。
 *
 * 职责：
 * 1. boot 时按 config.appModule 导入 Loom 应用模块（default 导出的 defineApp 产物）。
 * 2. 不全局注册工具：每个会话创建时在 agents.create 的 setup(agentCtx) 里按
 *    agent.tools 做 agent 作用域注册（实现"每 agent 不同工具集"），并注册
 *    deployment:persona system-prompt section（遮蔽部署默认 persona）。
 * 3. 挂 HTTP 路由（webServer 只支持 exact/prefix，带 :id 的路径用 prefix 自解析）：
 *    - GET  {prefix}/health
 *    - GET  {prefix}/agents                              → agent 清单
 *    - POST {prefix}/agents/:id/sessions                 → { sessionId }
 *    - GET  {prefix}/agents/:id/sessions                 → 会话列表（M7 sidecar 索引）
 *    - POST {prefix}/agents/:id/sessions/:sid/messages   → 追加用户消息
 *    - GET  {prefix}/agents/:id/sessions/:sid/events     → SSE（白名单+心跳+CORS）
 *    - GET  {prefix}/sessions/:sid/events[?since=N&to=M] → SSE 同流；to 有界区间读完即收
 *    - POST {prefix}/sessions/:sid/fork                  → { sessionId }（时间旅行分叉，M2）
 *    - POST {prefix}/sessions/:sid/approvals/:aid        → 审批答复（M2；M7 起仅属主）
 *    - POST {prefix}/auth/register|login / GET /auth/me  → 本地账号（M7；app.auth 声明时）
 *    - GET/PUT/DELETE {prefix}/memories[/:id]            → 记忆面板路由（M7；app.memory 声明时）
 *    - GET  {prefix}/projections[/:name]                 → 投影清单/规格
 *    - {method} {prefix}/api/<toolName>（或工具自定义 path）→ .http() 第二张面孔（M2）
 *    - POST {prefix}<channel.path>                        → webhook 通道（M3：
 *      声明了 secret 先校验 x-loom-signature（HMAC-SHA256(body)，401 形状清晰）→
 *      map 得任务文本（抛错 400，不建会话）→ sessionKey 命中复用/未命中新建 →
 *      agent.followup() 异步干活 → 202 {sessionId}，进度走既有 SSE）。
 *    M7 持久化恢复：ownedSessions 未命中的 sessionId 先查 sidecar 会话索引
 *    （.loom/sessions-index.json）——存在则 chat 会话 agents.resume（persona/作用域
 *    工具钩子与 create 相同）、fork/child 会话 sessionPersistence.prepare 重建只读
 *    回放；不存在才 404。M7 多用户：app.auth 声明后 POST 需身份（Bearer token /
 *    x-loom-user；SSE 支持 ?token=/?user=），会话按 sidecar userId 隔离（不匹配
 *    404 不泄露）。M7 loom memory：app.memory + agent memory:true——写路径监听
 *    turn/end{completed} 跑两阶段提取（mem0 v2：候选→FTS 相似→ADD/UPDATE/DELETE/
 *    NOOP），读路径在会话首条用户消息 FTS top-K 注入（form:'recall' 防注入框）。
 * 4. provider/model 取 ctx.agentDefaultModel.currentSelection()。
 * 5. M2 策略：AppSpec 带 policy 时注册 `tools/pre-execute` 裁决（allow→next /
 *    deny→拒绝 / approve→ask），ask 由内核工具管线路由进 `ctx.approval`
 *    审批缝（serviceAsk，自动落 approval/asked+decided 审计对）；B2 起
 *    `approval/request` answerer 由独立插件 dsh-web-approval-answerer 持有
 *    （组合 withApproval 行）：把待审批项经该会话 SSE 推 `loom/approval-asked`，
 *    等待 HTTP 答复或超时（默认 5 分钟，超时=拒绝——fail-closed）。本插件
 *    提供 webApprovalHost 桥（owns/push/参数预览/调用序/超时）并消费其服务。
 * 6. M3 子智能体：app.subagent(...) 声明编译为**按父 agent 作用域注册**的
 *    `subagent` 委派工具（只有 visibleTo 里的父看得到，且只能 spawn 声明过的
 *    子规格）。经内核 dsh-subagent 的 spawn provider（组合里的
 *    subagent-spawn-in-process 行）创建子 agent：persona → 内核 per-child
 *    persona，tools → 内核 toolFilter allow-list；子 agent 的 provider/model
 *    同父（resolveChildAgentOptions 默认继承）。子会话与父会话同在 SessionStore：
 *    子会话 id 在 start 兑现即可得（SubagentRun.id 即子会话 id），登记进本插件
 *    会话注册表后，既有 GET /sessions/:sid/events（或 /agents/:id/... 变体）
 *    直接开子会话直播；父流同时推 loom/subagent-started/-finished 合成事件，
 *    前端据此并屏显示父/子两条活动流。
 *
 * 零第三方依赖（node:http 原生 SSE）；纯 ESM。
 * @module @loom-sdk/web/runtime
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type { App, ProjectionSpec, SubagentSpec, ToolSpec, WebhookChannelSpec } from './types.js'
import { compilePolicy, type CompiledPolicy } from './policy.js'
import { httpRouteOf } from './http-route.js'
import { generateOpenapi } from './openapi-gen.js'
import { compileSubagents, denyListForAgent, type CompiledSubagents } from './subagent.js'
import { applyWebhookMap, applyWebhookSessionKey, verifyWebhookSignature, webhookSessionId } from './webhook.js'
import type { LoomPythonService } from './python-bridge.js'
import { AccountStore, resolveIdentity, signToken, type LoomIdentity } from './auth.js'
import { SessionSidecarIndex, titleOf, type SessionIndexRecord } from './session-index.js'
import { MemoryStore, toolSequenceSignature, type ToolCallShape } from './memory-store.js'
import type { WebApprovalAnswererService, WebApprovalHost } from 'dsh-web-approval-answerer'
import {
  applyDecisions,
  buildPathRecallMessage,
  buildRecallMessage,
  decisionSystemPrompt,
  decisionUserPrompt,
  extractionSystemPrompt,
  extractionUserPrompt,
  parseDecisions,
  parseExtraction,
} from './memory.js'
import { projectEvent, rebuildCallIndex, textOfBlocks, truncate, type CardIndex, type SessionEventLike } from './projection.js'

/** Cordis 插件名。 */
export const name = 'loom-runtime'

/** 挂载前提：工具注册表、智能体注册表、会话存储、web 路由、默认模型选择。 */
export const inject = ['tools', 'agents', 'sessions', 'webServer', 'agentDefaultModel']

/** 插件配置 schema。 */
export const Config = z.object({
  appModule: z.string().required(),
  apiPrefix: z.string().default('/~loom'),
  outDir: z.string(),
})

/** 插件配置形态。 */
export interface RuntimeConfig {
  appModule: string
  apiPrefix: string
  /** .loom 工作目录（M7 sidecar：sessions-index.json / accounts.json / auth-secret / memory.db；B1 起 session-query.db 由 session-query-sqlite 行持有）。 */
  outDir?: string
}

// ---------------------------------------------------------------------------
// 最小结构类型（避免为类型引入运行时无关依赖；服务形状见各内核包）
// ---------------------------------------------------------------------------

interface SessionLike {
  readonly id: string
  readonly events: Iterable<SessionEventLike>
}

interface AgentLike {
  readonly id: string
  readonly session: SessionLike
  followup(message: unknown): void
  /** 排队模型面上下文到下个 pre-step（不唤醒 driver；M7 记忆召回注入用）。 */
  inject(message: unknown): void
}

interface ScopedCtx {
  tools: {
    register(tool: unknown): void
    /** 全局层工具可见性限制（restrict 只作用于全局层，不影响本作用域注册）。 */
    restrict(filter: { allow?: string[]; deny?: string[] }): () => void
  }
  systemPrompt: { section(def: { name: string; order: number; text: string }): unknown }
}

interface AgentsService {
  create(options: {
    sessionId: string
    agentOptions?: { provider?: string; model?: string }
    meta?: { cwd?: string }
    setup?: (agentCtx: ScopedCtx) => void
  }): Promise<{ agent: AgentLike; dispose(): Promise<void> }>
  /** M7：在持久化会话上恢复 agent（setup 契约与 create 相同——persona/工具照常注册）。 */
  resume(options: {
    resumeSessionId: string
    agentOptions?: { provider?: string; model?: string }
    signal?: AbortSignal
    setup?: (agentCtx: ScopedCtx) => void
  }): Promise<{ agent: AgentLike; dispose(): Promise<void> }>
}

interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** 内核 tools/pre-execute 的 ask 裁决入参（loose 视图，见 dsh-tools PreToolDecision）。 */
interface PreExecLike {
  readonly callId: string
  readonly name: string
  readonly arguments?: unknown
  readonly signal?: AbortSignal
}

/** allow / deny / ask（内核 PreToolDecision）。 */
type PreDecisionLike =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

/** 内核 ToolExecutionResult（loose 视图）。 */
interface ToolResultLike {
  readonly isError: boolean
  readonly value?: unknown
  readonly error?: { message: string }
}

/** 内核 dsh-subagent 的 SubagentRun（loose 视图）。 */
interface SubagentRunLike {
  /** 对本地 run 即子会话 id。 */
  readonly id: string
  readonly localAgent: AgentLike | undefined
  readonly result: Promise<{
    readonly output?: unknown
    readonly structured?: unknown
    readonly stopReason: string
  }>
  dispose(): Promise<void>
}

/** 内核 dsh-subagent 的 ctx.subagents 服务（loose 视图）。 */
interface SubagentsService {
  start(provider: string, request: Record<string, unknown>): Promise<SubagentRunLike>
}

/** 内核 sessions.fork 的 SessionForkError。 */
interface ForkErrorLike extends Error {
  readonly code?: string
}

/** 内核 dsh-session-persistence 服务（loose 视图：fork/child 只读回放恢复用）。 */
interface SessionPersistenceLike {
  prepare(id: string, signal?: AbortSignal): Promise<{ session: SessionLike }>
}

/** 内核 dsh-llm 服务（loose 视图：记忆两阶段一次性调用）。 */
interface LlmServiceLike {
  stream(options: Record<string, unknown>): AsyncIterable<unknown>
}

interface RuntimeCtx {
  tools: {
    register(tool: unknown): void
    /** 程序化执行入口（dsh-tools ToolRuntime.execute）：完整走 pre-execute/守卫/派发/后置管线。 */
    execute(exec: { callId: string; name: string; arguments?: unknown; agent?: unknown; signal: AbortSignal }): Promise<ToolResultLike>
  }
  agents: AgentsService
  sessions: {
    get(id: string): unknown
    /** 在完整 turn 边界上分叉（SessionForkError：INVALID_BOUNDARY / OPEN_TURN / …）。 */
    fork(source: unknown, boundary?: number, childSessionId?: string): SessionLike
  }
  webServer: {
    register(route: WebRoute): void
  }
  agentDefaultModel: { currentSelection(): { provider: string; model: string } }
  logger: { info(line: string): void; warn(line: string): void }
  get?(service: 'approval'): unknown
  get?(service: 'subagents'): SubagentsService | undefined
  get?(service: 'loomPython'): LoomPythonService | undefined
  get?(service: 'sessionPersistence'): SessionPersistenceLike | undefined
  get?(service: 'llm'): LlmServiceLike | undefined
  on(event: 'session/event', listener: (session: { id: string }, event: SessionEventLike) => void): () => void
  on(event: 'tools/pre-execute', listener: (exec: PreExecLike, next: () => Promise<PreDecisionLike>) => PreDecisionLike | Promise<PreDecisionLike>): () => void
}

// ---------------------------------------------------------------------------
// 常量与小工具
// ---------------------------------------------------------------------------

/** CORS 响应头（本地演示默认；前端 dev 通常另有同源代理）。 */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, cache-control, authorization, x-loom-user',
}

/** 审批参数预览截断长度。 */
const ARGS_PREVIEW_MAX = 400
/** 审批等待答复的默认超时：5 分钟，超时按拒绝处理（fail-closed）。 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
/** .http() 直调的默认超时。 */
const HTTP_TOOL_TIMEOUT_MS = 30_000
/** JSON/raw 请求体的默认上限（2 MiB：远大于正常消息与 webhook 载荷，防超大 body 耗尽内存）。 */
const HTTP_BODY_MAX_BYTES = 2 * 1024 * 1024
/**
 * URL 路径里的 sessionId 形状（本服务生成的 id：`session-<app>-<uuid>` /
 * `…-hook-<slug>-<hash8>` / `…-fork-<8hex>`，全部 `[A-Za-z0-9_-]`）。
 * 不匹配的（`../`、绝对路径、emoji、超长）在触达存储/内核前即 404。
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
/** pendingArgs 软上限（防 policy never 分支下的缓慢积累）。 */
const PENDING_ARGS_MAX = 512
/** M7 记忆两阶段一次性 LLM 调用：maxTokens 与 deadline（照 session-title 模板）。 */
const MEMORY_MAX_TOKENS = 2048
const MEMORY_LLM_DEADLINE_MS = 60_000
/** 提取输入的单边文本上限（user/assistant surface 各 8000 字）。 */
const MEMORY_TURN_TEXT_MAX = 8000

/**
 * 按请求计算 CORS 头：声明了 auth.corsOrigins 时按白名单回显 Origin（不再
 * 硬编码 *）；未声明维持 `*`（本地演示形态，生产建议见 docs/auth.zh.md）。
 */
function corsHeadersFor(req: IncomingMessage, corsOrigins: string[] | undefined): Record<string, string> {
  if (corsOrigins === undefined) return CORS_HEADERS
  const origin = req.headers.origin
  if (typeof origin !== 'string' || !corsOrigins.includes(origin)) return {}
  return { ...CORS_HEADERS, 'access-control-allow-origin': origin, vary: 'origin' }
}

/** 写一个 JSON 响应（cors 缺省 `*`；声明白名单的路由传 corsHeadersFor(req)）。 */
function writeJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}, cors: Record<string, string> = CORS_HEADERS): void {
  res.writeHead(status, { ...cors, ...extraHeaders, 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 读取并解析请求体 JSON（空体按 {}；超过 maxBytes 拒绝——防超大载荷耗内存）。 */
function readJsonBody(req: IncomingMessage, maxBytes = HTTP_BODY_MAX_BYTES): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let oversized = false
    req.on('data', chunk => {
      size += chunk.length
      if (oversized) return
      if (size > maxBytes) {
        oversized = true
        reject(new RequestTooLargeError(maxBytes))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (oversized) return
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/** 请求体超限错误（路由层映射 413；普通 Error 一律 400/500，需可区分）。 */
class RequestTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`请求体超过上限 ${maxBytes} 字节（${Math.round(maxBytes / 1024)} KiB）——请拆分消息或缩减载荷`)
  }
}

/** 读取请求体原始字节（webhook 签名对象——不能先 JSON 再序列化；同样有上限）。 */
function readRawBody(req: IncomingMessage, maxBytes = HTTP_BODY_MAX_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let oversized = false
    req.on('data', chunk => {
      size += chunk.length
      if (oversized) return
      if (size > maxBytes) {
        oversized = true
        reject(new RequestTooLargeError(maxBytes))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (oversized) return
      resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

/** 非空字符串校验。 */
function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} 必须是非空字符串，收到 ${JSON.stringify(value)}`)
  }
  return value.trim()
}

/** 路由 catch 的状态码：请求体超限 413，其余按各路由默认（400/500）。 */
function errorStatusOf(error: unknown, fallback: number): number {
  return error instanceof RequestTooLargeError ? 413 : fallback
}

/** query/body 标量解析：先按 JSON 解析（数字/布尔/对象），失败按原字符串。 */
function parseScalar(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** defineTool 的宽松签名边界（Loom DSL 与内核泛型 DSL 之间的互转层）。 */
const defineToolLoose = defineTool as unknown as (options: Record<string, unknown>) => unknown

/**
 * DSL 规格化：内核 schema 转换器要求每个 type:'object' 节点显式声明
 * additionalProperties——Loom 作者省略时自动补 false（封闭对象），保持
 * loom.app.ts 声明简洁。深拷贝语义（不改作者的 spec）。
 */
function normalizeDsl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeDsl)
  if (value === null || typeof value !== 'object') return value
  const node: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    node[key] = normalizeDsl(entry)
  }
  if (node.type === 'object' && typeof node.additionalProperties !== 'boolean') {
    node.additionalProperties = false
  }
  return node
}

/** ToolSpec → defineTool 参数（render 自动生成：canonical JSON 文本投影）。 */
function toDefineToolArgs(spec: ToolSpec): unknown {
  const execute = spec.execute
  const render = (_args: unknown, value: unknown): Array<Record<string, unknown>> => [
    { type: 'text', text: JSON.stringify(value, null, 2) },
  ]
  return defineToolLoose({
    name: spec.name,
    description: spec.description,
    parameters: normalizeDsl(spec.parameters),
    output: { schema: normalizeDsl(spec.output), render },
    async execute(args: Record<string, unknown>, exec: { signal?: AbortSignal }): Promise<unknown> {
      return await execute(args, { signal: exec.signal })
    },
  })
}


// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------

/** 本插件创建的会话条目（fork 子会话无 agent，为只读回放视图）。 */
interface OwnedSession {
  agent?: AgentLike
  session: SessionLike
  agentId: string
  callIndex: Map<string, { seq: number; name: string }>
  /** true = fork 出的只读回放会话（不能 followup）。 */
  forked?: boolean
  /** M3：true = subagent 子会话（由父的委派工具创建；只读直播视图，不挂 agent）。 */
  child?: boolean
  /** M3：子规格 id 与父会话 id（子会话条目专有）。 */
  childSpec?: string
  parentSessionId?: string
}

/** 一个挂起中的审批（B2 起由 dsh-web-approval-answerer 持有；此处仅留注释锚点）。 */

/**
 * 挂载 Loom 运行时。appModule 的 default 导出必须是 defineApp 的产物。
 * @param ctx - 携带 tools/agents/sessions/webServer/agentDefaultModel 的上下文。
 * @param config - appModule（file:/// URL）与 apiPrefix。
 */
export async function apply(ctx: Context, config: RuntimeConfig): Promise<void> {
  const c = ctx as unknown as RuntimeCtx
  const prefix = config.apiPrefix.replace(/\/+$/, '') || '/~loom'

  // ---- 导入应用模块 --------------------------------------------------------
  const mod = (await import(config.appModule)) as { default?: App }
  const loaded = mod.default
  if (loaded === undefined || typeof loaded.tool !== 'function') {
    throw new Error(`loom-runtime: ${config.appModule} 缺少 defineApp 产物的 default 导出`)
  }
  // 收窄为 App（function 声明会提升，闭包内不保留对 const 的收窄，故在此落定类型）。
  const app: App = loaded
  const toolsByName = new Map<string, ToolSpec>(app.spec.tools.map(tool => [tool.name, tool]))
  const agentsById = new Map(app.spec.agents.map(agent => [agent.id, agent]))
  const projectionsByName = new Map<string, ProjectionSpec>(app.spec.projections.map(p => [p.name, p]))
  const cards: CardIndex = new Map(
    app.spec.tools
      .filter(tool => tool.card !== undefined)
      .map(tool => [tool.name, { kind: 'generic' as const, title: tool.card!.title ?? tool.name }]),
  )
  const policy: CompiledPolicy | undefined = app.spec.policy === undefined ? undefined : compilePolicy(app.spec.policy)
  const approvalTimeoutMs = app.spec.policy?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
  // M3：子智能体编译（引用完整性在纯函数里校验——诚实失败优于静默缺工具）。
  const compiledSubagents: CompiledSubagents | undefined = app.spec.subagents.length === 0 ? undefined : compileSubagents(app.spec)
  c.logger.info(
    `loom-runtime: 应用 "${app.name}" —— ${app.spec.tools.length} 工具 / ${app.spec.agents.length} 智能体 / ${app.spec.projections.length} 投影`
    + ` / ${app.spec.channels.length} 通道 / ${app.spec.subagents.length} 子智能体`
    + (policy === undefined ? '' : ` / 策略 default=${policy.spec.default} rules=${policy.spec.rules.length}`),
  )

  // 校验 agent.tools 引用都有对应工具声明（诚实失败优于静默缺工具）。
  for (const agent of app.spec.agents) {
    if (agent.tools === undefined) continue
    for (const toolName of agent.tools) {
      if (!toolsByName.has(toolName)) {
        throw new Error(`loom-runtime: 智能体 "${agent.id}" 引用了未声明的工具 "${toolName}"`)
      }
    }
  }
  for (const tool of app.spec.tools) {
    if (tool.http !== undefined && tool.http.path !== undefined && !tool.http.path.startsWith('/')) {
      throw new Error(`loom-runtime: 工具 "${tool.name}".http() 的自定义 path 必须以 / 开头，收到 "${tool.http.path}"`)
    }
  }
  for (const channel of app.spec.channels) {
    if (channel.kind !== 'webhook') continue
    if (!agentsById.has(channel.agent)) {
      throw new Error(`loom-runtime: 通道 "${channel.path}" 的 agent 引用了未声明的智能体 "${channel.agent}"`)
    }
  }
  const webhookPaths = new Set<string>()
  for (const channel of app.spec.channels) {
    if (webhookPaths.has(channel.path)) throw new Error(`loom-runtime: 重复的通道路径 "${channel.path}"`)
    webhookPaths.add(channel.path)
  }

  // ---- M3 子智能体：spawn provider + 全局层注册 --------------------------------
  /** 组合里 subagent-spawn-in-process 行注册的 provider 名（compose 同名约定）。 */
  const SUBAGENT_PROVIDER = 'loom-spawn'
  let subagentsService: SubagentsService | undefined
  if (compiledSubagents !== undefined) {
    subagentsService = c.get?.('subagents')
    if (subagentsService === undefined) {
      throw new Error(
        'loom-runtime: 应用声明了 app.subagent(...) 但组合缺少 @deepseek-ai/dsh-subagent / @deepseek-ai/dsh-subagent-spawn-in-process'
        + '（compose 在 withSubagent 时写入这两行；请重新运行 loom dev）',
      )
    }
    // 子规格引用的工具进内核全局层：子的 toolFilter（tools.restrict({allow})）只
    // 作用于全局层，作用域注册子看不见。为不破坏 M1 的"每 agent 不同工具集"，
    // 各父作用域再用 restrict({deny}) 摘掉自己声明不可见的全局工具（见 createChatSession）。
    for (const toolName of compiledSubagents.globalToolNames) {
      const toolSpec = toolsByName.get(toolName)
      if (toolSpec === undefined) continue // compileSubagents 已校验，防御性兜底
      c.tools.register(toDefineToolArgs(toolSpec))
    }
    for (const [parentId, specs] of compiledSubagents.byParent) {
      c.logger.info(`loom-runtime: 子智能体委派工具 subagent 已按 ${parentId} 作用域注册（可见规格：${specs.map(s => s.id).join(', ')}）`)
    }
  }

  // ---- M7：sidecar（会话索引 / 本地账号 / 记忆库）与身份解析 ------------------
  const loomDir = resolve(config.outDir ?? join(process.cwd(), '.loom'))
  const sessionIndex = new SessionSidecarIndex(join(loomDir, 'sessions-index.json'))
  await sessionIndex.load()

  const authSpec = app.spec.auth
  const authEnabled = authSpec !== undefined
  const corsOrigins = authSpec?.corsOrigins
  const accounts = authEnabled ? new AccountStore(join(loomDir, 'accounts.json'), join(loomDir, 'auth-secret')) : undefined
  let authSecret: string | undefined
  if (accounts !== undefined) authSecret = await accounts.hmacSecret()

  /** 解析请求身份（Bearer token / x-loom-user / ?token= / ?user=）。 */
  function resolveUser(req: IncomingMessage, url: URL): LoomIdentity | null {
    if (!authEnabled) return null
    return resolveIdentity({
      authorization: req.headers.authorization,
      xLoomUser: req.headers['x-loom-user'],
      tokenQuery: url.searchParams.get('token'),
      userQuery: url.searchParams.get('user'),
      secret: authSecret,
    })
  }

  /** POST（状态变更）身份门：无身份 401（auth 声明时）。返回 false 表示已写响应。 */
  function requireUser(req: IncomingMessage, url: URL, res: ServerResponse): LoomIdentity | null | false {
    if (!authEnabled) return null
    const identity = resolveUser(req, url)
    if (identity === null) {
      writeJson(res, 401, { error: '该操作需要身份：请先登录（POST /~loom/auth/login）或携带 x-loom-user 匿名标识', code: 'IDENTITY_REQUIRED' }, {}, corsHeadersFor(req, corsOrigins))
      return false
    }
    return identity
  }

  /** 会话归属校验：请求带身份且与 sidecar 记录不匹配 → 404（不泄露存在性）。 */
  function ownershipDenied(record: SessionIndexRecord | undefined, identity: LoomIdentity | null): boolean {
    return identity !== null && record !== undefined && record.userId !== identity.userId
  }

  // M7 记忆声明解析：extraction 默认关（花 token）；recall 默认开 topK=5。
  const memorySpec = app.spec.memory
  const extractionOn = memorySpec !== undefined
    && memorySpec.extraction !== undefined
    && memorySpec.extraction !== false
  const maxPerTurn = typeof memorySpec?.extraction === 'object' ? memorySpec.extraction.maxPerTurn ?? 5 : 5
  const recallOn = memorySpec !== undefined && memorySpec.recall !== false
  const recallTopK = typeof memorySpec?.recall === 'object' ? memorySpec.recall.topK ?? 5 : 5
  /** agent 级总开关：app.memory 声明 + 该 agent 显式 memory:true / {…}（对象形态即开启）。 */
  const memoryEnabled = (agentId: string): boolean => {
    const flag = agentsById.get(agentId)?.memory
    return memorySpec !== undefined && (flag === true || (flag !== null && typeof flag === 'object'))
  }
  /** M8 窄门控：memory:{ paths: true } 才记路径/失败触发检索（防闲聊也记路径）。 */
  const pathsEnabled = (agentId: string): boolean => {
    const flag = agentsById.get(agentId)?.memory
    return memorySpec !== undefined && flag !== null && typeof flag === 'object' && flag.paths === true
  }
  const memoryStore = memorySpec === undefined ? undefined : new MemoryStore(join(loomDir, 'memory.db'))
  if (memoryStore !== undefined) {
    // 卸载时关库（Windows 上未关的 sqlite 句柄会锁住 .loom 目录，测试清理会 EPERM）。
    ;(c as unknown as { on(event: 'dispose', listener: () => void): unknown }).on('dispose', () => {
      try {
        memoryStore.close()
      } catch {
        /* 关闭失败不阻塞卸载 */
      }
    })
    c.logger.info(
      `loom-runtime: loom memory 已开启 —— 提取 ${extractionOn ? `开（maxPerTurn=${maxPerTurn}）` : '关'} / 召回 ${recallOn ? `开（topK=${recallTopK}）` : '关'}`
      + `；启用 agent：${app.spec.agents.filter(agent => memoryEnabled(agent.id)).map(agent => agent.id).join(', ') || '(无——app.agent(id, {memory:true}) 显式开启)'}`
      + `；路径记忆 agent：${app.spec.agents.filter(agent => pathsEnabled(agent.id)).map(agent => agent.id).join(', ') || '(无——memory:{paths:true} 窄门控)'}`,
    )
  }

  /** M7 记忆模型工具（app.memory 声明时全局注册；memory 关闭的 agent 被 restrict 摘除）。 */
  const MEMORY_TOOL_NAMES = ['memory_search', 'memory_write', 'memory_forget'] as const

  /** 工具执行时从 exec.agent 反查 userId（会话 sidecar 归属；无归属拒绝）。 */
  function userIdOfAgentSession(agent: unknown): string {
    const sessionId = (agent as AgentLike | undefined)?.session?.id
    const record = typeof sessionId === 'string' ? sessionIndex.get(sessionId) : undefined
    if (record === undefined) {
      throw new Error('loom memory 工具需要归属用户的会话上下文（无归属会话不可操作记忆）')
    }
    return record.userId
  }

  if (memoryStore !== undefined) {
    // memory_search：FTS 检索当前用户记忆。
    c.tools.register(defineToolLoose({
      name: 'memory_search',
      description: '检索当前用户的长期记忆（全文匹配）。用于回答"用户偏好/背景"类问题前查证。',
      parameters: {
        query: { type: 'string', required: true, description: '检索词（支持中文子串）' },
        limit: { type: 'number', description: '返回条数上限（默认 5）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            items: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { id: { type: 'string', required: true }, kind: { type: 'string', required: true }, content: { type: 'string', required: true } },
              },
            },
          },
        },
        render: (_args: unknown, value: unknown): Array<Record<string, unknown>> => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args: Record<string, unknown>, exec: { agent?: unknown; signal?: AbortSignal }): Promise<unknown> {
        exec.signal?.throwIfAborted()
        const userId = userIdOfAgentSession(exec.agent)
        const query = String(args.query ?? '')
        const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 20) : 5
        return { items: memoryStore.search(userId, query, limit).map(record => ({ id: record.id, kind: record.kind, content: record.content })) }
      },
    }))
    // memory_write：写入一条记忆（建议在 policy 里配 approve——写操作）。
    c.tools.register(defineToolLoose({
      name: 'memory_write',
      description: '把一条值得长期记住的用户信息写入记忆（kind：fact=事实 / preference=偏好 / skill=能力）。',
      parameters: {
        content: { type: 'string', required: true, description: '记忆内容（一句话，主语是"用户"）' },
        kind: { type: 'string', description: '类别 fact|preference|skill（默认 fact）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string', required: true }, kind: { type: 'string', required: true }, content: { type: 'string', required: true } },
        },
        render: (_args: unknown, value: unknown): Array<Record<string, unknown>> => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args: Record<string, unknown>, exec: { agent?: unknown; signal?: AbortSignal }): Promise<unknown> {
        exec.signal?.throwIfAborted()
        const agent = exec.agent as AgentLike | undefined
        const userId = userIdOfAgentSession(agent)
        const kind = args.kind === 'preference' || args.kind === 'skill' ? args.kind : 'fact'
        const record = memoryStore.insert({
          userId,
          kind,
          content: String(args.content ?? ''),
          ...(agent?.session?.id === undefined ? {} : { sourceSession: agent.session.id }),
        })
        return { id: record.id, kind: record.kind, content: record.content }
      },
    }))
    // memory_forget：软删一条记忆（policy 建议 approve——删除操作）。
    c.tools.register(defineToolLoose({
      name: 'memory_forget',
      description: '忘记一条记忆（按 id 软删除；id 来自 memory_search 的结果）。',
      parameters: { id: { type: 'string', required: true, description: '记忆条目 id' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { forgotten: { type: 'boolean', required: true }, id: { type: 'string', required: true } } },
        render: (_args: unknown, value: unknown): Array<Record<string, unknown>> => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args: Record<string, unknown>, exec: { agent?: unknown; signal?: AbortSignal }): Promise<unknown> {
        exec.signal?.throwIfAborted()
        const userId = userIdOfAgentSession(exec.agent)
        const id = String(args.id ?? '')
        const forgotten = memoryStore.deactivate(id, userId)
        if (!forgotten) throw new Error(`没有找到属于当前用户的记忆 ${id}（可能已删除）`)
        return { forgotten: true, id }
      },
    }))
    c.logger.info('loom-runtime: 记忆工具已全局注册（memory_search / memory_write / memory_forget；memory_forget 建议在 policy 配 approve）')
  }

  // ---- 会话注册表与 SSE 订阅者 ----------------------------------------------
  const ownedSessions = new Map<string, OwnedSession>()
  const subscribers = new Map<string, Set<(payload: Record<string, unknown>) => void>>()

  /** 向一个会话的全部 SSE 订阅者直推载荷（用于 loom/* 合成事件）。 */
  function pushSse(sessionId: string, payload: Record<string, unknown>): void {
    for (const send of subscribers.get(sessionId) ?? []) {
      try {
        send(payload)
      } catch (error) {
        c.logger.warn(`loom-runtime: SSE 推送失败（session ${sessionId}）：${String(error)}`)
      }
    }
  }

  // 全局（无 scope 标签）session/event 监听：只投影本插件创建的会话。
  c.on('session/event', (session, event) => {
    const entry = ownedSessions.get(session.id)
    if (entry === undefined) return
    const payload = projectEvent(event, entry.callIndex, cards)
    if (payload !== undefined) {
      for (const send of subscribers.get(session.id) ?? []) {
        try {
          send(payload)
        } catch (error) {
          c.logger.warn(`loom-runtime: SSE 推送失败（session ${session.id}）：${String(error)}`)
        }
      }
    }
    if (event.type !== 'turn/end') return
    const reason = event.data?.reason?.kind as string | undefined
    // M8 重验回写：注入了待重验路径的会话，其**下一次** turn/end 结算——
    // completed 视为重验成功（verified_at 刷新、confidence +0.1）；error/blocked
    // 视为重验失败（confidence ×0.5，<0.3 软删）。其余结局（aborted 等）不结算。
    // 近似边界（文档化）：结算只看结局不核对工具序列——注入后的下一轮 completed
    // 即记成功，哪怕模型没真的重放路径（prompt 要求它先重跑只读步骤）。
    const pending = pendingPathReverify.get(session.id)
    if (pending !== undefined && event.seq > pending.atSeq) {
      if (reason === 'completed' || reason === 'error' || reason === 'blocked') {
        pendingPathReverify.delete(session.id)
        settlePathReverify(session.id, pending, reason)
      }
    }
    // M8 失败触发路径检索注入：turn 失败/被拒 → 以任务目标（首条用户消息）
    // 检索同用户 path 记忆 → 命中注入待重验路径。刚结算过 pending 的本轮不再
    // 触发（防抖：连续失败不会每轮都注入一轮新的）。
    if (pending === undefined && (reason === 'error' || reason === 'blocked') && pathsEnabled(entry.agentId)) {
      firePathRecall(session.id, entry, event.seq)
    }
    // M7 写路径：完成的 turn → 两阶段提取（每会话串行异步队列，失败仅告警）。
    // M8：paths 开启的 agent 在失败/被拒 turn 也跑提取（记录"此路不通"路径，
    // 结局进提取 prompt；rejected 路径 verified_at=null、confidence=0.4 降权）。
    if (extractionOn && (reason === 'completed' || ((reason === 'error' || reason === 'blocked') && pathsEnabled(entry.agentId)))) {
      enqueueExtraction(session.id, entry, event.seq, reason === 'completed' ? 'completed' : 'rejected')
    }
  })

  // ---- M7：惰性恢复（重启后 ownedSessions 未命中 → sidecar 索引 → resume） ----
  /** 恢复中的会话（并发去重：两个 SSE 同时命中同一未恢复会话只 resume 一次）。 */
  const restoring = new Map<string, Promise<OwnedSession | undefined>>()

  /**
   * 取一个会话条目：内存命中直接返回；未命中查 sidecar 索引——chat 会话经
   * agents.resume 恢复（persona/作用域工具钩子与 create 相同），fork/child
   * 会话经 sessionPersistence.prepare 重建只读回放视图；索引里没有 → undefined
   * （除非给 createIfMissing：webhook keyed 会话首建走它，并发同 key 经
   * restoring 去重——两个请求只会建一个 agent，第二个直接复用）。
   */
  function ensureSession(sessionId: string, createIfMissing?: () => Promise<OwnedSession>): Promise<OwnedSession | undefined> {
    const existing = ownedSessions.get(sessionId)
    if (existing !== undefined) return Promise.resolve(existing)
    const inFlight = restoring.get(sessionId)
    if (inFlight !== undefined) return inFlight
    const job = (async (): Promise<OwnedSession | undefined> => {
      const record = sessionIndex.get(sessionId)
      if (record === undefined && createIfMissing !== undefined) {
        // 首建（索引无记录）：createChatSession 内部登记 ownedSessions + sidecar。
        const entry = await createIfMissing()
        ownedSessions.set(sessionId, entry)
        return entry
      }
      if (record === undefined) return undefined
      const kind = record.kind ?? 'chat'
      if (kind === 'chat' && agentsById.has(record.agentId)) {
        // 与 create 相同的 persona + 作用域工具钩子（setup 契约在 resume 上等价）。
        const handle = await c.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: agentOptionsFor(record.agentId),
          setup: buildAgentSetup(record.agentId),
        })
        const entry: OwnedSession = {
          agent: handle.agent,
          session: handle.agent.session,
          agentId: record.agentId,
          callIndex: rebuildCallIndex(handle.agent.session),
        }
        ownedSessions.set(sessionId, entry)
        c.logger.info(`loom-runtime: 会话 ${sessionId} 已从持久化恢复（agent ${record.agentId}）`)
        return entry
      }
      // fork/child：只读回放（不挂 agent——不能 followup）。
      const persistence = c.get?.('sessionPersistence')
      if (persistence === undefined) return undefined
      const prepared = await persistence.prepare(sessionId)
      const entry: OwnedSession = {
        session: prepared.session,
        agentId: record.agentId,
        callIndex: rebuildCallIndex(prepared.session),
        forked: kind === 'fork',
        child: kind === 'child',
      }
      ownedSessions.set(sessionId, entry)
      c.logger.info(`loom-runtime: ${kind} 会话 ${sessionId} 已重建只读回放视图`)
      return entry
    })()
    restoring.set(sessionId, job)
    job.finally(() => restoring.delete(sessionId)).catch(() => undefined)
    return job
  }

  // ---- M7 记忆写路径：每会话串行异步队列（失败仅日志告警，不影响对话） --------
  /** sessionId → 队列尾 Promise（链式串行）。 */
  const extractionQueues = new Map<string, Promise<void>>()
  /** sessionId → 上次已提取到的 seq（本轮新增 = 上一边界之后的事件）。 */
  const extractedThrough = new Map<string, number>()

  /** 一次性 LLM 调用（照内核 session-title 模板：BlockAssembler + deadline + maxTokens）。 */
  async function memoryLlmCall(system: string, userText: string, sessionId: string): Promise<string> {
    const llm = c.get?.('llm')
    if (llm === undefined) throw new Error('loom memory: 组合缺少 LLM 服务（dsh-llm）——提取不可用')
    const route = c.agentDefaultModel.currentSelection()
    const assembler = new BlockAssembler()
    // purpose 留空：内核 GenerateOptions.purpose 是闭合枚举（'compaction' |
    // 'session-title'），loom-memory 提取尚非其成员，不冒用语义标签。
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: userText }],
          source: { kind: 'plugin', plugin: 'loom-memory' },
        }),
      ],
      system,
      maxTokens: MEMORY_MAX_TOKENS,
      sessionId,
      signal: AbortSignal.timeout(MEMORY_LLM_DEADLINE_MS),
    })) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- loose 内核块流
      assembler.push(chunk as never)
    }
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new Error(`loom memory: 提取调用失败（${finish.kind}）：${finish.failure.message}`)
    }
    if (finish.kind === 'max-tokens') throw new Error('loom memory: 提取输出达到 maxTokens 上限')
    if (finish.kind === 'tool-calls') throw new Error('loom memory: 提取模型意外请求了工具')
    return assembler.blocks()
      .filter(block => (block as { type?: string }).type === 'text')
      .map(block => (block as { text?: string }).text ?? '')
      .join(' ')
  }

  /** 取 (sinceSeq, toSeq] 的 user/assistant surface 文本（本轮新增）与工具调用序列（M8 签名源）。 */
  function surfaceTexts(entry: OwnedSession, sinceSeq: number, toSeq: number): { userText: string; assistantText: string; turn: number; toolCalls: ToolCallShape[] } {
    let userText = ''
    let assistantText = ''
    let turn = 0
    const toolCalls: ToolCallShape[] = []
    for (const event of entry.session.events) {
      if (event.seq > toSeq) break
      if (event.type === 'turn/end') turn++
      if (event.seq <= sinceSeq) continue
      if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
        userText += `${textOfBlocks(event.data.content)}\n`
      } else if (event.type === 'assistant/message') {
        assistantText += `${textOfBlocks(event.data?.message?.content)}\n`
      } else if (event.type === 'tool/call') {
        let args: unknown
        try {
          args = JSON.parse(event.data?.arguments as string)
        } catch {
          args = undefined // 参数原文解析失败 → 形状退化为空调用（值本就不进签名）
        }
        toolCalls.push({ name: String(event.data?.name ?? ''), ...(args === undefined ? {} : { args }) })
      }
    }
    return {
      userText: userText.slice(0, MEMORY_TURN_TEXT_MAX),
      assistantText: assistantText.slice(0, MEMORY_TURN_TEXT_MAX),
      turn,
      toolCalls,
    }
  }

  /** 会话首条用户消息文本（M8 失败触发检索的 slim 任务目标查询）。 */
  function firstUserText(entry: OwnedSession): string {
    for (const event of entry.session.events) {
      if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
        const text = textOfBlocks(event.data.content).trim()
        if (text !== '') return text.slice(0, MEMORY_TURN_TEXT_MAX)
      }
    }
    return ''
  }

  /** 两阶段提取/决策（mem0 v2）；任何失败只告警。M8：paths 开启时 prompt 扩 path 候选 + 结局入 prompt。 */
  async function runExtraction(sessionId: string, entry: OwnedSession, sinceSeq: number, turnEndSeq: number, outcome: 'completed' | 'rejected' = 'completed'): Promise<void> {
    if (memoryStore === undefined) return
    const record = sessionIndex.get(sessionId)
    if (record === undefined || !memoryEnabled(entry.agentId)) return
    const paths = pathsEnabled(entry.agentId)
    const { userText, assistantText, turn, toolCalls } = surfaceTexts(entry, sinceSeq, turnEndSeq)
    try {
      if (userText.trim() === '') return // 没有用户 surface 文本（如注入驱动的 turn）——不提取
      // 阶段一：提取候选（paths 开启时 prompt 带 path 格式与本轮结局）。
      const extractionText = await memoryLlmCall(
        extractionSystemPrompt(maxPerTurn, { paths }),
        extractionUserPrompt(userText, assistantText, paths ? { outcome } : {}),
        sessionId,
      )
      const candidates = parseExtraction(extractionText, maxPerTurn)
      if (candidates.length === 0) {
        memoryStore.logExtraction(sessionId, turn, [], [])
        return
      }
      // 阶段二：每候选 FTS top-3 相似（同 userId+kind）→ 一次性决策调用。
      const similarByIndex = candidates.map(candidate => memoryStore.search(record.userId, candidate.content, 3, candidate.kind))
      const decisionText = await memoryLlmCall(
        decisionSystemPrompt(),
        decisionUserPrompt(candidates, similarByIndex),
        sessionId,
      )
      const decisions = parseDecisions(decisionText, candidates, similarByIndex.map(similar => similar.map(item => item.id)))
      // M8：path 候选的写时去重键 = 本轮实际工具调用序列的图签名（无工具调用
      // 不成路径——path 候选在 applyDecisions 内丢弃并计 noop）。
      const summary = applyDecisions(memoryStore, record.userId, decisions, candidates, {
        agentId: entry.agentId,
        sourceSession: sessionId,
        sourceSeq: turnEndSeq,
      }, paths
        ? { ...(toolCalls.length === 0 ? {} : { signature: toolSequenceSignature(toolCalls) }), outcome }
        : undefined)
      memoryStore.logExtraction(sessionId, turn, candidates, decisions)
      c.logger.info(
        `loom memory: 会话 ${sessionId} 第 ${turn} 轮提取完成 —— 候选 ${candidates.length}（新增 ${summary.added} / 更新 ${summary.updated} / 删除 ${summary.deleted} / 跳过 ${summary.noop}）`
        + (paths ? `；结局 ${outcome}，工具 ${toolCalls.length} 步` : ''),
      )
    } catch (error) {
      c.logger.warn(`loom memory: 会话 ${sessionId} 第 ${turn} 轮提取失败（放弃本轮，不影响对话）：${String(error)}`)
    }
  }

  /** 入队（串行链；seq 边界先占位防重复提取）。 */
  function enqueueExtraction(sessionId: string, entry: OwnedSession, turnEndSeq: number, outcome: 'completed' | 'rejected' = 'completed'): void {
    const previous = extractedThrough.get(sessionId)
    if (previous !== undefined && turnEndSeq <= previous) return
    const since = previous ?? -1
    extractedThrough.set(sessionId, turnEndSeq)
    const tail = (extractionQueues.get(sessionId) ?? Promise.resolve()).catch(() => undefined)
    const next = tail.then(() => runExtraction(sessionId, entry, since, turnEndSeq, outcome))
    extractionQueues.set(sessionId, next)
    next
      .catch(error => c.logger.warn(`loom memory: 会话 ${sessionId} 提取队列异常：${String(error)}`))
      .finally(() => {
        if (extractionQueues.get(sessionId) === next) extractionQueues.delete(sessionId)
      })
  }

  // ---- M8 失败触发路径检索注入 + 重验回写 ------------------------------------
  /** 失败触发检索的 path top-K（窄注入：宁缺毋滥）。 */
  const PATH_RECALL_TOP_K = 3
  /** SSE 合成事件 loom/path-recall 携带的框文案预览上限。 */
  const PATH_RECALL_PREVIEW_MAX = 1200

  /** 一条待结算的重验：注入时刻 + 路径 id 集（下一次 turn/end 结算）。 */
  interface PendingPathReverify {
    pathIds: string[]
    userId: string
    atSeq: number
  }
  const pendingPathReverify = new Map<string, PendingPathReverify>()

  /**
   * 失败触发的路径检索注入（异步发，失败仅告警）：以会话首条用户消息为 slim
   * 任务目标 FTS 检索同用户 path → 命中则复用 M7 recall 管道注入（框文案为
   * "待重验路径"变体）→ 记 pending（下一轮 turn/end 结算重验）→ SSE 推
   * loom/path-recall 合成事件（前端/测试可观测；注入本体不落 SSE 白名单）。
   */
  function firePathRecall(sessionId: string, entry: OwnedSession, atSeq: number): void {
    if (memoryStore === undefined || entry.agent === undefined) return
    // 推迟到事件发布窗口之外：本函数在 session/event（turn/end）监听里触发，
    // 而 agent.inject 会 append 事件——内核不允许在另一个 append 的发布中重入
    // （"session append cannot reenter while another append is being published"）。
    setTimeout(() => {
      void (async () => {
        try {
          const record = sessionIndex.get(sessionId)
          if (record === undefined) return
          const goal = firstUserText(entry)
          if (goal === '') return
          const hits = memoryStore.search(record.userId, goal, PATH_RECALL_TOP_K, 'path')
          const message = buildPathRecallMessage(hits, PATH_RECALL_TOP_K)
          if (message === undefined) return
          entry.agent!.inject(message)
          pendingPathReverify.set(sessionId, { pathIds: hits.map(hit => hit.id), userId: record.userId, atSeq })
          const text = (message.content as Array<{ text?: string }>)[0]?.text ?? ''
          pushSse(sessionId, {
            type: 'loom/path-recall',
            sessionId,
            count: hits.length,
            paths: hits.map(hit => ({ id: hit.id, content: hit.content })),
            preview: truncate(text, PATH_RECALL_PREVIEW_MAX),
          })
          c.logger.info(`loom memory: 会话 ${sessionId} 失败触发路径召回注入 ${hits.length} 条（user ${record.userId}；待重验）`)
        } catch (error) {
          c.logger.warn(`loom memory: 会话 ${sessionId} 路径召回注入失败（不影响对话）：${String(error)}`)
        }
      })()
    }, 0)
  }

  /** 重验结算：completed → verified_at 刷新 + confidence +0.1；error/blocked → ×0.5（<0.3 软删）。 */
  function settlePathReverify(sessionId: string, pending: PendingPathReverify, reason: 'completed' | 'error' | 'blocked' | string): void {
    if (memoryStore === undefined) return
    try {
      if (reason === 'completed') {
        memoryStore.markPathsVerified(pending.pathIds, pending.userId)
        c.logger.info(`loom memory: 会话 ${sessionId} 路径重验成功 —— ${pending.pathIds.length} 条 verified_at 刷新、confidence +0.1`)
      } else {
        const outcomes = memoryStore.markPathsFailed(pending.pathIds, pending.userId)
        c.logger.info(
          `loom memory: 会话 ${sessionId} 路径重验失败（${reason}）—— ${outcomes.map(o => `${o.id.slice(0, 8)}→${o.confidence.toFixed(2)}${o.active ? '' : '(软删)'}`).join(', ')}`,
        )
      }
    } catch (error) {
      c.logger.warn(`loom memory: 会话 ${sessionId} 重验回写失败：${String(error)}`)
    }
  }

  // ---- M2 策略：tools/pre-execute 裁决 + 审批桥 --------------------------------
  /** callId → 审批参数预览（answerer 的 SSE 事件携带；审批缝本身不带参数）。 */
  const pendingArgs = new Map<string, string>()

  /**
   * B2 生产侧：SSE 审批 answerer 已抽为独立插件 dsh-web-approval-answerer
   * （compose 在 withApproval 时写入该行；QA 语义——重连重发未决卡、并发 409、
   * 超时 fail-closed——全在包内并有独立单测随行）。本运行时提供
   * webApprovalHost 桥（owns/push/预览 drain/调用序/超时），并惰性消费
   * webApprovalAnswerer 服务（重发留档/答复裁决/计数）。
   */
  const answererService = (): WebApprovalAnswererService | undefined =>
    (c as unknown as { get?(service: 'webApprovalAnswerer'): WebApprovalAnswererService | undefined }).get?.('webApprovalAnswerer')

  if (policy !== undefined) {
    // 裁决监听（无 scope 标签的插件监听器按 dsh-scope 规则收到全部 agent 作用域分发）。
    c.on('tools/pre-execute', (exec, next) => {
      const effect = policy.decide(exec.name)
      if (effect === 'allow') return next()
      if (effect === 'deny') {
        return { kind: 'deny', reason: `loom policy: 工具 "${exec.name}" 被应用策略（deny）拒绝` }
      }
      // approve → ask：内核工具管线的 serviceAsk 会调 ctx.approval.request
      // （携带 agent/toolName/callId/reason/signal），并自动落 approval/asked +
      // approval/decided 审计对；裁决结果映射回 allow/deny（fail-closed）。
      if (c.get?.('approval') === undefined) {
        c.logger.warn(`loom-runtime: 策略要求审批但组合缺少 user-approval 插件——工具 "${exec.name}" 将 fail-closed 拒绝（组合请加 @deepseek-ai/dsh-user-approval）`)
      }
      if (pendingArgs.size >= PENDING_ARGS_MAX) {
        const oldest = pendingArgs.keys().next().value
        if (oldest !== undefined) pendingArgs.delete(oldest)
      }
      try {
        pendingArgs.set(String(exec.callId), truncate(JSON.stringify(exec.arguments ?? {}), ARGS_PREVIEW_MAX))
      } catch {
        pendingArgs.set(String(exec.callId), '(参数不可序列化)')
      }
      return { kind: 'ask', reason: `loom policy: 工具 "${exec.name}" 需要人工审批` }
    })

    // 宿主桥注册（answerer 插件每次请求惰性解析——无激活顺序耦合）。
    ;(c as unknown as { reflect: { provide(name: string, value: unknown): () => void } }).reflect.provide('webApprovalHost', {
      owns: (sessionId: string) => ownedSessions.has(sessionId),
      push: (sessionId: string, payload: Record<string, unknown>) => pushSse(sessionId, payload),
      drainArgsPreview: (callId: string | undefined) => {
        if (callId === undefined) return undefined
        const value = pendingArgs.get(callId)
        pendingArgs.delete(callId)
        return value
      },
      callSeqOf: (sessionId: string, callId: string) => ownedSessions.get(sessionId)?.callIndex.get(callId)?.seq,
      timeoutMs: approvalTimeoutMs,
    } satisfies WebApprovalHost)
    // 组合守门（fail-loud）：policy 声明了就必须有 answerer 行——cordis 的
    // ctx.get 会按需激活提供方；缺行则 undefined，boot 直接拒绝（否则审批全部
    // 静默拖到超时 fail-closed，排查成本极高）。
    if (answererService() === undefined) {
      throw new Error(
        'loom-runtime: 应用声明了 app.policy 但组合缺少 web-approval-answerer 行'
        + '（compose 在 withApproval 时自动写入；请勿手改 .loom/cordis.yml——重新运行 loom dev）',
      )
    }
  }

  // ---- 健康检查（exact） -----------------------------------------------------
  c.webServer.register({
    kind: 'exact',
    path: `${prefix}/health`,
    handler(req, res) {
      const cors = corsHeadersFor(req, corsOrigins)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors)
        res.end()
        return
      }
      const pythonTools = c.get?.('loomPython')?.toolNames.length
      writeJson(res, 200, {
        ok: true,
        app: app.name,
        model: app.spec.model,
        agents: app.spec.agents.map(agent => agent.id),
        tools: app.spec.tools.map(tool => tool.name),
        projections: app.spec.projections.map(p => p.name),
        channels: app.spec.channels.map(channel => ({ kind: channel.kind, path: `${prefix}${channel.path}`, agent: channel.agent, secured: channel.secret !== undefined })),
        subagents: app.spec.subagents.map(sub => ({ id: sub.id, visibleTo: sub.visibleTo, tools: sub.tools ?? app.spec.tools.map(t => t.name) })),
        // M6：Python 工具不在 AppSpec.tools（health 的 tools 列表不含它们），
        // 单独以 pythonTools 计数汇报（可发现性；懒读——bridge 与 runtime 同 boot 激活）。
        ...(pythonTools === undefined ? {} : { pythonTools }),
        // QA：runtime 内部资源计数（订阅清理/泄漏排查的观测面；数字本身不敏感）。
        runtime: {
          sessions: ownedSessions.size,
          sse: [...subscribers.values()].reduce((sum, set) => sum + set.size, 0),
          sseSessions: subscribers.size,
          pendingApprovals: answererService()?.pendingCount ?? 0,
          // .http() 面孔的隐藏 api 会话 id（审批挂起位置排查/诊断观测面）。
          apiSessions: [...apiAgents.values()].map(agent => agent.session.id),
        },
        ...(policy === undefined ? {} : { policy: { default: policy.spec.default, rules: policy.spec.rules.length } }),
        ...(authEnabled ? { auth: { mode: authSpec!.mode ?? 'anon-and-local', corsOrigins: corsOrigins ?? null } } : {}),
        ...(memorySpec === undefined ? {} : { memory: { extraction: extractionOn, recall: recallOn, agents: app.spec.agents.filter(agent => memoryEnabled(agent.id)).map(agent => agent.id), paths: app.spec.agents.filter(agent => pathsEnabled(agent.id)).map(agent => agent.id) } }),
        httpApi: app.spec.tools
          .filter(tool => tool.http !== undefined)
          .map(tool => ({ tool: tool.name, method: tool.http!.method, path: httpRouteOf(tool, prefix) })),
      }, {}, cors)
    },
  })

  // ---- 运行时活文档：GET {prefix}/openapi.json（M5） ---------------------------
  // 与 health 同级注册；generateOpenapi 是纯函数，boot 时序列化一次即冻结
  // （应用声明不可变，文档与路由/校验天然同源）。
  const openapiJson = `${JSON.stringify(generateOpenapi(app), null, 2)}\n`
  c.webServer.register({
    kind: 'exact',
    path: `${prefix}/openapi.json`,
    handler(req, res) {
      const cors = corsHeadersFor(req, corsOrigins)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors)
        res.end()
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { error: `该端点只接受 GET，收到 ${req.method ?? ''}` }, { allow: 'GET' }, cors)
        return
      }
      res.writeHead(200, { ...cors, 'content-type': 'application/json; charset=utf-8' })
      res.end(req.method === 'HEAD' ? undefined : openapiJson)
    },
  })

  // ---- M7：/~loom/auth（register / login / me；auth 声明时挂载） ----------------
  if (authEnabled && accounts !== undefined) {
    c.webServer.register({
      kind: 'prefix',
      path: `${prefix}/auth`,
      handler: async (req, res) => {
        try {
          const cors = corsHeadersFor(req, corsOrigins)
          if (req.method === 'OPTIONS') {
            res.writeHead(204, cors)
            res.end()
            return
          }
          const url = new URL(req.url ?? '/', 'http://x')
          const action = url.pathname.split('/').filter(Boolean)[2] // ['~loom','auth', action]
          // POST /auth/register {username, password} → 自动登录返回 token。
          if (req.method === 'POST' && action === 'register') {
            const body = await readJsonBody(req)
            const verdict = await accounts.register(body.username, body.password)
            if (!verdict.ok) {
              writeJson(res, 400, { error: verdict.error, code: 'REGISTER_FAILED' }, {}, cors)
              return
            }
            const token = signToken(verdict.userId!, authSecret!)
            writeJson(res, 200, { token, userId: verdict.userId!, username: body.username }, {}, cors)
            return
          }
          // POST /auth/login {username, password} → {token, userId, username}。
          if (req.method === 'POST' && action === 'login') {
            const body = await readJsonBody(req)
            const verdict = await accounts.login(body.username, body.password)
            if (!verdict.ok) {
              writeJson(res, 401, { error: verdict.error, code: 'LOGIN_FAILED' }, {}, cors)
              return
            }
            const token = signToken(verdict.userId!, authSecret!)
            writeJson(res, 200, { token, userId: verdict.userId!, username: body.username }, {}, cors)
            return
          }
          // GET /auth/me（验 token；?token= 等价）。
          if (req.method === 'GET' && action === 'me') {
            const identity = resolveUser(req, url)
            if (identity === null || identity.kind !== 'local') {
              writeJson(res, 401, { error: '未登录或 token 无效/已过期', code: 'UNAUTHENTICATED' }, {}, cors)
              return
            }
            const username = await accounts.usernameOf(identity.userId)
            if (username === null) {
              writeJson(res, 401, { error: '未登录或 token 无效/已过期', code: 'UNAUTHENTICATED' }, {}, cors)
              return
            }
            writeJson(res, 200, { userId: identity.userId, username }, {}, cors)
            return
          }
          writeJson(res, 404, { error: `不支持的路由：${req.method ?? ''} ${url.pathname}` }, {}, cors)
        } catch (error) {
          c.logger.warn(`loom-runtime: auth ${req.method ?? ''} ${req.url ?? ''} 失败：${String(error)}`)
          if (!res.headersSent) writeJson(res, errorStatusOf(error, 400), { error: String(error), ...(error instanceof RequestTooLargeError ? { code: 'BODY_TOO_LARGE' } : {}) }, {}, corsHeadersFor(req, corsOrigins))
          else res.destroy()
        }
      },
    })
    c.logger.info(`loom-runtime: 认证已开启（匿名 x-loom-user + 本地账号 ${prefix}/auth/register|login|me）`)
  }

  // ---- M7：/~loom/memories（app.memory 声明时挂载；全部要求身份） --------------
  if (memoryStore !== undefined) {
    c.webServer.register({
      kind: 'prefix',
      path: `${prefix}/memories`,
      handler: async (req, res) => {
        try {
          const cors = corsHeadersFor(req, corsOrigins)
          if (req.method === 'OPTIONS') {
            res.writeHead(204, cors)
            res.end()
            return
          }
          const url = new URL(req.url ?? '/', 'http://x')
          const pathname = url.pathname
          const segments = pathname.split('/').filter(Boolean) // ['~loom','memories', id?]
          const [, , memoryId] = segments
          const identity = authEnabled ? resolveUser(req, url) : { userId: 'anon', kind: 'anon' as const }
          if (identity === null) {
            writeJson(res, 401, { error: '记忆属于具体用户：请携带身份（登录 token 或 x-loom-user）', code: 'IDENTITY_REQUIRED' }, {}, cors)
            return
          }

          // GET /memories?query= —— 有 query 走 FTS，否则全量列表（owner 范围）。
          if (req.method === 'GET' && memoryId === undefined) {
            const query = url.searchParams.get('query') ?? ''
            const items = query.trim() === ''
              ? memoryStore.list(identity.userId, { limit: 200 })
              : memoryStore.search(identity.userId, query, 50)
            writeJson(res, 200, {
              memories: items.map(record => ({
                id: record.id,
                kind: record.kind,
                content: record.content,
                sourceSession: record.sourceSession,
                confidence: record.confidence,
                verifiedAt: record.verifiedAt,
                createdAt: record.createdAt,
                updatedAt: record.updatedAt,
              })),
            }, {}, cors)
            return
          }

          // PUT /memories/:id {content} —— 编辑（owner 校验在 store 内：跨用户 404）。
          if (req.method === 'PUT' && memoryId !== undefined) {
            const body = await readJsonBody(req)
            const content = requireNonEmptyString(body.content, 'content')
            const updated = memoryStore.updateContent(memoryId, content, identity.userId)
            if (updated === undefined) {
              writeJson(res, 404, { error: '记忆条目不存在（或不属于当前用户）' }, {}, cors)
              return
            }
            writeJson(res, 200, { id: updated.id, kind: updated.kind, content: updated.content }, {}, cors)
            return
          }

          // DELETE /memories/:id —— 软删（active=0）。
          if (req.method === 'DELETE' && memoryId !== undefined) {
            const removed = memoryStore.deactivate(memoryId, identity.userId)
            if (!removed) {
              writeJson(res, 404, { error: '记忆条目不存在（或不属于当前用户）' }, {}, cors)
              return
            }
            writeJson(res, 200, { ok: true, id: memoryId }, {}, cors)
            return
          }

          writeJson(res, 404, { error: `不支持的路由：${req.method ?? ''} ${pathname}` }, {}, cors)
        } catch (error) {
          c.logger.warn(`loom-runtime: memories ${req.method ?? ''} ${req.url ?? ''} 失败：${String(error)}`)
          if (!res.headersSent) writeJson(res, errorStatusOf(error, 400), { error: String(error), ...(error instanceof RequestTooLargeError ? { code: 'BODY_TOO_LARGE' } : {}) }, {}, corsHeadersFor(req, corsOrigins))
          else res.destroy()
        }
      },
    })
  }

  // ---- /agents 子树（prefix 自解析） ------------------------------------------
  c.webServer.register({
    kind: 'prefix',
    path: `${prefix}/agents`,
    handler: async (req, res) => {
      try {
        const cors = corsHeadersFor(req, corsOrigins)
        if (req.method === 'OPTIONS') {
          res.writeHead(204, cors)
          res.end()
          return
        }
        const url = new URL(req.url ?? '/', 'http://x')
        const pathname = url.pathname
        const segments = pathname.split('/').filter(Boolean) // ['~loom','agents', agentId, 'sessions', sessionId, action?]
        const [, , agentId, noun, sessionId, action] = segments

        // GET /agents → 清单
        if (req.method === 'GET' && agentId === undefined) {
          writeJson(res, 200, { agents: app.spec.agents.map(agent => ({ id: agent.id, tools: agent.tools ?? app.spec.tools.map(t => t.name), memory: memoryEnabled(agent.id) })) }, {}, cors)
          return
        }

        const agentSpec = agentId === undefined ? undefined : agentsById.get(agentId)
        if (agentSpec === undefined) {
          writeJson(res, 404, { error: `未知智能体：${String(agentId)}` }, {}, cors)
          return
        }

        // POST /agents/:id/sessions —— 创建会话（setup 注册 persona + 作用域工具）
        if (req.method === 'POST' && noun === 'sessions' && sessionId === undefined) {
          const identity = requireUser(req, url, res)
          if (identity === false) return
          const userId = identity?.userId ?? 'anon'
          const sessionKey = `session-${app.name}-${randomUUID()}`
          await createChatSession(sessionKey, agentSpec.id, true, { userId })
          c.logger.info(`loom-runtime: 创建 ${agentSpec.id} 会话 ${sessionKey}（用户 ${userId}；工具：${(agentsById.get(agentSpec.id)!.tools ?? app.spec.tools.map(t => t.name)).join(', ')}）`)
          writeJson(res, 200, { sessionId: sessionKey, agentId: agentSpec.id }, {}, cors)
          return
        }

        // GET /agents/:id/sessions —— 会话列表（M7：sidecar 索引；带身份只看自己的）
        if (req.method === 'GET' && noun === 'sessions' && sessionId === undefined) {
          const identity = resolveUser(req, url)
          const list = await sessionIndex.listByAgent(agentSpec.id, identity === null ? undefined : identity.userId)
          writeJson(res, 200, {
            agentId: agentSpec.id,
            sessions: list.map(({ sessionId: sid, record }) => ({
              sessionId: sid,
              title: record.title,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
              kind: record.kind ?? 'chat',
            })),
          }, {}, cors)
          return
        }

        // 以下按 sessionId 路由：内存未命中 → sidecar 索引惰性恢复；都没有 → 404。
        if (sessionId === undefined) {
          writeJson(res, 404, { error: `不支持的路由：${req.method ?? ''} ${pathname}` }, {}, cors)
          return
        }
        // sessionId 形状门（纵深防御，同 /sessions 子树）：`../`、绝对路径、
        // emoji、超长或编码穿越在进 sidecar 索引/内核持久化之前即 404。
        if (!SESSION_ID_PATTERN.test(sessionId)) {
          writeJson(res, 404, { error: '会话不存在' }, {}, cors)
          return
        }
        // 身份门先行（401 优先于 404——不向未认证方泄露会话存在性）。
        if (req.method === 'POST') {
          const gate = requireUser(req, url, res)
          if (gate === false) return
        }
        const indexRecord = sessionIndex.get(sessionId)
        const identity = resolveUser(req, url)
        if (ownershipDenied(indexRecord, identity)) {
          writeJson(res, 404, { error: '会话不存在' }, {}, cors) // 不泄露他人会话的存在性
          return
        }
        const entry = await ensureSession(sessionId)
        if (entry === undefined) {
          writeJson(res, 404, { error: `未知会话：${String(sessionId)}（本服务重启后只恢复本应用索引里的会话；请从会话列表继续或新建会话）` }, {}, cors)
          return
        }

        // POST /agents/:id/sessions/:sid/messages —— 追加用户消息（进度走 SSE）
        if (req.method === 'POST' && action === 'messages') {
          if (entry.agent === undefined) {
            writeJson(res, 400, { error: '分叉会话是只读回放视图（内核不允许在已存在的 live 会话上再挂 agent）——请从原会话继续对话' }, {}, cors)
            return
          }
          const body = await readJsonBody(req)
          const text = requireNonEmptyString(body.text, 'text')
          // M7 读路径：该会话首条用户消息且 agent 记忆开启且 recall 开 → FTS top-K
          // 注入（source form:'recall'，防注入框），下个 pre-step 进入模型上下文。
          if (memoryStore !== undefined && recallOn && memoryEnabled(entry.agentId)) {
            let isFirstUserMessage = true
            for (const event of entry.session.events) {
              if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
                isFirstUserMessage = false
                break
              }
            }
            if (isFirstUserMessage && indexRecord !== undefined) {
              const hits = memoryStore.search(indexRecord.userId, text, recallTopK)
              const recallMessage = buildRecallMessage(hits, recallTopK)
              if (recallMessage !== undefined) {
                entry.agent.inject(recallMessage)
                c.logger.info(`loom memory: 会话 ${sessionId} 召回注入 ${hits.length} 条（user ${indexRecord.userId}）`)
              }
            }
          }
          entry.agent.followup(
            createUserMessage({
              content: [{ type: 'text', text }],
              source: { kind: 'user' },
            }),
          )
          // sidecar：标题取首条用户消息前 30 字 + updatedAt。
          const patch: { updatedAt: string; title?: string } = { updatedAt: new Date().toISOString() }
          if (indexRecord !== undefined && (indexRecord.title === '(新会话)' || indexRecord.title === '')) patch.title = titleOf(text)
          await sessionIndex.touch(sessionId, patch)
          writeJson(res, 200, { ok: true, sessionId }, {}, cors)
          return
        }

        // GET /agents/:id/sessions/:sid/events?since=N[&to=M] —— SSE
        if (req.method === 'GET' && action === 'events') {
          handleEventStream(req, res, sessionId, entry, cors)
          return
        }

        writeJson(res, 404, { error: `不支持的路由：${req.method ?? ''} ${pathname}` }, {}, cors)
      } catch (error) {
        c.logger.warn(`loom-runtime: ${req.method ?? ''} ${req.url ?? ''} 处理失败：${String(error)}`)
        if (!res.headersSent) writeJson(res, errorStatusOf(error, 400), { error: String(error), ...(error instanceof RequestTooLargeError ? { code: 'BODY_TOO_LARGE' } : {}) }, {}, corsHeadersFor(req, corsOrigins))
        else res.destroy()
      }
    },
  })

  /** agent 的 provider/model（resume 与 create 共用同一选择逻辑）。 */
  function agentOptionsFor(agentId: string): { provider: string; model: string } {
    const selection = c.agentDefaultModel.currentSelection()
    return { provider: selection.provider, model: agentsById.get(agentId)!.model ?? app.spec.model }
  }

  /** agent 的 setup 钩子（persona section + 作用域工具注册；resume 与 create 共用）。 */
  function buildAgentSetup(agentId: string, registerPersona = true): (agentCtx: ScopedCtx) => void {
    const agentSpec = agentsById.get(agentId)!
    const visibleTools = agentSpec.tools ?? app.spec.tools.map(tool => tool.name)
    // M3：子规格引用的工具已进全局层（子的 toolFilter 需要它们可 restrict）；
    // 在本父作用域摘掉其中它声明不可见的，保住 M1 的"每 agent 不同工具集"。
    // M7：记忆工具全局注册——memory 未开启的 agent 同样摘除（agent 级默认关）。
    const denyList = [
      ...(compiledSubagents === undefined ? [] : denyListForAgent(compiledSubagents, visibleTools)),
      ...(memoryStore !== undefined && !memoryEnabled(agentId) ? [...MEMORY_TOOL_NAMES] : []),
    ]
    const visibleSubagentSpecs = compiledSubagents?.byParent.get(agentId)
    return agentCtx => {
      // per-agent persona：同名 section 遮蔽部署默认 persona（order 0）。
      if (registerPersona) {
        agentCtx.systemPrompt.section({
          name: 'deployment:persona',
          order: 0,
          text: agentSpec.persona,
        })
      }
      // per-agent 工具集：agent 作用域注册（不进全局注册表）。
      for (const toolName of visibleTools) {
        const toolSpec = toolsByName.get(toolName)
        if (toolSpec === undefined) continue
        agentCtx.tools.register(toDefineToolArgs(toolSpec))
      }
      // 全局层兜底：本父不可见的全局工具摘除（restrict 只作用于全局层，
      // 不影响上面本作用域注册的同名/其他工具）。
      if (denyList.length > 0) agentCtx.tools.restrict({ deny: denyList })
      // M3：visibleTo 命中的父 agent 作用域注册 subagent 委派工具。
      if (visibleSubagentSpecs !== undefined && visibleSubagentSpecs.length > 0) {
        agentCtx.tools.register(buildSubagentTool(agentId, visibleSubagentSpecs))
      }
    }
  }

  /** 创建聊天会话（agents.create：persona section + agent 作用域工具注册）。 */
  async function createChatSession(
    sessionKey: string,
    agentId: string,
    registerPersona = true,
    index?: { userId: string },
  ): Promise<OwnedSession> {
    const handle = await c.agents.create({
      sessionId: sessionKey,
      agentOptions: agentOptionsFor(agentId),
      meta: { cwd: process.cwd() },
      setup: buildAgentSetup(agentId, registerPersona),
    })
    const entry: OwnedSession = { agent: handle.agent, session: handle.agent.session, agentId, callIndex: new Map() }
    ownedSessions.set(sessionKey, entry)
    // M7：sidecar 索引登记（惰性恢复与会话列表的数据源）。
    if (index !== undefined) {
      const now = new Date().toISOString()
      await sessionIndex.put(sessionKey, { userId: index.userId, agentId, title: '(新会话)', createdAt: now, updatedAt: now, kind: 'chat' })
    }
    return entry
  }

  // ---- M3：subagent 委派工具（按父 agent 作用域注册） ---------------------------
  /**
   * 把子规格声明编译为模型面工具（dsh-tool-subagent 的 per-parent 作用域变体：
   * 工具只在 visibleTo 父的作用域注册，execute 里二次校验 spec 可见性）。
   * 前台 one-shot 语义：await run.result 再 dispose（镜像内核 settleForegroundRun）；
   * 子会话 id 即 run.id，登记后既有 /sessions/:sid/events 直接开子会话直播。
   */
  function buildSubagentTool(parentAgentId: string, specs: readonly SubagentSpec[]): unknown {
    const specIds = specs.map(spec => spec.id)
    return defineToolLoose({
      name: 'subagent',
      description: '把一个自包含的任务委派给子智能体（独立上下文与工具集的另一个 agent，不消耗本对话上下文）。'
        + '可用规格：' + specs.map(spec => `${spec.id}（${truncate(spec.persona.split('：')[0] ?? spec.persona, 60)}）`).join('；') + '。'
        + '子智能体看不到本对话历史——task 必须写明全部背景（查证对象、口径、要回答的问题）。适合并行核对、独立调研等场景。',
      parameters: {
        spec: { type: 'string', required: true, description: `子智能体规格名：${specIds.join(' | ')}` },
        task: { type: 'string', required: true, description: '自包含的任务描述（子智能体看不到本对话，需包含全部背景与要查证的对象）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            spec: { type: 'string', required: true },
            sessionId: { type: 'string', required: true },
            stopReason: { type: 'string', required: true },
            output: { type: 'string', required: true },
          },
        },
        render: (_args: unknown, value: unknown): Array<Record<string, unknown>> => [
          { type: 'text', text: JSON.stringify(value, null, 2) },
        ],
      },
      async execute(args: Record<string, unknown>, exec: { agent?: unknown; signal?: AbortSignal }): Promise<unknown> {
        const parent = exec.agent as AgentLike | undefined
        const parentSessionId = typeof parent?.session?.id === 'string' ? parent.session.id : undefined
        if (parent === undefined || parentSessionId === undefined) {
          throw new Error('subagent 工具需要 agent 调用方（内核 agent loop 之外不可委派）')
        }
        const requested = String(args.spec ?? '')
        const spec = specs.find(candidate => candidate.id === requested)
        if (spec === undefined) {
          throw new Error(`智能体 "${parentAgentId}" 只能委派声明的子规格：${specIds.join(' / ')}，收到 "${requested}"`)
        }
        const task = typeof args.task === 'string' ? args.task.trim() : ''
        if (task === '') throw new Error('task 必须是非空字符串')
        const toolFilter = compiledSubagents?.toolFilterOf(spec)
        const run = await subagentsService!.start(SUBAGENT_PROVIDER, {
          label: `loom:${spec.id}`,
          prompt: [{ type: 'text', text: task }],
          parent,
          persona: spec.persona,
          ...(toolFilter === undefined ? {} : { toolFilter }),
          maxDepth: 1,
          signal: exec.signal ?? new AbortController().signal,
        })
        // 子会话登记：SubagentRun.id 即子会话 id（本地 spawn 保证），子会话与父
        // 会话同在 SessionStore——session/event 监听器据此直接投影子事件流。
        const childSessionId = run.id
        if (run.localAgent !== undefined) {
          ownedSessions.set(childSessionId, {
            session: run.localAgent.session,
            agentId: `subagent:${spec.id}`,
            callIndex: new Map(),
            child: true,
            childSpec: spec.id,
            parentSessionId,
          })
          // M7：子会话登记 sidecar（同父属主；kind 'child' → 重启后只读回放）。
          const now = new Date().toISOString()
          await sessionIndex.put(childSessionId, {
            userId: sessionIndex.get(parentSessionId)?.userId ?? 'anon',
            agentId: `subagent:${spec.id}`,
            title: `子智能体 ${spec.id} · ${truncate(task, 20)}`,
            createdAt: now,
            updatedAt: now,
            kind: 'child',
          })
        }
        pushSse(parentSessionId, { type: 'loom/subagent-started', spec: spec.id, childSessionId, parentSessionId })
        let result: Awaited<SubagentRunLike['result']>
        try {
          result = await run.result
        } finally {
          await run.dispose().catch(error => c.logger.warn(`loom-runtime: 子会话 ${childSessionId} dispose 失败：${String(error)}`))
        }
        pushSse(parentSessionId, { type: 'loom/subagent-finished', spec: spec.id, childSessionId, stopReason: result.stopReason })
        const childText = textOfBlocks(result.output)
        if (result.stopReason !== 'completed') {
          throw new Error(`子智能体 "${spec.id}" 未正常完成（stopReason=${result.stopReason}）${childText === '' ? '' : `；其保留的部分输出：\n${childText}`}`)
        }
        c.logger.info(`loom-runtime: ${parentAgentId} 委派 ${spec.id} 完成（子会话 ${childSessionId}）`)
        return { spec: spec.id, sessionId: childSessionId, stopReason: result.stopReason, output: childText }
      },
    })
  }

  // ---- /sessions/:sid/*（events / fork / approvals） ---------------------------
  c.webServer.register({
    kind: 'prefix',
    path: `${prefix}/sessions`,
    handler: async (req, res) => {
      try {
        const cors = corsHeadersFor(req, corsOrigins)
        if (req.method === 'OPTIONS') {
          res.writeHead(204, cors)
          res.end()
          return
        }
        const url = new URL(req.url ?? '/', 'http://x')
        const pathname = url.pathname
        const segments = pathname.split('/').filter(Boolean) // ['~loom','sessions', sessionId, action, arg?]
        const [, , sessionId, action, arg] = segments
        if (sessionId === undefined) {
          writeJson(res, 404, { error: `不支持的路由：${req.method ?? ''} ${pathname}` }, {}, cors)
          return
        }
        // sessionId 形状门（纵深防御）：本服务生成的会话 id 全部匹配
        // `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`——含 `../`、绝对路径、emoji、
        // 超长或编码穿越的输入在进 sidecar 索引/内核持久化之前即拒绝（404
        // 不泄露存在性；与"索引未命中 404"同语义）。
        if (!SESSION_ID_PATTERN.test(sessionId)) {
          writeJson(res, 404, { error: '会话不存在' }, {}, cors)
          return
        }
        // 身份门先行（fork/approvals 是状态变更；401 优先于 404）。
        if (req.method === 'POST') {
          const gate = requireUser(req, url, res)
          if (gate === false) return
        }
        const indexRecord = sessionIndex.get(sessionId)
        const identity = resolveUser(req, url)
        if (ownershipDenied(indexRecord, identity)) {
          writeJson(res, 404, { error: '会话不存在' }, {}, cors) // 不泄露他人会话的存在性
          return
        }
        const entry = await ensureSession(sessionId)
        if (entry === undefined) {
          writeJson(res, 404, { error: `未知会话：${String(sessionId)}（本服务重启后只恢复本应用索引里的会话；请从会话列表继续或新建会话）` }, {}, cors)
          return
        }

        // GET /sessions/:sid/events?since=N&to=M —— SSE（to 有界区间读完即收）
        if (req.method === 'GET' && action === 'events') {
          handleEventStream(req, res, sessionId, entry, cors)
          return
        }

        // POST /sessions/:sid/fork {atSeq} —— 时间旅行分叉（必须切在 turn/end 边界）
        if (req.method === 'POST' && action === 'fork' && arg === undefined) {
          const body = await readJsonBody(req)
          const atSeq = body.atSeq === undefined || body.atSeq === null ? undefined : Number(body.atSeq)
          if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 0)) {
            writeJson(res, 400, { error: `atSeq 必须是非负整数，收到 ${JSON.stringify(body.atSeq)}` }, {}, cors)
            return
          }
          const childId = `session-${app.name}-fork-${randomUUID().slice(0, 8)}`
          let child: SessionLike
          try {
            // 内核边界校验：INVALID_BOUNDARY / OPEN_TURN（切在未完成 turn 内）等抛 SessionForkError。
            child = c.sessions.fork(entry.session, atSeq, childId)
          } catch (error) {
            const forkError = error as ForkErrorLike
            if (forkError !== null && typeof forkError === 'object' && forkError.name === 'SessionForkError') {
              const hints: Record<string, string> = {
                OPEN_TURN: 'atSeq 需为 turn/end 的 seq（当前切点落在未完成的 turn 内）',
                INVALID_BOUNDARY: 'atSeq 必须是会话中已存在且连续的事件 seq',
                SESSION_NOT_FOUND: '分叉源会话不存在',
                SESSION_NOT_LIVE: '分叉源不是存活会话',
                SESSION_ALREADY_EXISTS: '目标会话 id 已被占用',
              }
              const code = String(forkError.code ?? '')
              writeJson(res, 400, { error: forkError.message, code, hint: hints[code] ?? 'atSeq 需为 turn/end 的 seq' }, {}, cors)
              return
            }
            throw error
          }
          const forkedAt = atSeq ?? [...entry.session.events].at(-1)?.seq ?? 0
          ownedSessions.set(childId, { session: child, agentId: entry.agentId, callIndex: rebuildCallIndex(child), forked: true })
          // M7：fork 子会话登记 sidecar（同属主；kind 'fork' → 重启后只读回放恢复）。
          if (indexRecord !== undefined) {
            const now = new Date().toISOString()
            await sessionIndex.put(childId, {
              userId: indexRecord.userId,
              agentId: entry.agentId,
              title: `分叉 @${forkedAt} · ${indexRecord.title}`,
              createdAt: now,
              updatedAt: now,
              kind: 'fork',
            })
          }
          c.logger.info(`loom-runtime: 会话 ${sessionId} 分叉 @seq=${forkedAt} → ${childId}`)
          writeJson(res, 200, { sessionId: childId, forkedFrom: sessionId, atSeq: forkedAt, events: forkedAt + 1 }, {}, cors)
          return
        }

        // POST /sessions/:sid/approvals/:aid {decision} —— 审批答复（仅会话属主）
        // B2：裁决语义委托 dsh-web-approval-answerer 服务（身份门在本路由先行）。
        if (req.method === 'POST' && action === 'approvals' && arg !== undefined) {
          const answerer = answererService()
          if (answerer === undefined) {
            writeJson(res, 503, { error: '审批 answerer 不在位（组合缺 web-approval-answerer 行）', code: 'ANSWERER_UNAVAILABLE' }, {}, cors)
            return
          }
          const body = await readJsonBody(req)
          const verdict = answerer.answer(arg, sessionId, body.decision)
          switch (verdict) {
            case 'unknown':
              writeJson(res, 404, { error: `未知或已决的审批：${arg}` }, {}, cors)
              return
            case 'wrong-session':
              writeJson(res, 403, { error: '审批不属于该会话' }, {}, cors)
              return
            case 'invalid-decision':
              writeJson(res, 400, { error: `decision 必须是 "allowed-once" 或 "rejected"，收到 ${JSON.stringify(body.decision)}` }, {}, cors)
              return
            case 'already-decided':
              // 并发答复只认第一次：首个 settle 生效（200），并发到达的第二个在
              // settle 的幂等闸上落空 → 409（明确语义，不静默双收）。
              writeJson(res, 409, { error: `该审批已被裁决（并发答复只认第一次）：${arg}`, code: 'ALREADY_DECIDED' }, {}, cors)
              return
            default:
              writeJson(res, 200, { ok: true, approvalId: arg, decision: body.decision }, {}, cors)
              return
          }
        }

        writeJson(res, 404, { error: `不支持的路由：${req.method ?? ''} ${pathname}` }, {}, cors)
      } catch (error) {
        c.logger.warn(`loom-runtime: ${req.method ?? ''} ${req.url ?? ''} 处理失败：${String(error)}`)
        if (!res.headersSent) writeJson(res, errorStatusOf(error, 400), { error: String(error), ...(error instanceof RequestTooLargeError ? { code: 'BODY_TOO_LARGE' } : {}) }, {}, corsHeadersFor(req, corsOrigins))
        else res.destroy()
      }
    },
  })

  // ---- /projections[/:name]（投影规格下发；apply 以源码形态重建于浏览器） ---------
  c.webServer.register({
    kind: 'prefix',
    path: `${prefix}/projections`,
    handler: (req, res) => {
      const cors = corsHeadersFor(req, corsOrigins)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors)
        res.end()
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const segments = pathname.split('/').filter(Boolean) // ['~loom','projections', name?]
      const [, , projectionName] = segments
      if (req.method !== 'GET') {
        writeJson(res, 404, { error: `不支持的路由：${req.method ?? ''} ${pathname}` }, {}, cors)
        return
      }
      if (projectionName === undefined) {
        writeJson(res, 200, { projections: [...projectionsByName.keys()] }, {}, cors)
        return
      }
      const spec = projectionsByName.get(decodeURIComponent(projectionName))
      if (spec === undefined) {
        writeJson(res, 404, { error: `未知投影：${projectionName}` }, {}, cors)
        return
      }
      writeJson(res, 200, {
        name: spec.name,
        init: spec.init,
        apply: spec.apply.toString(),
      }, {}, cors)
    },
  })

  // ---- .http() 第二张面孔：ToolSpec.http → exact 路由 ---------------------------
  /** API 执行用的隐藏 agent（工具按 agent 作用域注册，故需借一个可见该工具的作用域）。 */
  const apiAgents = new Map<string, AgentLike>()

  async function ensureApiAgent(toolName: string): Promise<AgentLike | undefined> {
    const allTools = app.spec.tools.map(tool => tool.name)
    const spec = app.spec.agents.find(agent => (agent.tools ?? allTools).includes(toolName))
    if (spec === undefined) return undefined
    const cached = apiAgents.get(spec.id)
    if (cached !== undefined) return cached
    const entry = await createChatSession(`session-${app.name}-api-${spec.id}-${randomUUID().slice(0, 8)}`, spec.id, false)
    apiAgents.set(spec.id, entry.agent!)
    return entry.agent
  }

  /** 经内核管线执行（ctx.tools.execute：pre-execute 策略/守卫/派发全走）。 */
  async function runViaPipeline(toolName: string, args: Record<string, unknown>): Promise<ToolResultLike> {
    const agent = await ensureApiAgent(toolName)
    if (agent === undefined) throw new Error(`NO_AGENT_SCOPE`)
    return await c.tools.execute({
      callId: `http-${randomUUID()}`,
      name: toolName,
      arguments: args,
      agent,
      signal: AbortSignal.timeout(HTTP_TOOL_TIMEOUT_MS),
    })
  }

  for (const tool of app.spec.tools) {
    if (tool.http === undefined) continue
    const method = tool.http.method.toUpperCase()
    const routePath = httpRouteOf(tool, prefix)
    c.webServer.register({
      kind: 'exact',
      path: routePath,
      handler: async (req, res) => {
        try {
          const cors = corsHeadersFor(req, corsOrigins)
          if (req.method === 'OPTIONS') {
            res.writeHead(204, cors)
            res.end()
            return
          }
          if (req.method !== method) {
            writeJson(res, 405, { error: `该端点只接受 ${method}，收到 ${req.method ?? ''}` }, { allow: method }, cors)
            return
          }
          const url = new URL(req.url ?? '/', 'http://x')
          const args: Record<string, unknown> = {}
          for (const [key, value] of url.searchParams) args[key] = parseScalar(value)
          if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
            Object.assign(args, await readJsonBody(req))
          }
          // 首选内核管线（ctx.tools.execute，享受 policy/守卫）；无 agent 作用域可见时退直调。
          let result: ToolResultLike
          let via: 'pipeline' | 'direct' = 'pipeline'
          try {
            result = await runViaPipeline(tool.name, args)
          } catch (error) {
            if (String(error).includes('NO_AGENT_SCOPE')) {
              via = 'direct'
              result = await tool.execute(args, { signal: AbortSignal.timeout(HTTP_TOOL_TIMEOUT_MS) }).then(
                (value): ToolResultLike => ({ isError: false, value }),
                (error): ToolResultLike => ({ isError: true, error: { message: String(error) } }),
              )
            } else {
              throw error
            }
          }
          if (result.isError) {
            const message = result.error?.message ?? '工具执行失败'
            // 策略拒绝 / 审批不可用 → 403；其余按 500。
            const forbidden = message.includes('loom policy') || message.includes('approval')
            writeJson(res, forbidden ? 403 : 500, { ok: false, error: message, tool: tool.name }, { 'x-loom-exec': via }, cors)
            return
          }
          writeJson(res, 200, result.value, { 'x-loom-exec': via }, cors)
        } catch (error) {
          c.logger.warn(`loom-runtime: .http() ${req.method ?? ''} ${req.url ?? ''} 失败：${String(error)}`)
          if (!res.headersSent) writeJson(res, errorStatusOf(error, 500), { ok: false, error: String(error), tool: tool.name }, {}, corsHeadersFor(req, corsOrigins))
          else res.destroy()
        }
      },
    })
    c.logger.info(`loom-runtime: HTTP 面孔 ${method} ${routePath} → 工具 ${tool.name}`)
  }

  // ---- M3 通道：webhook → exact 路由 ------------------------------------------
  for (const channel of app.spec.channels) {
    if (channel.kind !== 'webhook') continue
    const routePath = `${prefix}${channel.path}`
    c.webServer.register({
      kind: 'exact',
      path: routePath,
      handler: async (req, res) => {
        try {
          const cors = corsHeadersFor(req, corsOrigins)
          if (req.method === 'OPTIONS') {
            res.writeHead(204, cors)
            res.end()
            return
          }
          if (req.method !== 'POST') {
            writeJson(res, 405, { error: `该通道只接受 POST，收到 ${req.method ?? ''}`, code: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' }, cors)
            return
          }
          const rawBody = await readRawBody(req)
          // 声明了 secret 才校验：HMAC-SHA256(rawBody) 十六进制，timingSafeEqual。
          if (channel.secret !== undefined) {
            const verdict = verifyWebhookSignature(rawBody, req.headers['x-loom-signature'], channel.secret)
            if (!verdict.ok) {
              writeJson(res, 401, { error: verdict.reason, code: verdict.code }, {}, cors)
              return
            }
          }
          let payload: Record<string, unknown>
          try {
            payload = rawBody.length === 0 ? {} : (JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>)
          } catch (error) {
            writeJson(res, 400, { error: `请求体不是合法 JSON：${String(error)}`, code: 'INVALID_JSON' }, {}, cors)
            return
          }
          const mapped = applyWebhookMap(channel.map, payload)
          if (!mapped.ok) {
            writeJson(res, 400, { error: mapped.error, code: 'MAP_FAILED' }, {}, cors)
            return
          }
          // sessionKey：命中存活会话则复用，否则新建（缺省每次新会话）。
          let sessionId: string
          if (channel.sessionKey === undefined) {
            sessionId = `session-${app.name}-hook-${randomUUID()}`
          } else {
            const keyed = applyWebhookSessionKey(channel.sessionKey, payload)
            if (!keyed.ok) {
              writeJson(res, 400, { error: keyed.error, code: 'SESSION_KEY_FAILED' }, {}, corsHeadersFor(req, corsOrigins))
              return
            }
            sessionId = webhookSessionId(app.name, keyed.key)
          }
          // M7：机器身份属主（每通道 secret 即机器凭据）；重启后经 sidecar 惰性恢复。
          // 并发同 sessionKey 首建经 ensureSession 的 restoring 去重——只建一个 agent。
          const hookUserId = `hook:${channel.path}`
          let created = false
          const entry = await ensureSession(sessionId, () => {
            created = true
            return createChatSession(sessionId, channel.agent, true, { userId: hookUserId })
          })
          const reused = !created
          entry!.agent!.followup(
            createUserMessage({
              content: [{ type: 'text', text: mapped.text }],
              source: { kind: 'user' },
            }),
          )
          const indexRecord = sessionIndex.get(sessionId)
          if (indexRecord !== undefined && (indexRecord.title === '(新会话)' || indexRecord.title === '')) {
            await sessionIndex.touch(sessionId, { title: titleOf(mapped.text), updatedAt: new Date().toISOString() })
          }
          c.logger.info(`loom-runtime: webhook ${routePath} → ${channel.agent} 会话 ${sessionId}${reused ? '（复用）' : '（新建）'}：${truncate(mapped.text, 80)}`)
          writeJson(res, 202, { sessionId, agentId: channel.agent, reused }, {}, corsHeadersFor(req, corsOrigins))
        } catch (error) {
          c.logger.warn(`loom-runtime: webhook ${req.method ?? ''} ${req.url ?? ''} 失败：${String(error)}`)
          if (!res.headersSent) writeJson(res, errorStatusOf(error, 500), { error: String(error), code: error instanceof RequestTooLargeError ? 'BODY_TOO_LARGE' : 'INTERNAL' }, {}, corsHeadersFor(req, corsOrigins))
          else res.destroy()
        }
      },
    })
    c.logger.info(
      `loom-runtime: webhook 通道 POST ${routePath} → 智能体 ${channel.agent}`
      + (channel.secret === undefined ? '（无签名）' : '（校验 x-loom-signature）'),
    )
  }

  // ---- SSE 流（since 补放 + 实时 + 心跳；to 有界则读完即收） ---------------------
  /**
   * 先补放 since 之后的历史（从会话内存日志读），再实时转发；每 15 秒一条心跳注释行。
   * 订阅 sink 先缓冲再直写，消除"快照读完、监听未挂"的丢事件窗口（gis-bridge 同法）。
   * 带 `to` 时为有界区间读取：只补放 since < seq ≤ to，随后正常收尾（回放调试器用）。
   */
  function handleEventStream(req: IncomingMessage, res: ServerResponse, sessionId: string, entry: OwnedSession, cors: Record<string, string> = CORS_HEADERS): void {
    const params = new URL(req.url ?? '/', 'http://x').searchParams
    const sinceRaw = params.get('since')
    let since = Number.parseInt(String(sinceRaw), 10)
    if (!Number.isSafeInteger(since) || since < 0) since = -1
    const toRaw = params.get('to')
    let to: number | null = null
    if (toRaw !== null) {
      const parsed = Number.parseInt(toRaw, 10)
      to = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
    }

    res.writeHead(200, {
      ...cors,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 3000\n\n')

    const queue: Array<Record<string, unknown>> = []
    let lastSeq = since
    const emit = (payload: Record<string, unknown>): void => {
      // loom/* 合成事件（审批卡片）无 seq，直写不参与排序；seq 事件仍严格去重。
      if (typeof payload.seq === 'number') {
        if (payload.seq <= lastSeq) return
        lastSeq = payload.seq
      }
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    }

    // 有界区间（回放调试）：补放后即收尾，不挂实时订阅。
    if (to !== null) {
      for (const event of entry.session.events) {
        if (event.seq <= since) continue
        if (event.seq > to) break
        const payload = projectEvent(event, entry.callIndex, cards)
        if (payload !== undefined) emit(payload)
      }
      res.write(`data: ${JSON.stringify({ type: 'loom/replay-end', to })}\n\n`)
      res.end()
      return
    }

    const bufferingSink = (payload: Record<string, unknown>): void => {
      queue.push(payload)
    }

    let set = subscribers.get(sessionId)
    if (set === undefined) {
      set = new Set()
      subscribers.set(sessionId, set)
    }
    set.add(bufferingSink)

    for (const event of entry.session.events) {
      if (event.seq <= since) continue
      const payload = projectEvent(event, entry.callIndex, cards)
      if (payload !== undefined) emit(payload)
    }
    set.delete(bufferingSink)
    set.add(emit)
    for (const payload of queue) emit(payload)

    // M2 补强：approval-asked 是合成事件（不落会话日志），断线重连的重放拿不到
    // 它——订阅挂上后把该会话仍挂起的审批卡按原 approvalId 重发一遍（前端按
    // approvalId 幂等去重；刷新页面/重连后未决审批不再丢失）。
    // B2：留档数据源在 dsh-web-approval-answerer 服务（语义未变）。
    const answerer = answererService()
    if (answerer !== undefined) {
      for (const payload of answerer.pendingPayloads(sessionId)) emit(payload)
    }

    const heartbeat = setInterval(() => {
      res.write(': hb\n\n')
    }, 15000)
    res.on('close', () => {
      clearInterval(heartbeat)
      set!.delete(emit)
      // 空集合不驻留：会话再无订阅者时移除 Map 条目（防 subscribers Map 随
      // 会话数缓慢增长——断言见 health 的 runtime.sse 计数）。
      if ((set?.size ?? 1) === 0) subscribers.delete(sessionId)
    })
  }
}

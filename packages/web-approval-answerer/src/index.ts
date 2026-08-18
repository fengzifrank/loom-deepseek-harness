/**
 * dsh-web-approval-answerer —— SSE 审批 answerer 插件（自 @loom-sdk/web 的
 * runtime.ts 剥离，M8 插件化：Loom 成为插件生产者）。
 *
 * 职责（审批语义全部在此，宿主只留 HTTP 线形与身份门）：
 * 1. 注册 `approval/request` answerer：宿主认领的会话 → 经宿主桥 SSE 推
 *    `loom/approval-asked` 卡（approvalId/tool/callSeq/argsPreview/timeoutMs），
 *    等待答复或超时（默认 5 分钟，**超时=拒绝——fail-closed**）；req.signal
 *    abort → 'cancelled'；非宿主会话 → next() 委托（无人应答则内核 fail-closed）。
 * 2. 待审批留档重发：approval-asked 是合成事件（不落会话日志），SSE 重连的
 *    历史重放拿不到它——宿主的事件流处理器在订阅挂上后调
 *    `pendingPayloads(sessionId)` 按原 approvalId 幂等重发（前端按 id 去重）。
 * 3. 答复裁决：`answer(approvalId, sessionId, decision)` —— 并发答复只认
 *    第一次（首个 settle 生效 'ok'，第二个落空 'already-decided'，宿主映射
 *    409）；sessionId 不匹配 'wrong-session'（403）；未知/已决 'unknown'
 *    （404）；decision 形状非法 'invalid-decision'（400）。
 *
 * 宿主接缝（loose，照 python-bridge 模式）：宿主经 cordis 服务
 * `webApprovalHost`（reflect.provide）给出 owns/push/drainArgsPreview/
 * callSeqOf/timeoutMs；插件每次请求惰性 ctx.get——无激活顺序耦合。
 * HTTP 答复路由由宿主持有（身份门是宿主关切；宿主路由处理器把裁决委托给
 * 本插件的 answer()——线形不变，语义全在插件）。
 * @module dsh-web-approval-answerer
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Cordis 插件名。 */
export const name = 'web-approval-answerer'

/** 挂载前提：无硬依赖（approval/request 事件由 dsh-user-approval 声明——组合需在行）。 */
export const inject: string[] = []

/** 插件配置 schema。 */
export const Config = z.object({
  /** 审批等待答复的超时毫秒数（宿主桥未给时的缺省；宿主给了以宿主为准）。默认 5 分钟。 */
  timeoutMs: z.number().description('审批超时（毫秒），超时按拒绝处理（fail-closed）'),
})

/** 插件配置形态。 */
export interface WebApprovalAnswererConfig {
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// 内核 loose 类型（见 dsh-user-approval ApprovalRequest / ApprovalOutcome）
// ---------------------------------------------------------------------------

/** 内核 approval/request 的请求（loose 视图）。 */
export interface ApprovalRequestLike {
  readonly agent?: { session?: { id?: string } }
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** 内核 ApprovalOutcome：一次性放行 / 拒绝 / 撤回 / 无应答（fail-closed）。 */
export type ApprovalOutcomeLike = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

// ---------------------------------------------------------------------------
// 宿主桥接缝（宿主经 cordis 服务 'webApprovalHost' 提供）
// ---------------------------------------------------------------------------

/** 宿主桥：会话归属 / SSE 直推 / 参数预览 / 调用序 / 超时。 */
export interface WebApprovalHost {
  /** 会话是否归宿主插件管（非宿主会话的 approval/request 委托 next()）。 */
  owns(sessionId: string): boolean
  /** 向该会话的全部 SSE 订阅者直推载荷（loom/* 合成事件）。 */
  push(sessionId: string, payload: Record<string, unknown>): void
  /** 取走 callId 的审批参数预览（drain 语义：取走即删）；无预览返回 undefined。 */
  drainArgsPreview(callId: string | undefined): string | undefined
  /** callId 在该会话里的 tool/call seq（载荷携带 callSeq 供前端锚定）。 */
  callSeqOf(sessionId: string, callId: string): number | undefined
  /** 审批超时毫秒数（覆盖插件 config.timeoutMs）。 */
  readonly timeoutMs?: number
}

/** 宿主桥的 cordis 服务名。 */
export const WEB_APPROVAL_HOST_SERVICE = 'webApprovalHost'

/** answerer 对外提供的 cordis 服务名（宿主路由/事件流消费）。 */
export const WEB_APPROVAL_ANSWERER_SERVICE = 'webApprovalAnswerer'

/** 默认审批超时：5 分钟（fail-closed）。 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// ApprovalAnswerer：审批语义核心（不依赖 cordis，单测直测）
// ---------------------------------------------------------------------------

/** 答复裁决结果（宿主 HTTP 映射：ok→200 / unknown→404 / wrong-session→403 / already-decided→409 / invalid-decision→400）。 */
export type AnswerVerdict = 'ok' | 'unknown' | 'wrong-session' | 'already-decided' | 'invalid-decision'

/** 一个挂起中的审批。 */
export interface PendingApproval {
  readonly approvalId: string
  readonly sessionId: string
  readonly tool: string
  /** 首推时的完整 approval-asked 载荷（SSE 重连时按原 approvalId 幂等重发）。 */
  readonly payload: Record<string, unknown>
}

interface PendingEntry extends PendingApproval {
  /** 裁决（幂等）：首次返回 true，之后的调用 no-op 返回 false（并发答复只认第一次）。 */
  settle(outcome: ApprovalOutcomeLike): boolean
}

/** 最小日志接口（cordis ctx.logger / console 均满足）。 */
export interface AnswererLogger {
  info(line: string): void
  warn(line: string): void
}

const silentLogger: AnswererLogger = { info: () => undefined, warn: () => undefined }

/**
 * 审批 answerer 核心：`handleRequest` 是 approval/request 监听体；
 * `answer` 是 HTTP 答复裁决；`pendingPayloads` 是重连重发数据源。
 */
export class ApprovalAnswerer {
  private readonly host: WebApprovalHost
  private readonly timeoutMs: number
  private readonly logger: AnswererLogger
  private readonly pending = new Map<string, PendingEntry>()

  constructor(opts: { host: WebApprovalHost; timeoutMs?: number; logger?: AnswererLogger }) {
    this.host = opts.host
    this.timeoutMs = opts.host.timeoutMs ?? opts.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    this.logger = opts.logger ?? silentLogger
  }

  /** 挂起数（诊断/测试断言用）。 */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * approval/request 监听体：宿主会话 → SSE 审批卡 + 等答复/超时/abort；
   * 非宿主会话（或宿主缺席）→ next() 委托。
   */
  handleRequest(req: ApprovalRequestLike, next: () => Promise<ApprovalOutcomeLike>): Promise<ApprovalOutcomeLike> {
    const sessionId = req.agent?.session?.id
    if (typeof sessionId !== 'string' || !this.host.owns(sessionId)) return next()
    const callId = req.callId === undefined ? undefined : String(req.callId)
    const argsPreview = this.host.drainArgsPreview(callId)
    const callSeq = callId === undefined ? undefined : this.host.callSeqOf(sessionId, callId)
    const approvalId = crypto.randomUUID()
    const askedPayload: Record<string, unknown> = {
      type: 'loom/approval-asked',
      approvalId,
      sessionId,
      tool: req.toolName,
      ...(callId === undefined ? {} : { callId }),
      ...(callSeq === undefined ? {} : { callSeq }),
      ...(argsPreview === undefined ? {} : { argsPreview }),
      ...(req.reason === undefined ? {} : { reason: req.reason }),
      timeoutMs: this.timeoutMs,
    }
    this.host.push(sessionId, askedPayload)
    return new Promise<ApprovalOutcomeLike>(resolve => {
      let settled = false
      const settle = (outcome: ApprovalOutcomeLike): boolean => {
        if (settled) return false
        settled = true
        clearTimeout(timer)
        if (req.signal !== undefined) req.signal.removeEventListener('abort', onAbort)
        this.pending.delete(approvalId)
        this.host.push(sessionId, { type: 'loom/approval-decided', approvalId, decision: outcome })
        resolve(outcome)
        return true
      }
      // fail-closed：超时视作拒绝（不是放行）。
      const timer = setTimeout(() => settle('rejected'), this.timeoutMs)
      const onAbort = (): boolean => settle('cancelled')
      req.signal?.addEventListener('abort', onAbort, { once: true })
      // 载荷留档：SSE 重连时宿主事件流按原 approvalId 幂等重发
      // （approval-asked 是合成事件、不落会话日志，重连重放拿不到它）。
      this.pending.set(approvalId, { approvalId, sessionId, tool: req.toolName, settle, payload: askedPayload })
    })
  }

  /** 该会话仍挂起的审批卡载荷（SSE 重连重发用；订阅挂上后逐条 emit）。 */
  pendingPayloads(sessionId: string): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = []
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) out.push(entry.payload)
    }
    return out
  }

  /**
   * HTTP 答复裁决（宿主路由处理器委托到这里；身份门在宿主侧先行）。
   * 并发答复只认第一次：首个 settle 生效（'ok'），并发到达的第二个在 settle
   * 的幂等闸上落空 → 'already-decided'（明确语义，不静默双收）。
   */
  answer(approvalId: string, sessionId: string, decision: unknown): AnswerVerdict {
    const pending = this.pending.get(approvalId)
    if (pending === undefined) return 'unknown'
    if (pending.sessionId !== sessionId) return 'wrong-session'
    if (decision !== 'allowed-once' && decision !== 'rejected') return 'invalid-decision'
    return pending.settle(decision) ? 'ok' : 'already-decided'
  }
}

// ---------------------------------------------------------------------------
// cordis 插件
// ---------------------------------------------------------------------------

/** apply 需要的最小 ctx 形状（loose 视图）。 */
interface AnswererCtx {
  logger: AnswererLogger
  reflect: { provide(serviceName: string, value: unknown): () => void }
  effect(register: () => () => void): unknown
  get?(service: typeof WEB_APPROVAL_HOST_SERVICE): WebApprovalHost | undefined
  on(event: 'approval/request', listener: (req: ApprovalRequestLike, next: () => Promise<ApprovalOutcomeLike>) => Promise<ApprovalOutcomeLike>): () => void
}

/** 插件提供的答案器服务形状（宿主消费）。 */
export interface WebApprovalAnswererService {
  /** 该会话仍挂起的审批卡载荷（SSE 重连重发）。 */
  pendingPayloads(sessionId: string): Array<Record<string, unknown>>
  /** HTTP 答复裁决（宿主路由委托）。 */
  answer(approvalId: string, sessionId: string, decision: unknown): AnswerVerdict
  /** 挂起数（health 观测面）。 */
  readonly pendingCount: number
}

/**
 * 挂载 SSE 审批 answerer：注册 approval/request 监听（宿主桥惰性解析——
 * 宿主未提供桥或会话非宿主 → next() 委托），并提供 webApprovalAnswerer
 * 服务（重发留档 + 答复裁决 + 计数）。
 */
export function apply(ctx: Context, config: WebApprovalAnswererConfig): void {
  const c = ctx as unknown as AnswererCtx
  // answerer 按宿主桥惰性构造（每请求解析一次——桥可能在 answerer 之后激活；
  // 同一宿主桥的 answerer 共享 pending 注册表，故按宿主实例缓存）。
  let answerer: ApprovalAnswerer | undefined
  const answererFor = (host: WebApprovalHost): ApprovalAnswerer => {
    if (answerer === undefined || answererPendingHost(answerer) !== host) {
      answerer = new ApprovalAnswerer({
        host,
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        logger: c.logger,
      })
    }
    return answerer
  }
  const hostOf = (): WebApprovalHost | undefined => c.get?.(WEB_APPROVAL_HOST_SERVICE)

  c.on('approval/request', (req, next) => {
    const host = hostOf()
    if (host === undefined) return next() // 宿主桥未就位 → 委托（内核 fail-closed）
    return answererFor(host).handleRequest(req, next)
  })

  const service: WebApprovalAnswererService = {
    pendingPayloads: sessionId => {
      const host = hostOf()
      return host === undefined ? [] : answererFor(host).pendingPayloads(sessionId)
    },
    answer: (approvalId, sessionId, decision) => {
      const host = hostOf()
      return host === undefined ? 'unknown' : answererFor(host).answer(approvalId, sessionId, decision)
    },
    get pendingCount() {
      return answerer?.pendingCount ?? 0
    },
  }
  const unprovide = c.reflect.provide(WEB_APPROVAL_ANSWERER_SERVICE, service)
  c.effect(() => () => unprovide())
  c.logger.info('web-approval-answerer: SSE 审批 answerer 已挂载（approval/request → 宿主 SSE 审批卡；超时 fail-closed）')
}

/** 测试钩子：answerer 当前绑定的宿主桥（同一宿主复用同一 pending 注册表）。 */
function answererPendingHost(answerer: ApprovalAnswerer): WebApprovalHost {
  return (answerer as unknown as { host: WebApprovalHost }).host
}

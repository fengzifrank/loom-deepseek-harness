/**
 * 预算计量器（M9）—— 每会话一份，配合 app.policy({ budgets: [...] }) 使用。
 *
 * 计数语义（诚实边界见 policy.ts BudgetSpec 的 doc）：
 * - tool-calls：pre-execute 里**先记后查**——被策略/预算拒绝的调用也计数
 *   （计的是"尝试"，防反复试探绕预算；与 omnigent 在 tool_call 阶段计数一致）；
 * - session-tokens：assistant/message 的 usage 四桶（input/output/cacheRead/
 *   cacheWrite，内核保证不相交）求和累计，超限后**新的工具调用**被拒——
 *   模型仍可纯文本作答，但不许再动手；
 * - check() 返回声明顺序里第一条已超限且影响该工具的预算。
 * @module @loom-sdk/web/budget
 */

import { globToRegExp, type BudgetSpec } from './policy.js'

/** 内核 TokenUsage（loose 视图：llm/types.ts 四桶，互不相交）。 */
export interface BudgetUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** 一条预算的超限事实（SSE 事件与拒绝理由共用）。 */
export interface BudgetExceeded {
  /** 声明顺序下标（同一条预算只广播一次 SSE 的判定键）。 */
  readonly index: number
  readonly spec: BudgetSpec
  /** 上限副本（SSE 载荷直接用）。 */
  readonly max: number
  /** 当前值（tool-calls 为命中计数；session-tokens 为累计 token）。 */
  readonly current: number
  /** 是否为本条预算的首次越限（SSE 只在首次广播）。 */
  readonly firstTime: boolean
}

/** 每会话的预算计量器。构造后只暴露三个纯记账方法，不做任何 I/O。 */
export class BudgetMeter {
  private readonly patterns: ReadonlyArray<RegExp | undefined>
  private tokens = 0
  private readonly exceededOnce = new Set<number>()

  constructor(private readonly specs: readonly BudgetSpec[]) {
    this.patterns = specs.map(spec => (spec.kind === 'tool-calls' ? globToRegExp(spec.tool ?? '*') : undefined))
  }

  /** 各 tool-calls 预算的当前计数（下标 → 计数；快照/测试用）。 */
  private readonly toolCallCounts = new Map<number, number>()

  /** 记一次工具调用尝试（只增加命中 tool-calls 预算的计数）。 */
  recordToolCall(toolName: string): void {
    for (const [index, pattern] of this.patterns.entries()) {
      if (pattern === undefined || !pattern.test(toolName)) continue
      this.toolCallCounts.set(index, (this.toolCallCounts.get(index) ?? 0) + 1)
    }
  }

  /** 记一次 assistant 消息的 token 用量（四桶求和；缺失桶按 0）。 */
  recordTokens(usage: BudgetUsage): void {
    const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
      + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    if (total > 0) this.tokens += total
  }

  /** 当前累计（只读快照，观测/测试用）。 */
  snapshot(): { toolCalls: Record<number, number>; tokens: number } {
    return { toolCalls: Object.fromEntries(this.toolCallCounts), tokens: this.tokens }
  }

  /**
   * 检查该工具是否触碰已超限预算：tool-calls 看"命中模式的计数 > max"，
   * session-tokens 看累计 > max（作用于任何工具）。返回声明顺序第一条。
   */
  check(toolName: string): BudgetExceeded | undefined {
    for (const [index, spec] of this.specs.entries()) {
      if (spec.kind === 'session-tokens') {
        if (this.tokens > spec.max) return this.exceeded(index, spec, this.tokens)
        continue
      }
      const current = this.toolCallCounts.get(index)
      if (current === undefined) continue
      if (!this.patterns[index]!.test(toolName)) continue
      if (current > spec.max) return this.exceeded(index, spec, current)
    }
    return undefined
  }

  private exceeded(index: number, spec: BudgetSpec, current: number): BudgetExceeded {
    const firstTime = !this.exceededOnce.has(index)
    this.exceededOnce.add(index)
    return { index, spec, max: spec.max, current, firstTime }
  }
}

/** 超限事实 → 人类可读描述（拒绝理由与 SSE 事件共用同一份文案）。 */
export function describeBudget(exceeded: BudgetExceeded): string {
  const scope = exceeded.spec.kind === 'tool-calls'
    ? `工具调用预算（模式 "${exceeded.spec.tool ?? '*'}"）`
    : '会话 token 预算'
  const effect = exceeded.spec.effect === 'approve' ? '需人工审批' : '已超限拒绝'
  return `${scope}已超限：${exceeded.current}/${exceeded.spec.max}，本次调用${effect}`
}

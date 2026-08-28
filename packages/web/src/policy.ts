/**
 * 策略编译器（M2）—— 把 app.policy({...}) 声明编译为工具名 → 裁决的纯函数。
 *
 * 语义（whitepaper §5.5 的可运行子集）：
 * - 规则按声明顺序求值，**后声明覆盖先声明**（最后一条命中的规则生效）；
 * - 无规则命中时取 `default`；
 * - `allow` 放行 / `deny` 拒绝 / `approve` 需人工审批（映射到内核
 *   `tools/pre-execute` 的 allow/deny/ask 三种裁决，ask 由内核工具管线路由进
 *   `ctx.approval` 审批缝，见 deepseek-harness packages/core/tools/src/index.ts
 *   的 serviceAsk）。
 * @module @loom-sdk/web/policy
 */

/** 策略裁决（approve 在内核层面即 `ask` 裁决）。 */
export type PolicyEffect = 'allow' | 'deny' | 'approve'

/** 一条规则：glob 工具名模式 + 裁决。 */
export interface PolicyRule {
  readonly tool: string
  readonly effect: PolicyEffect
}

/** app.policy({...}) 的声明形态。 */
export interface PolicySpec {
  /** 无规则命中时的兜底裁决。 */
  readonly default: PolicyEffect
  /** 有序规则；后声明覆盖先声明。 */
  readonly rules: readonly PolicyRule[]
  /** 审批等待答复的超时（毫秒）；超时按拒绝处理（fail-closed）。默认 300000（5 分钟）。 */
  readonly approvalTimeoutMs?: number
  /** 量化预算（M9）：按会话累计，超限 fail-closed（默认拒绝，或转人工审批）。 */
  readonly budgets?: readonly BudgetSpec[]
}

/**
 * 一条量化预算（M9，语义移植自 omnigent 治理层的 spend-cap 思路）：
 * 计数器挂在会话上——工具调用按命中 glob 计数，token 按 assistant 消息的
 * usage 四桶（input/output/cacheRead/cacheWrite，内核保证不相交）求和累计；
 * 超限后的下一次工具调用按 effect 处理。v1 边界：计数器在内存中，进程重启
 * 清零（会话日志保留完整审计，可事后核对）。
 */
export interface BudgetSpec {
  /** 预算类型：tool-calls 每会话工具调用次数 / session-tokens 每会话 token 总消耗。 */
  readonly kind: 'tool-calls' | 'session-tokens'
  /** 上限（正整数）。tool-calls：命中模式的第 max+1 次调用被拒；session-tokens：累计超过 max 后新工具调用被拒。 */
  readonly max: number
  /** 命中的 glob 工具模式（tool-calls 用；缺省 '*' 全部工具）。 */
  readonly tool?: string
  /** 超限处理：deny 拒绝（默认，fail-closed）/ approve 转人工审批（复用审批门）。 */
  readonly effect?: 'deny' | 'approve'
}

/** 全部合法预算类型（运行时校验用）。 */
export const BUDGET_KINDS: readonly ('tool-calls' | 'session-tokens')[] = ['tool-calls', 'session-tokens']

/** 全部合法预算超限裁决（运行时校验用）。 */
export const BUDGET_EFFECTS: readonly ('deny' | 'approve')[] = ['deny', 'approve']

/** 全部合法裁决（运行时校验用）。 */
export const POLICY_EFFECTS: readonly PolicyEffect[] = ['allow', 'deny', 'approve']

/**
 * glob → RegExp。仅支持 `*`（任意字符序列）与 `?`（单个字符），
 * 其余字符按字面转义；整串匹配。工具名不含 `/`，`*` 即 `.*`。
 */
export function globToRegExp(pattern: string): RegExp {
  let source = '^'
  for (const ch of pattern) {
    if (ch === '*') source += '.*'
    else if (ch === '?') source += '.'
    else source += ch.replace(/[.*+?^${}()|[\]\\]/, '\\$&')
  }
  return new RegExp(`${source}$`)
}

/** 校验 PolicySpec 形状，非法即抛错（诚实失败优于静默忽略）。 */
export function assertPolicySpec(spec: unknown): asserts spec is PolicySpec {
  if (spec === null || typeof spec !== 'object') throw new Error('app.policy() 参数必须是对象')
  const s = spec as Record<string, unknown>
  if (!POLICY_EFFECTS.includes(s.default as PolicyEffect)) {
    throw new Error(`app.policy() 的 default 必须是 ${POLICY_EFFECTS.map(e => `"${e}"`).join(' / ')}，收到 ${JSON.stringify(s.default)}`)
  }
  if (!Array.isArray(s.rules)) throw new Error('app.policy() 的 rules 必须是数组')
  for (const [index, rule] of s.rules.entries()) {
    if (rule === null || typeof rule !== 'object') throw new Error(`app.policy() rules[${index}] 必须是 { tool, effect } 对象`)
    const r = rule as Record<string, unknown>
    if (typeof r.tool !== 'string' || r.tool.trim() === '') {
      throw new Error(`app.policy() rules[${index}].tool 必须是非空字符串`)
    }
    if (!POLICY_EFFECTS.includes(r.effect as PolicyEffect)) {
      throw new Error(`app.policy() rules[${index}].effect 必须是 ${POLICY_EFFECTS.map(e => `"${e}"`).join(' / ')}，收到 ${JSON.stringify(r.effect)}`)
    }
  }
  if (s.approvalTimeoutMs !== undefined
    && (!Number.isSafeInteger(s.approvalTimeoutMs) || (s.approvalTimeoutMs as number) <= 0)) {
    throw new Error(`app.policy() 的 approvalTimeoutMs 必须是正整数，收到 ${JSON.stringify(s.approvalTimeoutMs)}`)
  }
  if (s.budgets !== undefined) {
    if (!Array.isArray(s.budgets)) throw new Error('app.policy() 的 budgets 必须是数组')
    for (const [index, budget] of (s.budgets as unknown[]).entries()) {
      if (budget === null || typeof budget !== 'object') throw new Error(`app.policy() budgets[${index}] 必须是 { kind, max } 对象`)
      const b = budget as Record<string, unknown>
      if (!BUDGET_KINDS.includes(b.kind as 'tool-calls')) {
        throw new Error(`app.policy() budgets[${index}].kind 必须是 ${BUDGET_KINDS.map(k => `"${k}"`).join(' / ')}，收到 ${JSON.stringify(b.kind)}`)
      }
      if (!Number.isSafeInteger(b.max) || (b.max as number) <= 0) {
        throw new Error(`app.policy() budgets[${index}].max 必须是正整数，收到 ${JSON.stringify(b.max)}`)
      }
      if (b.tool !== undefined && (typeof b.tool !== 'string' || (b.tool as string).trim() === '')) {
        throw new Error(`app.policy() budgets[${index}].tool 必须是非空字符串（glob 模式）`)
      }
      if (b.effect !== undefined && !BUDGET_EFFECTS.includes(b.effect as 'deny')) {
        throw new Error(`app.policy() budgets[${index}].effect 必须是 ${BUDGET_EFFECTS.map(e => `"${e}"`).join(' / ')}，收到 ${JSON.stringify(b.effect)}`)
      }
      if (b.kind === 'session-tokens' && b.tool !== undefined) {
        throw new Error(`app.policy() budgets[${index}]：session-tokens 预算是会话级总量，不支持 tool 模式（收到 ${JSON.stringify(b.tool)}）`)
      }
    }
  }
}

/** 编译后的策略：一个纯函数。 */
export interface CompiledPolicy {
  /** 工具名 → 裁决（后声明覆盖先声明，无命中取 default）。 */
  decide(toolName: string): PolicyEffect
  /** 只读副本（调试/测试）。 */
  readonly spec: PolicySpec
}

/**
 * 编译策略声明。规则按声明顺序求值但**后声明覆盖先声明**：
 * 求值从最后一条规则往前找首个命中，等价于"最后命中的规则生效"。
 */
export function compilePolicy(spec: PolicySpec): CompiledPolicy {
  assertPolicySpec(spec)
  const compiled = spec.rules.map(rule => ({ pattern: globToRegExp(rule.tool), effect: rule.effect }))
  return {
    spec,
    decide(toolName: string): PolicyEffect {
      for (let index = compiled.length - 1; index >= 0; index -= 1) {
        if (compiled[index]!.pattern.test(toolName)) return compiled[index]!.effect
      }
      return spec.default
    },
  }
}

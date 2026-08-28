import { describe, expect, it } from 'vitest'
import { BudgetMeter, describeBudget } from '../src/budget.js'
import type { BudgetSpec } from '../src/policy.js'

const spec = (partial: Partial<BudgetSpec> & Pick<BudgetSpec, 'kind' | 'max'>): BudgetSpec => partial as BudgetSpec

describe('BudgetMeter：tool-calls 计数', () => {
  it('命中模式逐次计数，第 max+1 次超限', () => {
    const meter = new BudgetMeter([spec({ kind: 'tool-calls', max: 3, tool: 'gis_*' })])
    for (let i = 0; i < 3; i += 1) {
      meter.recordToolCall('gis_query_land_types')
      expect(meter.check('gis_query_land_types')).toBeUndefined()
    }
    meter.recordToolCall('gis_query_land_types')
    const exceeded = meter.check('gis_query_land_types')
    expect(exceeded).toBeDefined()
    expect(exceeded!.current).toBe(4)
    expect(exceeded!.max).toBe(3)
    expect(exceeded!.spec.kind).toBe('tool-calls')
  })

  it('不匹配模式的调用不计数；超限只影响命中的工具', () => {
    const meter = new BudgetMeter([spec({ kind: 'tool-calls', max: 1, tool: 'gis_update_*' })])
    meter.recordToolCall('gis_query_land_types')
    meter.recordToolCall('gis_query_land_types')
    expect(meter.check('gis_query_land_types')).toBeUndefined()
    meter.recordToolCall('gis_update_land_note')
    expect(meter.check('gis_update_land_note')).toBeUndefined() // 1 次 = max，未超
    meter.recordToolCall('gis_update_land_note')
    expect(meter.check('gis_update_land_note')).toBeDefined()   // 第 2 次超限
    // token 或其他工具不受此预算影响
    expect(meter.check('gis_query_land_types')).toBeUndefined()
  })

  it('缺省模式 = 全部工具', () => {
    const meter = new BudgetMeter([spec({ kind: 'tool-calls', max: 2 })])
    meter.recordToolCall('a')
    meter.recordToolCall('b')
    expect(meter.check('c')).toBeUndefined() // 计数 2 = max，未超
    meter.recordToolCall('c')
    expect(meter.check('c')).toBeDefined()   // 第 3 次超限（计数按调用累计，不限工具名）
  })

  it('firstTime 只在首次越限时为 true（SSE 只广播一次）', () => {
    const meter = new BudgetMeter([spec({ kind: 'tool-calls', max: 0 })])
    meter.recordToolCall('x')
    expect(meter.check('x')!.firstTime).toBe(true)
    meter.recordToolCall('x')
    expect(meter.check('x')!.firstTime).toBe(false)
  })

  it('多条预算声明顺序优先：返回第一条超限', () => {
    const meter = new BudgetMeter([
      spec({ kind: 'tool-calls', max: 5, tool: 'a_*' }),
      spec({ kind: 'tool-calls', max: 0, tool: 'a_*' }),
    ])
    meter.recordToolCall('a_x')
    const exceeded = meter.check('a_x')
    expect(exceeded!.index).toBe(1) // 第 0 条未超，第 1 条超
  })
})

describe('BudgetMeter：session-tokens 累计', () => {
  it('四桶求和，缺失桶按 0；累计越限作用于任何工具', () => {
    const meter = new BudgetMeter([spec({ kind: 'session-tokens', max: 1000 })])
    meter.recordTokens({ inputTokens: 400, outputTokens: 100 })
    expect(meter.check('any_tool')).toBeUndefined()
    meter.recordTokens({ inputTokens: 300, cacheReadTokens: 150, cacheWriteTokens: 60 }) // 四桶均计
    const exceeded = meter.check('any_tool')
    expect(exceeded).toBeDefined()
    expect(exceeded!.current).toBe(1010)
  })

  it('零/负值桶不累计（防御性：内核不会发负数）', () => {
    const meter = new BudgetMeter([spec({ kind: 'session-tokens', max: 100 })])
    meter.recordTokens({ inputTokens: 0, outputTokens: 0 })
    meter.recordTokens({})
    expect(meter.snapshot().tokens).toBe(0)
    expect(meter.check('x')).toBeUndefined()
  })

  it('token 超限不依赖工具模式（声明里带 tool 也按会话级生效）', () => {
    const meter = new BudgetMeter([spec({ kind: 'session-tokens', max: 10 })])
    meter.recordTokens({ inputTokens: 11 })
    expect(meter.check('whatever')).toBeDefined()
  })
})

describe('BudgetMeter：混合预算', () => {
  it('tool-calls 与 session-tokens 并存，任一越限即拒', () => {
    const meter = new BudgetMeter([
      spec({ kind: 'tool-calls', max: 2, tool: 'gis_*' }),
      spec({ kind: 'session-tokens', max: 500, effect: 'approve' }),
    ])
    meter.recordToolCall('gis_a')
    meter.recordToolCall('gis_a')
    expect(meter.check('gis_a')).toBeUndefined()
    meter.recordTokens({ inputTokens: 600 })
    const exceeded = meter.check('gis_a')
    expect(exceeded!.spec.kind).toBe('session-tokens')
    expect(exceeded!.spec.effect).toBe('approve')
  })
})

describe('describeBudget', () => {
  it('文案包含模式、计数与上限', () => {
    const meter = new BudgetMeter([spec({ kind: 'tool-calls', max: 3, tool: 'gis_update_*' })])
    for (let i = 0; i < 4; i += 1) meter.recordToolCall('gis_update_land_note')
    const text = describeBudget(meter.check('gis_update_land_note')!)
    expect(text).toContain('gis_update_*')
    expect(text).toContain('4/3')
    expect(text).toContain('超限')
  })
})

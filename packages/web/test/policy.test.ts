import { describe, expect, it } from 'vitest'
import { assertPolicySpec, compilePolicy, globToRegExp } from '../src/policy.js'

describe('globToRegExp', () => {
  it('前缀 + * 通配整段后缀', () => {
    expect(globToRegExp('gis_write_*').test('gis_write_report')).toBe(true)
    expect(globToRegExp('gis_write_*').test('gis_write')).toBe(false)
    expect(globToRegExp('gis_write_*').test('gis_update_land_note')).toBe(false)
  })

  it('? 匹配单个字符', () => {
    expect(globToRegExp('tool_?').test('tool_a')).toBe(true)
    expect(globToRegExp('tool_?').test('tool_ab')).toBe(false)
  })

  it('正则元字符按字面转义', () => {
    expect(globToRegExp('a.b+c').test('a.b+c')).toBe(true)
    expect(globToRegExp('a.b+c').test('axbzc')).toBe(false)
  })

  it('整串匹配（不允许多行/部分匹配）', () => {
    expect(globToRegExp('gis_*').test('gis_query_land_types')).toBe(true)
    expect(globToRegExp('gis_*').test('prefix_gis_x')).toBe(false)
  })
})

describe('compilePolicy', () => {
  it('命中规则返回规则裁决，未命中取 default', () => {
    const policy = compilePolicy({
      default: 'allow',
      rules: [
        { tool: 'gis_write_*', effect: 'approve' },
        { tool: 'gis_query_*', effect: 'allow' },
      ],
    })
    expect(policy.decide('gis_write_report')).toBe('approve')
    expect(policy.decide('gis_query_land_types')).toBe('allow')
    expect(policy.decide('gis_focus_map')).toBe('allow') // default
  })

  it('后声明覆盖先声明（同工具命中多条时取最后一条）', () => {
    const policy = compilePolicy({
      default: 'deny',
      rules: [
        { tool: 'gis_*', effect: 'allow' },
        { tool: 'gis_write_*', effect: 'approve' },
        { tool: 'gis_write_report', effect: 'deny' },
      ],
    })
    expect(policy.decide('gis_write_report')).toBe('deny')     // 最后声明
    expect(policy.decide('gis_write_other')).toBe('approve')  // 覆盖更早的 gis_*
    expect(policy.decide('gis_query_x')).toBe('allow')
    expect(policy.decide('other_tool')).toBe('deny')           // default
  })

  it('deny 与 approve 的组合语义', () => {
    const policy = compilePolicy({
      default: 'approve',
      rules: [{ tool: 'read_*', effect: 'allow' }],
    })
    expect(policy.decide('read_file')).toBe('allow')
    expect(policy.decide('shell_exec')).toBe('approve')
  })

  it('空规则全部走 default', () => {
    const policy = compilePolicy({ default: 'deny', rules: [] })
    expect(policy.decide('anything')).toBe('deny')
  })

  it('spec 副本只读可查', () => {
    const policy = compilePolicy({ default: 'allow', rules: [{ tool: 'a_*', effect: 'deny' }] })
    expect(policy.spec.default).toBe('allow')
    expect(policy.spec.rules).toHaveLength(1)
  })
})

describe('assertPolicySpec', () => {
  it('合法声明通过', () => {
    expect(() => assertPolicySpec({ default: 'allow', rules: [{ tool: 'a', effect: 'deny' }] })).not.toThrow()
    expect(() => assertPolicySpec({ default: 'approve', rules: [] })).not.toThrow()
  })

  it('非法 default / effect / tool / 超时逐一拒绝', () => {
    expect(() => assertPolicySpec({ default: 'maybe', rules: [] })).toThrow(/default/)
    expect(() => assertPolicySpec({ default: 'allow', rules: [{ tool: 'a', effect: 'ask' }] })).toThrow(/effect/)
    expect(() => assertPolicySpec({ default: 'allow', rules: [{ tool: '', effect: 'deny' }] })).toThrow(/tool/)
    expect(() => assertPolicySpec({ default: 'allow', rules: 'nope' })).toThrow(/rules/)
    expect(() => assertPolicySpec({ default: 'allow', rules: [], approvalTimeoutMs: 0 })).toThrow(/approvalTimeoutMs/)
    expect(() => assertPolicySpec(null)).toThrow()
  })
})

describe('assertPolicySpec：budgets 校验（M9）', () => {
  it('合法预算通过（tool-calls / session-tokens / effect 可选）', () => {
    expect(() => assertPolicySpec({
      default: 'allow', rules: [],
      budgets: [{ kind: 'tool-calls', max: 100, tool: 'gis_*' }],
    })).not.toThrow()
    expect(() => assertPolicySpec({
      default: 'allow', rules: [],
      budgets: [{ kind: 'session-tokens', max: 200_000, effect: 'approve' }],
    })).not.toThrow()
  })

  it('非法 kind / max / tool / effect 逐一拒绝', () => {
    expect(() => assertPolicySpec({ default: 'allow', rules: [], budgets: [{ kind: 'money', max: 1 }] })).toThrow(/kind/)
    expect(() => assertPolicySpec({ default: 'allow', rules: [], budgets: [{ kind: 'tool-calls', max: 0 }] })).toThrow(/max/)
    expect(() => assertPolicySpec({ default: 'allow', rules: [], budgets: [{ kind: 'tool-calls', max: 1.5 }] })).toThrow(/max/)
    expect(() => assertPolicySpec({ default: 'allow', rules: [], budgets: [{ kind: 'tool-calls', max: 1, tool: '' }] })).toThrow(/tool/)
    expect(() => assertPolicySpec({ default: 'allow', rules: [], budgets: [{ kind: 'tool-calls', max: 1, effect: 'stop' }] })).toThrow(/effect/)
    expect(() => assertPolicySpec({ default: 'allow', rules: [], budgets: 'nope' })).toThrow(/budgets/)
  })

  it('session-tokens 不允许带 tool 模式（会话级总量）', () => {
    expect(() => assertPolicySpec({
      default: 'allow', rules: [],
      budgets: [{ kind: 'session-tokens', max: 100, tool: 'gis_*' }],
    })).toThrow(/session-tokens/)
  })

  it('budgets 透传到编译后的 spec 副本', () => {
    const budgets = [{ kind: 'tool-calls' as const, max: 7 }]
    const policy = compilePolicy({ default: 'allow', rules: [], budgets })
    expect(policy.spec.budgets).toEqual(budgets)
  })
})

/**
 * M3 单测：subagent 声明编译 —— visibleTo 作用域 / toolFilter allow-list /
 * globalToolNames 并集 / denyListForAgent / 引用完整性校验，以及 defineApp
 * 的 channel/subagent 收集器。
 */
import { describe, expect, it } from 'vitest'
import { defineApp } from '../src/index.js'
import { compileSubagents, denyListForAgent } from '../src/subagent.js'
import type { AppSpec } from '../src/types.js'

function fixtureApp(): AppSpec {
  const app = defineApp('test-app')
  app.tool('query_land_types').input({}).output({}).execute(async () => ({}))
  app.tool('render_pie_chart').input({}).output({}).execute(async () => ({}))
  app.tool('write_report').input({}).output({}).execute(async () => ({}))
  app.agent('data-analyst', { persona: 'p1', tools: ['query_land_types', 'render_pie_chart', 'write_report'] })
  app.agent('report-writer', { persona: 'p2', tools: ['query_land_types', 'write_report'] })
  return app.spec
}

describe('compileSubagents', () => {
  it('visibleTo → byParent 作用域：只有声明的父能委派', () => {
    const spec = fixtureApp()
    spec.subagents.push(
      { id: 'researcher', persona: '研究员', tools: ['query_land_types'], visibleTo: ['data-analyst', 'report-writer'] },
      { id: 'reviewer', persona: '评审员', tools: ['write_report'], visibleTo: ['data-analyst'] },
    )
    const compiled = compileSubagents(spec)
    expect([...compiled.byParent.keys()].sort()).toEqual(['data-analyst', 'report-writer'])
    expect(compiled.byParent.get('data-analyst')!.map(s => s.id)).toEqual(['researcher', 'reviewer'])
    expect(compiled.byParent.get('report-writer')!.map(s => s.id)).toEqual(['researcher'])
    expect(compiled.byId.get('researcher')!.persona).toBe('研究员')
  })

  it('tools → toolFilter allow-list（内核 ToolRestriction 形状）；缺省 undefined', () => {
    const spec = fixtureApp()
    spec.subagents.push(
      { id: 'researcher', persona: 'p', tools: ['query_land_types', 'render_pie_chart'], visibleTo: ['data-analyst'] },
      { id: 'generalist', persona: 'p', visibleTo: ['data-analyst'] },
    )
    const compiled = compileSubagents(spec)
    expect(compiled.toolFilterOf(compiled.byId.get('researcher')!)).toEqual({ allow: ['query_land_types', 'render_pie_chart'] })
    expect(compiled.toolFilterOf(compiled.byId.get('generalist')!)).toBeUndefined()
  })

  it('globalToolNames = 各子规格引用工具的并集', () => {
    const spec = fixtureApp()
    spec.subagents.push(
      { id: 'a', persona: 'p', tools: ['query_land_types'], visibleTo: ['data-analyst'] },
      { id: 'b', persona: 'p', tools: ['query_land_types', 'write_report'], visibleTo: ['data-analyst'] },
    )
    expect([...compileSubagents(spec).globalToolNames].sort()).toEqual(['query_land_types', 'write_report'])
  })

  it('引用未声明工具 → 抛错', () => {
    const spec = fixtureApp()
    spec.subagents.push({ id: 'a', persona: 'p', tools: ['nope_tool'], visibleTo: ['data-analyst'] })
    expect(() => compileSubagents(spec)).toThrow('未声明的工具 "nope_tool"')
  })

  it('visibleTo 空 / 引用未声明 agent → 抛错', () => {
    const spec = fixtureApp()
    spec.subagents.push({ id: 'a', persona: 'p', tools: ['query_land_types'], visibleTo: [] })
    expect(() => compileSubagents(spec)).toThrow('visibleTo 不能为空')
    const spec2 = fixtureApp()
    spec2.subagents.push({ id: 'a', persona: 'p', tools: [], visibleTo: ['ghost-agent'] })
    expect(() => compileSubagents(spec2)).toThrow('未声明的智能体 "ghost-agent"')
  })
})

describe('denyListForAgent（保住 M1 每 agent 工具集语义）', () => {
  it('父看得见全部全局工具 → 空 deny；看不见的 → 进 deny', () => {
    const spec = fixtureApp()
    spec.subagents.push({ id: 'a', persona: 'p', tools: ['query_land_types', 'write_report'], visibleTo: ['data-analyst'] })
    const compiled = compileSubagents(spec)
    // data-analyst 可见全部三个工具 → 全局 {query,write} 都看得见 → deny 为空。
    expect(denyListForAgent(compiled, ['query_land_types', 'render_pie_chart', 'write_report'])).toEqual([])
    // report-writer 只声明了 query+write → 无全局工具要摘。
    expect(denyListForAgent(compiled, ['query_land_types', 'write_report'])).toEqual([])
    // 构造一个看不见 write_report 的父 → deny [write_report]。
    expect(denyListForAgent(compiled, ['query_land_types'])).toEqual(['write_report'])
  })
})

describe('defineApp 收集器（M3）', () => {
  it('channel.webhook / subagent 收集 + 形状校验', () => {
    const app = defineApp('collect-app')
    app.tool('t1').input({}).output({}).execute(async () => ({}))
    app.agent('a1', { persona: 'p' })
    app.channel.webhook('/hooks/demo', {
      agent: 'a1',
      map: payload => String(payload.text),
      secret: 'whsec_x',
      sessionKey: payload => String(payload.topic),
    })
    app.subagent('researcher', { persona: '数据核对研究员', tools: ['t1'], visibleTo: ['a1'] })
    expect(app.spec.channels).toEqual([
      {
        kind: 'webhook',
        path: '/hooks/demo',
        agent: 'a1',
        map: expect.any(Function),
        secret: 'whsec_x',
        sessionKey: expect.any(Function),
      },
    ])
    expect(app.spec.subagents).toEqual([
      { id: 'researcher', persona: '数据核对研究员', tools: ['t1'], visibleTo: ['a1'] },
    ])
  })

  it('路径必须以 / 开头、重复路径、非函数 map → 抛错', () => {
    const app = defineApp('valid-app')
    app.tool('t1').input({}).output({}).execute(async () => ({}))
    app.agent('a1', { persona: 'p' })
    expect(() => app.channel.webhook('hooks/demo', { agent: 'a1', map: () => 'x' })).toThrow('/ 开头')
    app.channel.webhook('/hooks/a', { agent: 'a1', map: () => 'x' })
    expect(() => app.channel.webhook('/hooks/a', { agent: 'a1', map: () => 'x' })).toThrow('重复的通道路径')
    expect(() => app.channel.webhook('/hooks/b', { agent: 'a1', map: 'not-fn' as unknown as () => string })).toThrow('map 必须是函数')
    expect(() => app.channel.webhook('/hooks/c', { agent: 'a1', map: () => 'x', secret: '' })).toThrow('secret 必须是非空字符串')
  })

  it('subagent 重复 id / 空 visibleTo / 空 persona → 抛错', () => {
    const app = defineApp('sub-valid')
    app.agent('a1', { persona: 'p' })
    app.subagent('r', { persona: 'ok', visibleTo: ['a1'] })
    expect(() => app.subagent('r', { persona: 'dup', visibleTo: ['a1'] })).toThrow('重复的子智能体 id')
    expect(() => app.subagent('r2', { persona: 'x', visibleTo: [] })).toThrow('visibleTo 必须是非空数组')
    expect(() => app.subagent('r3', { persona: ' ', visibleTo: ['a1'] })).toThrow('persona 必须是非空字符串')
  })

  it('返回 App（可链式续写）', () => {
    const app = defineApp('chain-app')
    app.agent('a1', { persona: 'p' })
    const chained = app.subagent('s1', { persona: 'x', visibleTo: ['a1'] })
    expect(chained).toBe(app)
    const chainedHook = app.channel.webhook('/hooks/x', { agent: 'a1', map: () => 'y' })
    expect(chainedHook).toBe(app)
  })
})

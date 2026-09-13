import { describe, expect, it } from 'vitest'
import { compileSwarm, DELEGATION_TOOL_NAME, SWARM_MEMORY_TOOL_NAMES } from '../src/swarm.js'
import { compileSubagents } from '../src/subagent.js'
import { defineApp } from '../src/index.js'
import type { ToolSpec } from '../src/types.js'

const tool = (name: string): ToolSpec => ({
  name,
  description: `${name} 工具`,
  parameters: {},
  output: { type: 'object' },
  execute: async () => ({}),
})

const ctxOf = (tools: string[], agents: string[] = [], subs: string[] = [], swarms: string[] = []) => ({
  toolNames: tools,
  allToolNames: tools,
  agentIds: agents,
  subagentIds: subs,
  swarmNames: swarms,
})

const baseSwarm = {
  entry: { id: 'lead', persona: '你是组长。' },
  topology: 'hierarchical' as const,
  members: [
    { id: 'researcher', role: 'worker', persona: '你是研究员。' },
    { id: 'writer', persona: '你是写作员。' },
  ],
}

describe('compileSwarm：展开语义', () => {
  it('hierarchical：成员只对入口可见；工具清单显式化（= 全部应用工具）', () => {
    const compiled = compileSwarm('pod', baseSwarm, ctxOf(['t_query', 't_write']))
    expect(compiled.meta).toEqual({ name: 'pod', topology: 'hierarchical', depth: 1, memory: false, entryId: 'lead', memberIds: ['researcher', 'writer'] })
    expect(compiled.entryAgent.id).toBe('lead')
    expect(compiled.entryAgent.tools).toEqual(['t_query', 't_write'])
    expect(compiled.memberSubagents.map(m => m.visibleTo)).toEqual([['lead'], ['lead']])
    expect(compiled.memberSubagents[0]!.tools).toEqual(['t_query', 't_write'])
  })

  it('mesh：成员对入口+同伴可见；工具注入委派工具；depth 默认 2', () => {
    const compiled = compileSwarm('pod', { ...baseSwarm, topology: 'mesh' }, ctxOf(['t_query']))
    expect(compiled.meta.depth).toBe(2)
    expect(compiled.memberSubagents[0]!.visibleTo).toEqual(['lead', 'writer'])
    expect(compiled.memberSubagents[1]!.visibleTo).toEqual(['lead', 'researcher'])
    expect(compiled.memberSubagents[0]!.tools).toContain(DELEGATION_TOOL_NAME)
    expect(compiled.memberSubagents[0]!.persona).toContain('subagent 工具')
    expect(compiled.memberSubagents[0]!.persona).toContain('同伴')
  })

  it('memory：入口与成员工具注入群体记忆工具；persona 注入纪律', () => {
    const compiled = compileSwarm('pod', { ...baseSwarm, memory: true }, ctxOf(['t_query']))
    expect(compiled.entryAgent.tools).toEqual(['t_query', ...SWARM_MEMORY_TOOL_NAMES])
    for (const member of compiled.memberSubagents) {
      for (const name of SWARM_MEMORY_TOOL_NAMES) expect(member.tools).toContain(name)
      expect(member.persona).toContain('swarm_note')
      expect(member.persona).toContain('swarm_recall')
    }
    expect(compiled.entryAgent.persona).toContain('swarm_note')
  })

  it('成员显式 tools 保留并追加注入项；role 进 persona', () => {
    const compiled = compileSwarm('pod', {
      ...baseSwarm,
      topology: 'mesh',
      memory: true,
      members: [{ id: 'solo', role: 'specialist', persona: '专家。', tools: ['t_query'] }],
    }, ctxOf(['t_query', 't_write']))
    const solo = compiled.memberSubagents[0]!
    expect(solo.tools).toEqual(['t_query', DELEGATION_TOOL_NAME, ...SWARM_MEMORY_TOOL_NAMES])
    expect(solo.persona).toContain('specialist')
  })
})

describe('compileSwarm：校验（诚实失败）', () => {
  it('拓扑非法 / 空成员 / depth 越界 / mesh depth<2', () => {
    expect(() => compileSwarm('pod', { ...baseSwarm, topology: 'ring' as never }, ctxOf([]))).toThrow(/topology/)
    expect(() => compileSwarm('pod', { ...baseSwarm, members: [] }, ctxOf([]))).toThrow(/members/)
    expect(() => compileSwarm('pod', { ...baseSwarm, depth: 4 }, ctxOf([]))).toThrow(/depth/)
    expect(() => compileSwarm('pod', { ...baseSwarm, topology: 'mesh', depth: 1 }, ctxOf([]))).toThrow(/mesh/)
  })

  it('id 冲突（内部重复 / 与 agent / 与 subagent / 与既有 swarm 同名）', () => {
    expect(() => compileSwarm('pod', { ...baseSwarm, members: [{ id: 'lead', persona: 'x' }] }, ctxOf([]))).toThrow(/重复/)
    expect(() => compileSwarm('pod', baseSwarm, ctxOf([], ['lead']))).toThrow(/智能体冲突/)
    expect(() => compileSwarm('pod', baseSwarm, ctxOf([], [], ['researcher']))).toThrow(/子智能体冲突/)
    expect(() => compileSwarm('pod', baseSwarm, ctxOf([], [], [], ['pod']))).toThrow(/群体名/)
  })

  it('工具悬空引用 / persona 空', () => {
    expect(() => compileSwarm('pod', { ...baseSwarm, entry: { id: 'lead', persona: 'p', tools: ['nope'] } }, ctxOf(['t1']))).toThrow(/nope/)
    expect(() => compileSwarm('pod', { ...baseSwarm, members: [{ id: 'm', persona: '' }] }, ctxOf([]))).toThrow(/persona/)
  })
})

describe('app.swarm 声明期展开（穿过 compileSubagents）', () => {
  it('spec 出现 entry agent + 成员 subagents + 元数据；mesh 的同伴 visibleTo 编译通过', () => {
    const app = defineApp('swarm-demo')
    for (const t of ['t_query', 't_write']) app.tool(t).description(`${t}`).input({}).output({ type: 'object' }).execute(async () => ({}))
    app.swarm('pod', {
      entry: { id: 'lead', persona: '组长' },
      topology: 'mesh',
      memory: true,
      members: [
        { id: 'researcher', role: 'worker', persona: '研究员' },
        { id: 'writer', persona: '写作员' },
      ],
    })
    const spec = app.spec
    expect(spec.swarms).toEqual([{ name: 'pod', topology: 'mesh', depth: 2, memory: true, entryId: 'lead', memberIds: ['researcher', 'writer'] }])
    expect(spec.agents.map(a => a.id)).toContain('lead')
    expect(spec.subagents.map(s => s.id)).toEqual(['researcher', 'writer'])
    // mesh 同伴 visibleTo（子 id 作父）经 compileSubagents 合法
    const compiledSubs = compileSubagents(spec as never)
    expect(compiledSubs.byParent.get('researcher')!.map(s => s.id)).toEqual(['writer'])
    expect(compiledSubs.byParent.get('lead')!.map(s => s.id)).toEqual(['researcher', 'writer'])
    // 保留名不进 globalToolNames（runtime 自注册），但进 toolFilter allow
    expect([...compiledSubs.globalToolNames].sort()).toEqual(['t_query', 't_write'])
    const filter = compiledSubs.toolFilterOf(spec.subagents[0]!)!
    expect(filter.allow).toContain(DELEGATION_TOOL_NAME)
    expect(filter.allow).toContain('swarm_note')
  })

  it('compileSubagents：保留名豁免校验但拒绝任意未声明工具', () => {
    const app = defineApp('x')
    app.tool('t1').description('t').input({}).output({ type: 'object' }).execute(async () => ({}))
    app.agent('a1', { persona: 'p', tools: ['t1'] })
    app.subagent('ok', { persona: 'p', tools: ['t1', 'swarm_note'], visibleTo: ['a1'] })
    expect(() => compileSubagents(app.spec as never)).not.toThrow()
    // 任意未声明工具：声明期即拒（比编译期更早——fail-loud 前移）
    expect(() => app.subagent('bad', { persona: 'p', tools: ['ghost'], visibleTo: ['a1'] })).toThrow(/ghost/)
  })
})

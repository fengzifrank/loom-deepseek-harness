/**
 * transcript 评测（eval.ts）单测：slim 夹具提取（折叠/保留/幂等）、夹具视图与
 * 断言辅助（byTool/toolCalled/toolFailed/turnEnded/approvalFlow/textIncludes/
 * orderOf/text）、defineEval 守门与 runEval 的成败路径。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildEvalContext, defineEval, runEval, slimSessionLog, type EvalEvent } from '../src/eval.js'

/** 一行 jsonl。 */
const line = (event: Record<string, unknown>): string => JSON.stringify(event)

describe('slimSessionLog：原始日志 → 精简夹具', () => {
  const raw = [
    line({ type: 'session', version: 0, id: 's1' }),
    line({ type: 'agent/inbox/spliced', seq: 0, data: {} }),
    line({ type: 'turn/start', seq: 1, data: { turn: 1 } }),
    line({ type: 'step/start', seq: 2, data: { turn: 1, step: 1 } }),
    line({ type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: '查一下' }], source: { kind: 'user' } } }),
    line({ type: 'request/header', seq: 4, data: { header: { system: '巨型系统提示词' } } }),
    line({ type: 'assistant/chunk', seq: 5, data: { chunk: { type: 'text-delta', text: '正在' } } }),
    line({ type: 'assistant/chunk', seq: 6, data: { chunk: { type: 'text-delta', text: '查询' } } }),
    line({ type: 'tool/call', seq: 7, data: { callId: 'c1', name: 'gis_query_land_types', arguments: '{"region":"连河村"}' } }),
    line({ type: 'tool/result', seq: 8, data: { message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', isError: false, content: [{ type: 'text', text: '{"totalAreaSqm":57351531.17}' }] }] } } }),
    line({ type: 'approval/asked', seq: 9, data: { toolName: 'gis_update_land_note' } }),
    line({ type: 'approval/decided', seq: 10, data: { outcome: 'rejected' } }),
    line({ type: 'loom/approval-asked', approvalId: 'a1' }),
    line({ type: 'assistant/message', seq: 11, data: { message: { content: [{ type: 'text', text: '查询完成' }] } } }),
    line({ type: 'turn/end', seq: 12, data: { turn: 1, reason: { kind: 'completed' } } }),
    '',
    '不是 json 的一行',
  ]

  const slim = slimSessionLog(raw)

  it('折叠 assistant/chunk 增量（保留 assistant/message），其余 noise 剔除', () => {
    const types = slim.map(entry => (JSON.parse(entry) as EvalEvent).type)
    expect(types).toEqual([
      'turn/start', 'step/start', 'user/message', 'tool/call', 'tool/result',
      'approval/asked', 'approval/decided', 'loom/approval-asked', 'assistant/message', 'turn/end',
    ])
  })

  it('保留的事件原样（字段不动，如 approval 的 toolName/outcome）', () => {
    const asked = slim.map(entry => JSON.parse(entry) as EvalEvent).find(event => event.type === 'approval/asked')!
    expect(asked.data).toEqual({ toolName: 'gis_update_land_note' })
  })

  it('幂等：对精简结果再跑一遍不变', () => {
    expect(slimSessionLog(slim)).toEqual(slim)
  })
})

describe('buildEvalContext：视图与断言辅助', () => {
  const events: EvalEvent[] = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '给连河村加备注' }] } },
    { type: 'tool/call', seq: 3, data: { callId: 'c1', name: 'gis_update_land_note', arguments: '{"region":"连河村","note":"x"}' } },
    { type: 'approval/asked', seq: 4, data: { toolName: 'gis_update_land_note' } },
    { type: 'approval/decided', seq: 5, data: { outcome: 'rejected' } },
    {
      type: 'tool/result', seq: 6,
      data: { message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: 'Error: rejected' }] }] } },
    },
    { type: 'assistant/message', seq: 7, data: { message: { content: [{ type: 'text', text: '已拒绝，' }] } } },
    { type: 'tool/call', seq: 8, data: { callId: 'c2', name: 'gis_query_land_types', arguments: '{}' } },
    { type: 'tool/result', seq: 9, data: { message: { source: { callId: 'c2' }, content: [{ type: 'tool-result', isError: false, content: [{ type: 'text', text: '{"totalAreaSqm":57351531.17}' }] }] } } },
    { type: 'assistant/message', seq: 10, data: { message: { content: [{ type: 'text', text: '未修改。' }] } } },
    { type: 'turn/end', seq: 11, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const ev = buildEvalContext(events)

  it('byTool：调用折叠（args 解析、isError、value 解析）', () => {
    const calls = ev.byTool('gis_update_land_note')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toEqual({ region: '连河村', note: 'x' })
    expect(calls[0]!.isError).toBe(true)
    expect(calls[0]!.resultSeq).toBe(6)
    expect(ev.byTool('gis_query_land_types')[0]!.value).toEqual({ totalAreaSqm: 57351531.17 })
    expect(ev.toolCalls().map(call => call.name)).toEqual(['gis_update_land_note', 'gis_query_land_types'])
  })

  it('byType / turns / orderOf / text', () => {
    expect(ev.byType('approval/asked')).toHaveLength(1)
    expect(ev.turns()).toEqual([{ turn: 1, seq: 11, reason: 'completed' }])
    expect(ev.orderOf('user/message', 'tool/call', 'turn/end')).toEqual([2, 3, 11])
    expect(ev.orderOf('user/message', 'nope/type')).toEqual([2, undefined])
    expect(ev.text()).toBe('已拒绝，未修改。')
  })

  it('expect.toolCalled / toolFailed / turnEnded / textIncludes 通过与失败', () => {
    expect(() => ev.expect.toolCalled('gis_query_land_types')).not.toThrow()
    expect(() => ev.expect.toolFailed('gis_update_land_note')).not.toThrow()
    expect(() => ev.expect.turnEnded('completed')).not.toThrow()
    expect(() => ev.expect.textIncludes('未修改')).not.toThrow()
    expect(() => ev.expect.toolCalled('nope')).toThrow(/期望工具 "nope" 被调用/)
    expect(() => ev.expect.toolFailed('gis_query_land_types')).toThrow(/全部成功/)
    expect(() => ev.expect.turnEnded('aborted')).toThrow(/期望最后一个 turn 以 "aborted" 收场/)
    expect(() => ev.expect.textIncludes('不存在的内容')).toThrow(/助手文本不包含/)
  })

  it('expect.approvalFlow：asked → decided 顺序与 outcome', () => {
    const flow = ev.expect.approvalFlow()
    expect(flow.outcome).toBe('rejected')
    const broken = buildEvalContext([
      { type: 'approval/decided', seq: 1, data: { outcome: 'allowed-once' } },
      { type: 'approval/asked', seq: 2, data: {} },
    ])
    expect(() => broken.expect.approvalFlow()).toThrow(/没有 approval\/decided/)
    expect(() => buildEvalContext([]).expect.approvalFlow()).toThrow(/没有 approval\/asked/)
  })
})

describe('defineEval / runEval', () => {
  it('defineEval 守门：name/fixture/assert', () => {
    expect(() => defineEval({ name: '', fixture: 'f', assert() {} })).toThrow(/name/)
    expect(() => defineEval({ name: 'x', fixture: '', assert() {} })).toThrow(/fixture/)
    expect(() => defineEval({ name: 'x', fixture: 'f', assert: undefined as unknown as () => void })).toThrow(/assert/)
  })

  it('runEval：夹具读取 + 断言成败路径', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-eval-'))
    try {
      const fixture = join(dir, 'f.jsonl')
      writeFileSync(fixture, slimSessionLog([
        line({ type: 'turn/start', seq: 1, data: { turn: 1 } }),
        line({ type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '好的' }] } } }),
        line({ type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } }),
      ]).join('\n'), 'utf8')

      const ok = await runEval(defineEval({ name: 'ok', fixture: 'f.jsonl', assert(e) { e.expect.turnEnded('completed'); e.expect.textIncludes('好的') } }), { fixtureDir: dir })
      expect(ok.ok).toBe(true)
      expect(ok.eventCount).toBe(3)

      const bad = await runEval(defineEval({ name: 'bad', fixture: 'f.jsonl', assert(e) { e.expect.toolCalled('nope') } }), { fixtureDir: dir })
      expect(bad.ok).toBe(false)
      expect(bad.error).toMatch(/期望工具 "nope" 被调用/)

      const missing = await runEval(defineEval({ name: 'missing', fixture: 'absent.jsonl', assert() {} }), { fixtureDir: dir })
      expect(missing.ok).toBe(false)
      expect(missing.error).toMatch(/夹具读取失败/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

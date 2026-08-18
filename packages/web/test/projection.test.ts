import { describe, expect, it } from 'vitest'
import { projectEvent, rebuildCallIndex, truncate } from '../src/projection.js'

const cards = new Map([['gis_query_land_types', { kind: 'generic' as const, title: '地类面积查询' }]])

describe('projectEvent：SSE 白名单过滤', () => {
  it('turn 边界与 user/message（人类来源）在白名单内', () => {
    expect(projectEvent({ seq: 0, type: 'turn/start', data: { turn: 1 } }, new Map(), cards))
      .toEqual({ seq: 0, type: 'turn/start', turn: 1 })
    expect(projectEvent({ seq: 9, type: 'turn/end', data: { turn: 1, reason: 'completed' } }, new Map(), cards))
      .toEqual({ seq: 9, type: 'turn/end', turn: 1, reason: 'completed' })
    expect(projectEvent({ seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }, new Map(), cards))
      .toEqual({ seq: 1, type: 'user/message', text: 'hi' })
  })

  it('user/message 的 plugin 来源（runtime-context 注入）被过滤', () => {
    expect(projectEvent({ seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: 'approval policy changed' }], source: { kind: 'plugin', plugin: 'user-approval' } } }, new Map(), cards))
      .toBeUndefined()
  })

  it('request/header（完整系统提示词）永不转发；approval/* 审计对不进白名单', () => {
    expect(projectEvent({ seq: 3, type: 'request/header', data: { system: 'SECRET' } }, new Map(), cards)).toBeUndefined()
    expect(projectEvent({ seq: 4, type: 'approval/asked', data: { id: 'a1', toolName: 't' } }, new Map(), cards)).toBeUndefined()
    expect(projectEvent({ seq: 5, type: 'approval/decided', data: { id: 'a1', outcome: 'rejected' } }, new Map(), cards)).toBeUndefined()
  })

  it('assistant/chunk 只投影 text-delta', () => {
    expect(projectEvent({ seq: 6, type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '你好' } } }, new Map(), cards))
      .toEqual({ seq: 6, type: 'assistant/chunk', delta: '你好' })
    expect(projectEvent({ seq: 7, type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'x' } } }, new Map(), cards))
      .toBeUndefined()
  })

  it('tool/call 解析参数 JSON、登记 callIndex、附卡片标题', () => {
    const index = new Map()
    const payload = projectEvent({ seq: 8, type: 'tool/call', data: { callId: 'c1', name: 'gis_query_land_types', arguments: '{"region":"连河村"}' } }, index, cards)
    expect(payload).toEqual({
      seq: 8, type: 'tool/call', callId: 'c1', name: 'gis_query_land_types',
      args: { region: '连河村' }, card: { kind: 'generic', title: '地类面积查询' },
    })
    expect(index.get('c1')).toEqual({ seq: 8, name: 'gis_query_land_types' })
  })

  it('tool/result 回填工具名/callSeq，小结果附解析 value，isError 透传', () => {
    const index = new Map([['c1', { seq: 8, name: 'gis_query_land_types' }]])
    const payload = projectEvent({
      seq: 10, type: 'tool/result',
      data: { message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', isError: false, content: [{ type: 'text', text: '{"totalAreaSqm": 1}' }] }] } },
    }, index, cards)
    expect(payload).toMatchObject({ seq: 10, type: 'tool/result', callSeq: 8, name: 'gis_query_land_types', isError: false, value: { totalAreaSqm: 1 } })
  })

  it('未知 callId 的 tool/result 以 callId 兜底为 name', () => {
    const payload = projectEvent({
      seq: 11, type: 'tool/result',
      data: { message: { source: { callId: 'cX' }, content: [{ type: 'tool-result', content: [] }] } },
    }, new Map(), cards)
    expect(payload).toMatchObject({ name: 'cX', callSeq: undefined })
  })

  it('超长预览被截断且不附 value', () => {
    const long = 'x'.repeat(3000)
    const payload = projectEvent({
      seq: 12, type: 'tool/result',
      data: { message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: long }] }] } },
    }, new Map(), cards)
    expect((payload!.preview as string).startsWith('x'.repeat(100))).toBe(true)
    expect((payload!.preview as string).includes('截断')).toBe(true)
    expect(payload!.value).toBeUndefined()
  })
})

describe('truncate', () => {
  it('短文本原样返回，长文本截断带标记', () => {
    expect(truncate('abc', 10)).toBe('abc')
    expect(truncate('abcdef', 3)).toBe('abc…(截断，共 6 字符)')
  })
})

describe('rebuildCallIndex（fork 子会话回放）', () => {
  it('从历史 tool/call 事件重建 callId→{seq,name}', () => {
    const index = rebuildCallIndex({
      events: [
        { seq: 0, type: 'turn/start', data: { turn: 1 } },
        { seq: 1, type: 'user/message', data: {} },
        { seq: 2, type: 'tool/call', data: { callId: 'c1', name: 'gis_query_land_types', arguments: '{}' } },
        { seq: 3, type: 'tool/call', data: { callId: 'c2', name: 'gis_update_land_note', arguments: '{}' } },
      ],
    })
    expect(index.get('c1')).toEqual({ seq: 2, name: 'gis_query_land_types' })
    expect(index.get('c2')).toEqual({ seq: 3, name: 'gis_update_land_note' })
    expect(index.size).toBe(2)
  })
})

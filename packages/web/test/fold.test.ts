import { describe, expect, it } from 'vitest'
import { foldEvent, type LoomMessage } from '../src/react.js'

const empty = (): LoomMessage[] => []
const foldAll = (messages: LoomMessage[], events: Array<Record<string, any>>): LoomMessage[] =>
  events.reduce((acc, event) => foldEvent(acc, event as any), messages)

describe('foldEvent：聊天流折叠', () => {
  it('user/message → 用户气泡；空文本不产生气泡', () => {
    let m = foldEvent(empty(), { seq: 1, type: 'user/message', text: '查询地类占比' })
    expect(m).toEqual([{ role: 'user', text: '查询地类占比', toolCards: [], approvals: [] }])
    m = foldEvent(m, { seq: 2, type: 'user/message', text: '' })
    expect(m).toHaveLength(1)
  })

  it('assistant/chunk 聚合增量，assistant/message 定稿覆盖', () => {
    let m = empty()
    m = foldEvent(m, { seq: 3, type: 'assistant/chunk', delta: '连河' })
    m = foldEvent(m, { seq: 4, type: 'assistant/chunk', delta: '村面积' })
    expect(m).toEqual([{ role: 'assistant', text: '连河村面积', toolCards: [], approvals: [] }])
    m = foldEvent(m, { seq: 5, type: 'assistant/message', text: '连河村面积 5735 万㎡。' })
    expect(m[m.length - 1]!.text).toBe('连河村面积 5735 万㎡。')
  })

  it('tool/call 挂到最近 assistant 消息；tool/result 按 callSeq 定稿（含 value）', () => {
    let m = foldEvent(empty(), { seq: 1, type: 'user/message', text: '画饼图' })
    m = foldEvent(m, { seq: 2, type: 'assistant/chunk', delta: '好' })
    m = foldEvent(m, { seq: 3, type: 'tool/call', name: 'gis_render_pie_chart', card: { kind: 'generic', title: '饼图' }, args: { title: '各村地类' } })
    expect(m[m.length - 1]!.toolCards).toEqual([{
      seq: 3, name: 'gis_render_pie_chart', title: '饼图', args: { title: '各村地类' }, done: false,
    }])
    m = foldEvent(m, { seq: 4, type: 'tool/result', callSeq: 3, name: 'gis_render_pie_chart', isError: false, preview: '...', value: { title: '各村地类', items: [] } })
    expect(m[m.length - 1]!.toolCards[0]!).toMatchObject({ done: true, isError: false, value: { title: '各村地类', items: [] } })
  })

  it('无 assistant 消息时 tool/call 新建空 assistant 载体', () => {
    const m = foldEvent(empty(), { seq: 1, type: 'tool/call', name: 't' })
    expect(m).toEqual([{ role: 'assistant', text: '', toolCards: [{ seq: 1, name: 't', title: 't', done: false }], approvals: [] }])
  })

  it('未知事件类型不改变消息列表', () => {
    const m = foldEvent(empty(), { seq: 1, type: 'turn/start', turn: 1 })
    expect(m).toEqual([])
  })
})

describe('foldEvent：审批卡片折叠（M2）', () => {
  it('loom/approval-asked → 最近 assistant 消息挂 pending 审批卡片', () => {
    let m = foldEvent(empty(), { seq: 1, type: 'user/message', text: '给连河村加备注' })
    m = foldEvent(m, { seq: 2, type: 'assistant/chunk', delta: '我来修改' })
    m = foldEvent(m, {
      type: 'loom/approval-asked', approvalId: 'ap-1', tool: 'gis_update_land_note',
      argsPreview: '{"region":"连河村","note":"重点耕地保护区"}', reason: 'loom policy: 需要人工审批',
    })
    expect(m[m.length - 1]!.approvals).toEqual([{
      approvalId: 'ap-1', tool: 'gis_update_land_note', status: 'pending',
      argsPreview: '{"region":"连河村","note":"重点耕地保护区"}', reason: 'loom policy: 需要人工审批',
    }])
  })

  it('loom/approval-decided → 同 approvalId 的 pending 卡片定稿，其余不动', () => {
    let m = foldEvent(empty(), { seq: 1, type: 'assistant/chunk', delta: 'x' })
    m = foldEvent(m, { type: 'loom/approval-asked', approvalId: 'ap-1', tool: 't1' })
    m = foldEvent(m, { type: 'loom/approval-asked', approvalId: 'ap-2', tool: 't2' })
    m = foldEvent(m, { type: 'loom/approval-decided', approvalId: 'ap-1', decision: 'allowed-once' })
    const approvals = m[0]!.approvals
    expect(approvals!.find(a => a.approvalId === 'ap-1')!.status).toBe('allowed-once')
    expect(approvals!.find(a => a.approvalId === 'ap-2')!.status).toBe('pending')
  })

  it('拒绝路径：rejected 状态落到卡片', () => {
    let m = foldEvent(empty(), { seq: 1, type: 'assistant/chunk', delta: 'x' })
    m = foldEvent(m, { type: 'loom/approval-asked', approvalId: 'ap-9', tool: 'gis_update_land_note' })
    m = foldEvent(m, { type: 'loom/approval-decided', approvalId: 'ap-9', decision: 'rejected' })
    expect(m[0]!.approvals![0]!.status).toBe('rejected')
  })

  it('decided 之后重复的 decided 事件不改写终态；缺失 approvalId 的 asked 被忽略', () => {
    let m = foldEvent(empty(), { seq: 1, type: 'assistant/chunk', delta: 'x' })
    m = foldEvent(m, { type: 'loom/approval-asked', approvalId: 'ap-1', tool: 't' })
    m = foldEvent(m, { type: 'loom/approval-decided', approvalId: 'ap-1', decision: 'rejected' })
    m = foldEvent(m, { type: 'loom/approval-decided', approvalId: 'ap-1', decision: 'allowed-once' })
    m = foldEvent(m, { type: 'loom/approval-asked', tool: 'no-id' })
    expect(m[0]!.approvals).toHaveLength(1)
    expect(m[0]!.approvals![0]!.status).toBe('rejected')
  })

  it('完整审批链端到端折叠：asked → decided → 工具结果错误（拒绝后工具失败）', () => {
    const m = foldAll(empty(), [
      { seq: 1, type: 'user/message', text: '给连河村加备注：重点耕地保护区' },
      { seq: 2, type: 'tool/call', name: 'gis_update_land_note', args: { region: '连河村', note: '重点耕地保护区' } },
      { type: 'loom/approval-asked', approvalId: 'ap-1', tool: 'gis_update_land_note', argsPreview: '{"region":"连河村"}', callSeq: 2 },
      { type: 'loom/approval-decided', approvalId: 'ap-1', decision: 'rejected' },
      { seq: 3, type: 'tool/result', callSeq: 2, name: 'gis_update_land_note', isError: true, preview: 'Error: the user rejected tool "gis_update_land_note"' },
    ])
    const assistant = m.find(x => x.role === 'assistant')!
    expect(assistant.approvals![0]!.status).toBe('rejected')
    expect(assistant.toolCards[0]!.isError).toBe(true)
    expect(assistant.toolCards[0]!.done).toBe(true)
  })
})

describe('foldEvent：审批卡重连幂等（QA #2 回归）', () => {
  it('同 approvalId 的 approval-asked 重发只保留一张卡（不复活已决卡片）', () => {
    let m = foldEvent(empty(), { seq: 1, type: 'assistant/chunk', delta: 'x' })
    m = foldEvent(m, { type: 'loom/approval-asked', approvalId: 'ap-re', tool: 't', argsPreview: 'p' })
    // SSE 重连后服务端按原 approvalId 重发同一载荷——不得产生第二张卡
    m = foldEvent(m, { type: 'loom/approval-asked', approvalId: 'ap-re', tool: 't', argsPreview: 'p' })
    expect(m[0]!.approvals).toHaveLength(1)
    // 已决后重连重发（乱序窗口）也不复活：终态保持
    m = foldEvent(m, { type: 'loom/approval-decided', approvalId: 'ap-re', decision: 'rejected' })
    m = foldEvent(m, { type: 'loom/approval-asked', approvalId: 'ap-re', tool: 't' })
    expect(m[0]!.approvals).toHaveLength(1)
    expect(m[0]!.approvals![0]!.status).toBe('rejected')
    // 不同 approvalId 照常新增
    m = foldEvent(m, { type: 'loom/approval-asked', approvalId: 'ap-other', tool: 't2' })
    expect(m[0]!.approvals).toHaveLength(2)
  })
})

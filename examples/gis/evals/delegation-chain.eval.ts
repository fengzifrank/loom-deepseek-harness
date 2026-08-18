/**
 * 评测用例：委派链（M3 子智能体）。夹具来源：真实会话——父 agent 先自查两村
 * 数据 → subagent 委派 researcher 独立核对 → 拿到结论后画对比饼图 + 双村聚焦。
 */
import { defineEval } from '@loom-sdk/web'

export default defineEval({
  name: 'delegation-chain',
  fixture: 'fixtures/delegation-chain.jsonl',
  assert(ev) {
    // 先查证后委派：两次查询 → subagent
    ev.expect.toolCalled('gis_query_land_types')
    ev.expect.toolCalled('subagent')
    const queries = ev.byTool('gis_query_land_types')
    if (queries.length !== 2) throw new Error(`期望自查 2 次查询，实际 ${queries.length} 次`)
    if (queries.some(call => call.isError === true)) throw new Error('自查查询不应有失败')
    // 委派只能 spawn 声明过的规格，且子智能体正常完成
    const delegated = ev.byTool('subagent')[0]!
    const value = delegated.value as { spec?: string; sessionId?: string; stopReason?: string } | undefined
    if (value?.spec !== 'researcher') throw new Error(`期望委派规格 researcher，实际 ${JSON.stringify(value)?.slice(0, 120)}`)
    if (value?.stopReason !== 'completed') throw new Error(`期望子智能体 stopReason=completed，实际 ${String(value?.stopReason)}`)
    if (typeof value?.sessionId !== 'string' || value.sessionId === '') throw new Error('委派结果应带回子会话 id')
    // 结论落地：对比饼图 + 两次聚焦（连河村 / 太平河村）
    ev.expect.toolCalled('gis_render_pie_chart')
    if (ev.byTool('gis_focus_map').length !== 2) throw new Error('期望委派结论后聚焦两个村庄')
    ev.expect.turnEnded('completed')
  },
})

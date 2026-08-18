/**
 * 评测用例：基础查询链。夹具来源：真实会话——用户问全镇地类结构，模型先查
 * 真实数据（全部村庄），再画饼图、聚焦最大图斑村庄，回答带具体数字。
 */
import { defineEval } from '@loom-sdk/web'

export default defineEval({
  name: 'basic-query',
  fixture: 'fixtures/basic-query.jsonl',
  assert(ev) {
    ev.expect.toolCalled('gis_query_land_types')
    // 查询成功且返回真实总量（全部 8 村合计，禁止编造数字的锚点断言）
    const query = ev.byTool('gis_query_land_types')[0]!
    if (query.isError !== false) throw new Error('查询不应失败')
    const value = query.value as { totalAreaSqm?: number; items?: unknown[] } | undefined
    if (value?.totalAreaSqm !== 179573989.09) {
      throw new Error(`期望 totalAreaSqm=179573989.09（全镇合计），实际 ${JSON.stringify(value)?.slice(0, 120)}`)
    }
    if (!Array.isArray(value?.items) || value.items.length < 8) throw new Error('期望返回全部村庄明细')
    // 展示链：饼图 + 地图聚焦，且都成功
    ev.expect.toolCalled('gis_render_pie_chart')
    ev.expect.toolCalled('gis_focus_map')
    if (ev.toolCalls().some(call => call.isError === true)) throw new Error('不应有失败的工具调用')
    ev.expect.turnEnded('completed')
  },
})

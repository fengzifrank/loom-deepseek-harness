/**
 * 评测用例：webhook 入口（M3 通道）。夹具来源：真实会话——外部 POST
 * /~loom/hooks/demo 映射出的任务（【webhook】前缀文本），同 topic 会话复用，
 * 两个 turn 均正常完成。
 */
import { defineEval } from '@loom-sdk/web'

export default defineEval({
  name: 'webhook-entry',
  fixture: 'fixtures/webhook-entry.jsonl',
  assert(ev) {
    // 任务文本来自 webhook 映射（【webhook】前缀）
    const userTexts = ev
      .byType('user/message')
      .filter(event => (event.data?.source as { kind?: string } | undefined)?.kind === 'user')
      .map(event => String(event.data?.content?.[0]?.text ?? ''))
    if (userTexts.length === 0 || !userTexts.every(text => text.startsWith('【webhook】'))) {
      throw new Error(`期望用户消息全部来自 webhook 映射，实际：${JSON.stringify(userTexts).slice(0, 160)}`)
    }
    // 会话复用（sessionKey 命中同 topic）：同一条日志里两个完整 turn
    const turns = ev.turns()
    if (turns.length !== 2) throw new Error(`期望 sessionKey 复用出 2 个 turn，实际 ${turns.length} 个`)
    if (!turns.every(turn => turn.reason === 'completed')) {
      throw new Error(`期望两个 turn 都 completed，实际 ${JSON.stringify(turns.map(t => t.reason))}`)
    }
    // 每个任务都真实查了库（不编数字）
    if (ev.byTool('gis_query_land_types').length !== 2) throw new Error('期望每个 webhook 任务各查一次库')
    if (ev.toolCalls().some(call => call.isError === true)) throw new Error('不应有失败的工具调用')
    ev.expect.textIncludes('太平河村')
  },
})

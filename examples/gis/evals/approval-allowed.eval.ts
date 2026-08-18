/**
 * 评测用例：审批允许链（真实会话日志的纯重放断言，零网络零 key）。
 * 夹具来源：真实跑出的会话（模型调写工具 → 审批卡 → 人工允许 → 落盘成功）。
 * 运行：pnpm eval:gis（或 loom eval evals）。
 */
import { defineEval } from '@loom-sdk/web'

export default defineEval({
  name: 'approval-allowed',
  fixture: 'fixtures/approval-allowed.jsonl',
  assert(ev) {
    // 模型确实调了写工具（真实落盘操作）
    ev.expect.toolCalled('gis_update_land_note')
    // 审批闭环顺序：asked → decided(allowed-once)，且都在工具结果之前
    const flow = ev.expect.approvalFlow()
    if (flow.outcome !== 'allowed-once') throw new Error(`期望审批结果 allowed-once，实际 ${flow.outcome}`)
    const [callSeq, askedSeq, decidedSeq, resultSeq] = ev.orderOf('tool/call', 'approval/asked', 'approval/decided', 'tool/result')
    if (!(callSeq! < askedSeq! && askedSeq! < decidedSeq! && decidedSeq! < resultSeq!)) {
      throw new Error(`审批链顺序不成立：call=${callSeq} asked=${askedSeq} decided=${decidedSeq} result=${resultSeq}`)
    }
    // 允许之后工具成功（isError=false）且真实更新了记录
    const call = ev.byTool('gis_update_land_note')[0]!
    if (call.isError !== false) throw new Error(`允许后工具应成功，实际 isError=${String(call.isError)}`)
    if ((call.value as { updated?: number }).updated !== 1) throw new Error(`期望 updated=1，实际 ${JSON.stringify(call.value)}`)
    // turn 正常收场
    ev.expect.turnEnded('completed')
  },
})

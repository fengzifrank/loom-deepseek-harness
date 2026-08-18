/**
 * dsh-web-approval-answerer 单测（mock 宿主桥，零 cordis 启动）：
 * 审批语义回归面——允许/拒绝/超时 fail-closed/abort cancelled/并发 409/
 * 错会话 403/未知 404/非法 decision 400/重连重发留档/非宿主委托/参数预览 drain。
 */
import { describe, expect, it } from 'vitest'
import {
  ApprovalAnswerer,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type ApprovalOutcomeLike,
  type ApprovalRequestLike,
  type WebApprovalHost,
} from '../src/index.js'

/** mock 宿主桥：ownedSessions 集合 + push 记录 + 预览/调用序表。 */
function mockHost(owned: string[] = ['session-a'], extra: Partial<WebApprovalHost> = {}) {
  const pushed: Array<{ sessionId: string; payload: Record<string, unknown> }> = []
  const previews = new Map<string, string>([['call-1', '{"note":"演示"}']])
  const seqs = new Map<string, number>([['call-1', 7]])
  const host: WebApprovalHost = {
    owns: sessionId => owned.includes(sessionId),
    push: (sessionId, payload) => { pushed.push({ sessionId, payload }) },
    drainArgsPreview: callId => {
      if (callId === undefined) return undefined
      const value = previews.get(callId)
      previews.delete(callId)
      return value
    },
    callSeqOf: (sessionId, callId) => seqs.get(`${sessionId}:${callId}`) ?? seqs.get(callId),
    ...extra,
  }
  return { host, pushed }
}

const REQ: ApprovalRequestLike = {
  agent: { session: { id: 'session-a' } },
  toolName: 'gis_update_land_note',
  callId: 'call-1',
  reason: 'loom policy: 工具需要人工审批',
}

describe('ApprovalAnswerer（审批语义核心）', () => {
  it('ask → SSE 审批卡（载荷完整：approvalId/tool/callSeq/argsPreview/timeoutMs）→ 允许 → allowed-once + decided 推送', async () => {
    const { host, pushed } = mockHost()
    const answerer = new ApprovalAnswerer({ host })
    const req = REQ
    const outcomePromise = answerer.handleRequest(req, async () => 'unavailable')
    // 审批卡已推
    expect(pushed.length).toBe(1)
    const asked = pushed[0]!.payload
    expect(asked.type).toBe('loom/approval-asked')
    expect(asked.tool).toBe('gis_update_land_note')
    expect(asked.callSeq).toBe(7)
    expect(asked.argsPreview).toBe('{"note":"演示"}')
    expect(asked.timeoutMs).toBe(DEFAULT_APPROVAL_TIMEOUT_MS)
    expect(answerer.pendingCount).toBe(1)
    // argsPreview 是 drain 语义（取走即删）
    expect(host.drainArgsPreview('call-1')).toBeUndefined()
    // 答复允许
    expect(answerer.answer(String(asked.approvalId), 'session-a', 'allowed-once')).toBe('ok')
    await expect(outcomePromise).resolves.toBe('allowed-once')
    const decided = pushed[1]!.payload
    expect(decided).toMatchObject({ type: 'loom/approval-decided', approvalId: asked.approvalId, decision: 'allowed-once' })
    expect(answerer.pendingCount).toBe(0)
  })

  it('拒绝路径：answer rejected → outcome rejected', async () => {
    const { host } = mockHost()
    const answerer = new ApprovalAnswerer({ host })
    const outcomePromise = answerer.handleRequest(REQ, async () => 'unavailable')
    const asked = answerer.pendingPayloads('session-a')[0]!
    expect(answerer.answer(String(asked.approvalId), 'session-a', 'rejected')).toBe('ok')
    await expect(outcomePromise).resolves.toBe('rejected')
  })

  it('并发答复只认第一次：首个 ok，后续落空 unknown（QA 语义：已决出注册表 → 404「已决」）', async () => {
    const { host } = mockHost()
    const answerer = new ApprovalAnswerer({ host })
    const outcomePromise = answerer.handleRequest(REQ, async () => 'unavailable')
    const asked = answerer.pendingPayloads('session-a')[0]!
    const id = String(asked.approvalId)
    expect(answerer.answer(id, 'session-a', 'allowed-once')).toBe('ok')
    // settle 同步出注册表：其后的答复（同步或迟到）一律 unknown（宿主映射 404，
    // 报文「未知或已决」——与 qa-matrix e2e「已决再答 404」一致）；
    // 'already-decided'（409）仅当两次 settle 在删除前交错（幂等闸防御路径）。
    expect(answerer.answer(id, 'session-a', 'rejected')).toBe('unknown')
    expect(answerer.answer(id, 'session-a', 'allowed-once')).toBe('unknown')
    await expect(outcomePromise).resolves.toBe('allowed-once')
  })

  it('错会话 wrong-session；未知 id unknown；非法 decision invalid-decision（不改变挂起态）', async () => {
    const { host } = mockHost()
    const answerer = new ApprovalAnswerer({ host })
    const outcomePromise = answerer.handleRequest(REQ, async () => 'unavailable')
    const asked = answerer.pendingPayloads('session-a')[0]!
    const id = String(asked.approvalId)
    expect(answerer.answer(id, 'session-b', 'rejected')).toBe('wrong-session')
    expect(answerer.answer('no-such-id', 'session-a', 'rejected')).toBe('unknown')
    expect(answerer.answer(id, 'session-a', 'yes-please')).toBe('invalid-decision')
    expect(answerer.pendingCount).toBe(1) // 均未裁决
    expect(answerer.answer(id, 'session-a', 'rejected')).toBe('ok')
    await expect(outcomePromise).resolves.toBe('rejected')
  })

  it('超时 fail-closed：到点按拒绝处理（不是放行）', async () => {
    const { host } = mockHost()
    const answerer = new ApprovalAnswerer({ host, timeoutMs: 50 })
    const outcomePromise = answerer.handleRequest(REQ, async () => 'unavailable')
    await expect(outcomePromise).resolves.toBe('rejected') // 超时=rejected
    expect(answerer.pendingCount).toBe(0)
  })

  it('abort → cancelled（撤回不推 rejected）', async () => {
    const { host, pushed } = mockHost()
    const answerer = new ApprovalAnswerer({ host })
    const controller = new AbortController()
    const outcomePromise = answerer.handleRequest({ ...REQ, signal: controller.signal }, async () => 'unavailable')
    controller.abort()
    await expect(outcomePromise).resolves.toBe('cancelled')
    expect((pushed.at(-1)!.payload as { decision?: string }).decision).toBe('cancelled')
  })

  it('重连重发：pendingPayloads 按会话过滤、按原 approvalId 幂等（载荷同一引用）', async () => {
    const { host, pushed } = mockHost(['session-a', 'session-b'])
    const answerer = new ApprovalAnswerer({ host })
    void answerer.handleRequest(REQ, async () => 'unavailable')
    void answerer.handleRequest({ ...REQ, agent: { session: { id: 'session-b' } }, toolName: 'other_tool' }, async () => 'unavailable')
    const forA = answerer.pendingPayloads('session-a')
    expect(forA.length).toBe(1)
    expect(forA[0]).toBe(pushed[0]!.payload) // 同一份载荷（approvalId 幂等）
    expect(answerer.pendingPayloads('session-b').length).toBe(1)
    expect(answerer.pendingPayloads('session-c')).toEqual([])
    // 清理
    answerer.answer(String(forA[0]!.approvalId), 'session-a', 'rejected')
    answerer.answer(String(answerer.pendingPayloads('session-b')[0]!.approvalId), 'session-b', 'rejected')
  })

  it('非宿主会话 → next() 委托（不推卡、不挂起）', async () => {
    const { host, pushed } = mockHost()
    const answerer = new ApprovalAnswerer({ host })
    const outcome = await answerer.handleRequest({ ...REQ, agent: { session: { id: 'session-x' } } }, async () => 'unavailable')
    expect(outcome).toBe('unavailable')
    expect(pushed).toEqual([])
    expect(answerer.pendingCount).toBe(0)
  })

  it('宿主桥 timeoutMs 覆盖插件 config', async () => {
    const { host, pushed } = mockHost(['session-a'], { timeoutMs: 1234 })
    const answerer = new ApprovalAnswerer({ host, timeoutMs: 99_999 })
    void answerer.handleRequest(REQ, async () => 'unavailable')
    expect(answerer.pendingPayloads('session-a')[0]!.timeoutMs).toBe(1234)
    answerer.answer(String(answerer.pendingPayloads('session-a')[0]!.approvalId), 'session-a', 'rejected')
  })
})

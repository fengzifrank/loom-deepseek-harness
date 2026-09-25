/**
 * SSE 事件协议契约（M16.5）——内核升级后对外事件流的类型清单与载荷形状。
 *
 * 用 budget fixture（最快 boot）驱动一轮工具调用，枚举**全部对外事件类型**，
 * 验证每种类型的载荷含必需字段。任何事件类型消失/载荷字段改名都会 fail-loud。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import {
  ANON_HEADERS, bootLoom, cleanupDir, ensureTsx, GIS_DIR, openEventStream, readEnv, sdkBuilt, type BootedLoom,
} from '../../../examples/gis/tests/helpers.js'

const gisEnv = readEnv(GIS_DIR)
const hasKey = process.env.DEEPSEEK_API_KEY !== undefined || gisEnv.DEEPSEEK_API_KEY !== undefined
if (process.env.DEEPSEEK_API_KEY === undefined && gisEnv.DEEPSEEK_API_KEY !== undefined) {
  process.env.DEEPSEEK_API_KEY = gisEnv.DEEPSEEK_API_KEY
}

describe.skipIf(!sdkBuilt() || !hasKey)('SSE 事件协议契约（事件类型清单 + 载荷必需字段）', () => {
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    ensureTsx()
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'tests', 'budget-app.ts'),
      withApproval: true,
      port: 4676,
      outDirName: '.loom-sse-contract-e2e',
    })
  }, 180_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(GIS_DIR, '.loom-sse-contract-e2e'))
  })

  it('完整工具调用轮的事件协议：每种类型载荷含必需字段', async () => {
    const created = await fetch(`${loom!.base}/agents/echo-worker/sessions`, { method: 'POST', headers: ANON_HEADERS })
    const { sessionId } = (await created.json()) as { sessionId: string }
    const sse = await openEventStream(loom!.base, sessionId)
    try {
      // 三连调（预算 max=2）覆盖：tool/call + tool/result（成功 + 被拒）+ turn 生命周期
      await fetch(`${loom!.base}/agents/echo-worker/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ANON_HEADERS },
        body: JSON.stringify({ text: '请连续调用三次 budget_echo，text 分别为"一""二""三"，每次告诉我结果。' }),
      })
      await sse.wait(e => e.type === 'turn/end' && String(e.reason?.kind ?? e.reason) === 'completed', 300_000, 'turn 完成')

      // ---- 事件类型清单（对外协议快照）----
      const types = new Set(sse.events.map(e => e.type))
      const REQUIRED_TYPES = [
        'turn/start',        // 轮开始
        'user/message',      // 用户消息（text 字段）
        'assistant/message', // 定稿（text 字段）——0.1.7 必有
        'tool/call',         // 工具调用（callId/name/args）
        'tool/result',       // 工具结果（callSeq/isError/preview）
        'turn/end',          // 轮结束（reason）
      ]
      // 0.1.7 起 assistant/chunk 为流式增量（text-delta），短回复可能整体聚合为
      // assistant/message 而不发出独立 chunk——可选，不锁。
      const OPTIONAL_TYPES = ['assistant/chunk']
      for (const required of REQUIRED_TYPES) {
        expect(types.has(required), `事件类型 "${required}" 缺失——对外协议破坏`).toBe(true)
      }

      // ---- 载荷必需字段逐类型验证 ----
      const call = sse.events.find(e => e.type === 'tool/call')!
      expect(call).toMatchObject({ callId: expect.any(String), name: expect.any(String) })
      expect(call.args).toBeDefined()

      const result = sse.events.find(e => e.type === 'tool/result')!
      expect(result).toMatchObject({ callSeq: expect.any(Number), isError: expect.any(Boolean) })
      expect(typeof result.preview).toBe('string')

      const user = sse.events.find(e => e.type === 'user/message')!
      expect(typeof user.text).toBe('string')

      const start = sse.events.find(e => e.type === 'turn/start')!
      expect(typeof start.turn).toBe('number')

      const end = sse.events.find(e => e.type === 'turn/end')!
      expect(end.reason).toBeDefined()

      // 预算拒绝的第三轮结果含预算描述（错误文本模型可见 = 对外协议）
      const denied = sse.events.filter(e => e.type === 'tool/result' && e.isError === true)
      expect(denied.length).toBeGreaterThanOrEqual(1)
      expect(String(denied[0]!.preview)).toContain('预算')
    } finally {
      sse.close()
    }
  }, 400_000)
})

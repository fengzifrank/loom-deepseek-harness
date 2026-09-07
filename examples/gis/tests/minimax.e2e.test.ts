/**
 * MiniMax-M3 真实端点全链 e2e（M11 网关第三方实证；需要 MINIMAX_API_KEY，无 key 自跳过）。
 *
 * 证据链（不假设，全部真实网络）：
 * 1. boot → 组合为 llm-pi-ai 的 minimax 路由（yml 断言）+ health 200；
 * 2. 纯文本轮：SSE assistant/message 到达（M3 的 <think> 内联思考会随文本流过——
 *    如实断言收到内容而非特定文案）+ turn/end completed；
 * 3. 工具轮（函数调用全链）：模型调 probe_echo → tool/call 参数正确 → tool/result
 *    → assistant/message 确认 → turn/end completed——MiniMax-M3 的 finish_reason=
 *    tool_calls 语义经 pi-ai 适配进内核工具管线；
 * 4. 同会话第二轮（多轮上下文含工具历史）。
 */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import {
  ANON_HEADERS, bootLoom, cleanupDir, ensureTsx, GIS_DIR, openEventStream, readEnv, sdkBuilt, type BootedLoom,
} from './helpers.js'

const env = readEnv(GIS_DIR)
const hasKey = process.env.MINIMAX_API_KEY !== undefined || env.MINIMAX_API_KEY !== undefined
if (process.env.MINIMAX_API_KEY === undefined && env.MINIMAX_API_KEY !== undefined) {
  process.env.MINIMAX_API_KEY = env.MINIMAX_API_KEY
}

describe.skipIf(!sdkBuilt() || !hasKey)('MiniMax-M3 真实端点 e2e', () => {
  let loom: BootedLoom | undefined
  let sessionId = ''

  beforeAll(async () => {
    ensureTsx()
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'tests', 'minimax-app.ts'),
      withApproval: false,
      port: 4654,
      outDirName: '.loom-minimax-e2e',
    })
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(GIS_DIR, '.loom-minimax-e2e'))
  })

  it('组合：llm-pi-ai + minimax 路由 + MINIMAX_API_KEY 引用（值不进 yml）', () => {
    const yml = readFileSync(resolve(GIS_DIR, '.loom-minimax-e2e', 'cordis.yml'), 'utf8')
    expect(yml).toContain("'@deepseek-ai/dsh-llm-pi-ai'")
    expect(yml).toContain('minimax:')
    expect(yml).toContain('baseURL: "https://api.minimaxi.com/v1"')
    expect(yml).toContain('apiKeyEnv: MINIMAX_API_KEY')
    expect(yml).toContain('- id: "MiniMax-M3"')
    expect(yml).not.toContain('sk-cp-') // 机密绝不落组合文件
  })

  it('纯文本轮：真实流式回答 + turn completed', async () => {
    const created = await fetch(`${loom!.base}/agents/talker/sessions`, { method: 'POST', headers: ANON_HEADERS })
    expect(created.status).toBe(200)
    sessionId = ((await created.json()) as { sessionId: string }).sessionId
    const sse = await openEventStream(loom!.base, sessionId)
    try {
      const sent = await fetch(`${loom!.base}/agents/talker/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ANON_HEADERS },
        body: JSON.stringify({ text: '用一句话介绍你自己（不要调用工具）。' }),
      })
      expect(sent.status).toBe(200)
      await sse.wait(e => e.type === 'assistant/message', 180_000, 'assistant/message（真实流式）')
      const end = await sse.wait(e => e.type === 'turn/end', 180_000, 'turn/end')
      expect(String(end.reason?.kind ?? end.reason)).toBe('completed')
    } finally {
      sse.close()
    }
  }, 400_000)

  it('工具轮：函数调用全链（probe_echo）+ 多轮上下文', async () => {
    const sse = await openEventStream(loom!.base, sessionId)
    try {
      const sent = await fetch(`${loom!.base}/agents/talker/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ANON_HEADERS },
        body: JSON.stringify({ text: '请调用 probe_echo 工具，text 参数填"网关连通"，然后一句话告诉我工具返回了什么。' }),
      })
      expect(sent.status).toBe(200)
      const call = await sse.wait(e => e.type === 'tool/call' && e.name === 'probe_echo', 180_000, 'probe_echo 调用')
      expect(String(call.args?.text)).toContain('网关连通')
      const result = await sse.wait(e => e.type === 'tool/result' && e.callSeq === call.seq, 60_000, 'probe_echo 结果')
      expect(result.isError).toBeFalsy()
      expect(String(result.value?.text ?? result.preview)).toContain('echo: 网关连通')
      // 工具结果回流模型 → 最终确认（多步 turn）
      const confirm = await sse.wait(
        e => e.type === 'assistant/message' && sse.events.filter(x => x.type === 'tool/result').length > 0,
        180_000,
        '工具后的最终回答',
      )
      expect(String(confirm.text)).not.toBe('')
      const end = await sse.wait(e => e.type === 'turn/end', 180_000, 'turn/end（工具轮）')
      expect(String(end.reason?.kind ?? end.reason)).toBe('completed')
    } finally {
      sse.close()
    }
  }, 400_000)
})

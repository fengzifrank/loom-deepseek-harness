/**
 * M3 真实 e2e（需要 DEEPSEEK_API_KEY；无 key 自跳过）：
 *
 * 1. 委派链：消息「让研究员核对连河村和太平河村的地类数据，然后汇总差异」
 *    → 父流 tool/call(subagent) → loom/subagent-started{childSessionId}
 *    → 子会话流（自己的 turn / gis_query_land_types 工具调用 / turn/end）
 *    → 父流 loom/subagent-finished + tool/result(subagent, 非错误)
 *    → 父 turn/end completed。
 * 2. webhook 正确签名 → 202 {sessionId} → 该会话 SSE 出现 map 后的用户消息
 *    与 agent 活动（turn/start → … → turn/end）。
 * 3. 签名错误 → 401；map 抛错 → 400（不建会话）。
 *
 * 数据纪律：委派与 webhook 任务均为只读查询；仍按惯例快照/还原 land-types.json。
 */
import { createHmac } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import {
  ANON_HEADERS, bootLoom, cleanupDir, ensureTsx, GIS_DIR, openEventStream, readEnv, sdkBuilt, type BootedLoom, type SseCollector,
} from './helpers.js'

const DATA_PATH = join(GIS_DIR, 'data', 'land-types.json')

const env = readEnv(GIS_DIR)
const hasKey = process.env.DEEPSEEK_API_KEY !== undefined || env.DEEPSEEK_API_KEY !== undefined
if (process.env.DEEPSEEK_API_KEY === undefined && env.DEEPSEEK_API_KEY !== undefined) {
  process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY
}

const WEBHOOK_SECRET = process.env.LOOM_WEBHOOK_SECRET ?? env.LOOM_WEBHOOK_SECRET ?? 'whsec_loom_demo'
const DELEGATION_MESSAGE = '让研究员核对连河村和太平河村的地类数据，然后汇总差异'

describe.skipIf(!hasKey || !sdkBuilt())('M3 委派链与 webhook 通道 e2e（带 key）', () => {
  let loom: BootedLoom | undefined
  let originalData: string

  beforeAll(async () => {
    ensureTsx()
    originalData = readFileSync(DATA_PATH, 'utf8')
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'loom.app.ts'),
      withApproval: true,
      withSubagent: true,
      port: 4624,
      outDirName: '.loom-m3-e2e',
    })
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(GIS_DIR, '.loom-m3-e2e'))
    if (originalData !== undefined) writeFileSync(DATA_PATH, originalData, 'utf8')
  })

  it('health 汇报 M3 声明（webhook 通道 + researcher 子智能体）', async () => {
    const res = await fetch(`${loom!.base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.channels).toEqual([
      { kind: 'webhook', path: '/~loom/hooks/demo', agent: 'data-analysis', secured: true },
    ])
    expect(body.subagents).toEqual([
      { id: 'researcher', visibleTo: ['data-analysis'], tools: ['gis_query_land_types'] },
    ])
  })

  it('委派链：父 tool/call(subagent) → 子会话直播 → 父收到结果 → 父 turn/end completed', async () => {
    // 1) 建父会话 + 挂父 SSE
    const created = await fetch(`${loom!.base}/agents/data-analysis/sessions`, { method: 'POST', headers: ANON_HEADERS })
    expect(created.status).toBe(200)
    const { sessionId } = (await created.json()) as { sessionId: string }
    const parent = await openEventStream(loom!.base, sessionId)

    try {
      // 2) 发委派消息
      const sent = await fetch(`${loom!.base}/agents/data-analysis/sessions/${sessionId}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...ANON_HEADERS }, body: JSON.stringify({ text: DELEGATION_MESSAGE }),
      })
      expect(sent.status).toBe(200)

      // 3) 父流：tool/call(subagent)
      const subCall = await parent.wait(e => e.type === 'tool/call' && e.name === 'subagent', 120_000, '父 tool/call(subagent)')
      expect((subCall.args as Record<string, any>)?.spec).toBe('researcher')
      expect(String((subCall.args as Record<string, any>)?.task ?? '')).toContain('连河村')

      // 4) 父流：loom/subagent-started 带子会话 id
      const started = await parent.wait(e => e.type === 'loom/subagent-started', 15_000, 'loom/subagent-started')
      const childSessionId = String(started.childSessionId)
      expect(started.spec).toBe('researcher')
      expect(childSessionId).not.toBe(sessionId)

      // 5) 子会话直播（既有 SSE 端点直接开第二条流）：自己的 turn / 工具调用 / turn/end
      const child = await openEventStream(loom!.base, childSessionId)
      try {
        const childTurn = await child.wait(e => e.type === 'turn/start', 30_000, '子 turn/start')
        expect(typeof childTurn.seq).toBe('number')
        const childQuery = await child.wait(e => e.type === 'tool/call' && e.name === 'gis_query_land_types', 90_000, '子 tool/call(gis_query_land_types)')
        expect((childQuery.args as Record<string, any>)?.region).toContain('连河村')
        await child.wait(e => e.type === 'tool/result' && e.callSeq === childQuery.seq, 60_000, '子 tool/result')
        const childEnd = await child.wait(e => e.type === 'turn/end', 120_000, '子 turn/end')

        // 6) 父流：subagent-finished（completed）+ tool/result(subagent) 非错误 → 父 turn/end completed
        await parent.wait(e => e.type === 'loom/subagent-finished' && e.childSessionId === childSessionId && e.stopReason === 'completed', 60_000, 'loom/subagent-finished completed')
        const subResult = await parent.wait(
          e => e.type === 'tool/result' && e.callSeq === subCall.seq && !e.isError,
          60_000,
          '父 tool/result(subagent)',
        )
        // render 是 canonical JSON：短结果附 value（可直接断言子会话 id）；长结果
        // 被 PREVIEW_MAX 截断时 value 缺失，退而断言 preview 前缀里的规格名。
        const resultValue = subResult.value as Record<string, any> | undefined
        if (resultValue !== undefined) {
          expect(String(resultValue.sessionId ?? '')).toBe(childSessionId)
          expect(String(resultValue.output ?? '')).not.toBe('')
        } else {
          expect(String(subResult.preview ?? '')).toContain('researcher')
        }
        const parentEnd = await parent.wait(
          e => e.type === 'turn/end' && (e as any).reason?.kind === 'completed',
          180_000,
          '父 turn/end completed',
        )
        expect(parentEnd.seq).toBeGreaterThan(subResult.seq)
        expect(childEnd.seq).toBeGreaterThan(0)
      } finally {
        child.close()
      }
    } finally {
      parent.close()
    }
  }, 300_000)

  it('webhook：正确签名 → 202 {sessionId} → 会话 SSE 出现 map 后文本与 agent 活动', async () => {
    const payload = JSON.stringify({ text: '查询连河村的地类面积，给出一句汇总', topic: 'e2e-hook' })
    const res = await fetch(`${loom!.base}/hooks/demo`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-loom-signature': createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex'),
      },
      body: payload,
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { sessionId: string; agentId: string; reused: boolean }
    expect(body.agentId).toBe('data-analysis')
    expect(body.reused).toBe(false)

    const sse = await openEventStream(loom!.base, body.sessionId)
    try {
      // map 后的文本作为任务（user/message）
      const userMessage = await sse.wait(e => e.type === 'user/message' && String(e.text ?? '').includes('【webhook】查询连河村的地类面积'), 10_000, 'webhook 用户消息')
      expect(userMessage.type).toBe('user/message')
      // agent 异步干活：turn/start → … → turn/end（真实 key 下应完整走完）
      await sse.wait(e => e.type === 'turn/start', 30_000, 'webhook turn/start')
      const end = await sse.wait(e => e.type === 'turn/end', 180_000, 'webhook turn/end')
      expect((end as any).reason?.kind).toBe('completed')
    } finally {
      sse.close()
    }

    // sessionKey 命中：同 topic 再发 → 复用同一会话
    const again = await fetch(`${loom!.base}/hooks/demo`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-loom-signature': createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex'),
      },
      body: payload,
    })
    expect(again.status).toBe(202)
    const againBody = (await again.json()) as { sessionId: string; reused: boolean }
    expect(againBody.sessionId).toBe(body.sessionId)
    expect(againBody.reused).toBe(true)
  }, 300_000)

  it('webhook：签名错误 → 401；map 抛错 → 400（不建会话）', async () => {
    const payload = JSON.stringify({ text: 'x', topic: 'e2e-bad' })
    const badSig = await fetch(`${loom!.base}/hooks/demo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-loom-signature': createHmac('sha256', 'whsec_wrong').update(payload).digest('hex') },
      body: payload,
    })
    expect(badSig.status).toBe(401)
    expect(((await badSig.json()) as Record<string, any>).code).toBe('SIGNATURE_MISMATCH')

    const missing = await fetch(`${loom!.base}/hooks/demo`, { method: 'POST', body: payload })
    expect(missing.status).toBe(401)
    expect(((await missing.json()) as Record<string, any>).code).toBe('MISSING_SIGNATURE')

    // map 抛错：text 缺失（map 要求非空字符串）
    const mapFail = JSON.stringify({ topic: 'e2e-map-fail' })
    const failed = await fetch(`${loom!.base}/hooks/demo`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-loom-signature': createHmac('sha256', WEBHOOK_SECRET).update(mapFail).digest('hex'),
      },
      body: mapFail,
    })
    expect(failed.status).toBe(400)
    expect(((await failed.json()) as Record<string, any>).code).toBe('MAP_FAILED')
  })
})

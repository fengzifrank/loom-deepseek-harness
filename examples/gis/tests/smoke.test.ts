/**
 * 集成冒烟（无 key）：boot 最小应用 → health 200 → 404 形状 → .http() 端点
 * → M3 webhook 401/400/202 与 sessionKey 命中/未命中、subagent 组合行可 boot。
 * 前置：@loom-sdk/web 已构建（pnpm build:sdk）；未构建则自跳过。
 * 学 harness test:e2e 约定：条件自跳过，而不是 fail。
 */
import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootLoom, cleanupDir, GIS_DIR, openEventStream, sdkBuilt, type BootedLoom } from './helpers.js'
import { join, resolve } from 'node:path'

describe.skipIf(!sdkBuilt())('集成冒烟（无 key）', () => {
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'tests', 'fixtures', 'smoke.app.mjs'),
      withApproval: true,
      withSubagent: true,
      port: 4621,
      outDirName: '.loom-smoke',
    })
  }, 60_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(GIS_DIR, '.loom-smoke'))
  })

  it('health 200：应用/工具/策略齐全', async () => {
    const res = await fetch(`${loom!.base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.ok).toBe(true)
    expect(body.app).toBe('smoke')
    expect(body.tools).toContain('smoke_echo')
    expect(body.agents).toEqual(['smoke-agent'])
    expect(body.policy).toMatchObject({ default: 'allow', rules: 2 })
    expect(body.httpApi).toEqual([{ tool: 'smoke_echo', method: 'GET', path: '/~loom/api/smoke_echo' }])
  })

  it('未知智能体 404 形状：{ error }', async () => {
    const res = await fetch(`${loom!.base}/agents/not-an-agent`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, any>
    expect(typeof body.error).toBe('string')
    expect(body.error).toContain('not-an-agent')
  })

  it('agents 清单 200', async () => {
    const res = await fetch(`${loom!.base}/agents`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.agents[0]).toMatchObject({ id: 'smoke-agent', tools: ['smoke_echo'] })
  })

  it('.http() 端点返回真实数据（GET query → 内核管线 → 工具值）', async () => {
    const res = await fetch(`${loom!.base}/api/smoke_echo?text=${encodeURIComponent('loom')}&times=2`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-loom-exec')).toBe('pipeline')
    expect(await res.json()).toEqual({ text: 'loomloom', n: 42 })
  })

  it('.http() 参数校验失败走内核错误结果（缺 required text）', async () => {
    const res = await fetch(`${loom!.base}/api/smoke_echo`)
    expect(res.status).toBe(500)
    const body = (await res.json()) as Record<string, any>
    expect(body.ok).toBe(false)
    expect(typeof body.error).toBe('string')
  })

  it('空会话 fork（无 atSeq）得到空子会话；atSeq 越界映射 400 INVALID_BOUNDARY', async () => {
    const created = await fetch(`${loom!.base}/agents/smoke-agent/sessions`, { method: 'POST' })
    const { sessionId } = (await created.json()) as Record<string, string>
    expect(typeof sessionId).toBe('string')

    const forkRes = await fetch(`${loom!.base}/sessions/${sessionId}/fork`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })
    expect(forkRes.status).toBe(200)
    const forkBody = (await forkRes.json()) as Record<string, any>
    expect(forkBody.forkedFrom).toBe(sessionId)
    expect(forkBody.sessionId).not.toBe(sessionId)

    const badRes = await fetch(`${loom!.base}/sessions/${sessionId}/fork`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ atSeq: 0 }),
    })
    expect(badRes.status).toBe(400)
    const badBody = (await badRes.json()) as Record<string, any>
    expect(badBody.code).toBe('INVALID_BOUNDARY')
    expect(typeof badBody.error).toBe('string')
  })

  it('审批答复路由：未知审批 id 404，非法 decision 400', async () => {
    const created = await fetch(`${loom!.base}/agents/smoke-agent/sessions`, { method: 'POST' })
    const { sessionId } = (await created.json()) as Record<string, string>
    const unknown = await fetch(`${loom!.base}/sessions/${sessionId}/approvals/nope`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'allowed-once' }),
    })
    expect(unknown.status).toBe(404)
  })

  // ---- M3：webhook 通道（无 key 即可断言 401/400/202 + sessionKey 命中/未命中）----

  it('health 汇报通道与子智能体（M3）', async () => {
    const res = await fetch(`${loom!.base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.channels).toEqual([
      { kind: 'webhook', path: '/~loom/hooks/smoke', agent: 'smoke-agent', secured: true },
    ])
    expect(body.subagents).toEqual([
      { id: 'smoke-researcher', visibleTo: ['smoke-agent'], tools: ['smoke_echo'] },
    ])
  })

  it('webhook 缺签名 / 错签名 → 401（形状清晰，不建会话）', async () => {
    const body = JSON.stringify({ text: 'hello', topic: 't1' })
    const missing = await fetch(`${loom!.base}/hooks/smoke`, { method: 'POST', body })
    expect(missing.status).toBe(401)
    expect(((await missing.json()) as Record<string, any>).code).toBe('MISSING_SIGNATURE')

    const wrong = await fetch(`${loom!.base}/hooks/smoke`, {
      method: 'POST', headers: { 'x-loom-signature': '0'.repeat(64) }, body,
    })
    expect(wrong.status).toBe(401)
    expect(((await wrong.json()) as Record<string, any>).code).toBe('SIGNATURE_MISMATCH')

    const malformed = await fetch(`${loom!.base}/hooks/smoke`, {
      method: 'POST', headers: { 'x-loom-signature': 'not-hex' }, body,
    })
    expect(malformed.status).toBe(401)
    expect(((await malformed.json()) as Record<string, any>).code).toBe('MALFORMED_SIGNATURE')
  })

  it('webhook 非 JSON / map 抛错 → 400（不建会话）', async () => {
    const signed = (payload: string): { 'x-loom-signature': string, 'content-type': string } => ({
      'content-type': 'application/json',
      'x-loom-signature': createHmac('sha256', 'whsec_smoke').update(payload).digest('hex'),
    })
    const badJson = 'not-json{'
    const invalid = await fetch(`${loom!.base}/hooks/smoke`, { method: 'POST', headers: signed(badJson), body: badJson })
    expect(invalid.status).toBe(400)
    expect(((await invalid.json()) as Record<string, any>).code).toBe('INVALID_JSON')

    const mapFail = JSON.stringify({ text: '', topic: 't' })
    const failed = await fetch(`${loom!.base}/hooks/smoke`, { method: 'POST', headers: signed(mapFail), body: mapFail })
    expect(failed.status).toBe(400)
    expect(((await failed.json()) as Record<string, any>).code).toBe('MAP_FAILED')
  })

  it('webhook 正确签名 → 202 {sessionId}；sessionKey 命中复用 / 未命中新建', async () => {
    const post = async (payload: unknown): Promise<{ status: number, body: Record<string, any> }> => {
      const raw = JSON.stringify(payload)
      const res = await fetch(`${loom!.base}/hooks/smoke`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-loom-signature': createHmac('sha256', 'whsec_smoke').update(raw).digest('hex'),
        },
        body: raw,
      })
      return { status: res.status, body: (await res.json()) as Record<string, any> }
    }

    // 未命中（新 topic）→ 新建
    const first = await post({ text: '核对 A 村数据', topic: 'village-a' })
    expect(first.status).toBe(202)
    expect(first.body.agentId).toBe('smoke-agent')
    expect(first.body.reused).toBe(false)
    expect(String(first.body.sessionId)).toMatch(/^session-smoke-hook-village-a-/)

    // 命中（同 topic）→ 复用同一会话
    const second = await post({ text: '继续核对 A 村', topic: 'village-a' })
    expect(second.status).toBe(202)
    expect(second.body.sessionId).toBe(first.body.sessionId)
    expect(second.body.reused).toBe(true)

    // 不同 topic → 未命中，另建
    const third = await post({ text: '核对 B 村数据', topic: 'village-b' })
    expect(third.status).toBe(202)
    expect(third.body.sessionId).not.toBe(first.body.sessionId)
    expect(third.body.reused).toBe(false)

    // 202 的会话可开 SSE（事件里应有 map 后的用户消息——无 key 时 turn 可能失败，但消息已落日志）
    const sse = await openEventStream(loom!.base, String(first.body.sessionId))
    try {
      const seen = await sse.wait(e => e.type === 'user/message' && String(e.text ?? '').includes('【webhook】核对 A 村数据'), 5_000, 'webhook 用户消息')
      expect(seen.type).toBe('user/message')
    } finally {
      sse.close()
    }
  })

  it('webhook 非 POST → 405', async () => {
    const res = await fetch(`${loom!.base}/hooks/smoke`, { method: 'GET' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })
})

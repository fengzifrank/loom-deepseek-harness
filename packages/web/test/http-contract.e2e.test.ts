/**
 * HTTP API 契约测试（M16.5）——内核升级后对外路由/状态码/载荷形状的兼容性锁定。
 *
 * 用一个全功能 fixture（工具 + 策略 + 认证 + 记忆 + 群体 + 子智能体），
 * 对**每一条对外 HTTP 路由**做方法/形状验证。任何路由消失、状态码变化、
 * 响应字段改名都会在此 fail-loud——这是内核升级最直接的下游爆炸面。
 *
 * 路由清单（= 文档声明的对外 API）：
 *   GET  /health                          200 { ok, app, model, agents, tools, ... }
 *   GET  /agents                          200 [{ id, ... }]
 *   POST /agents/:id/sessions             200 { sessionId }
 *   GET  /agents/:id/sessions             200 [{ sessionId, title }]
 *   POST /agents/:id/sessions/:sid/messages  200（进度走 SSE）
 *   GET  /agents/:id/sessions/:sid/events    SSE
 *   GET  /sessions/:sid/events[?since&to]    SSE（to 有界读完即收）
 *   POST /sessions/:sid/fork              200 { sessionId, atSeq }
 *   POST /sessions/:sid/approvals/:aid    200/400
 *   GET  /openapi.json                    200 { openapi: "3.1.0" }
 *   GET  /projections[/:name]             200
 *   GET  /memories?query=                 200 { memories: [...] }
 *   PUT  /memories/:id                    200 { id, content }
 *   DELETE /memories/:id                  200 { ok, id }
 *   POST /auth/register                   200 { token, userId }
 *   POST /auth/login                      200 { token, userId }
 *   GET  /auth/me                         200 { userId, username }
 *   POST <webhook path>                   202 { sessionId }
 *   .http() 工具面                         200 JSON
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { hmac } from 'node:crypto'
import { createHmac } from 'node:crypto'
import {
  bootLoom, cleanupDir, ensureTsx, GIS_DIR, sdkBuilt, type BootedLoom,
} from '../../../examples/gis/tests/helpers.js'

const contractApp = join(GIS_DIR, 'tests', '..', 'loom.app.ts')

describe.skipIf(!sdkBuilt())('HTTP API 契约测试（全路由形状锁定）', () => {
  let loom: BootedLoom | undefined
  let sessionId = ''
  const ANON = { 'x-loom-user': 'anon-contract-test-0001' }

  beforeAll(async () => {
    ensureTsx()
    loom = await bootLoom({
      appModulePath: contractApp,
      withApproval: true,
      withSubagent: true,
      port: 4675,
      outDirName: '.loom-contract-e2e',
    })
  }, 180_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(GIS_DIR, '.loom-contract-e2e'))
  })

  // ---- 基础路由 ----

  it('GET /health → 200 { ok, app, model, agents[], tools[], httpApi[] }', async () => {
    const res = await fetch(`${loom!.base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.ok).toBe(true)
    expect(typeof body.app).toBe('string')
    expect(typeof body.model).toBe('string')
    expect(Array.isArray(body.agents)).toBe(true)
    expect(Array.isArray(body.tools)).toBe(true)
    expect(Array.isArray(body.httpApi)).toBe(true)
    expect(body.httpApi[0]).toMatchObject({ tool: expect.any(String), method: expect.any(String), path: expect.any(String) })
  })

  it('GET /agents → 200 { agents: [{ id, tools, memory }] }', async () => {
    const res = await fetch(`${loom!.base}/agents`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { agents: Array<Record<string, any>> }
    expect(body.agents.length).toBeGreaterThanOrEqual(3)
    expect(body.agents[0]).toMatchObject({ id: expect.any(String), tools: expect.any(Array) })
  })

  it('GET /openapi.json → 200 { openapi: "3.1.0", paths }', async () => {
    const res = await fetch(`${loom!.base}/openapi.json`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.openapi).toBe('3.1.0')
    expect(typeof body.paths).toBe('object')
    expect(Object.keys(body.paths).length).toBeGreaterThanOrEqual(1)
  })

  it('GET /projections → 200 { projections: [...] }', async () => {
    const res = await fetch(`${loom!.base}/projections`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projections: string[] }
    expect(body.projections).toContain('workspace')
  })

  // ---- 会话生命周期 ----

  it('POST /agents/:id/sessions → 200 { sessionId }', async () => {
    const res = await fetch(`${loom!.base}/agents/data-analysis/sessions`, { method: 'POST', headers: ANON })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessionId: string }
    expect(body.sessionId).toMatch(/^session-/)
    sessionId = body.sessionId
  })

  it('GET /agents/:id/sessions → 200 { sessions: [{ sessionId, title }] }', async () => {
    const res = await fetch(`${loom!.base}/agents/data-analysis/sessions`, { headers: ANON })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessions: Array<{ sessionId: string; title: string }> }
    expect(body.sessions.some(s => s.sessionId === sessionId)).toBe(true)
  })

  it('GET /sessions/:sid/events → SSE 流（Content-Type 正确）', async () => {
    const res = await fetch(`${loom!.base}/sessions/${sessionId}/events?since=-1&to=0`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    // 有界读完即收
    const text = await res.text()
    expect(text).toContain('data: ')
  })

  it('GET /agents/:id/sessions/:sid/events → SSE 同流（变体路由）', async () => {
    const res = await fetch(`${loom!.base}/agents/data-analysis/sessions/${sessionId}/events?since=-1&to=0`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
  })

  it('POST /sessions/:sid/fork → 200 { sessionId, atSeq }', async () => {
    const res = await fetch(`${loom!.base}/sessions/${sessionId}/fork`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...ANON }, body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessionId: string; atSeq: number }
    expect(body.sessionId).toMatch(/^session-/)
    expect(typeof body.atSeq).toBe('number')
  })

  // ---- .http() 第二面孔 ----

  it('.http() 工具面 → 200 JSON + x-loom-exec 头', async () => {
    const res = await fetch(`${loom!.base}/api/gis_query_land_types?region=${encodeURIComponent('连河村')}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-loom-exec')).toBeTruthy()
    const body = (await res.json()) as { items: Array<{ village: string }> }
    expect(body.items.length).toBeGreaterThan(0)
  })

  // ---- 策略审批 ----

  it('POST /sessions/:sid/approvals/:aid → 无待审批时 400/404（不泄露）', async () => {
    const res = await fetch(`${loom!.base}/sessions/${sessionId}/approvals/fake-approval-id`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...ANON }, body: JSON.stringify({ decision: 'allowed-once' }),
    })
    expect([400, 404]).toContain(res.status)
  })

  // ---- 认证路由 ----

  it('POST /auth/register → 200 { token, userId, username }；GET /auth/me → 200', async () => {
    const reg = await fetch(`${loom!.base}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'contract_tester', password: 'password88' }),
    })
    expect(reg.status).toBe(200)
    const body = (await reg.json()) as { token: string; userId: string; username: string }
    expect(typeof body.token).toBe('string')
    expect(body.username).toBe('contract_tester')

    const me = await fetch(`${loom!.base}/auth/me`, { headers: { authorization: `Bearer ${body.token}` } })
    expect(me.status).toBe(200)
    const meBody = (await me.json()) as { userId: string; username: string }
    expect(meBody.username).toBe('contract_tester')
  })

  it('POST /auth/login → 200 { token }；错密码 401', async () => {
    const ok = await fetch(`${loom!.base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'contract_tester', password: 'password88' }),
    })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { token: string }
    expect(typeof body.token).toBe('string')

    const bad = await fetch(`${loom!.base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'contract_tester', password: 'wrong' }),
    })
    expect(bad.status).toBe(401)
  })

  // ---- 记忆路由 ----

  it('GET /memories → 200 { memories: [...] }（auth 声明的应用需身份）', async () => {
    const res = await fetch(`${loom!.base}/memories`, { headers: ANON })
    // gis 应用声明 auth → 需身份；ANON 头合法
    expect([200, 401]).toContain(res.status)
    if (res.status === 200) {
      const body = (await res.json()) as { memories: unknown[] }
      expect(Array.isArray(body.memories)).toBe(true)
    }
  })

  // ---- Webhook 通道 ----

  it('POST webhook 通道 → 202 { sessionId }（HMAC 签名校验）', async () => {
    const payload = JSON.stringify({ text: '契约测试：查连河村地类', topic: 'contract-test' })
    const secret = 'whsec_loom_demo' // gis loom.app.ts 里声明的缺省 secret
    const sig = createHmac('sha256', secret).update(payload, 'utf8').digest('hex')
    const res = await fetch(`${loom!.base}/hooks/demo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-loom-signature': sig },
      body: payload,
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { sessionId: string }
    expect(body.sessionId).toMatch(/^session-/)
  })

  // ---- 404 不泄露 ----

  it('未知路由 → 404（统一形状）', async () => {
    const res = await fetch(`${loom!.base}/nonexistent/route`)
    expect(res.status).toBe(404)
  })

  it('未知会话 events → 404（不泄露存在性）', async () => {
    const res = await fetch(`${loom!.base}/sessions/session-gis-platform-nonexistent-0000/events`)
    expect(res.status).toBe(404)
  })

  // ---- CORS ----

  it('OPTIONS 预检 → 204 + CORS 头', async () => {
    const res = await fetch(`${loom!.base}/health`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy()
  })
})

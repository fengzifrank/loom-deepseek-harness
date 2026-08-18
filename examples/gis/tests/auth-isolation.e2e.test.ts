/**
 * M7 Part B e2e：多用户隔离（匿名 + 本地账号）。
 *
 * 证据矩阵（应用已声明 app.auth()，全部不触 LLM、无 key 可跑）：
 * 1. 注册 alice/bob → 拿 token；register 规则校验（中文错误）；
 * 2. login 密码错 → 401 统一文案（不泄露存在性）；token 篡改 → me 401；
 * 3. 匿名无身份：POST 建会话 401（中文）；GET events 只读放行；
 * 4. alice 建会话 → bob 访问 messages/events/approvals 全 404"会话不存在"；
 * 5. bob 有自己的会话，与 alice 互不可见（会话列表按归属过滤）；
 * 6. SSE ?token= query 等价解析（EventSource 不能带头）。
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootLoom, cleanupDir, ensureTsx, GIS_DIR, sdkBuilt, type BootedLoom } from './helpers.js'

describe.skipIf(!sdkBuilt())('M7 多用户隔离 e2e（auth + 404 矩阵）', () => {
  let loom: BootedLoom | undefined
  let aliceToken = ''
  let bobToken = ''
  let aliceSessionId = ''

  beforeAll(async () => {
    ensureTsx()
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'loom.app.ts'),
      withApproval: true,
      withSubagent: true,
      port: 4628,
      outDirName: '.loom-auth-e2e',
    })
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(join(GIS_DIR, '.loom-auth-e2e'))
  })

  const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

  it('注册 alice/bob → token 形态与 me 验证', async () => {
    for (const name of ['alice', 'bob']) {
      const res = await fetch(`${loom!.base}/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name, password: 'password88' }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { token: string; userId: string; username: string }
      expect(body.userId).toBe(`user-${name}`)
      expect(body.username).toBe(name)
      expect(body.token).toMatch(/^[\w-]+\.[\w-]+$/)
      if (name === 'alice') aliceToken = body.token
      else bobToken = body.token
    }
    // me：验 token
    const me = await fetch(`${loom!.base}/auth/me`, { headers: bearer(aliceToken) })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ userId: 'user-alice', username: 'alice' })
    // 规则校验（中文错误）
    const shortName = await fetch(`${loom!.base}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ab', password: 'password88' }),
    })
    expect(shortName.status).toBe(400)
    expect(((await shortName.json()) as { error: string }).error).toContain('用户名')
    const dup = await fetch(`${loom!.base}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'password99' }),
    })
    expect(dup.status).toBe(400)
    expect(((await dup.json()) as { error: string }).error).toContain('已被注册')
  })

  it('登录失败不泄露存在性；篡改 token → me 401', async () => {
    const wrong = await fetch(`${loom!.base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'wrong-password' }),
    })
    const unknown = await fetch(`${loom!.base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'who-is-this', password: 'password88' }),
    })
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(((await wrong.json()) as { error: string }).error).toBe('用户名或密码不正确')
    expect(((await unknown.json()) as { error: string }).error).toBe('用户名或密码不正确')

    const tampered = await fetch(`${loom!.base}/auth/me`, { headers: bearer(`${aliceToken.slice(0, -4)}dead`) })
    expect(tampered.status).toBe(401)
    // ?token= query 等价（SSE 场景）
    const viaQuery = await fetch(`${loom!.base}/auth/me?token=${encodeURIComponent(aliceToken)}`)
    expect(viaQuery.status).toBe(200)
    // 登录成功也返回 token
    const login = await fetch(`${loom!.base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'password88' }),
    })
    expect(login.status).toBe(200)
    expect(((await login.json()) as { token: string }).token).toMatch(/^[\w-]+\.[\w-]+$/)
  })

  it('无身份：POST 401（中文）；只读 GET 放行；匿名 x-loom-user 可建会话', async () => {
    const anonymous = await fetch(`${loom!.base}/agents/data-governance/sessions`, { method: 'POST' })
    expect(anonymous.status).toBe(401)
    expect(((await anonymous.json()) as { error: string }).error).toContain('身份')

    const health = await fetch(`${loom!.base}/health`)
    expect(health.status).toBe(200)

    const anonCreate = await fetch(`${loom!.base}/agents/data-governance/sessions`, {
      method: 'POST', headers: { 'x-loom-user': 'anon-isolation-guest-1' },
    })
    expect(anonCreate.status).toBe(200)
    const { sessionId: anonSid } = (await anonCreate.json()) as { sessionId: string }
    // 匿名自己的流可读（只读 GET 放行 + 同身份归属一致）
    const events = await fetch(`${loom!.base}/agents/data-governance/sessions/${anonSid}/events?since=-1&to=0`)
    expect(events.status).toBe(200)
    await events.text()
    // 另一个匿名 UUID 带身份访问 → 404（隔离对匿名身份同样生效）
    const stranger = await fetch(`${loom!.base}/agents/data-governance/sessions/${anonSid}/events?since=-1&to=0`, {
      headers: { 'x-loom-user': 'anon-isolation-other-2' },
    })
    expect(stranger.status).toBe(404)
  })

  it('隔离矩阵：alice 建会话 → bob 访问 messages/events/approvals 全 404', async () => {
    const created = await fetch(`${loom!.base}/agents/data-governance/sessions`, { method: 'POST', headers: bearer(aliceToken) })
    expect(created.status).toBe(200)
    aliceSessionId = ((await created.json()) as { sessionId: string }).sessionId

    // messages：bob → 404"会话不存在"（不泄露）
    const bobMessage = await fetch(`${loom!.base}/agents/data-governance/sessions/${aliceSessionId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...bearer(bobToken) }, body: JSON.stringify({ text: 'bob 借过一下' }),
    })
    expect(bobMessage.status).toBe(404)
    expect(((await bobMessage.json()) as { error: string }).error).toBe('会话不存在')

    // events（SSE）：bob 头 → 404；bob ?token= query → 404（等价解析）
    const bobEvents = await fetch(`${loom!.base}/agents/data-governance/sessions/${aliceSessionId}/events?since=-1`, {
      headers: bearer(bobToken),
    })
    expect(bobEvents.status).toBe(404)
    const bobEventsQuery = await fetch(`${loom!.base}/agents/data-governance/sessions/${aliceSessionId}/events?since=-1&token=${encodeURIComponent(bobToken)}`)
    expect(bobEventsQuery.status).toBe(404)

    // approvals：bob → 404（且优先于"未知审批"——不泄露会话）
    const bobApproval = await fetch(`${loom!.base}/sessions/${aliceSessionId}/approvals/00000000-0000-0000-0000-000000000000`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...bearer(bobToken) }, body: JSON.stringify({ decision: 'allowed-once' }),
    })
    expect(bobApproval.status).toBe(404)
    expect(((await bobApproval.json()) as { error: string }).error).toBe('会话不存在')

    // fork：bob → 404
    const bobFork = await fetch(`${loom!.base}/sessions/${aliceSessionId}/fork`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...bearer(bobToken) }, body: JSON.stringify({}),
    })
    expect(bobFork.status).toBe(404)

    // alice 自己访问正常（SSE 头 + query 两法都通）
    const aliceEvents = await fetch(`${loom!.base}/agents/data-governance/sessions/${aliceSessionId}/events?since=-1&to=0`, {
      headers: bearer(aliceToken),
    })
    expect(aliceEvents.status).toBe(200)
    await aliceEvents.text()
    const aliceEventsQuery = await fetch(`${loom!.base}/agents/data-governance/sessions/${aliceSessionId}/events?since=-1&to=0&token=${encodeURIComponent(aliceToken)}`)
    expect(aliceEventsQuery.status).toBe(200)
    await aliceEventsQuery.text()
  })

  it('bob 有自己的会话；会话列表按归属过滤、互不可见', async () => {
    const bobCreate = await fetch(`${loom!.base}/agents/data-governance/sessions`, { method: 'POST', headers: bearer(bobToken) })
    expect(bobCreate.status).toBe(200)
    const bobSessionId = ((await bobCreate.json()) as { sessionId: string }).sessionId
    expect(bobSessionId).not.toBe(aliceSessionId)

    const aliceList = await (await fetch(`${loom!.base}/agents/data-governance/sessions`, { headers: bearer(aliceToken) })).json() as { sessions: Array<{ sessionId: string }> }
    const bobList = await (await fetch(`${loom!.base}/agents/data-governance/sessions`, { headers: bearer(bobToken) })).json() as { sessions: Array<{ sessionId: string }> }
    expect(aliceList.sessions.some(s => s.sessionId === bobSessionId)).toBe(false)
    expect(bobList.sessions.some(s => s.sessionId === bobSessionId)).toBe(true)
    expect(bobList.sessions.some(s => s.sessionId === aliceSessionId)).toBe(false)
    expect(aliceList.sessions.some(s => s.sessionId === aliceSessionId)).toBe(true)

    // alice 给自己的会话发消息成功（消息不经 LLM 完成也可投递——200 即受理）
    // （此处不发真实消息：无 key 环境也能跑完整隔离矩阵。）
  })
})

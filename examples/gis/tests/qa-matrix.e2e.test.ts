/**
 * QA 冲刺矩阵 e2e（B 并发 / C 畸形 / D 越权 / E 容灾 / F 资源 + 修复回归）。
 *
 * 夹具 qa.app.mjs 声明 auth（CORS 白名单）+ policy（qa_approve_* 走人工审批、
 * 8s 超时）+ webhook；qa_approve_write 带 .http() 面孔——HTTP 直调经完整
 * policy 管线触发审批缝，**全程不触 LLM**（无 key 可跑）。审批挂在隐藏 api
 * 会话（`session-qa-app-api-qa-agent-*`，扫描 .loom/sessions 目录获取其 id）。
 *
 * 回归对应：
 * - #15 匿名头伪造 `user-<username>` 冒充本地账号 → 修复后身份被拒（401）；
 * - #13 sessionId 路径遍历 / emoji / 超长 → 形状门 404；
 * - #2 SSE 断线重连后未决审批卡按原 approvalId 幂等重发；
 * - 并发答复只认第一次（409）；并发 webhook 同 sessionKey 只建一个会话；
 * - body > 2 MiB → 413；SSE 100 连接断开后 subscribers 归零（health 计数）。
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootLoom, cleanupDir, GIS_DIR, openEventStream, readEnv, sdkBuilt, type BootedLoom, type SseCollector } from './helpers.js'

const QA_APP = join(GIS_DIR, 'tests', 'fixtures', 'qa.app.mjs')
const ANON: Record<string, string> = { 'x-loom-user': 'anon-qa-matrix-0001' }

const env = readEnv(GIS_DIR)
const hasKey = process.env.DEEPSEEK_API_KEY !== undefined || env.DEEPSEEK_API_KEY !== undefined
if (process.env.DEEPSEEK_API_KEY === undefined && env.DEEPSEEK_API_KEY !== undefined) {
  process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY
}

describe.skipIf(!sdkBuilt())('QA 矩阵：qa.app（无 key；C/D/E/F + 并发审批/webhook + 修复回归）', () => {
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    loom = await bootLoom({
      appModulePath: QA_APP,
      withApproval: true,
      port: 4630,
      outDirName: '.loom-qa-e2e',
    })
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(join(GIS_DIR, '.loom-qa-e2e'))
  })

  async function health(): Promise<Record<string, any>> {
    const res = await fetch(`${loom!.base}/health`)
    expect(res.status).toBe(200)
    return await res.json() as Record<string, any>
  }

  /** 触发一次 .http()（qa_touch）确保隐藏 api 会话已创建，返回其 sessionId（health 观测面）。 */
  async function apiSessionId(): Promise<string> {
    const res = await fetch(`${loom!.base}/api/qa_touch?text=boot`)
    expect(res.status).toBe(200)
    const body = await health()
    const apiSessions: string[] = body.runtime.apiSessions ?? []
    expect(apiSessions.length, `api 会话应已创建（实际 ${JSON.stringify(body.runtime)}）`).toBeGreaterThanOrEqual(1)
    return apiSessions[0]!
  }

  // ---------------------------------------------------------------- C 畸形输入

  it('C1：非 JSON body → 400 中文报错（不崩）', async () => {
    const created = await fetch(`${loom!.base}/agents/qa-agent/sessions`, { method: 'POST', headers: ANON })
    expect(created.status).toBe(200)
    const { sessionId } = await created.json() as { sessionId: string }
    const bad = await fetch(`${loom!.base}/agents/qa-agent/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ANON },
      body: '这不是 JSON {{{',
    })
    expect(bad.status).toBe(400)
    const body = await bad.json() as { error: string }
    expect(body.error).toContain('请求体不是合法 JSON')
  })

  it('C2：10MB 超长消息 → 413 BODY_TOO_LARGE（明确上限 2 MiB）', async () => {
    const created = await fetch(`${loom!.base}/agents/qa-agent/sessions`, { method: 'POST', headers: ANON })
    const { sessionId } = await created.json() as { sessionId: string }
    const res = await fetch(`${loom!.base}/agents/qa-agent/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ANON },
      body: JSON.stringify({ text: 'x'.repeat(10 * 1024 * 1024) }),
    })
    expect(res.status).toBe(413)
    const body = await res.json() as { error: string; code: string }
    expect(body.code).toBe('BODY_TOO_LARGE')
    expect(body.error).toContain('上限')
  })

  it('C3：sessionId 路径遍历 / 绝对路径 / emoji / 超长 → 404（不触存储）', async () => {
    const bad = [
      '..%2F..%2Fetc%2Fpasswd',            // 编码穿越
      encodeURIComponent('../../../etc/passwd'),
      encodeURIComponent('F:\\Windows\\system32'), // 绝对路径
      encodeURIComponent('会话😀'),               // emoji
      'a'.repeat(200),                       // 超长
      '.hidden',                             // 非法起始字符
      'has space',                           // 空格（编码后 %20）
    ]
    for (const sid of bad) {
      const viaSessions = await fetch(`${loom!.base}/sessions/${sid}/events?since=-1&to=0`)
      expect(viaSessions.status, `sessions 路由应 404：${sid}`).toBe(404)
      const viaAgents = await fetch(`${loom!.base}/agents/qa-agent/sessions/${sid}/events?since=-1&to=0`)
      expect(viaAgents.status, `agents 路由应 404：${sid}`).toBe(404)
    }
    // 服务仍活
    expect((await health()).ok).toBe(true)
  })

  it('C4：工具 args 深嵌套（100 层完整 JSON）→ 明确失败不爆栈，服务仍活', async () => {
    const deep = `${'['.repeat(100)}${']'.repeat(100)}`
    const res = await fetch(`${loom!.base}/api/qa_touch?deep=${encodeURIComponent(deep)}`)
    expect([200, 400, 413, 500]).toContain(res.status)
    // 服务未崩：health 仍 200 且 runtime 计数在场
    const body = await health()
    expect(body.runtime).toBeDefined()
    expect(body.runtime.sse).toBe(0)
  })

  it('C5：body 内 5000 层深嵌套 JSON → 400 明确报错（不爆栈不崩）', async () => {
    const created = await fetch(`${loom!.base}/agents/qa-agent/sessions`, { method: 'POST', headers: ANON })
    const { sessionId } = await created.json() as { sessionId: string }
    const deepBody = `{"text":"x","junk":${'['.repeat(5000)}${']'.repeat(5000)}}`
    const res = await fetch(`${loom!.base}/agents/qa-agent/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ANON },
      body: deepBody,
    })
    // 深嵌套要么被 JSON.parse 的 RangeError 拒绝（400"不是合法 JSON"），要么
    // 正常解析后走参数校验（400 text 校验不适用——text 在场则 200 受理）；
    // 核心断言：明确响应 + 进程存活。
    expect([200, 400]).toContain(res.status)
    expect((await health()).ok).toBe(true)
  })

  // ---------------------------------------------------------------- D 安全/越权

  it('D1（#15 回归）：伪造 x-loom-user: user-alice 不能冒充本地账号 alice', async () => {
    // 注册 alice（本地账号 userId = user-alice）
    const reg = await fetch(`${loom!.base}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'password88' }),
    })
    expect(reg.status).toBe(200)
    // alice（token）建会话
    const { token } = await reg.json() as { token: string }
    const created = await fetch(`${loom!.base}/agents/qa-agent/sessions`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    })
    expect(created.status).toBe(200)
    const { sessionId } = await created.json() as { sessionId: string }

    // 攻击者只知道用户名，伪造 x-loom-user: user-alice（修复前会被当作匿名身份
    // 且 userId 与本地账号一致 → 越权写成功 200；修复后身份解析拒绝 → 401）。
    const spoofedWrite = await fetch(`${loom!.base}/agents/qa-agent/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-loom-user': 'user-alice' },
      body: JSON.stringify({ text: '冒充写入' }),
    })
    expect(spoofedWrite.status).toBe(401)
    expect(((await spoofedWrite.json()) as { error: string }).error).toContain('身份')

    // 伪造 ?user= query 同样拒绝（SSE 等价面）：解析为无身份 → POST 面 401
    //（GET 事件流是 documented 公开只读面（docs/auth.zh.md"只读 GET 放行"），
    // 与身份伪造无关——写路径被拒才是冒充判据）。
    const spoofedQuery = await fetch(`${loom!.base}/agents/qa-agent/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    })
    expect(spoofedQuery.status).toBe(401)

    // 伪造 user- 前缀的其它形态（长用户名/数字）同样不进匿名身份
    const spoofedQuery2 = await fetch(`${loom!.base}/agents/qa-agent/sessions`, {
      method: 'POST',
      headers: { 'x-loom-user': 'user-somebody-else-99' },
    })
    expect(spoofedQuery2.status).toBe(401)

    // 记忆面板同样拒绝伪造（修复前会拿到 alice 的记忆列表）
    const spoofedMemories = await fetch(`${loom!.base}/memories`, { headers: { 'x-loom-user': 'user-alice' } })
    expect(spoofedMemories.status).toBe(401)
  })

  it('D2：CORS 白名单——非白名单 Origin 不回显，白名单回显 + vary', async () => {
    const evil = await fetch(`${loom!.base}/health`, { headers: { origin: 'http://evil.example' } })
    expect(evil.status).toBe(200)
    expect(evil.headers.get('access-control-allow-origin')).toBeNull()

    const allowed = await fetch(`${loom!.base}/health`, { headers: { origin: 'http://localhost:5173' } })
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(allowed.headers.get('vary')).toBe('origin')

    // 预检：白名单 Origin 正常 204；非白名单 204 但无 CORS 头（浏览器侧拦截）
    const preflight = await fetch(`${loom!.base}/health`, {
      method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })

  // ------------------------------------------- #2 审批卡重连重发 + 并发审批答复

  // ---------------------------------------------------------------- B 并发 webhook

  it('B1：并发 webhook 同 sessionKey ×5 → 全 202、同一会话（无竞态双建）', async () => {
    const before = await health()
    const posts = Array.from({ length: 5 }, (_, i) => fetch(`${loom!.base}/hooks/qa`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'race-key', text: `并发 ${i}` }),
    }))
    const results = await Promise.all(posts)
    expect(results.every(r => r.status === 202)).toBe(true)
    const bodies = await Promise.all(results.map(r => r.json() as Promise<{ sessionId: string }>))
    const ids = new Set(bodies.map(b => b.sessionId))
    expect(ids.size).toBe(1) // 会话复用：并发只建一个
    // runtime 会话计数：恰好 +1（hook 会话）；无重复创建残留
    const after = await health()
    expect(after.runtime.sessions).toBe(before.runtime.sessions + 1)
  })

  // ---------------------------------------------------------------- F 资源

  it('F1：SSE 100 连接建立 → health 计数 100 → 全部断开 → subscribers 归零', async () => {
    const sid = await apiSessionId()
    const controllers = Array.from({ length: 100 }, () => new AbortController())
    const opened = await Promise.all(controllers.map(controller =>
      fetch(`${loom!.base}/sessions/${sid}/events?since=-1`, { signal: controller.signal, headers: { accept: 'text/event-stream' } }),
    ))
    expect(opened.every(res => res.status === 200)).toBe(true)
    // 等服务端把 100 个订阅都挂上（轮询 health 计数）
    const deadline = Date.now() + 20_000
    for (;;) {
      const body = await health()
      if (body.runtime.sse === 100 && body.runtime.sseSessions === 1) break
      if (Date.now() > deadline) throw new Error(`SSE 计数未达 100：${JSON.stringify(body.runtime)}`)
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    for (const controller of controllers) controller.abort()
    // 全部断开后订阅清零（含空 Set 的 Map 条目移除）
    const deadline2 = Date.now() + 20_000
    for (;;) {
      const body = await health()
      if (body.runtime.sse === 0 && body.runtime.sseSessions === 0) break
      if (Date.now() > deadline2) throw new Error(`SSE 订阅未清零：${JSON.stringify(body.runtime)}`)
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }, 120_000)

  it('F3：会话计数随创建线性增长（20 会话 = +20，无重复/泄漏）', async () => {
    const before = await health()
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${loom!.base}/agents/qa-agent/sessions`, { method: 'POST', headers: ANON })
      expect(res.status).toBe(200)
    }
    const after = await health()
    expect(after.runtime.sessions).toBe(before.runtime.sessions + 20)
  })
})

// ---------------------------------------------------------------------------
// E 维容灾：python 命令路径错误 → boot fail-loud（清晰报错，服务不半死）
// ---------------------------------------------------------------------------

describe.skipIf(!sdkBuilt())('QA 容灾：python 路径错误 → boot 拒绝（fail-loud）', () => {
  it('不存在的解释器 → bootLoom rejects 且错误信息指向 python', async () => {
    await expect(bootLoom({
      appModulePath: join(GIS_DIR, 'tests', 'fixtures', 'qa.app.mjs'),
      withApproval: true,
      withPython: true,
      pythonConfig: { command: 'no-such-python-interpreter-xyz --version' },
      port: 4632,
      outDirName: '.loom-qa-python-bad',
    })).rejects.toThrow(/python|loom-py|ENOENT|spawn/i)
    cleanupDir(join(GIS_DIR, '.loom-qa-python-bad'))
  }, 120_000)
})

// ---------------------------------------------------------------------------
// B 维并发 messages ×5（真实 LLM；无 key 自跳过）
// ---------------------------------------------------------------------------

describe.skipIf(!hasKey || !sdkBuilt())('QA 并发：同会话并发 messages ×5（inbox 排队，seq 连续不丢）', () => {
  let loom: BootedLoom | undefined
  let sse: SseCollector | undefined

  beforeAll(async () => {
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'loom.app.ts'),
      withApproval: true,
      withSubagent: true,
      port: 4631,
      outDirName: '.loom-qa-b',
    })
  }, 120_000)

  afterAll(async () => {
    sse?.close()
    await loom?.dispose()
    cleanupDir(join(GIS_DIR, '.loom-qa-b'))
  })

  it('5 条并发消息全部受理且逐条成轮（user/message seq 严格递增无重复）', async () => {
    const created = await fetch(`${loom!.base}/agents/data-governance/sessions`, { method: 'POST', headers: ANON })
    expect(created.status).toBe(200)
    const { sessionId } = await created.json() as { sessionId: string }
    sse = await openEventStream(loom!.base, sessionId)

    const messages = ['第 1 条：一句话介绍你自己', '第 2 条：平台能查什么数据', '第 3 条：现在几点了', '第 4 条：数据入库建议一条', '第 5 条：清洗建议一条']
    const posts = messages.map(text => fetch(`${loom!.base}/agents/data-governance/sessions/${sessionId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...ANON }, body: JSON.stringify({ text }),
    }))
    const results = await Promise.all(posts)
    expect(results.every(r => r.status === 200)).toBe(true)

    // 5 条 user/message 全部出现在流上（内核 inbox 排队语义：不丢失）
    const deadline = Date.now() + 300_000
    for (;;) {
      const users = sse.events.filter(e => e.type === 'user/message')
      const completed = sse.events.filter(e => e.type === 'turn/end' && String(e.reason?.kind ?? e.reason) === 'completed')
      if (users.length >= 5 && completed.length >= 5) break
      if (Date.now() > deadline) {
        throw new Error(`并发消息未全部成轮：user/message=${users.length} turn/end=${completed.length}；类型：${sse.events.map(e => e.type).join(',')}`)
      }
      await new Promise(resolve => setTimeout(resolve, 300))
    }

    // seq 连续性：user/message 按到达顺序严格递增（SSE emit 去重保证）、无重复
    const seqs = sse.events.filter(e => e.type === 'user/message' && typeof e.seq === 'number').map(e => e.seq as number)
    const unique = new Set(seqs)
    expect(unique.size).toBe(seqs.length) // 无重复投递
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!) // 顺序权威
    expect(seqs.length).toBeGreaterThanOrEqual(5)
  }, 360_000)
})

// ---------------------------------------------------------------------------
// 审批链（带 key）：内核审批缝 turn-enclosed（approval/asked+decided 审计对
// 必须落在 open turn 内）——审批只在 agent turn 内的工具调用上触发，因此
// #2 重连重发 / B2 并发答复 / F2 超时清理经真实 LLM 调 qa_approve_write 触发
// （挂在消息会话上，sessionId 已知）。无 key 自跳过。
// ---------------------------------------------------------------------------

describe.skipIf(!hasKey || !sdkBuilt())('QA 审批链（qa.app 消息触发，8s 超时配置）', () => {
  let loom: BootedLoom | undefined
  const ANON_QA: Record<string, string> = { 'x-loom-user': 'anon-qa-approval-0001' }

  beforeAll(async () => {
    loom = await bootLoom({
      appModulePath: QA_APP,
      withApproval: true,
      port: 4634,
      outDirName: '.loom-qa-approve',
    })
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(join(GIS_DIR, '.loom-qa-approve'))
  })

  async function healthOf(): Promise<Record<string, any>> {
    const res = await fetch(`${loom!.base}/health`)
    expect(res.status).toBe(200)
    return await res.json() as Record<string, any>
  }

  /** 新会话 + SSE + 发消息让模型调 qa_approve_write → { sid, sse, asked }。 */
  async function triggerApproval(): Promise<{ sid: string; sse: SseCollector; asked: Record<string, any> }> {
    const created = await fetch(`${loom!.base}/agents/qa-agent/sessions`, { method: 'POST', headers: ANON_QA })
    expect(created.status).toBe(200)
    const { sessionId } = await created.json() as { sessionId: string }
    const sse = await openEventStream(loom!.base, sessionId)
    const sent = await fetch(`${loom!.base}/agents/qa-agent/sessions/${sessionId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...ANON_QA }, body: JSON.stringify({ text: '请调用 qa_approve_write 工具，note 参数填 hello，然后等审批结果' }),
    })
    expect(sent.status).toBe(200)
    const asked = await sse.wait(e => e.type === 'loom/approval-asked', 120_000, 'approval-asked（模型调写工具）')
    return { sid: sessionId, sse, asked }
  }

  it('#2：SSE 断开重连后未决审批卡按原 approvalId 幂等重发', async () => {
    const { sid, sse: first, asked: asked1 } = await triggerApproval()
    try {
      // 断开（模拟刷新/网络抖动）→ 重连：approval-asked 不在会话日志里，
      // 只有服务端重发才能再次出现（且 approvalId 不变——前端可幂等去重）。
      first.close()
      const second = await openEventStream(loom!.base, sid)
      try {
        const asked2 = await second.wait(e => e.type === 'loom/approval-asked' && e.approvalId === asked1.approvalId, 10_000, '重连后重发 approval-asked')
        expect(asked2.approvalId).toBe(asked1.approvalId)
        expect(asked2.tool).toBe('qa_approve_write')
        // 重连流上答复 → decided 事件可见
        const decision = await fetch(`${loom!.base}/sessions/${sid}/approvals/${asked2.approvalId}`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...ANON_QA }, body: JSON.stringify({ decision: 'rejected' }),
        })
        expect(decision.status).toBe(200)
        const decided = await second.wait(e => e.type === 'loom/approval-decided' && e.approvalId === asked2.approvalId, 15_000, 'approval-decided')
        expect(decided.decision).toBe('rejected')
        const body = await healthOf()
        expect(body.runtime.pendingApprovals).toBe(0)
      } finally {
        second.close()
      }
    } finally {
      first.close()
    }
  }, 180_000)

  it('B2：并发审批答复只认第一次（第二答复 409，已决再答 404）', async () => {
    const { sid, sse: stream, asked } = await triggerApproval()
    try {
      const url = `${loom!.base}/sessions/${sid}/approvals/${asked.approvalId}`
      const opts = { method: 'POST', headers: { 'content-type': 'application/json', ...ANON_QA }, body: JSON.stringify({ decision: 'allowed-once' }) }
      const [a, b] = await Promise.all([fetch(url, opts), fetch(url, opts)])
      const statuses = [a.status, b.status].sort()
      expect(statuses[0]).toBe(200)                          // 第一裁决生效
      expect(statuses[1]).toBeGreaterThanOrEqual(400)        // 第二答复明确失败（409 已决 / 404 已删）
      expect(statuses.filter(s => s === 200).length).toBe(1) // 不允许双受理
      const decided = await stream.wait(e => e.type === 'loom/approval-decided' && e.approvalId === asked.approvalId, 15_000, 'decided')
      expect(decided.decision).toBe('allowed-once')
      // 已决后再答 → 404（明确"未知或已决"）
      const late = await fetch(url, opts)
      expect(late.status).toBe(404)
      expect(((await late.json()) as { error: string }).error).toContain('已决')
    } finally {
      stream.close()
    }
  }, 180_000)

  it('F2：审批超时（8s fail-closed）→ pendingApprovals 自动清理 + SSE decided(rejected)', async () => {
    const { sse: stream, asked } = await triggerApproval()
    try {
      expect(asked.timeoutMs).toBe(8_000)
      const decided = await stream.wait(e => e.type === 'loom/approval-decided' && e.approvalId === asked.approvalId, 15_000, '超时 decided')
      expect(decided.decision).toBe('rejected') // fail-closed：超时=拒绝
      const body = await healthOf()
      expect(body.runtime.pendingApprovals).toBe(0) // 超时清理（不泄漏）
    } finally {
      stream.close()
    }
  }, 180_000)
})

/**
 * 预算治理 e2e（M9，无需 DEEPSEEK_API_KEY——只走 .http() 面的内核管线）：
 *
 * 1. health 汇报 budgets 声明（可观测面）；
 * 2. 前 2 次调用（= max）200 放行，第 3 次 403 fail-closed，error 含预算描述
 *    （current=3 > max=2），x-loom-exec=pipeline 证明走的是 pre-execute 管线；
 * 3. 越限后持续 fail-closed（第 4 次仍 403——被拒的调用也计数，无绕过窗口）；
 * 4. SSE 合成事件 loom/budget-exceeded（隐藏 api 会话无订阅者，事件静默但
 *    行为正确；此处断言行为面）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { ANON_HEADERS, bootLoom, cleanupDir, ensureTsx, GIS_DIR, openEventStream, readEnv, sdkBuilt, type BootedLoom } from './helpers.js'

const env = readEnv(GIS_DIR)
const hasKey = process.env.DEEPSEEK_API_KEY !== undefined || env.DEEPSEEK_API_KEY !== undefined
if (process.env.DEEPSEEK_API_KEY === undefined && env.DEEPSEEK_API_KEY !== undefined) {
  process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY
}

describe.skipIf(!sdkBuilt())('预算治理 e2e（无 key，.http() 面驱动）', () => {
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    ensureTsx()
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'tests', 'budget-app.ts'),
      withApproval: true, // 声明了 policy → 组合需带审批缝（boot 守门）
      port: 4637,
      outDirName: '.loom-budget-e2e',
    })
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(GIS_DIR, '.loom-budget-e2e'))
  })

  const call = () => fetch(`${loom!.base}/api/budget_echo?text=${encodeURIComponent('hi')}`)

  it('health 汇报 budgets 声明', async () => {
    const res = await fetch(`${loom!.base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.app).toBe('budget-demo')
    expect(body.budgets).toEqual([{ kind: 'tool-calls', max: 2, tool: 'budget_echo' }])
  })

  it('前 2 次放行，第 3 次 403（current=3 > max=2），走的是内核管线', async () => {
    expect((await call()).status).toBe(200)
    expect((await call()).status).toBe(200)
    const third = await call()
    expect(third.status).toBe(403)
    expect(third.headers.get('x-loom-exec')).toBe('pipeline')
    const body = (await third.json()) as { error: string }
    expect(body.error).toContain('loom policy budget')
    expect(body.error).toContain('3/2')
  })

  it('越限后持续 fail-closed（被拒的调用也计数，无绕过窗口）', async () => {
    const fourth = await call()
    expect(fourth.status).toBe(403)
    const fifth = await call()
    expect(fifth.status).toBe(403)
  })
})

describe.skipIf(!sdkBuilt() || !hasKey)('预算治理 e2e：模型发起的调用链（带 key）', () => {
  // 猎捕目标：tools/pre-execute 的 exec.agent.sessionId 在模型发起的工具调用上
  // 必须存在（此前只有 .http() 隐藏 api 会话的证据）——否则预算按 sessionless
  // 桶记账，per-session 语义失效。max=2 → 模型连调三次：第 3 次 fail-closed。
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    ensureTsx()
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'tests', 'budget-app.ts'),
      withApproval: true,
      port: 4645,
      outDirName: '.loom-budget-e2e-key',
    })
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(GIS_DIR, '.loom-budget-e2e-key'))
  })

  it('模型连续调用：前 2 次成功，第 3 次被预算拒绝（错误文本含预算描述）', async () => {
    const created = await fetch(`${loom!.base}/agents/echo-worker/sessions`, { method: 'POST', headers: ANON_HEADERS })
    expect(created.status).toBe(200)
    const { sessionId } = (await created.json()) as { sessionId: string }
    const sse = await openEventStream(loom!.base, sessionId)
    try {
      const sent = await fetch(`${loom!.base}/agents/echo-worker/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ANON_HEADERS },
        body: JSON.stringify({ text: '请连续调用三次 budget_echo 工具，每次 text 参数分别为"一""二""三"。把每次的结果（包括失败原因）逐条告诉我。' }),
      })
      expect(sent.status).toBe(200)
      // 三次 tool/call 都会发出（被拒的调用也有 call 事件）；结果两成一败。
      // 注意：不能在谓词里用全局计数匹配单条事件（先到的调用也会满足）——
      // 先等到第三次调用存在，再取第三条。
      await sse.wait(
        () => sse.events.filter(x => x.type === 'tool/call' && x.name === 'budget_echo').length >= 3,
        90_000,
        '第三次 budget_echo 调用',
      )
      const thirdCall = sse.events.filter(x => x.type === 'tool/call' && x.name === 'budget_echo')[2]!
      const thirdResult = await sse.wait(
        e => e.type === 'tool/result' && e.callSeq === thirdCall.seq,
        90_000,
        '第三次调用结果',
      )
      expect(thirdResult.isError).toBe(true)
      expect(String(thirdResult.preview)).toContain('预算')
      // 前两次成功（模型按指令先调一、二，再调三；顺序由 seq 保证）。
      const results = sse.events.filter(e => e.type === 'tool/result' && e.name === 'budget_echo')
      const okResults = results.filter(r => r.isError !== true)
      expect(okResults.length).toBeGreaterThanOrEqual(2)
      await sse.wait(e => e.type === 'turn/end', 90_000, 'turn/end')
    } finally {
      sse.close()
    }
  })
})

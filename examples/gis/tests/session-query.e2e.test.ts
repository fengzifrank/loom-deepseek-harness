/**
 * B1.1 e2e：会话历史查询（消费内核官方件 dsh-session-query-sqlite +
 * dsh-tool-session-query）——模型面 session_search 工具真实可用的证据。
 *
 * 流程（带 key）：会话 A 先聊一个独特话题（"连河村耕地"）→ 会话 B 要求模型
 * 用 session_search 搜历史会话 → SSE 证据：tool/call name=session_search →
 * turn/end completed。
 * 无 key 段：健康检查 boot 即证明组合两行激活（sessionQuery 服务在位——
 * 缺服务 tool-session-query 激活会 fail-loud）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { bootLoom, cleanupDir, ensureTsx, GIS_DIR, openEventStream, readEnv, sdkBuilt, type BootedLoom } from './helpers.js'

const env = readEnv(GIS_DIR)
const hasKey = process.env.DEEPSEEK_API_KEY !== undefined || env.DEEPSEEK_API_KEY !== undefined
if (process.env.DEEPSEEK_API_KEY === undefined && env.DEEPSEEK_API_KEY !== undefined) {
  process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY
}

describe.skipIf(!sdkBuilt())('B1.1 session-query 组合（无 key：boot 即激活证据）', () => {
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    ensureTsx()
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'loom.app.ts'),
      withApproval: true,
      withSubagent: true,
      port: 4634,
      outDirName: '.loom-sq-e2e',
    })
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(join(GIS_DIR, '.loom-sq-e2e'))
  })

  it('组合激活（sessionQuery 服务在位，否则 tool-session-query 激活 fail-loud）+ 索引文件落 .loom', async () => {
    const res = await fetch(`${loom!.base}/health`)
    expect(res.status).toBe(200)
    // session-query-sqlite startup 打开索引文件
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(loom!.outDir, 'session-query.db'))).toBe(true)
  })
})

describe.skipIf(!hasKey || !sdkBuilt())('B1.1 session_search e2e（带 key：模型真实调用）', () => {
  let loom: BootedLoom | undefined
  const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })
  let token = ''

  beforeAll(async () => {
    ensureTsx()
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'loom.app.ts'),
      withApproval: true,
      withSubagent: true,
      port: 4635,
      outDirName: '.loom-sq-key-e2e',
    })
    const registered = await fetch(`${loom!.base}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'password88' }),
    })
    token = ((await registered.json()) as { token: string }).token
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(join(GIS_DIR, '.loom-sq-key-e2e'))
  })

  it('会话 A 聊独特话题 → 会话 B 调 session_search 找到历史', async () => {
    // 会话 A：留下可检索的历史（独特词"连河村耕地"）。
    const createdA = await fetch(`${loom!.base}/agents/data-analysis/sessions`, { method: 'POST', headers: bearer(token) })
    const { sessionId: sessionA } = (await createdA.json()) as { sessionId: string }
    const sseA = await openEventStream(loom!.base, sessionA)
    await fetch(`${loom!.base}/agents/data-analysis/sessions/${sessionA}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...bearer(token) },
      body: JSON.stringify({ text: '连河村的耕地面积是多少？查一下。' }),
    })
    await sseA.wait(e => e.type === 'turn/end' && String(e.reason?.kind ?? e.reason) === 'completed', 180_000, '会话 A turn/end completed')
    sseA.close()

    // 会话 B：要求模型用 session_search 检索历史（工具由 tool-session-query 全局注册）。
    const createdB = await fetch(`${loom!.base}/agents/data-analysis/sessions`, { method: 'POST', headers: bearer(token) })
    const { sessionId: sessionB } = (await createdB.json()) as { sessionId: string }
    const sseB = await openEventStream(loom!.base, sessionB)
    await fetch(`${loom!.base}/agents/data-analysis/sessions/${sessionB}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...bearer(token) },
      body: JSON.stringify({ text: '请使用 session_search 工具搜索历史会话里关于"连河村耕地"的讨论，告诉我搜索到了什么。不要调用其他工具。' }),
    })
    await sseB.wait(
      e => e.type === 'tool/call' && e.name === 'session_search',
      180_000,
      'tool/call session_search',
    )
    await sseB.wait(e => e.type === 'turn/end' && String(e.reason?.kind ?? e.reason) === 'completed', 180_000, '会话 B turn/end completed')
    // 结果非错误（授权 cwd 一致——同应用会话互相可见）
    const results = sseB.events.filter(e => e.type === 'tool/result' && e.name === 'session_search')
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(r => r.isError !== true)).toBe(true)
    sseB.close()
  }, 420_000)
})

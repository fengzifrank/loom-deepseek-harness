/**
 * 模型网关 e2e（M11，不需要 DEEPSEEK_API_KEY）：
 *
 * 1. 测试进程内起一个 mock OpenAI 兼容服务器（openai-completions 流式协议）；
 * 2. fixture 应用 provider 'openai-compatible' 指向 mock（env 注入端点）；
 * 3. boot → 创建会话 → 发一条消息 → SSE 收到 assistant/message 文本；
 * 4. 断言 mock 真的收到了 chat/completions 请求且 model = 'mock-model'——
 *    证明 dsh-llm-pi-ai 组合/路由/协议适配端到端成立；
 * 5. 组合文件里没有 llm-deepseek / DEEPSEEK_API_KEY（官方行被替换）。
 */
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import {
  ANON_HEADERS, bootLoom, cleanupDir, ensureTsx, GIS_DIR, openEventStream, sdkBuilt, type BootedLoom,
} from './helpers.js'

interface CapturedRequest {
  path: string
  body: Record<string, any>
}

describe.skipIf(!sdkBuilt())('模型网关 e2e（mock OpenAI 兼容端点）', () => {
  let mock: Server | undefined
  let mockPort = 0
  const captured: CapturedRequest[] = []
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    ensureTsx()
    // 1) mock OpenAI 兼容服务器：POST /v1/chat/completions → openai-completions 流式协议。
    mock = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        let body: Record<string, any> = {}
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* 忽略 */ }
        captured.push({ path: req.url ?? '', body })
        // SSE 分块必须 res.write（res.end 会提前关流，pi-ai 客户端视为截断重试）。
        const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const head = { id: 'mock-1', object: 'chat.completion.chunk', created: 0, model: body.model ?? 'mock-model' }
        send({ ...head, choices: [{ index: 0, delta: { role: 'assistant', content: '你好，我是网关 mock 模型。' }, finish_reason: null }] })
        send({ ...head, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
    await new Promise<void>(done => mock!.listen(0, '127.0.0.1', done))
    mockPort = (mock!.address() as { port: number }).port
    process.env.LOOM_GW_MOCK_URL = `http://127.0.0.1:${mockPort}/v1`

    // 2) boot fixture 应用（组合会生成 llm-pi-ai 行；不再有 llm-deepseek）。
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'tests', 'gateway-app.ts'),
      withApproval: false,
      port: 4639,
      outDirName: '.loom-gateway-e2e',
    })
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    await new Promise<void>(done => mock?.close(() => done()))
    cleanupDir(resolve(GIS_DIR, '.loom-gateway-e2e'))
  })

  it('组合文件：llm-pi-ai 在、llm-deepseek 与 DEEPSEEK_API_KEY 不在', () => {
    const yml = readFileSync(resolve(GIS_DIR, '.loom-gateway-e2e', 'cordis.yml'), 'utf8')
    expect(yml).toContain("'@deepseek-ai/dsh-llm-pi-ai'")
    expect(yml).not.toContain('llm-deepseek')
    expect(yml).not.toContain('DEEPSEEK_API_KEY')
    expect(yml).toContain('provider: openai-compatible')
    expect(yml).toContain(`http://127.0.0.1:${mockPort}/v1`)
  })

  it('health 200（应用在 mock 网关上启动）', async () => {
    const res = await fetch(`${loom!.base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.app).toBe('gateway-demo')
    expect(body.model).toBe('mock-model')
  })

  it('一轮对话经 mock 网关返回文本，且 mock 收到 chat/completions（model=mock-model）', async () => {
    const created = await fetch(`${loom!.base}/agents/talker/sessions`, { method: 'POST', headers: ANON_HEADERS })
    expect(created.status).toBe(200)
    const { sessionId } = (await created.json()) as { sessionId: string }
    const sse = await openEventStream(loom!.base, sessionId)
    try {
      const sent = await fetch(`${loom!.base}/agents/talker/sessions/${sessionId}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...ANON_HEADERS }, body: JSON.stringify({ text: '你好' }),
      })
      expect(sent.status).toBe(200)
      const message = await sse.wait(e => e.type === 'assistant/message', 30_000, 'assistant/message')
      expect(String(message.text)).toContain('网关 mock 模型')
      const hit = captured.find(req => req.path.includes('/chat/completions'))
      expect(hit).toBeDefined()
      expect(hit!.body.model).toBe('mock-model')
    } finally {
      sse.close()
    }
  })
})

/**
 * MCP 桥接 e2e（M10）：
 *
 * 无 key 段（永远可跑）：
 * 1. 组合文件包含 mcp-echo 行（stdio + failOnStartupError）；
 * 2. boot 成功 = 连接 + 工具发现 + 注册全部完成（failOnStartupError: true 时失败会
 *    拒绝插件激活）——dsh-mcp-client 的命名约定工具 mcp__echo__say 已进全局工具层；
 * 3. health 200。
 *
 * 带 key 段（学 approval-chain 约定无 key 自跳过）：
 * 4. 驱动真实模型轮次调用 mcp__echo__say → SSE tool/call + tool/result 含 "echo:"。
 */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import {
  ANON_HEADERS, bootLoom, cleanupDir, ensureTsx, GIS_DIR, openEventStream, readEnv, sdkBuilt, type BootedLoom,
} from './helpers.js'

const env = readEnv(GIS_DIR)
const hasKey = process.env.DEEPSEEK_API_KEY !== undefined || env.DEEPSEEK_API_KEY !== undefined
if (process.env.DEEPSEEK_API_KEY === undefined && env.DEEPSEEK_API_KEY !== undefined) {
  process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY
}

describe.skipIf(!sdkBuilt())('MCP 桥接 e2e：本地 stdio echo 服务器', () => {
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    ensureTsx()
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'tests', 'mcp-app.ts'),
      withApproval: false,
      port: 4642,
      outDirName: '.loom-mcp-e2e',
    })
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(GIS_DIR, '.loom-mcp-e2e'))
  })

  it('组合文件包含 mcp-echo 行（stdio 传输）', () => {
    const yml = readFileSync(resolve(GIS_DIR, '.loom-mcp-e2e', 'cordis.yml'), 'utf8')
    expect(yml).toContain('- id: mcp-echo')
    expect(yml).toContain("name: '@deepseek-ai/dsh-mcp-client'")
    expect(yml).toContain('serverName: "echo"')
    expect(yml).toContain('transport: stdio')
    expect(yml).toContain('failOnStartupError: true')
  })

  it('boot 成功 = 连接 + 工具发现 + 注册完成（failOnStartupError 门）', () => {
    // beforeAll 已 boot 成功；dsh-mcp-client 连接失败会拒绝激活 → boot 抛错。
    expect(loom).toBeDefined()
  })

  it('health 200', async () => {
    const res = await fetch(`${loom!.base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.app).toBe('mcp-demo')
  })
})

describe.skipIf(!sdkBuilt() || !hasKey)('MCP 桥接 e2e：真实模型调用 mcp__echo__say（带 key）', () => {
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    ensureTsx()
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'tests', 'mcp-app.ts'),
      withApproval: false,
      port: 4643,
      outDirName: '.loom-mcp-e2e-key',
    })
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(GIS_DIR, '.loom-mcp-e2e-key'))
  })

  it('模型经全局工具层调用 echo 服务器', async () => {
    const created = await fetch(`${loom!.base}/agents/caller/sessions`, { method: 'POST', headers: ANON_HEADERS })
    const { sessionId } = (await created.json()) as { sessionId: string }
    const sse = await openEventStream(loom!.base, sessionId)
    try {
      const sent = await fetch(`${loom!.base}/agents/caller/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ANON_HEADERS },
        body: JSON.stringify({ text: '调用工具 mcp__echo__say，参数 text 设为"你好"，然后一句话确认。' }),
      })
      expect(sent.status).toBe(200)
      const call = await sse.wait(e => e.type === 'tool/call' && e.name === 'mcp__echo__say', 60_000, 'mcp__echo__say 调用')
      expect(call.args?.text).toBe('你好')
      const result = await sse.wait(
        e => e.type === 'tool/result' && e.callSeq === call.seq,
        60_000,
        'echo 工具结果',
      )
      expect(result.isError).toBeFalsy()
      expect(String(result.preview)).toContain('echo: 你好')
      await sse.wait(e => e.type === 'turn/end', 60_000, 'turn/end')
    } finally {
      sse.close()
    }
  })
})

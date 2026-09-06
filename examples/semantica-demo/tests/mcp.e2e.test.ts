/**
 * MCP 变体 e2e（零代码路径）：loom.mcp-app.ts → python -m semantica.mcp_server。
 *
 * 无 key：boot 成功 = MCP 连接 + 工具发现 + 注册完成（failOnStartupError 门：
 * 任一步失败都会拒绝插件激活）；组合文件含 mcp-semantica 行与 SEMANTICA_KG_PATH；
 * health 200。带 key 的模型调用链已由 gis 的 mcp.e2e 证明同机制，这里不重复。
 */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { bootLoom, cleanupDir, sdkBuilt, semanticaReady, SEM_DIR, type BootedLoom } from './helpers.js'

const ready = sdkBuilt() && semanticaReady()

describe.skipIf(!ready)('semantica MCP 变体 e2e：零代码接入（无 key）', () => {
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    loom = await bootLoom({
      appModulePath: join(SEM_DIR, 'loom.mcp-app.ts'),
      withApproval: true, // policy 声明 → 审批缝
      port: 4653,
      outDirName: '.loom-mcp-e2e',
    })
  }, 180_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(SEM_DIR, '.loom-mcp-e2e'))
  })

  it('组合文件：mcp-semantica 行 + stdio + KG 路径独立于桥路径', () => {
    const yml = readFileSync(resolve(SEM_DIR, '.loom-mcp-e2e', 'cordis.yml'), 'utf8')
    expect(yml).toContain('- id: mcp-semantica')
    expect(yml).toContain("name: '@deepseek-ai/dsh-mcp-client'")
    expect(yml).toContain('transport: stdio')
    expect(yml).toContain('graph-mcp.json') // MCP 变体自己的 KG 文件（单写者原则）
    expect(yml).toContain('failOnStartupError: true')
  })

  it('boot 成功 = 连接/发现/注册完成；health 200 且预算已声明', async () => {
    const res = await fetch(`${loom!.base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.app).toBe('semantica-mcp-demo')
    expect(body.budgets).toEqual([{ kind: 'tool-calls', max: 20 }])
  })
})

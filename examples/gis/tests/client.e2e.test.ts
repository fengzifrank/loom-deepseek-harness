/**
 * 类型化客户端 e2e（M4；需要 DEEPSEEK_API_KEY 场景下 boot 真实服务，无 key 自跳过）：
 *
 * 用 `loom client` 生成物（src/loom.client.ts，快照与生成器逐字节一致）直调真实
 * HTTP 端点，验证：
 * 1. loomTools.gis_query_land_types({ region: '连河村' }) → 真实数据
 *    totalAreaSqm = 57351531.17（.http() 经内核管线执行）；
 * 2. loomSessions 会话客户端：createSession 的 agent id 是字面量联合（编译期已
 *    保证），streamEvents 的 AsyncIterable 能读到该会话的事件流（SSE 解析）。
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ANON_HEADERS, bootLoom, cleanupDir, ensureTsx, GIS_DIR, readEnv, sdkBuilt, type BootedLoom } from './helpers.js'
import { configureLoomClient, loomSessions, loomTools } from '../src/loom.client.js'

const env = readEnv(GIS_DIR)
const hasKey = process.env.DEEPSEEK_API_KEY !== undefined || env.DEEPSEEK_API_KEY !== undefined
if (process.env.DEEPSEEK_API_KEY === undefined && env.DEEPSEEK_API_KEY !== undefined) {
  process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY
}

describe.skipIf(!hasKey || !sdkBuilt())('类型化客户端 e2e（生成物直调真实端点）', () => {
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    ensureTsx()
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'loom.app.ts'),
      withApproval: true,
      withSubagent: true,
      port: 4625,
      outDirName: '.loom-client-e2e',
    })
    configureLoomClient({ baseUrl: loom.base, headers: ANON_HEADERS })
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(join(GIS_DIR, '.loom-client-e2e'))
  })

  it('loomTools.gis_query_land_types：生成物类型化直调返回真实数据', async () => {
    const result = await loomTools.gis_query_land_types({ region: '连河村' })
    // 类型即断言：result 的形状来自 InferToolOutput（编译期），值来自真实端点。
    const total: number = result.totalAreaSqm
    const first = result.items[0]!
    expect(total).toBeCloseTo(57351531.17, 2)
    expect(first.village).toContain('连河村')
    expect(first.landType).toBe('耕地')
    expect(typeof result.queriedAt).toBe('string')
  })

  it('loomTools：省略可选参数与 init 透传也可用', async () => {
    const all = await loomTools.gis_query_land_types({}, { headers: { 'x-test': 'loom-client-e2e' } })
    expect(all.items.length).toBeGreaterThanOrEqual(8)
    expect(all.totalAreaSqm).toBeGreaterThan(0)
  })

  it('loomSessions：createSession 字面量联合 agent id + sendMessage + streamEvents AsyncIterable', async () => {
    const { sessionId, agentId } = await loomSessions.createSession('data-governance')
    expect(agentId).toBe('data-governance')
    expect(sessionId).toMatch(/^session-gis-platform-/)

    // 先开事件流（AsyncIterable），再发消息——SSE 解析出的类型序列应覆盖一个完整 turn。
    const controller = new AbortController()
    const types: string[] = []
    const iterating = (async () => {
      for await (const event of loomSessions.streamEvents('data-governance', sessionId, { signal: controller.signal })) {
        types.push(String(event.type))
        if (event.type === 'turn/end') break
      }
    })()
    await loomSessions.sendMessage('data-governance', sessionId, '用一句话介绍你能帮用户做什么，不要调用工具。')
    await iterating
    controller.abort()

    expect(types).toContain('turn/start')
    expect(types).toContain('user/message')
    expect(types.filter(type => type === 'turn/end').length).toBeGreaterThanOrEqual(1)
  }, 180_000)
})

/**
 * M6 Python 工具桥真实 e2e（需要 DEEPSEEK_API_KEY + Python 3.10+；缺任一自跳过）：
 *
 * boot gis（含 python-bridge，配置取自 loom.app.ts 的 app.python 声明）→
 * health 含 pythonTools: 2（且 Python 工具不进 tools 列表）→
 * 发消息「用 Python 工具统计各村占比的均值和标准差」→ SSE 证据链：
 * tool/call gis_area_stats → tool/result（Python 算出的数字：均值 5.31/标准差 3.83）
 * → turn/end completed → assistant 文本含具体数字。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ANON_HEADERS, bootLoom, cleanupDir, ensureTsx, GIS_DIR, openEventStream, readEnv, sdkBuilt, type BootedLoom, type SseCollector,
} from './helpers.js'

const DATA_PATH = join(GIS_DIR, 'data', 'land-types.json')

const env = readEnv(GIS_DIR)
const hasKey = process.env.DEEPSEEK_API_KEY !== undefined || env.DEEPSEEK_API_KEY !== undefined
if (process.env.DEEPSEEK_API_KEY === undefined && env.DEEPSEEK_API_KEY !== undefined) {
  process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY
}

/** Python 探测（与 packages/web/test/python-env.ts 同法；这里独立内联）。 */
function detectPython(): string | undefined {
  const candidates = process.env.LOOM_TEST_PYTHON ? [process.env.LOOM_TEST_PYTHON] : ['python', 'python3', 'py']
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 })
    if (result.status === 0) return candidate
  }
  return undefined
}
const PYTHON = detectPython()

const STATS_MESSAGE = '用 Python 工具统计各村占比的均值和标准差'

describe.skipIf(!hasKey || !sdkBuilt() || PYTHON === undefined)('M6 Python 工具桥 e2e（带 key + python）', () => {
  let loom: BootedLoom | undefined
  let originalData: string

  beforeAll(async () => {
    ensureTsx()
    originalData = readFileSync(DATA_PATH, 'utf8')
    // python 配置取自 loom.app.ts 的 app.python 声明（单一事实源——含 LOOM_PYTHON 覆盖）。
    const mod = (await import(pathToFileURL(join(GIS_DIR, 'loom.app.ts')).href)) as {
      default: { spec: { python?: { command: string; cwd?: string; env?: Record<string, string>; restartLimit?: number; callTimeoutMs?: number } } }
    }
    const python = mod.default.spec.python
    expect(python).toBeDefined()
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'loom.app.ts'),
      withApproval: true,
      withSubagent: true,
      withPython: true,
      pythonConfig: python,
      port: 4626,
      outDirName: '.loom-m6-e2e',
    })
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(GIS_DIR, '.loom-m6-e2e'))
    if (originalData !== undefined) writeFileSync(DATA_PATH, originalData, 'utf8')
  })

  it('health 含 pythonTools 计数（Python 工具不进 tools 列表）', async () => {
    const res = await fetch(`${loom!.base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.pythonTools).toBe(2)
    expect(body.tools).not.toContain('gis_area_stats')
    expect(body.tools).not.toContain('gis_rank_change')
  })

  it('消息 → tool/call(gis_area_stats) → tool/result(Python 数字) → turn/end completed → 文本含数字', async () => {
    const created = await fetch(`${loom!.base}/agents/data-analysis/sessions`, { method: 'POST', headers: ANON_HEADERS })
    expect(created.status).toBe(200)
    const { sessionId } = (await created.json()) as { sessionId: string }
    const sse = await openEventStream(loom!.base, sessionId)
    try {
      const sent = await fetch(`${loom!.base}/agents/data-analysis/sessions/${sessionId}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...ANON_HEADERS }, body: JSON.stringify({ text: STATS_MESSAGE }),
      })
      expect(sent.status).toBe(200)

      // ① tool/call gis_area_stats（模型选择 Python 工具）
      const call = await sse.wait(e => e.type === 'tool/call' && e.name === 'gis_area_stats', 120_000, 'tool/call(gis_area_stats)')
      expect(typeof call.seq).toBe('number')

      // ② tool/result：Python 算出的真实数字（8 村、均值 5.31、标准差 3.83、最大村连河村）
      const result = await sse.wait(
        e => e.type === 'tool/result' && e.callSeq === call.seq && !e.isError,
        60_000,
        'tool/result(gis_area_stats)',
      )
      const value = result.value as Record<string, any> | undefined
      if (value !== undefined) {
        expect(value.villages).toBe(8)
        expect(value.meanRatioPct).toBeCloseTo(5.31, 2)
        expect(value.stdRatioPct).toBeCloseTo(3.83, 2)
        expect(value.topVillage).toBe('连河村')
      } else {
        // 长 render 被截断时退而断言 preview 前缀里的字段名
        expect(String(result.preview ?? '')).toContain('meanRatioPct')
      }

      // ③ turn/end completed
      const end = await sse.wait(
        e => e.type === 'turn/end' && (e as any).reason?.kind === 'completed',
        180_000,
        'turn/end completed',
      )
      expect(end.seq).toBeGreaterThan(result.seq)

      // ④ assistant 文本含 Python 算出的数字（5.31 均值 / 3.83 标准差）
      const message = await sse.wait(
        e => e.type === 'assistant/message' && typeof e.text === 'string' && (e.text.includes('5.31') || e.text.includes('3.83')),
        30_000,
        'assistant 文本含 Python 数字',
      )
      expect(String(message.text)).toMatch(/5\.31|3\.83/)
    } finally {
      sse.close()
    }
  }, 300_000)
})

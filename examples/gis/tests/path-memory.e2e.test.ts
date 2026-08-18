/**
 * M8 e2e：path memory（路径记忆）全链证据。
 *
 * 触发方式说明（计划要求"选最稳的触发方式并说明"）：turn/end error 的最稳
 * 制造法是**把 DEEPSEEK_API_KEY 临时置为无效值**——dsh-llm-deepseek 的
 * apiKeyEnv 每请求解析环境变量，无效 key → 401 → turn/end {kind:'error'}
 * 必现且快速（不依赖模型行为）；恢复真实 key 后下一轮即可正常 completed。
 * 这正好串起全链：失败 turn → 路径召回注入 → 下一轮 completed → 重验回写。
 *
 * 无 key 段（始终可跑）：
 * 1. 预置 path 记忆 → 发消息（无 key，turn 必然 error）→ SSE 出现
 *    loom/path-recall 合成事件（preview 含"待重验路径"文案）；
 * 2. 再发一条 flush 注入进日志（inject 在下个 pre-step 落日志）→ 会话日志
 *    出现 form:'recall' 且含"待重验路径"；同时这一轮 error 结算重验失败 →
 *    confidence ×0.5（0.8 → 0.4）。
 *
 * 带 key 段（完整闭环）：
 * 3. 无效 key 起失败 turn → 注入 → 恢复真 key → 下一轮 completed →
 *    重验成功回写：confidence 0.8 → 0.9、verified_at 刷新。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryStore, toolSequenceSignature } from '@loom-sdk/web'
import { bootLoom, cleanupDir, ensureTsx, GIS_DIR, openEventStream, readEnv, sdkBuilt, type BootedLoom } from './helpers.js'

const env = readEnv(GIS_DIR)
const REAL_KEY = process.env.DEEPSEEK_API_KEY ?? env.DEEPSEEK_API_KEY
const hasKey = REAL_KEY !== undefined

/** 预置路径记忆的种子（confidence 0.8：留出 +0.1 的可见上升空间）。 */
const SEED = {
  goal: '对比各村地类占比',
  content: '查询各村地类占比：gis_query_land_types(region) → gis_render_pie_chart(title, items)；region 取用户指定村（缺省全镇）；结局：已完成',
  signature: toolSequenceSignature([
    { name: 'gis_query_land_types', args: { region: '' } },
    { name: 'gis_render_pie_chart', args: { title: '', items: [] } },
  ]),
  confidence: 0.8,
}

/** 读会话的原始持久化日志（recall 注入不走 SSE 白名单，落日志可查）。 */
function sessionLogText(outDir: string, sessionId: string): string {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
  for (const file of walk(join(outDir, 'sessions'))) {
    if (file.includes(sessionId)) return readFileSync(file, 'utf8')
  }
  return ''
}

/** 向 store 预置一条已验证 path 记忆（当天 verified_at）。 */
function seedPath(store: MemoryStore, userId: string): string {
  const record = store.upsertPath({
    userId,
    content: SEED.content,
    signature: SEED.signature,
    outcome: 'completed',
  })
  // upsertPath completed 给 confidence 1.0——改回 0.8 留上升空间（直接 SQL 免 API 噪声）。
  store.markPathsFailed([record.id], userId) // 1.0 → 0.5
  store.markPathsVerified([record.id], userId) // 0.5 → 0.6
  store.markPathsVerified([record.id], userId) // 0.6 → 0.7
  store.markPathsVerified([record.id], userId) // 0.7 → 0.8
  return record.id
}

async function registerAlice(base: string): Promise<string> {
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'password88' }),
  })
  return ((await res.json()) as { token: string }).token
}

async function createSession(base: string, token: string): Promise<string> {
  const res = await fetch(`${base}/agents/data-analysis/sessions`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  expect(res.status).toBe(200)
  return ((await res.json()) as { sessionId: string }).sessionId
}

async function sendMessage(base: string, token: string, sessionId: string, text: string): Promise<void> {
  const res = await fetch(`${base}/agents/data-analysis/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ text }),
  })
  expect(res.status).toBe(200)
}

describe.skipIf(!sdkBuilt())('M8 path memory e2e（失败触发注入 + 重验失败回写；无效 key 强制 error turn，无需真 key）', () => {
  let loom: BootedLoom | undefined
  let store: MemoryStore | undefined
  let savedKey: string | undefined

  beforeAll(async () => {
    ensureTsx()
    // 确定性失败触发：显式置无效 key（不依赖环境是否恰好无 key）——
    // apiKeyEnv 每请求解析，401 → turn/end error 必现。
    savedKey = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = 'loom-m8-invalid-key'
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'loom.app.ts'),
      withApproval: true,
      withSubagent: true,
      port: 4631,
      outDirName: '.loom-path-e2e',
    })
    store = new MemoryStore(join(loom!.outDir, 'memory.db'))
  }, 120_000)

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = savedKey
    store?.close()
    await loom?.dispose()
    cleanupDir(join(GIS_DIR, '.loom-path-e2e'))
  })

  it('健康检查汇报 paths 窄门控（data-analysis 开路径记忆）', async () => {
    const res = await fetch(`${loom!.base}/health`)
    const body = (await res.json()) as Record<string, any>
    expect(body.memory).toMatchObject({ extraction: true, recall: true, agents: ['data-analysis'], paths: ['data-analysis'] })
  })

  it('失败 turn → SSE loom/path-recall（含"待重验路径"）→ 重验失败 confidence 0.8→0.4 → 日志见注入框', async () => {
    const token = await registerAlice(loom!.base)
    const pathId = seedPath(store!, 'user-alice')
    expect(store!.get(pathId)!.confidence).toBeCloseTo(0.8, 10)

    const sessionId = await createSession(loom!.base, token)
    const sse = await openEventStream(loom!.base, sessionId)
    // 无效 key：turn 必然 error → 失败触发路径检索注入（同用户、FTS 命中种子路径）。
    await sendMessage(loom!.base, token, sessionId, SEED.goal)
    const recallEvent = await sse.wait(e => e.type === 'loom/path-recall', 60_000, 'loom/path-recall 合成事件')
    expect(String(recallEvent.preview)).toContain('待重验路径')
    expect(String(recallEvent.preview)).toContain('以下为历史成功路径，重验后才可复用')
    expect((recallEvent.paths as Array<{ id: string }>).some(p => p.id === pathId)).toBe(true)

    // 再发一条：注入在下个 pre-step 落日志；本轮仍 error → 结算重验失败（×0.5）。
    await sendMessage(loom!.base, token, sessionId, '继续')
    await sse.wait(
      e => e.type === 'turn/end' && e.seq > 0 && String(e.reason?.kind ?? e.reason) === 'error' && Math.abs(store!.get(pathId)!.confidence - 0.4) < 1e-9,
      60_000,
      '第二轮 error + 重验失败回写（confidence 0.4）',
    )
    expect(store!.get(pathId)!.confidence).toBeCloseTo(0.4, 10) // 0.8 × 0.5
    expect(store!.get(pathId)!.active).toBe(true) // 0.4 ≥ 0.3 不软删

    // 日志证据：form:'recall' 注入 + 待重验框文案 + 种子内容。
    const deadline = Date.now() + 20_000
    for (;;) {
      const log = sessionLogText(loom!.outDir, sessionId)
      if (log.includes('"form":"recall"') && log.includes('待重验路径')) break
      if (Date.now() > deadline) throw new Error(`未在会话日志找到待重验路径注入；片段：${log.slice(0, 400)}`)
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    const log = sessionLogText(loom!.outDir, sessionId)
    expect(log).toContain('"plugin":"loom-memory"')
    expect(log).toContain('gis_query_land_types')
    sse.close()
  }, 180_000)
})

describe.skipIf(!hasKey || !sdkBuilt())('M8 path memory 闭环 e2e（带 key：注入 → 重验成功 → confidence 上升）', () => {
  let loom: BootedLoom | undefined
  let store: MemoryStore | undefined

  beforeAll(async () => {
    ensureTsx()
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'loom.app.ts'),
      withApproval: true,
      withSubagent: true,
      port: 4632,
      outDirName: '.loom-path-key-e2e',
    })
    store = new MemoryStore(join(loom!.outDir, 'memory.db'))
  }, 120_000)

  afterAll(async () => {
    store?.close()
    await loom?.dispose()
    cleanupDir(join(GIS_DIR, '.loom-path-key-e2e'))
  })

  it('失败（无效 key）→ 待重验路径注入 → 恢复 key 后 completed → 重验成功回写（0.8→0.9 + verified_at 刷新）', async () => {
    const token = await registerAlice(loom!.base)
    const pathId = seedPath(store!, 'user-alice')
    const seededAt = store!.get(pathId)!.verifiedAt
    expect(seededAt).not.toBeNull()
    expect(store!.get(pathId)!.confidence).toBeCloseTo(0.8, 10)

    const sessionId = await createSession(loom!.base, token)
    const sse = await openEventStream(loom!.base, sessionId)

    // ① 无效 key 制造 error turn（apiKeyEnv 每请求解析——只影响本进程后续请求）。
    process.env.DEEPSEEK_API_KEY = 'loom-m8-invalid-key'
    try {
      await sendMessage(loom!.base, token, sessionId, SEED.goal)
      const recallEvent = await sse.wait(e => e.type === 'loom/path-recall', 90_000, 'loom/path-recall 合成事件')
      expect(String(recallEvent.preview)).toContain('待重验路径')
    } finally {
      process.env.DEEPSEEK_API_KEY = REAL_KEY! // ② 恢复真 key：下一轮正常 completed
    }

    // ③ 下一轮：模型见到待重验路径注入（prompt 要求先重跑只读步骤），completed 后结算重验成功。
    await sendMessage(loom!.base, token, sessionId, `${SEED.goal}，给出饼图`)
    await sse.wait(
      e => e.type === 'turn/end' && String(e.reason?.kind ?? e.reason) === 'completed',
      180_000,
      'turn/end completed（重验轮）',
    )
    // 结算在 turn/end 事件处理内同步完成；轮询兜底事件序。
    const deadline = Date.now() + 15_000
    for (;;) {
      const record = store!.get(pathId)!
      if (record.confidence > 0.85 && record.verifiedAt !== seededAt) break
      if (Date.now() > deadline) {
        throw new Error(`重验成功回写未生效：${JSON.stringify({ confidence: record.confidence, verifiedAt: record.verifiedAt, seededAt })}`)
      }
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    const record = store!.get(pathId)!
    expect(record.confidence).toBeCloseTo(0.9, 10) // 0.8 + 0.1
    expect(record.verifiedAt).not.toBe(seededAt)
    expect(new Date(record.verifiedAt!).getTime()).toBeGreaterThan(new Date(seededAt!).getTime())

    // SSE 全链旁证：重验轮真实调用了只读工具（persona 与注入框均要求先重跑查询）。
    const called = sse.events.filter(e => e.type === 'tool/call').map(e => String(e.name))
    expect(called).toContain('gis_query_land_types')
    sse.close()
  }, 360_000)
})

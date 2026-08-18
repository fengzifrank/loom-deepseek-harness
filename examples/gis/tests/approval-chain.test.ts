/**
 * 真实审批链 e2e（需要 DEEPSEEK_API_KEY；学 harness test:e2e 约定无 key 自跳过）：
 *
 * 1. 允许路径：发"给连河村加备注：重点耕地保护区" → tool/call(gis_update_land_note)
 *    → SSE loom/approval-asked → POST allowed-once → tool/result 成功 → turn/end completed
 *    → land-types.json 的连河村 note 真实变更（diff 证据）。
 * 2. 拒绝路径：再次触发 → POST rejected → 工具失败（错误结果含 rejected）→ 文件未变。
 * 3. 回放：GET events?to=<turn/end seq> 有界读取；fork atSeq 前缀一致；
 *    fork 切在 turn 中间 → 400 OPEN_TURN。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ANON_HEADERS, bootLoom, cleanupDir, ensureTsx, GIS_DIR, openEventStream, readEnv, readEventRange, sdkBuilt, type BootedLoom, type SseCollector,
} from './helpers.js'
import { join, resolve } from 'node:path'

const DATA_PATH = join(GIS_DIR, 'data', 'land-types.json')

const env = readEnv(GIS_DIR)
const hasKey = process.env.DEEPSEEK_API_KEY !== undefined || env.DEEPSEEK_API_KEY !== undefined
if (process.env.DEEPSEEK_API_KEY === undefined && env.DEEPSEEK_API_KEY !== undefined) {
  process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY
}

const NOTE = '重点耕地保护区'
const MESSAGE = `调用工具 gis_update_land_note 把连河村的 note 改成"${NOTE}"（note 参数逐字使用这七个字，不要增删），然后一句话确认。`

interface LandItem { village: string; note?: string; [key: string]: unknown }

const readData = (): { items: LandItem[] } => JSON.parse(readFileSync(DATA_PATH, 'utf8'))
const noteOf = (village: string): string | undefined => readData().items.find(item => String(item.village).includes(village))?.note

describe.skipIf(!hasKey || !sdkBuilt())('真实审批链 e2e（带 key）', () => {
  let loom: BootedLoom | undefined
  let sse: SseCollector | undefined
  let originalData: string
  let sessionId = ''

  beforeAll(async () => {
    ensureTsx() // 应用入口 loom.app.ts 是 TS：等价于 cli 子进程的 --import tsx
    originalData = readFileSync(DATA_PATH, 'utf8')
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'loom.app.ts'),
      withApproval: true,
      withSubagent: true, // M3 起应用声明了 researcher，组合需带 subagent 服务缝
      port: 4623,
      outDirName: '.loom-e2e',
    })
  }, 120_000)

  afterAll(async () => {
    sse?.close()
    await loom?.dispose()
    cleanupDir(resolve(GIS_DIR, '.loom-e2e'))
    // 数据文件还原：测试不应留下副作用（diff 证据由断言过程给出）。
    if (originalData !== undefined) writeFileSync(DATA_PATH, originalData, 'utf8')
  })

  async function newSession(): Promise<string> {
    const res = await fetch(`${loom!.base}/agents/data-analysis/sessions`, { method: 'POST', headers: ANON_HEADERS })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessionId: string }
    expect(body.sessionId).toMatch(/^session-gis-platform-/)
    return body.sessionId
  }

  async function sendMessage(sid: string, text: string): Promise<void> {
    const res = await fetch(`${loom!.base}/agents/data-analysis/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...ANON_HEADERS }, body: JSON.stringify({ text }),
    })
    expect(res.status).toBe(200)
  }

  it('health 200：新工具在列、策略已编译', async () => {
    const res = await fetch(`${loom!.base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.app).toBe('gis-platform')
    expect(body.tools).toContain('gis_update_land_note')
    expect(body.policy).toEqual({ default: 'allow', rules: 3 })
    expect(body.httpApi).toEqual([{ tool: 'gis_query_land_types', method: 'GET', path: '/~loom/api/gis_query_land_types' }])
  })

  it('.http() 直调返回真实数据（连河村地类面积）', async () => {
    const res = await fetch(`${loom!.base}/api/gis_query_land_types?region=${encodeURIComponent('连河村')}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-loom-exec')).toBe('pipeline')
    const body = (await res.json()) as { items: Array<{ village: string }> }
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items[0]!.village).toContain('连河村')
  })

  it('允许路径：审批卡 → 允许 → 工具成功 → 文件真实变更', async () => {
    sessionId = await newSession()
    sse = await openEventStream(loom!.base, sessionId)
    const noteBefore = noteOf('连河村')

    await sendMessage(sessionId, MESSAGE)

    // 证据链 1：模型调写工具
    const call = await sse.wait(e => e.type === 'tool/call' && e.name === 'gis_update_land_note', 180_000, 'tool/call(gis_update_land_note)')
    expect(call.args).toMatchObject({ region: expect.stringContaining('连河村'), note: expect.stringContaining(NOTE) })

    // 证据链 2：SSE 出现审批卡（含参数预览）
    const asked = await sse.wait(e => e.type === 'loom/approval-asked' && e.tool === 'gis_update_land_note', 30_000, 'loom/approval-asked')
    expect(typeof asked.approvalId).toBe('string')
    expect(String(asked.argsPreview)).toContain('连河村')
    expect(asked.callSeq).toBe(call.seq)

    // 证据链 3：POST 允许 → 审批定稿 → 工具完成
    const decision = await fetch(`${loom!.base}/sessions/${sessionId}/approvals/${asked.approvalId}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...ANON_HEADERS }, body: JSON.stringify({ decision: 'allowed-once' }),
    })
    expect(decision.status).toBe(200)

    const decided = await sse.wait(e => e.type === 'loom/approval-decided' && e.approvalId === asked.approvalId, 15_000, 'loom/approval-decided')
    expect(decided.decision).toBe('allowed-once')

    const result = await sse.wait(e => e.type === 'tool/result' && e.callSeq === call.seq, 60_000, 'tool/result(允许后)')
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ updated: expect.any(Number) })

    // 证据链 4：turn 完成（内核 reason 是 { kind: 'completed' } 对象）
    await sse.wait(e => e.type === 'turn/end' && String(e.reason?.kind ?? e.reason) === 'completed', 120_000, 'turn/end completed')

    // 证据链 5：文件 diff——note 真的变了
    const noteAfter = noteOf('连河村')
    expect(noteAfter).toContain(NOTE)
    expect(noteAfter).not.toEqual(noteBefore)
  }, 420_000)

  it('拒绝路径：审批卡 → 拒绝 → 工具失败 → 文件未变', async () => {
    const sid = await newSession()
    const stream = await openEventStream(loom!.base, sid)
    const dataBefore = readFileSync(DATA_PATH, 'utf8')

    await sendMessage(sid, MESSAGE)

    const call = await stream.wait(e => e.type === 'tool/call' && e.name === 'gis_update_land_note', 180_000, 'tool/call(拒绝路径)')
    const asked = await stream.wait(e => e.type === 'loom/approval-asked' && e.tool === 'gis_update_land_note', 30_000, 'loom/approval-asked(拒绝路径)')

    const decision = await fetch(`${loom!.base}/sessions/${sid}/approvals/${asked.approvalId}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...ANON_HEADERS }, body: JSON.stringify({ decision: 'rejected' }),
    })
    expect(decision.status).toBe(200)

    const result = await stream.wait(e => e.type === 'tool/result' && e.callSeq === call.seq, 60_000, 'tool/result(拒绝后)')
    expect(result.isError).toBe(true)
    expect(String(result.preview)).toContain('rejected')

    await stream.wait(e => e.type === 'turn/end', 180_000, 'turn/end(拒绝路径)')

    // fail-closed：文件字节未变
    expect(readFileSync(DATA_PATH, 'utf8')).toBe(dataBefore)
    stream.close()
  }, 420_000)

  it('回放：events?to=<turn/end seq> 有界读取；fork 前缀一致；turn 中间分叉 400 OPEN_TURN', async () => {
    // 允许路径会话的完整事件（含实时收集期间的顺序权威）
    expect(sessionId).not.toBe('')
    const all = await readEventRange(loom!.base, sessionId, -1, 1_000_000_000)
    const turnEnds = all.filter(e => e.type === 'turn/end').map(e => e.seq as number)
    expect(turnEnds.length).toBeGreaterThanOrEqual(1)
    const boundary = turnEnds[turnEnds.length - 1]!

    // 有界读取：所有返回 seq ≤ boundary，且包含写工具调用
    const bounded = await readEventRange(loom!.base, sessionId, -1, boundary)
    expect(bounded.length).toBeGreaterThan(0)
    expect(bounded.every(e => typeof e.seq !== 'number' || e.seq <= boundary)).toBe(true)
    expect(bounded.some(e => e.type === 'tool/call' && e.name === 'gis_update_land_note')).toBe(true)

    // fork 在 turn/end 边界 → 前缀一致
    const forkRes = await fetch(`${loom!.base}/sessions/${sessionId}/fork`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...ANON_HEADERS }, body: JSON.stringify({ atSeq: boundary }),
    })
    expect(forkRes.status).toBe(200)
    const forkBody = (await forkRes.json()) as { sessionId: string; forkedFrom: string; atSeq: number }
    expect(forkBody.forkedFrom).toBe(sessionId)
    expect(forkBody.atSeq).toBe(boundary)

    const childEvents = await readEventRange(loom!.base, forkBody.sessionId, -1, 1_000_000_000)
    const childSeqs = childEvents.filter(e => typeof e.seq === 'number').map(e => e.seq)
    const sourceSeqs = all.filter(e => typeof e.seq === 'number' && e.seq <= boundary).map(e => e.seq)
    expect(childSeqs).toEqual(sourceSeqs)

    // fork 切在 turn 中间（tool/call 的 seq）→ 400 + OPEN_TURN 提示
    const midTurn = all.find(e => e.type === 'tool/call' && e.name === 'gis_update_land_note')!.seq as number
    const badRes = await fetch(`${loom!.base}/sessions/${sessionId}/fork`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...ANON_HEADERS }, body: JSON.stringify({ atSeq: midTurn }),
    })
    expect(badRes.status).toBe(400)
    const badBody = (await badRes.json()) as { code: string; hint: string }
    expect(badBody.code).toBe('OPEN_TURN')
    expect(badBody.hint).toContain('turn/end')
  }, 60_000)
})

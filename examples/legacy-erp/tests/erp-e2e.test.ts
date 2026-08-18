/**
 * 老系统对接 e2e（需要 DEEPSEEK_API_KEY；无 key 自跳过）：三路证据链。
 *
 * 1. 查询：'查一下库存低于 10 的商品并给补货建议' → SSE 证据——导入工具
 *    erp_list_products 被真实调用 + 回答含真实商品名与数字（轴承 D60 剩 4、
 *    液压油 L46 剩 7）。
 * 2. 下单（允许）：'帮 C001 下单买 2 个轴承 D60' → 审批卡出现 → POST
 *    allowed-once → 老系统 erp-state.json 库存真实扣减（4→2，diff 证据）
 *    + sqlite 冗余副本同步（erp.db 同为 2）。
 * 3. 下单（拒绝）：再下一单 → POST rejected → 工具失败（含 rejected）→
 *    库存不变（fail-closed）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ANON_HEADERS, APP_DIR, bootLegacyServer, bootLoom, cleanupDir, ensureTsx, ERP_DB_PATH, openEventStream, readEnv, sdkBuilt, STATE_PATH,
  type BootedLegacy, type BootedLoom, type SseCollector,
} from './helpers.js'
import { join, resolve } from 'node:path'

const LEGACY_PORT = 4712
const LOOM_PORT = 4642

const env = readEnv(APP_DIR)
const hasKey = process.env.DEEPSEEK_API_KEY !== undefined || env.DEEPSEEK_API_KEY !== undefined
if (process.env.DEEPSEEK_API_KEY === undefined && env.DEEPSEEK_API_KEY !== undefined) {
  process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY
}
if (env.LEGACY_API_KEY !== undefined && process.env.LEGACY_API_KEY === undefined) {
  process.env.LEGACY_API_KEY = env.LEGACY_API_KEY
}

interface ProductRow { id: string, name: string, stock: number }

/** 读 JSON 状态里某商品库存（diff 证据用）。 */
const stockOf = (productId: string): number =>
  (JSON.parse(readFileSync(STATE_PATH, 'utf8')) as { products: ProductRow[] }).products.find(p => p.id === productId)!.stock

/** readonly 读 sqlite 冗余副本的库存（路 3 同款姿势）。 */
const dbStockOf = (productId: string): number => {
  const db = new DatabaseSync(ERP_DB_PATH, { readOnly: true })
  try {
    return (db.prepare('SELECT stock FROM products WHERE id = ?').get(productId) as { stock: number } | undefined)?.stock ?? -1
  } finally {
    db.close()
  }
}

describe.skipIf(!hasKey || !sdkBuilt())('老系统对接 e2e（带 key）', () => {
  let legacy: BootedLegacy | undefined
  let loom: BootedLoom | undefined
  let stateBefore: string

  beforeAll(async () => {
    ensureTsx()
    stateBefore = readFileSync(STATE_PATH, 'utf8')
    process.env.LEGACY_ERP_BASE = `http://127.0.0.1:${LEGACY_PORT}`
    legacy = await bootLegacyServer({ port: LEGACY_PORT })
    loom = await bootLoom({
      appModulePath: join(APP_DIR, 'loom.app.ts'),
      withApproval: true,
      port: LOOM_PORT,
      outDirName: '.loom-e2e',
    })
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    await legacy?.dispose()
    cleanupDir(resolve(APP_DIR, '.loom-e2e'))
    if (stateBefore !== undefined) writeFileSync(STATE_PATH, stateBefore, 'utf8')
  })

  async function newSession(): Promise<string> {
    const res = await fetch(`${loom!.base}/agents/erp-assistant/sessions`, { method: 'POST', headers: ANON_HEADERS })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessionId: string }
    expect(body.sessionId).toMatch(/^session-legacy-erp-/)
    return body.sessionId
  }

  async function sendMessage(sid: string, text: string): Promise<void> {
    const res = await fetch(`${loom!.base}/agents/erp-assistant/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...ANON_HEADERS }, body: JSON.stringify({ text }),
    })
    expect(res.status).toBe(200)
  }

  it('查询链：导入工具真实调用，回答带真实商品与数字', async () => {
    const sid = await newSession()
    const sse = await openEventStream(loom!.base, sid)
    try {
      await sendMessage(sid, '查一下库存低于 10 的商品并给补货建议')

      // 证据 1：模型调了导入生成的查询工具（路 1）
      const call = await sse.wait(e => e.type === 'tool/call' && e.name === 'erp_list_products', 180_000, 'tool/call(erp_list_products)')
      expect(call.seq).toBeGreaterThan(0)

      // 证据 2：turn 完成
      await sse.wait(e => e.type === 'turn/end' && String(e.reason?.kind ?? e.reason) === 'completed', 180_000, 'turn/end completed')

      // 证据 3：回答里是真实商品名与真实数字（轴承 D60 剩 4、液压油 L46 剩 7）
      const answer = sse.events.filter(e => e.type === 'assistant/message').map(e => String(e.text ?? '')).join(' ')
      expect(answer).toContain('轴承')
      expect(answer).toContain('液压油')
      expect(answer).toMatch(/4/)
      expect(answer).toMatch(/7/)
    } finally {
      sse.close()
    }
  }, 420_000)

  it('允许链：下单 → 审批允许 → 老系统库存真实扣减 + sqlite 同步', async () => {
    const sid = await newSession()
    const sse = await openEventStream(loom!.base, sid)
    try {
      const beforeJson = stockOf('P101')
      const beforeDb = dbStockOf('P101')

      await sendMessage(sid, '帮 C001 下单买 2 个轴承 D60：直接调用 erp_orders_create（customerId=C001，items=[{productId:"P101", qty:2}]），不要先向我确认，完成后一句话汇报订单号。')

      // 证据 1：模型调导入的写工具
      const call = await sse.wait(e => e.type === 'tool/call' && e.name === 'erp_orders_create', 180_000, 'tool/call(erp_orders_create)')
      expect(call.args).toMatchObject({ customerId: 'C001', items: expect.arrayContaining([expect.objectContaining({ productId: 'P101', qty: 2 })]) })

      // 证据 2：审批卡（SSE）出现
      const asked = await sse.wait(e => e.type === 'loom/approval-asked' && e.tool === 'erp_orders_create', 30_000, 'loom/approval-asked')
      expect(typeof asked.approvalId).toBe('string')

      // 证据 3：POST 允许 → 定稿 → 工具成功返回订单号
      const decision = await fetch(`${loom!.base}/sessions/${sid}/approvals/${asked.approvalId}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...ANON_HEADERS }, body: JSON.stringify({ decision: 'allowed-once' }),
      })
      expect(decision.status).toBe(200)

      const result = await sse.wait(e => e.type === 'tool/result' && e.callSeq === call.seq, 60_000, 'tool/result(允许后)')
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ customerId: 'C001', orderId: expect.stringMatching(/^SO-/) })

      await sse.wait(e => e.type === 'turn/end' && String(e.reason?.kind ?? e.reason) === 'completed', 180_000, 'turn/end completed')

      // 证据 4：老系统 JSON 账本真实扣减（diff）
      expect(stockOf('P101')).toBe(beforeJson - 2)
      // 证据 5：sqlite 冗余副本同步
      expect(dbStockOf('P101')).toBe(beforeDb - 2)
    } finally {
      sse.close()
    }
  }, 420_000)

  it('拒绝链：下单 → 审批拒绝 → 工具失败 + 库存不变（fail-closed）', async () => {
    const sid = await newSession()
    const sse = await openEventStream(loom!.base, sid)
    try {
      const beforeJson = stockOf('P101')
      const beforeJson2 = stockOf('P102')
      const beforeDb = dbStockOf('P101')

      await sendMessage(sid, '再帮 C001 下单买 1 个液压油 L46：直接调用 erp_orders_create（customerId=C001，items=[{productId:"P102", qty:1}]），不要先向我确认，完成后一句话汇报订单号。')

      const call = await sse.wait(e => e.type === 'tool/call' && e.name === 'erp_orders_create', 180_000, 'tool/call(拒绝路径)')
      const asked = await sse.wait(e => e.type === 'loom/approval-asked' && e.tool === 'erp_orders_create', 30_000, 'loom/approval-asked(拒绝路径)')

      const decision = await fetch(`${loom!.base}/sessions/${sid}/approvals/${asked.approvalId}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...ANON_HEADERS }, body: JSON.stringify({ decision: 'rejected' }),
      })
      expect(decision.status).toBe(200)

      const result = await sse.wait(e => e.type === 'tool/result' && e.callSeq === call.seq, 60_000, 'tool/result(拒绝后)')
      expect(result.isError).toBe(true)
      expect(String(result.preview)).toContain('rejected')

      await sse.wait(e => e.type === 'turn/end', 180_000, 'turn/end(拒绝路径)')

      // fail-closed：老系统账本与 sqlite 都一个字没动
      expect(stockOf('P101')).toBe(beforeJson)
      expect(stockOf('P102')).toBe(beforeJson2)
      expect(dbStockOf('P101')).toBe(beforeDb)
    } finally {
      sse.close()
    }
  }, 420_000)
})

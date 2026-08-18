/**
 * 无 key 冒烟（零 DEEPSEEK_API_KEY 依赖）：起老系统 + boot 应用 →
 * ① health 200（三路工具齐全 + 策略编译）② 导入/手写/直连库工具经 .http() 面
 * 孔直调真实老系统数据 ③ 老系统自身的认证（无 key 401）、文档可达、库存不足 409。
 * 前置：@loom-sdk/web 已构建（pnpm build:sdk）；未构建则自跳过。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  ANON_HEADERS, APP_DIR, bootLegacyServer, bootLoom, cleanupDir, ensureTsx, readEnv, sdkBuilt,
  STATE_PATH, type BootedLegacy, type BootedLoom,
} from './helpers.js'
import { join, resolve } from 'node:path'

const LEGACY_PORT = 4711
const LOOM_PORT = 4641

describe.skipIf(!sdkBuilt())('老系统对接冒烟（无 key）', () => {
  let legacy: BootedLegacy | undefined
  let loom: BootedLoom | undefined
  let stateBefore: string

  beforeAll(async () => {
    ensureTsx() // 应用入口 loom.app.ts 是 TS
    const env = readEnv(APP_DIR)
    // 老系统 key（非 LLM key）：映射进应用（loom.app.ts 会转给 LOOM_IMPORT_TOKEN）。
    if (env.LEGACY_API_KEY !== undefined) process.env.LEGACY_API_KEY = env.LEGACY_API_KEY
    // 老系统走测试专属端口，避免撞上演示实例 4710。
    process.env.LEGACY_ERP_BASE = `http://127.0.0.1:${LEGACY_PORT}`
    stateBefore = readFileSync(STATE_PATH, 'utf8')
    legacy = await bootLegacyServer({ port: LEGACY_PORT })
    loom = await bootLoom({
      appModulePath: join(APP_DIR, 'loom.app.ts'),
      withApproval: true, // 应用声明了 policy（下单 approve）
      port: LOOM_PORT,
      outDirName: '.loom-smoke',
    })
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    await legacy?.dispose()
    cleanupDir(resolve(APP_DIR, '.loom-smoke'))
    if (stateBefore !== undefined) { // 冒烟里如有写入则还原（本轮只有 409，不动账）
      writeFileSync(STATE_PATH, stateBefore, 'utf8')
    }
  })

  it('老系统：无 X-Api-Key → 401；/openapi.json 可达且为 3.x', async () => {
    const noKey = await fetch(`${legacy!.base}/api/products`)
    expect(noKey.status).toBe(401)
    expect(((await noKey.json()) as Record<string, any>).error).toBe('UNAUTHORIZED')

    const doc = await fetch(`${legacy!.base}/openapi.json`)
    expect(doc.status).toBe(200)
    const body = (await doc.json()) as Record<string, any>
    expect(String(body.openapi).startsWith('3.')).toBe(true)
    // 文档"故意不完整"：库存流水接口不在里面（→ 路 2 手写包装的存在理由）。
    expect(Object.keys(body.paths)).not.toContain('/api/stock-movements')
  })

  it('老系统：库存不足下单 → 409（真实扣减约束）', async () => {
    const res = await fetch(`${legacy!.base}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Api-Key': process.env.LEGACY_API_KEY ?? 'legacy-key-2018' },
      body: JSON.stringify({ customerId: 'C001', items: [{ productId: 'P101', qty: 999 }] }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, any>
    expect(body.error).toBe('INSUFFICIENT_STOCK')
    expect(body.stock).toBeLessThan(999)
  })

  it('health 200：三路工具齐全、策略编译为 3 条规则', async () => {
    const res = await fetch(`${loom!.base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.ok).toBe(true)
    expect(body.app).toBe('legacy-erp')
    // 路 1（导入×5）：
    for (const tool of ['erp_list_products', 'erp_get_product', 'erp_list_customers', 'erp_get_customer', 'erp_orders_create']) {
      expect(body.tools).toContain(tool)
    }
    // 路 2（手写包装）+ 路 3（直连库）：
    expect(body.tools).toContain('erp_stock_movements')
    expect(body.tools).toContain('erp_db_stock_audit')
    expect(body.policy).toEqual({ default: 'allow', rules: 3 })
    expect(body.agents).toEqual(['erp-assistant'])
  })

  it('路 1：导入工具经 .http() 直调老系统（注入 X-Api-Key 后取回真实商品）', async () => {
    const res = await fetch(`${loom!.base}/api/erp_list_products`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-loom-exec')).toBe('pipeline')
    const body = (await res.json()) as Array<{ id: string, name: string, stock: number }>
    expect(body.length).toBeGreaterThanOrEqual(6)
    expect(body.some(p => p.id === 'P101' && p.name === '轴承 D60')).toBe(true)
  })

  it('路 2：手写包装工具取回未文档化接口的库存流水', async () => {
    const res = await fetch(`${loom!.base}/api/erp_stock_movements?productId=P101`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { total: number, items: Array<{ productId: string, productName: string, kind: string }> }
    expect(body.total).toBeGreaterThanOrEqual(3)
    expect(body.items.every(item => item.productId === 'P101')).toBe(true)
    expect(body.items.some(item => item.productName === '轴承 D60')).toBe(true)
  })

  it('路 3：直连库审计返回低库存清单（readonly sqlite）', async () => {
    const res = await fetch(`${loom!.base}/api/erp_db_stock_audit?below=10`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { below: number, lowCount: number, items: Array<{ productId: string, name: string, stock: number }> }
    expect(body.below).toBe(10)
    expect(body.lowCount).toBe(2)
    expect(body.items.map(item => item.productId)).toEqual(['P101', 'P102'])
    expect(body.items[0]).toMatchObject({ name: '轴承 D60', stock: 4 })
    expect(body.items[1]).toMatchObject({ name: '液压油 L46', stock: 7 })
  })
})

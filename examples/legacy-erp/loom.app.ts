/**
 * 老系统对接（examples/legacy-erp）：把一台"2018 年上线的进销存 ERP"三路接进
 * Loom，agent 直接查/改老系统数据，写操作走人工审批，全程可回放。
 *
 * ── 三路接入（什么形态的老系统走哪路，详见 README.zh.md 决策表） ──────────
 *
 * 路 1【有 OpenAPI 文档 → 一键导入】适用：文档齐全或大体的现代/半现代系统。
 *   `loom import-openapi http://127.0.0.1:4710/openapi.json --base http://127.0.0.1:4710`
 *   生成 loom.openapi.ts，这里一行 registerImportedTools(app)——5 个查询/下单
 *   工具立即获得模型面孔 + HTTP 面孔 + 策略治理。生成器对源头 apiKey(header)
 *   形态的原生支持：认证头 X-Api-Key 从 process.env.LOOM_IMPORT_TOKEN 注入
 *   （生成代码约定变量名，见 loom.openapi.ts 头部）。本例的密钥统一放
 *   LEGACY_API_KEY（.env），由 loom.import-env（本文件第一条 import，先于
 *   生成物模块体执行）映射过去——生成物零手改。
 *
 * 路 2【没写进文档的接口 → 手写包装】适用：老运维口头交接、文档覆盖不到的
 *   端点。GET /api/stock-movements（库存流水）压根不在 openapi.json 里——
 *   手写 erp_stock_movements 工具：fetch + 注入 X-Api-Key + 如实声明 output。
 *
 * 路 3【连 API 都没有 → 只读直连库】适用：只有数据库可看的存量系统。
 *   legacy-server 把商品库存冗余写进 data/erp.db（模拟"老系统的库"）——
 *   erp_db_stock_audit 用 node:sqlite 以 readonly 打开做低库存对账审计
 *   （框架 engines ≥22.13，node:sqlite 免 flag）。
 *
 * 治理与体验：policy 里 *_orders_* 走 approve（下单是真实写操作，会真实扣
 * 库存）；查询放行；memory 开启（assistant 记住客户偏好）；全程落会话日志，
 * 可回放可分叉。启动：先起老系统（node legacy-server/server.mjs），再
 * pnpm loom dev（智能体服务 4640 + Vite 5174）。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import z from '@deepseek-ai/schemastery'
import { defineApp } from '@loom-sdk/web'
import './loom.import-env' // 先于 loom.openapi：把 LEGACY_API_KEY 映射到 LOOM_IMPORT_TOKEN（生成物的注入位）
import { configureImportedClient, registerImportedTools } from './loom.openapi'

/** 老系统的库（sqlite 冗余副本；readonly 打开——Loom 侧绝不写老库）。 */
const ERP_DB = join(dirname(fileURLToPath(import.meta.url)), 'legacy-server', 'data', 'erp.db')
/** 老 API 基址（测试用 LEGACY_ERP_BASE 指到别的实例；缺省 4710）。 */
const LEGACY_BASE = process.env.LEGACY_ERP_BASE ?? 'http://127.0.0.1:4710'
/** 老系统的 X-Api-Key（.env 统一配这一个；生成物约定从 LOOM_IMPORT_TOKEN 读）。 */
const LEGACY_API_KEY = process.env.LEGACY_API_KEY ?? 'legacy-key-2018'

if (process.env.LEGACY_ERP_BASE !== undefined) configureImportedClient({ baseUrl: LEGACY_BASE })

const app = defineApp('legacy-erp', { model: 'deepseek-v4-flash', port: 4640 })

// ── 路 1：一键导入（loom.openapi.ts 是 import-openapi 的生成物，零手改） ───
// 密钥经 loom.import-env 映射：LEGACY_API_KEY → LOOM_IMPORT_TOKEN（见文件顶部
// 第一条 import——必须在生成物模块体执行前完成）。
registerImportedTools(app)
// 此刻模型已可见：erp_list_products / erp_get_product / erp_list_customers /
// erp_get_customer / erp_orders_create（写操作——policy 里配 approve）。

// ── 路 2：手写包装（未写进文档的老运维接口） ──────────────────────────────
app
  .tool('erp_stock_movements')
  .description('查询老 ERP 的库存流水（入库/出库记录，含原因与时间）。这是老运维口头交接的接口，没写进 openapi.json 文档——本工具是手写包装：直接 fetch 老 API 并注入 X-Api-Key。可按商品编号过滤。')
  .input({ productId: { type: 'string', description: '商品编号过滤词，如 P101；省略返回全部流水。' } })
  .output(z.object({
    total: z.number(),
    items: z.array(z.object({
      id: z.string(),
      productId: z.string(),
      productName: z.string(),
      qty: z.number(),
      kind: z.string(),
      reason: z.string(),
      at: z.string(),
    })),
  }))
  .card('generic', { title: '库存流水（手写包装）' })
  .http('GET')
  .execute(async (args, exec) => {
    const params = new URLSearchParams()
    if (args.productId !== undefined && args.productId !== '') params.set('productId', args.productId)
    const qs = params.toString()
    const res = await fetch(`${LEGACY_BASE}/api/stock-movements${qs === '' ? '' : `?${qs}`}`, {
      signal: exec.signal,
      headers: { 'X-Api-Key': process.env.LEGACY_API_KEY ?? LEGACY_API_KEY },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`erp_stock_movements 调用失败：HTTP ${res.status}——${text.slice(0, 200)}`)
    }
    const body = (await res.json()) as { total: number, items: Array<{ id: string, productId: string, qty: number, kind: string, reason: string, at: string }> }
    const names = new Map<string, string>()
    const products = await fetch(`${LEGACY_BASE}/api/products`, {
      signal: exec.signal,
      headers: { 'X-Api-Key': process.env.LEGACY_API_KEY ?? LEGACY_API_KEY },
    })
    if (products.ok) {
      for (const product of (await products.json()) as Array<{ id: string, name: string }>) names.set(product.id, product.name)
    }
    return { total: body.total, items: body.items.map(item => ({ ...item, productName: names.get(item.productId) ?? item.productId })) }
  })

// ── 路 3：只读直连库（连 API 都没有的存量系统） ────────────────────────────
app
  .tool('erp_db_stock_audit')
  .description('直连老系统的数据库做低库存对账审计：以 readonly 打开 legacy-server/data/erp.db（sqlite，商品库存冗余副本），返回库存低于阈值的商品清单。适合"不放心 API、要跟库对账"的场景；只读，绝不写老库。')
  .input({ below: { type: 'number', description: '低库存阈值（库存 < below 记为低）；缺省 10。' } })
  .output(z.object({
    below: z.number(),
    lowCount: z.number(),
    items: z.array(z.object({ productId: z.string(), name: z.string(), stock: z.number(), updatedAt: z.string() })),
    auditedAt: z.string(),
  }))
  .card('generic', { title: '直连库库存审计' })
  .http('GET')
  .execute(async (args) => {
    const below = typeof args.below === 'number' && Number.isFinite(args.below) && args.below > 0 ? args.below : 10
    // readonly 打开：就算这里写错了代码也写不进老库（sqlite 层拒绝）。
    const db = new DatabaseSync(ERP_DB, { readOnly: true })
    try {
      const rows = db.prepare('SELECT id, name, stock, updated_at FROM products WHERE stock < ? ORDER BY stock ASC').all(below) as Array<{ id: string, name: string, stock: number, updated_at: string | null }>
      return {
        below,
        lowCount: rows.length,
        items: rows.map(row => ({ productId: row.id, name: row.name, stock: row.stock, updatedAt: row.updated_at ?? '' })),
        auditedAt: new Date().toISOString(),
      }
    } finally {
      db.close()
    }
  })

// ── 认证 + 记忆（老系统对接也要多用户与长期记忆） ──────────────────────────
app.auth()
app.memory({ extraction: { maxPerTurn: 3 } })

// ── 智能体：一个懂这台老 ERP 的中文助手 ────────────────────────────────────
app.agent('erp-assistant', {
  persona: [
    '你是"老 ERP 助手"，对接一台 2018 年上线的进销存老系统，帮业务同事查库存、查客户、下订单。',
    '规则：查商品/库存一律先调用 erp_list_products（唯一权威清单），禁止编造商品名或数字；查客户用 erp_list_customers / erp_get_customer；',
    '查库存流水（入库出库历史）用 erp_stock_movements；用户明确要求"直连库对账/审计数据库"或不放心 API 数据时，用 erp_db_stock_audit（只读直连 sqlite）核对；',
    '创建订单用 erp_orders_create：这是真实写操作，会真实扣老系统库存并触发人工审批——用户要求下单时直接调用创建，不要先反问确认（审批卡本身就是确认环节）；审批被拒后如实告知"订单未创建"，绝不能编造成功；库存不足会收到 HTTP 409 错误，如实转述缺口；',
    '发现库存低于 10 的商品时，主动给出补货建议（结合单价与近期流水）；用户说明偏好（常用客户、汇报口径）时可调用 memory_write 记住。用中文简洁作答，结论带具体数字。',
  ].join('\n'),
  tools: [
    'erp_list_products', 'erp_get_product', 'erp_list_customers', 'erp_get_customer', // 路 1：导入
    'erp_orders_create',                                                               // 路 1：导入（写，approve）
    'erp_stock_movements',                                                             // 路 2：手写包装
    'erp_db_stock_audit',                                                              // 路 3：只读直连库
  ],
  memory: true, // 提取 + 召回（提取花 token，按 agent 显式开启）
})

// ── 策略：老系统的写必须人批，读放行 ────────────────────────────────────────
// 规则按声明顺序求值、后声明覆盖先声明：先放行 erp_* 查询（含路 2/路 3 工具），
// 再把 *_orders_*（即导入生成的 erp_orders_create）压成 approve。
app.policy({
  default: 'allow',
  rules: [
    { tool: 'erp_*', effect: 'allow' },          // 三路查询工具：放行
    { tool: '*_orders_*', effect: 'approve' },   // 导入生成的下单写操作：人工审批（真实扣库存）
    { tool: 'memory_forget', effect: 'approve' },// 删除记忆：破坏性写，审批
  ],
})

// ── 投影：任务链（聊天流旁的工具调用清单，回放时同样可折叠） ────────────────
export interface WorkspaceState {
  tasks: Array<{ seq: number; title: string; name: string; status: 'running' | 'done' | 'error' }>
}

app.projection<WorkspaceState>('workspace', {
  init: { tasks: [] },
  apply(state, event) {
    const fields = event as Record<string, unknown>
    const pick = <T,>(key: string): T | undefined => fields[key] as T | undefined
    switch (event.type) {
      case 'tool/call':
        return {
          ...state,
          tasks: [...state.tasks, { seq: event.seq, title: String(pick<{ title?: string }>('card')?.title ?? event.name), name: String(event.name), status: 'running' }],
        }
      case 'tool/result': {
        const callSeq = pick<number>('callSeq') ?? -1
        return {
          ...state,
          tasks: state.tasks.map(task => (task.seq === callSeq ? { ...task, status: pick<boolean>('isError') === true ? 'error' : 'done' } : task)),
        }
      }
      default:
        return state
    }
  },
})

export default app

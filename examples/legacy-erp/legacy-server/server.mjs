#!/usr/bin/env node
/**
 * 模拟老系统：一台"2018 年上线的进销存 ERP"（examples/legacy-erp 的接入对象）。
 *
 * 形态刻意"老"：
 * - 零依赖 node:http + 内存态 + JSON 文件落盘（data/erp-state.json）；
 * - 旧风格 REST（/api/products、/api/customers、/api/orders）；
 * - 认证是一个 2018 年流行的 X-Api-Key 头（全部 /api/* 都要，缺头 401）；
 * - /openapi.json 是当年运维手写的 OpenAPI 3.0 文档：只文档化了查询类
 *   operation（POST /api/orders 的 requestBody schema 写得粗糙——字段没描述、
 *   带着生成器覆盖不了的 minLength/minItems 约束）；库存流水接口
 *   GET /api/stock-movements 压根没写进文档（老运维口头交接的接口）；
 * - 商品库存同时冗余写一份 sqlite（data/erp.db）——模拟"老系统自己的库"，
 *   供 Loom 应用用 node:sqlite 只读直连做对账（路 3）。
 *
 * 独立可跑（供演示与测试）：
 *   node legacy-server/server.mjs            # 端口 4710
 *   PORT=4711 node legacy-server/server.mjs  # 换端口
 *   node legacy-server/server.mjs --reset    # 重置回种子数据
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const PORT = Number(process.env.PORT ?? 4710)
const API_KEY = process.env.LEGACY_API_KEY ?? 'legacy-key-2018'
const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(HERE, 'data')
const STATE_PATH = join(DATA_DIR, 'erp-state.json')
const DB_PATH = join(DATA_DIR, 'erp.db')

// ---------------------------------------------------------------------------
// 种子数据（2018 年的账）
// ---------------------------------------------------------------------------

/** 全量商品：6 个，其中"轴承 D60"剩 4、"液压油 L46"剩 7——低库存展示位。 */
const SEED_PRODUCTS = [
  { id: 'P101', name: '轴承 D60', spec: '深沟球轴承 60mm', unit: '个', price: 38.5, stock: 4, updatedAt: '2026-08-11T09:20:00+08:00' },
  { id: 'P102', name: '液压油 L46', spec: '抗磨液压油 46# 18L/桶', unit: '桶', price: 268, stock: 7, updatedAt: '2026-08-12T14:05:00+08:00' },
  { id: 'P103', name: '三角皮带 B2100', spec: 'B 型 2100mm', unit: '条', price: 21.9, stock: 58, updatedAt: '2026-08-05T10:00:00+08:00' },
  { id: 'P104', name: '铸造法兰 DN100', spec: 'PN1.6 平焊法兰', unit: '片', price: 45, stock: 23, updatedAt: '2026-08-08T16:40:00+08:00' },
  { id: 'P105', name: '不锈钢螺母 M16', spec: '304 六角螺母', unit: '个', price: 1.35, stock: 310, updatedAt: '2026-07-30T11:15:00+08:00' },
  { id: 'P106', name: '密封圈 80x100', spec: 'NBR 橡胶油封', unit: '个', price: 6.8, stock: 12, updatedAt: '2026-08-13T08:30:00+08:00' },
]

const SEED_CUSTOMERS = [
  { id: 'C001', name: '老张', company: '红星机械厂', phone: '13801380001', city: '河北·沧州', creditLevel: 'A' },
  { id: 'C002', name: '王姐', company: '众和机电设备', phone: '13901390002', city: '江苏·常州', creditLevel: 'B' },
  { id: 'C003', name: '李工', company: '北方重工维修部', phone: '13701370003', city: '辽宁·沈阳', creditLevel: 'A' },
]

/** 历史库存流水（入库/出库 + 原因）。 */
const SEED_MOVEMENTS = [
  { id: 'M9001', productId: 'P101', qty: 50, kind: 'in', reason: '采购入库（供应商：洛轴）', at: '2026-07-28T09:00:00+08:00' },
  { id: 'M9002', productId: 'P101', qty: 18, kind: 'out', reason: '销售出库（C003 老单）', at: '2026-08-01T15:20:00+08:00' },
  { id: 'M9003', productId: 'P101', qty: 28, kind: 'out', reason: '销售出库（C001 月度补货）', at: '2026-08-11T09:20:00+08:00' },
  { id: 'M9004', productId: 'P102', qty: 30, kind: 'in', reason: '采购入库（供应商：长城润滑油）', at: '2026-07-25T10:30:00+08:00' },
  { id: 'M9005', productId: 'P102', qty: 23, kind: 'out', reason: '销售出库（C002 季度采购）', at: '2026-08-12T14:05:00+08:00' },
  { id: 'M9006', productId: 'P103', qty: 100, kind: 'in', reason: '采购入库', at: '2026-08-04T09:10:00+08:00' },
  { id: 'M9007', productId: 'P104', qty: 40, kind: 'in', reason: '采购入库', at: '2026-08-07T14:00:00+08:00' },
  { id: 'M9008', productId: 'P105', qty: 500, kind: 'in', reason: '采购入库（批量）', at: '2026-07-29T16:45:00+08:00' },
  { id: 'M9009', productId: 'P106', qty: 60, kind: 'in', reason: '采购入库', at: '2026-08-12T08:30:00+08:00' },
]

/** 历史订单（对上部分出库流水）。 */
const SEED_ORDERS = [
  {
    orderId: 'SO-2026-0811-001', customerId: 'C001',
    items: [{ productId: 'P101', productName: '轴承 D60', qty: 28, unitPrice: 38.5 }],
    totalAmount: 1078, createdAt: '2026-08-11T09:20:00+08:00',
  },
]

// ---------------------------------------------------------------------------
// 状态：JSON 文件持久化 + sqlite 库存冗余
// ---------------------------------------------------------------------------

function seedState() {
  return {
    syncedAt: '2018-06-18T00:00:00+08:00',
    products: structuredClone(SEED_PRODUCTS),
    customers: structuredClone(SEED_CUSTOMERS),
    movements: structuredClone(SEED_MOVEMENTS),
    orders: structuredClone(SEED_ORDERS),
  }
}

function loadState() {
  if (process.argv.includes('--reset')) return seedState()
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    if (!Array.isArray(state.products) || !Array.isArray(state.customers)) throw new Error('bad shape')
    return state
  } catch {
    return seedState() // 文件缺失/损坏 → 回种子（老系统的"重装逻辑"）
  }
}

const state = loadState()

/** JSON 落盘（临时文件 + rename，尽量原子）。 */
function persist() {
  state.syncedAt = new Date().toISOString()
  mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${STATE_PATH}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, STATE_PATH)
}

/** sqlite 冗余：每次 boot 从当前 state 重建（保证 JSON 与库一致），写操作同步更新。 */
const db = new DatabaseSync(DB_PATH)
function rebuildDb() {
  db.exec('DROP TABLE IF EXISTS products')
  db.exec('CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, stock INTEGER NOT NULL, updated_at TEXT)')
  const insert = db.prepare('INSERT INTO products (id, name, stock, updated_at) VALUES (?, ?, ?, ?)')
  for (const p of state.products) insert.run(p.id, p.name, p.stock, p.updatedAt)
}
rebuildDb()
function syncProduct(p) {
  db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?').run(p.stock, p.updatedAt, p.id)
}

// ---------------------------------------------------------------------------
// 手写 OpenAPI 3.0 文档（当年的运维只写了这么多）
// ---------------------------------------------------------------------------

const OPENAPI_DOC = {
  openapi: '3.0.3',
  info: {
    title: 'Legacy ERP API（2018）',
    version: '1.2.0',
    description: '进销存老系统的 HTTP 接口。文档由当年运维手工维护，覆盖不全（库存流水等运维接口未收录）；POST /api/orders 的请求体 schema 记录简略，详见各 operation 描述。',
  },
  servers: [{ url: `http://127.0.0.1:${PORT}` }],
  security: [{ LegacyApiKey: [] }],
  tags: [
    { name: 'products', description: '商品与库存' },
    { name: 'customers', description: '客户' },
    { name: 'orders', description: '销售订单' },
  ],
  paths: {
    '/api/products': {
      get: {
        tags: ['products'],
        operationId: 'erpListProducts',
        summary: '商品清单（含库存）',
        description: '返回全部商品：编号、名称、规格、单位、单价、当前库存与最后库存变更时间。支持按名称关键字过滤。',
        parameters: [
          { name: 'keyword', in: 'query', required: false, description: '商品名称过滤词（部分匹配），如"轴承"', schema: { type: 'string' } },
        ],
        responses: {
          200: {
            description: '商品数组',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } } } },
          },
        },
      },
    },
    '/api/products/{id}': {
      get: {
        tags: ['products'],
        operationId: 'erpGetProduct',
        summary: '查单个商品',
        description: '按商品编号查详情（当年没写响应 schema，返回字段与清单一致）。',
        parameters: [{ name: 'id', in: 'path', required: true, description: '商品编号，如 P101', schema: { type: 'string' } }],
        responses: { 200: { description: '商品详情（字段同清单）' }, 404: { description: '商品不存在' } },
      },
    },
    '/api/customers': {
      get: {
        tags: ['customers'],
        operationId: 'erpListCustomers',
        summary: '客户清单',
        responses: {
          200: {
            description: '客户数组',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Customer' } } } },
          },
        },
      },
    },
    '/api/customers/{id}': {
      get: {
        tags: ['customers'],
        operationId: 'erpGetCustomer',
        summary: '查单个客户',
        parameters: [{ name: 'id', in: 'path', required: true, description: '客户编号，如 C001', schema: { type: 'string' } }],
        responses: {
          200: {
            description: '客户详情',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Customer' } } },
          },
          404: { description: '客户不存在' },
        },
      },
    },
    '/api/orders': {
      post: {
        tags: ['orders'],
        operationId: 'erpOrdersCreate',
        summary: '创建销售订单（写操作：扣库存）',
        description: '创建订单并立即扣减库存。请求体：customerId 是客户编号（如 C001）；items 是购买明细数组，每项 {productId, qty}（商品编号与数量）。库存不足返回 409，订单不落账。',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['customerId', 'items'],
                properties: {
                  customerId: { type: 'string', minLength: 1 },
                  items: { type: 'array', minItems: 1 },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: '订单已创建',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['orderId', 'customerId', 'items', 'totalAmount', 'createdAt'],
                  properties: {
                    orderId: { type: 'string', description: '订单号，如 SO-2026-0819-003' },
                    customerId: { type: 'string', description: '客户编号' },
                    items: {
                      type: 'array',
                      description: '明细',
                      items: {
                        type: 'object',
                        required: ['productId', 'productName', 'qty', 'unitPrice'],
                        properties: {
                          productId: { type: 'string', description: '商品编号' },
                          productName: { type: 'string', description: '商品名称' },
                          qty: { type: 'integer', description: '数量' },
                          unitPrice: { type: 'number', description: '成交单价' },
                        },
                      },
                    },
                    totalAmount: { type: 'number', description: '订单总额' },
                    createdAt: { type: 'string', description: '创建时间（ISO 8601）' },
                  },
                },
              },
            },
          },
          409: { description: '库存不足（不落账）' },
          404: { description: '客户或商品不存在' },
        },
      },
    },
    // 注意：GET /api/stock-movements（库存流水）没有写进这份文档——老运维
    // 口头交接的接口，Loom 侧走"手写包装"（路 2）。
  },
  components: {
    securitySchemes: {
      LegacyApiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
    },
    schemas: {
      Product: {
        type: 'object',
        required: ['id', 'name', 'spec', 'unit', 'price', 'stock', 'updatedAt'],
        properties: {
          id: { type: 'string', description: '商品编号，如 P101' },
          name: { type: 'string', description: '商品名称，如"轴承 D60"' },
          spec: { type: 'string', description: '规格' },
          unit: { type: 'string', description: '计价单位，如 个/桶/条' },
          price: { type: 'number', description: '单价（元）' },
          stock: { type: 'integer', description: '当前库存' },
          updatedAt: { type: 'string', description: '最后库存变更时间（ISO 8601）' },
        },
      },
      Customer: {
        type: 'object',
        required: ['id', 'name', 'company', 'phone', 'city', 'creditLevel'],
        properties: {
          id: { type: 'string', description: '客户编号，如 C001' },
          name: { type: 'string', description: '联系人' },
          company: { type: 'string', description: '单位名称' },
          phone: { type: 'string', description: '联系电话' },
          city: { type: 'string', description: '城市' },
          creditLevel: { type: 'string', description: '信用等级（A/B/C）' },
        },
      },
    },
  },
}

// ---------------------------------------------------------------------------
// HTTP 服务（旧风格：JSON 进出，错误也是 JSON）
// ---------------------------------------------------------------------------

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', chunk => {
      raw += chunk
      if (raw.length > 1 << 20) reject(new Error('body too large'))
    })
    req.on('end', () => {
      if (raw === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

/** 订单号：老系统的"日期-序号"风格。 */
function nextOrderId() {
  const today = new Date().toISOString().slice(5, 10).replaceAll('-', '')
  const prefix = `SO-${new Date().toISOString().slice(0, 4)}-${today}-`
  let max = 0
  for (const order of state.orders) {
    if (String(order.orderId).startsWith(prefix)) {
      const n = Number(String(order.orderId).slice(prefix.length))
      if (Number.isFinite(n) && n > max) max = n
    }
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`
}

function createOrder(body) {
  const customerId = body.customerId
  const items = body.items
  if (typeof customerId !== 'string' || customerId.trim() === '') return { status: 400, body: { error: 'BAD_REQUEST', detail: 'customerId 必须是非空字符串' } }
  if (!Array.isArray(items) || items.length === 0) return { status: 400, body: { error: 'BAD_REQUEST', detail: 'items 必须是非空数组 [{productId, qty}]' } }
  const customer = state.customers.find(c => c.id === customerId)
  if (customer === undefined) return { status: 404, body: { error: 'NOT_FOUND', detail: `客户不存在：${customerId}` } }

  // 先整体校验（老系统也要么全成要么全不成），再扣减。
  const plan = []
  for (const item of items) {
    const productId = item?.productId
    const qty = item?.qty
    if (typeof productId !== 'string' || !Number.isInteger(qty) || qty <= 0) {
      return { status: 400, body: { error: 'BAD_REQUEST', detail: 'items 每项必须是 {productId: string, qty: 正整数}' } }
    }
    const product = state.products.find(p => p.id === productId)
    if (product === undefined) return { status: 404, body: { error: 'NOT_FOUND', detail: `商品不存在：${productId}` } }
    if (product.stock < qty) {
      return { status: 409, body: { error: 'INSUFFICIENT_STOCK', productId, productName: product.name, stock: product.stock, requested: qty, detail: `库存不足：${product.name} 只剩 ${product.stock} ${product.unit}，要 ${qty}` } }
    }
    plan.push({ product, qty })
  }
  const now = new Date().toISOString()
  const orderItems = []
  let total = 0
  for (const { product, qty } of plan) {
    product.stock -= qty
    product.updatedAt = now
    syncProduct(product) // sqlite 冗余同步
    state.movements.push({ id: `M${now.replace(/\D/g, '').slice(0, 14)}-${Math.floor(Math.random() * 9000 + 1000)}`, productId: product.id, qty, kind: 'out', reason: `销售出库（${customerId} ${customer.name}）`, at: now })
    orderItems.push({ productId: product.id, productName: product.name, qty, unitPrice: product.price })
    total += product.price * qty
  }
  const order = { orderId: nextOrderId(), customerId, items: orderItems, totalAmount: Math.round(total * 100) / 100, createdAt: now }
  state.orders.push(order)
  persist()
  return { status: 201, body: order }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  // 文档不设防（2018 年就这样）
  if (req.method === 'GET' && (path === '/openapi.json' || path === '/openapi.json/')) {
    return send(res, 200, OPENAPI_DOC)
  }

  if (path === '/api' || path.startsWith('/api/')) {
    // 旧式 key 认证：所有 /api 请求都要 X-Api-Key。
    if (req.headers['x-api-key'] !== API_KEY) {
      return send(res, 401, { error: 'UNAUTHORIZED', detail: '缺少或错误的 X-Api-Key 头（老系统 2018 年起就这么认证）' })
    }

    if (req.method === 'GET' && path === '/api/products') {
      const keyword = url.searchParams.get('keyword') ?? ''
      const products = keyword === '' ? state.products : state.products.filter(p => p.name.includes(keyword) || p.id.includes(keyword))
      return send(res, 200, products)
    }
    let match = /^\/api\/products\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && match !== null) {
      const product = state.products.find(p => p.id === decodeURIComponent(match[1]))
      if (product === undefined) return send(res, 404, { error: 'NOT_FOUND', detail: `商品不存在：${match[1]}` })
      return send(res, 200, product)
    }
    if (req.method === 'GET' && path === '/api/customers') {
      return send(res, 200, state.customers)
    }
    match = /^\/api\/customers\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && match !== null) {
      const customer = state.customers.find(c => c.id === decodeURIComponent(match[1]))
      if (customer === undefined) return send(res, 404, { error: 'NOT_FOUND', detail: `客户不存在：${match[1]}` })
      return send(res, 200, customer)
    }
    if (req.method === 'POST' && path === '/api/orders') {
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        return send(res, 400, { error: 'BAD_REQUEST', detail: String(error?.message ?? error) })
      }
      const result = createOrder(body)
      return send(res, result.status, result.body)
    }
    // 库存流水：老运维接口，没进文档。
    if (req.method === 'GET' && path === '/api/stock-movements') {
      const productId = url.searchParams.get('productId')
      const movements = (productId === null || productId === '' ? state.movements : state.movements.filter(m => m.productId === productId))
        .slice()
        .sort((a, b) => (a.at < b.at ? 1 : -1))
      return send(res, 200, { total: movements.length, items: movements })
    }
    if (path === '/api/orders' && req.method === 'GET') {
      return send(res, 405, { error: 'METHOD_NOT_ALLOWED', detail: '订单查询接口 2019 年下线了，只保留 POST /api/orders' })
    }
    return send(res, 404, { error: 'NOT_FOUND', detail: `老系统没有这个接口：${req.method} ${path}` })
  }

  if (path === '/healthz') return send(res, 200, { ok: true, since: '2018-06-18' })
  return send(res, 404, { error: 'NOT_FOUND', detail: path })
})

server.listen(PORT, '127.0.0.1', () => {
  persist() // boot 即落一次盘（--reset 时把种子写回）
  console.log(`[legacy-erp] 2018 年的老 ERP 已上线：http://127.0.0.1:${PORT}（X-Api-Key 认证；文档 GET /openapi.json）`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close()
      process.exit(0)
    })
    setTimeout(() => process.exit(0), 1500).unref()
  })
}

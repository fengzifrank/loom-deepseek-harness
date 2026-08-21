#!/usr/bin/env node
/**
 * 智能餐厅漫画生成器 —— 调 MiniMax image-01-live（内置漫画风格）生成 8 幅教学漫画。
 *
 * 用法：
 *   node scripts/comic-gen.mjs            # 生成全部（幂等：已存在则跳过）
 *   node scripts/comic-gen.mjs --only 1   # 只生成第 1 幅（冒烟/重画）
 *   node scripts/comic-gen.mjs --only 3 --force   # 强制重生成第 3 幅
 *
 * 密钥：环境变量 MINIMAX_API_KEY，或仓库根 .env.local（gitignored）。
 * 产物：docs/img/comic/NN-<id>.png|.jpg + manifest.json（生成元数据，便于复现）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(ROOT, 'docs/img/comic')
const MANIFEST = resolve(OUT_DIR, 'manifest.json')
const ENDPOINT = 'https://api.minimaxi.com/v1/image_generation'
const SEED = 20260821

/** 读取密钥：env 优先，回落 .env.local */
function loadKey() {
  if (process.env.MINIMAX_API_KEY) return process.env.MINIMAX_API_KEY
  const local = resolve(ROOT, '.env.local')
  if (existsSync(local)) {
    const line = readFileSync(local, 'utf8').split('\n').find(l => l.startsWith('MINIMAX_API_KEY='))
    if (line) return line.slice('MINIMAX_API_KEY='.length).trim()
  }
  throw new Error('找不到 MINIMAX_API_KEY（环境变量或 .env.local）')
}

/** 角色圣经：每幅逐字复用，保证跨图一致性 */
const CHARS = {
  customer: 'a young man with short black hair wearing a blue shirt and a small backpack',
  chef: 'a chubby friendly chef with a tall white chef hat and a red apron',
  manager: 'a strict manager in a dark suit holding a clipboard',
  ledger: 'a thick blue hardcover ledger book',
  robots: 'small round-headed cute robots',
  style: 'Japanese manga art style, clean bold outlines, expressive faces, warm colors, soft restaurant lighting. Absolutely no text, no words, no letters, no numbers, no captions anywhere in the image.',
}

const PANELS = [
  {
    id: '01-intent-vs-process',
    prompt: `Split-scene comic panel with two halves. LEFT half: ${CHARS.customer} looks overwhelmed and panicking in a messy kitchen, holding a long paper checklist covered in flowchart arrows and boxes, a pot boiling over behind him. RIGHT half: the same ${CHARS.customer} sits relaxed at a clean restaurant table, calmly speaking to a service terminal, while in the background ${CHARS.chef} cooks confidently. ${CHARS.style}`,
  },
  {
    id: '02-menu-contract',
    prompt: `A big wooden menu board hanging on the wall of a warm modern restaurant, dishes shown only as simple food pictures with small checkmark boxes and no letters. In front of the board, three ${CHARS.robots} stand at attention: one holding a weighing scale, one holding a clipboard with green checkmarks, one holding a delivery box. ${CHARS.chef} is pinning a new dish card onto the board. ${CHARS.style}`,
  },
  {
    id: '03-three-outlets',
    prompt: `Center of the panel: a steaming healthy chicken dish on a plate at a kitchen counter. Three bold arrows lead from the plate in three directions: top-left to a plain tidy warehouse shelf holding a row of identical plain white boxes; top-right to a large empty thought bubble above containing a small warm illustration of the same dish; bottom to a fancy glass display case with soft spotlights showing the same dish beautifully garnished. ${CHARS.style}`,
  },
  {
    id: '04-archive-room',
    prompt: `A cozy wooden archive room with shelves, an owl librarian wearing glasses guarding ${CHARS.ledger} resting open on a wooden lectern. Six different characters politely queue to read copies of the same ledger: a waiter, ${CHARS.chef}, ${CHARS.manager}, one of the ${CHARS.robots}, ${CHARS.customer}, and a safety inspector with a magnifier. The chef is reading carefully before returning to the kitchen door. ${CHARS.style}`,
  },
  {
    id: '05-no-side-notes',
    prompt: `Inside the warm restaurant kitchen, a sneaky suspicious character secretly tries to hand a small folded paper note to ${CHARS.chef}. The chef firmly waves his hand in refusal and points at ${CHARS.ledger} displayed under a glass dome on the wall, showing that the ledger is the only allowed source of information. ${CHARS.style}`,
  },
  {
    id: '06-approval-desk',
    prompt: `At a sturdy wooden approval desk, ${CHARS.chef} stands waiting nervously, holding a tray with a small controlled cooking flame and a pan on it. ${CHARS.manager} sits behind the desk, finger hovering over a big round physical button. On the wall a large clock shows time ticking away; above the button float a green check mark symbol and a red X symbol. ${CHARS.style}`,
  },
  {
    id: '07-fork-photocopy',
    prompt: `In the wooden archive room, a big friendly photocopy machine is printing out a copy of the first half of ${CHARS.ledger}, warm pages sliding out of the slot. On the right side a brand-new clean dining table: ${CHARS.chef} sits there reading the photocopied half ledger and continues cooking from that exact point. On the left the original ${CHARS.ledger} stays untouched under a glass dome. ${CHARS.style}`,
  },
  {
    id: '08-modular-kitchen',
    prompt: `A comic-style restaurant kitchen where the stove, the refrigerator and the chef workstation are each installed inside separate large crates with handles and wheels, like swap-in modules. A maintenance worker with a wrench slides one whole module crate out on rails, replacing it with a new identical-size module crate. On the wall, the wooden menu board and ${CHARS.ledger} under a glass dome remain completely untouched. ${CHARS.style}`,
  },
]

/** 带退避的生成调用 */
async function generate(apiKey, prompt) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'image-01-live',
        prompt,
        aspect_ratio: '4:3',
        response_format: 'base64',
        n: 1,
        seed: SEED,
        prompt_optimizer: false,
        style: { style_type: '漫画', style_weight: 0.8 },
      }),
      signal: AbortSignal.timeout(180_000),
    })
    const body = await res.json().catch(() => ({}))
    const status = body?.base_resp?.status_code ?? (res.ok ? 0 : -1)
    if (status === 0 && Array.isArray(body?.data?.image_base64) && body.data.image_base64.length > 0) {
      return { b64: body.data.image_base64[0], apiId: body.id }
    }
    if (status === 1002 && attempt < 4) { // 限流：退避重试
      const wait = attempt * 8000
      console.log(`  限流(1002)，${wait / 1000}s 后重试`)
      await new Promise(r => setTimeout(r, wait))
      continue
    }
    throw new Error(`生成失败 status=${status} msg=${body?.base_resp?.status_msg ?? res.status}`)
  }
  throw new Error('重试耗尽')
}

function extOf(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  throw new Error('未知的图片格式（magic bytes 不匹配）')
}

function loadManifest() {
  return existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : []
}

const args = process.argv.slice(2)
const onlyIdx = args.includes('--only') ? Number(args[args.indexOf('--only') + 1]) : undefined
const force = args.includes('--force')
const apiKey = loadKey()
mkdirSync(OUT_DIR, { recursive: true })
const manifest = loadManifest()

const t0 = Date.now()
for (let i = 0; i < PANELS.length; i++) {
  const n = i + 1
  if (onlyIdx !== undefined && n !== onlyIdx) continue
  const panel = PANELS[i]
  const existing = manifest.find(m => m.id === panel.id)
  const existingFile = existing && existsSync(resolve(OUT_DIR, `${panel.id}.${existing.ext}`))
  if (existingFile && !force) { console.log(`[${n}/8] ${panel.id} 已存在，跳过`); continue }
  const ts = Date.now()
  console.log(`[${n}/8] 生成 ${panel.id} …`)
  try {
    const { b64, apiId } = await generate(apiKey, panel.prompt)
    const buf = Buffer.from(b64, 'base64')
    const ext = extOf(buf)
    writeFileSync(resolve(OUT_DIR, `${panel.id}.${ext}`), buf)
    const entry = { id: panel.id, model: 'image-01-live', seed: SEED, apiId, ext, bytes: buf.length, ms: Date.now() - ts, prompt: panel.prompt }
    const rest = manifest.filter(m => m.id !== panel.id)
    rest.push(entry)
    writeFileSync(MANIFEST, JSON.stringify(rest, null, 2) + '\n')
    console.log(`  ✓ ${panel.id}.${ext}（${(buf.length / 1024).toFixed(0)}KB，${((Date.now() - ts) / 1000).toFixed(0)}s）`)
  } catch (error) {
    console.error(`  ✗ ${panel.id} 失败：${error.message}`)
    process.exitCode = 1
  }
}
console.log(`完成，总耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)

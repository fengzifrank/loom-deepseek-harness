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
  {
    id: '09-cordis-mall',
    prompt: `A cross-section blueprint view of a shopping mall specialized for restaurants: a long corridor with many modular shop units, each unit is a glass box plugged into shared utility sockets in the floor and ceiling (water pipes, electricity lines, glowing data cables). One shop is being unplugged by movers and its sign is dimming, while the utilities stay on for everyone else. A friendly owl building manager holds a rulebook. ${CHARS.style}`,
  },
  {
    id: '10-opening-checklists',
    prompt: `A restaurant opening ceremony scene: on a wooden desk lies a tall stack of paper checklist documents layered on top of each other, and a magical stamp press is compressing them into one single opening manual booklet. ${CHARS.manager} proudly holds the final booklet. Behind him, the restaurant interior is being assembled from flat-pack modules. ${CHARS.style}`,
  },
  {
    id: '11-chef-teams',
    prompt: `Behind a kitchen pass counter, three completely different chef teams work side by side in three interchangeable kitchen bays: a classic French chef team with tall hats, a Chinese wok master team with round hats, and a futuristic robot chef arm team. All three bays serve identical-looking dishes onto the same pass counter where ${CHARS.customer} waits. Each bay sits on wheels with big handles, ready to swap. ${CHARS.style}`,
  },
  {
    id: '12-conveyor-loop',
    prompt: `A circular conveyor belt running through the restaurant kitchen with an order card traveling along it: first station a cloud thinking station with a glowing brain, second station a tool rack station where a mechanical arm grabs utensils, third station a checkpoint station where a wise owl inspects. The order card loops around the circle multiple times until a green flag rises. ${CHARS.style}`,
  },
  {
    id: '13-recipe-card-machine',
    prompt: `${CHARS.chef} writes a single long recipe card and inserts it into a big friendly machine; inside the machine, visible through a glass window, small automated arms perform a whole sequence of cooking steps in order, using many different utensils in a row, and one finished dish comes out at the end. ${CHARS.style}`,
  },
  {
    id: '14-satellite-kitchens',
    prompt: `A main restaurant kitchen with two tiny satellite kitchen food-trucks parked beside it, connected by dumbwaiter elevators. ${CHARS.chef} hands a small task card to one satellite truck where a junior chef works; when done, the satellite truck sends back a small result box via the dumbwaiter rope. ${CHARS.style}`,
  },
  {
    id: '15-private-pods',
    prompt: `A restaurant floor with several round private dining pods, each pod containing its own dedicated waiter, its own small spice rack and utensils, and its own customer. In the center behind the pods stands one shared giant pantry room that all pods draw supplies from. ${CHARS.style}`,
  },
  {
    id: '16-summary-note',
    prompt: `In the wooden archive room, a wise owl librarian carefully glues a single bright yellow sticky note onto the front half of ${CHARS.ledger}, the note showing tiny simple food icons summarizing many pages. The original pages behind the note remain fully intact and readable. ${CHARS.style}`,
  },
  {
    id: '17-contract-goal',
    prompt: `On the restaurant wall hangs a framed long-term catering contract board with a row of small round tokens advancing along a track, like a progress board. ${CHARS.chef} works round after round checking tokens. Next to the board, a big brass alarm clock with a protective glass cover that only ${CHARS.manager} can unlock and press. ${CHARS.style}`,
  },
  {
    id: '18-appointment-bell',
    prompt: `A cozy sleeping pod where ${CHARS.chef} naps; a wall of brass service bells each connected to a small calendar wheel. One bell rings at the right moment and one of the ${CHARS.robots} gently delivers a reminder card to the pod. The chef wakes up and starts a fresh round of cooking. ${CHARS.style}`,
  },
  {
    id: '19-event-lanes',
    prompt: `A busy airport-security-style corridor inside the restaurant with multiple lanes: one wide broadcast lane where a town crier shouts news to everyone, one relay lane where staff pass a baton from person to person transforming it slightly, one strict single-file lane with a stern guard checking order. Staff and ${CHARS.robots} pick their lanes. ${CHARS.style}`,
  },
  {
    id: '20-socket-wall',
    prompt: `A large standardized socket wall in the restaurant back office with three columns of colorful universal sockets. Different appliances plug in freely: a stove plugs into one column, a fridge into another, a menu display into the third. Each socket column has a distinct icon shape: a certificate scroll, a factory gear, a shopping basket. ${CHARS.style}`,
  },
  {
    id: '21-blueprint-faces',
    prompt: `A magical architect moment: ${CHARS.manager} draws one single blueprint page, and it splits into three glowing copies flying away: one becomes a wooden menu board, one becomes a service counter window with a bell, one becomes a mini smartphone screen held by ${CHARS.customer}. All three clearly show the same dish icon. ${CHARS.style}`,
  },
  {
    id: '22-glass-window',
    prompt: `A big glass kitchen window where passersby watch ${CHARS.chef} cook live; in front of the window, multiple different screens of various sizes mirror the exact same live cooking scene from the video feed, one screen in the dining room, one mini screen at a drive-through counter, one on a home TV. ${CHARS.style}`,
  },
  {
    id: '23-safety-dome',
    prompt: `In the corner of the kitchen stands a transparent safety dome over a cooking station; inside the dome, a small controlled risky experiment cooks with sparks safely contained. ${CHARS.manager} watches through the glass with a clipboard, and a red lever next to the dome can shut everything down instantly. ${CHARS.style}`,
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

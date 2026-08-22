#!/usr/bin/env node
/**
 * 智能奶茶店漫画生成器 —— 调 MiniMax image-01-live（内置漫画风格）生成 23 幅教学漫画。
 * v2：全面奶茶店化（标准化配方 = 契约的完美隐喻）。
 *
 * 用法：
 *   node scripts/comic-gen.mjs            # 生成全部（幂等：已存在则跳过）
 *   node scripts/comic-gen.mjs --only 1   # 只生成第 1 幅（冒烟/重画）
 *   node scripts/comic-gen.mjs --force    # 全部强制重生成
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
const SEED = 20260822

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

/** 角色圣经：每幅逐字复用，保证跨图一致性（奶茶店版） */
const CHARS = {
  customer: 'a young man with short black hair wearing a blue shirt and a small backpack',
  barista: 'a chubby friendly bubble tea barista wearing a green apron, a visor cap and rubber gloves',
  manager: 'a strict manager in a dark suit holding a clipboard',
  ledger: 'a thick blue hardcover ledger book',
  robots: 'small round-headed cute robots',
  shop: 'a cozy modern bubble tea shop with jars of dark tapioca pearls, steel shaker cups, tea brewing machines and colorful sealed plastic cups',
  style: 'Japanese manga art style, clean bold outlines, expressive faces, warm colors, soft lighting. Absolutely no text, no words, no letters, no numbers, no captions anywhere in the image.',
}

const PANELS = [
  {
    id: '01-intent-vs-process',
    prompt: `Split-scene comic panel with two halves. LEFT half: ${CHARS.customer} looks overwhelmed at a messy self-service tea station, holding a long paper checklist covered in flowchart arrows and boxes, tea spilling and a shaker cup overflowing. RIGHT half: the same ${CHARS.customer} stands relaxed at the counter of ${CHARS.shop}, calmly ordering while ${CHARS.barista} confidently shakes a drink behind the counter. ${CHARS.style}`,
  },
  {
    id: '02-menu-contract',
    prompt: `A big wooden menu board hanging in ${CHARS.shop}, each drink shown only as a cup picture with tiny ingredient-proportion icons and checkmark boxes, no letters. Below the board, a wall of small standardized recipe formula cards in neat rows. In front, three ${CHARS.robots} stand at attention: one holding a precision weighing scale with a small cup on it, one holding a clipboard with green checkmarks, one holding a delivery box. ${CHARS.barista} pins a new drink card onto the board. ${CHARS.style}`,
  },
  {
    id: '03-three-outlets',
    prompt: `Center of the panel: one sealed cup of milk tea with dark tapioca pearls on the counter of ${CHARS.shop}. Three bold arrows lead from the cup in three directions: top-left to a plain tidy warehouse shelf holding a row of identical plain white boxes; top-right to a large empty thought bubble above containing a small warm illustration of the same drink; bottom to a fancy glass display fridge with soft spotlights showing the same drink beautifully presented. ${CHARS.style}`,
  },
  {
    id: '04-archive-room',
    prompt: `A cozy wooden archive room with shelves behind ${CHARS.shop}, an owl librarian wearing glasses guarding ${CHARS.ledger} resting open on a wooden lectern. Six different characters politely queue to read copies of the same ledger: a young waiter with a tray of sealed cups, ${CHARS.barista}, ${CHARS.manager}, one of the ${CHARS.robots}, ${CHARS.customer}, and a safety inspector with a magnifier. The barista is reading carefully before returning through the door to the shop. ${CHARS.style}`,
  },
  {
    id: '05-no-side-notes',
    prompt: `Inside ${CHARS.shop}, a sneaky suspicious character secretly tries to hand a small folded paper note to ${CHARS.barista}. The barista firmly waves one hand in refusal while holding a shaker cup in the other, and points at ${CHARS.ledger} displayed under a glass dome on the back wall, showing that the ledger is the only allowed source of information. ${CHARS.style}`,
  },
  {
    id: '06-approval-desk',
    prompt: `At a sturdy wooden approval desk, ${CHARS.barista} stands waiting nervously, holding a tray with a rubber stamp, a membership card and a small receipt on it. ${CHARS.manager} sits behind the desk, finger hovering over a big round physical button. On the wall a large clock shows time ticking away; above the button float a green check mark symbol and a red X symbol. ${CHARS.style}`,
  },
  {
    id: '07-fork-photocopy',
    prompt: `In the wooden archive room, a big friendly photocopy machine is printing out a copy of the first half of ${CHARS.ledger}, warm pages sliding out of the slot. On the right side a brand-new clean tea bar counter: ${CHARS.barista} stands there reading the photocopied half ledger and continues preparing a drink from that exact point, shaker cup in hand. On the left the original ${CHARS.ledger} stays untouched under a glass dome. ${CHARS.style}`,
  },
  {
    id: '08-modular-kitchen',
    prompt: `The back counter of ${CHARS.shop} where the tea brewing machine, the cup sealer machine and the tapioca topping station are each installed inside separate large crates with handles and wheels, like swap-in modules. A maintenance worker with a wrench slides one whole module crate out on rails, replacing it with a new identical-size module crate. On the wall, the wooden menu board with drink pictures and ${CHARS.ledger} under a glass dome remain completely untouched. ${CHARS.style}`,
  },
  {
    id: '09-cordis-mall',
    prompt: `A cross-section view of a lively food street mall specialized for bubble tea: a long street with many small glass-box tea stalls side by side, each stall plugged into shared utility sockets in the floor and ceiling (water pipes, electricity lines, glowing data cables). Every stall has its own colors and cup designs but identical socket shapes. One stall is being unplugged by movers and its sign is dimming, while the utilities stay on for everyone else. A friendly owl building manager holds a rulebook. ${CHARS.style}`,
  },
  {
    id: '10-opening-checklists',
    prompt: `A bubble tea shop opening ceremony scene: on a wooden desk lies a tall stack of paper checklist documents layered on top of each other, and a magical stamp press is compressing them into one single opening manual booklet. ${CHARS.manager} proudly holds the final booklet. Behind him, ${CHARS.shop} interior is being assembled from flat-pack modules by workers. ${CHARS.style}`,
  },
  {
    id: '11-chef-teams',
    prompt: `Behind one shared pass counter, three completely different tea-making teams work side by side in three interchangeable bays: a human barista team with visor caps and green aprons shaking cups by hand, a robotic tea-arm assembly line team with precise mechanical arms, and a futuristic fully-automated kiosk team glowing softly. All three bays serve identical-looking sealed cups of milk tea with pearls onto the same pass counter where ${CHARS.customer} waits. Each bay sits on wheels with big handles, ready to swap. ${CHARS.style}`,
  },
  {
    id: '12-conveyor-loop',
    prompt: `A circular conveyor belt running through ${CHARS.shop} with an order card shaped like a sealed cup traveling along it: first station a cloud thinking station with a glowing brain, second station a tool rack station where a mechanical arm grabs a shaker cup and a pearl ladle, third station a checkpoint station where a wise owl inspects the cup. The order card loops around the circle multiple times until a green flag rises at the pickup window. ${CHARS.style}`,
  },
  {
    id: '13-recipe-card-machine',
    prompt: `${CHARS.barista} writes a single long recipe formula card and inserts it into a big friendly machine shaped like a giant tea maker; inside the machine, visible through a glass window, small automated arms perform a whole sequence of steps in order: brewing tea, shaking, adding dark pearls, sealing the cup. One finished sealed cup of milk tea comes out at the end into a tray. ${CHARS.style}`,
  },
  {
    id: '14-satellite-kitchens',
    prompt: `The main counter of ${CHARS.shop} with two tiny satellite tea stalls parked beside it, small food-truck style booths connected by dumbwaiter rope elevators. ${CHARS.barista} hands a small task card to one satellite stall where a junior barista works with a mini shaker; when done, the satellite stall sends back a small sealed cup and result box via the dumbwaiter rope. ${CHARS.style}`,
  },
  {
    id: '15-private-pods',
    prompt: `The seating floor of ${CHARS.shop} with several round private VIP pods, each pod containing its own dedicated server with a small private syrup rack and custom toppings, and its own customer sipping a personalized drink. In the center behind the pods stands one shared giant pantry room with tea leaves, syrup bottles, pearl jars and cup stacks, that all pods draw supplies from. ${CHARS.style}`,
  },
  {
    id: '16-summary-note',
    prompt: `In the wooden archive room, a wise owl librarian carefully glues a single bright yellow sticky note onto the front half of ${CHARS.ledger}, the note showing tiny simple drink cup icons summarizing many pages. The original pages behind the note remain fully intact and readable. ${CHARS.style}`,
  },
  {
    id: '17-contract-goal',
    prompt: `On the wall of ${CHARS.shop} hangs a framed monthly catering contract board with a row of small round tokens advancing along a track, like a progress board. ${CHARS.barista} works round after round preparing trays of sealed cups, checking tokens. Next to the board, a big brass alarm clock with a protective glass cover that only ${CHARS.manager} can unlock and press. ${CHARS.style}`,
  },
  {
    id: '18-appointment-bell',
    prompt: `A cozy sleeping pod beside ${CHARS.shop} where ${CHARS.barista} naps; a wall of brass service bells each connected to a small calendar wheel. One bell rings at the right moment and one of the ${CHARS.robots} gently delivers a reminder card to the pod. The barista wakes up and starts a fresh round of tea making. ${CHARS.style}`,
  },
  {
    id: '19-event-lanes',
    prompt: `A busy airport-security-style corridor inside ${CHARS.shop} with multiple lanes: one wide broadcast lane where a town crier shouts news to everyone, one relay lane where staff pass a baton from person to person transforming it slightly, one strict single-file lane with a stern guard checking order. Staff and ${CHARS.robots} carrying sealed cups pick their lanes. ${CHARS.style}`,
  },
  {
    id: '20-socket-wall',
    prompt: `A large standardized socket wall in the back office of ${CHARS.shop} with three columns of colorful universal sockets. Different appliances plug in freely: a tea brewing machine plugs into one column, a fridge with milk jugs into another, a menu display screen into the third. Each socket column has a distinct icon shape: a certificate scroll, a factory gear, a shopping basket. ${CHARS.style}`,
  },
  {
    id: '21-blueprint-faces',
    prompt: `A magical architect moment: ${CHARS.manager} draws one single drink blueprint page, and it splits into three glowing copies flying away: one becomes a wooden menu board with a cup icon, one becomes an ordering counter window with a service bell, one becomes a mini smartphone screen held by ${CHARS.customer} showing the same drink icon. All three clearly show the same sealed milk tea cup icon. ${CHARS.style}`,
  },
  {
    id: '22-glass-window',
    prompt: `A big transparent glass wall of ${CHARS.shop} where passersby watch ${CHARS.barista} shake and seal cups live; in front of the glass, multiple different screens of various sizes mirror the exact same live making scene from the video feed: one large pickup status screen inside the shop, one mini screen at a drive-through counter, one on a home TV. ${CHARS.style}`,
  },
  {
    id: '23-safety-dome',
    prompt: `In the corner of ${CHARS.shop} stands a transparent safety dome over a tea experiment station; inside the dome, a small controlled risky new-recipe experiment brews with sparkles safely contained. ${CHARS.manager} watches through the glass with a clipboard, and a red lever next to the dome can shut everything down instantly. ${CHARS.style}`,
  },
  {
    id: '24-loom-dev',
    prompt: `${CHARS.manager} claps hands once and the entire ${CHARS.shop} lights up in one go: tea brewing machines, pickup screens and menu board all boot together from one big switch. Meanwhile on the right side, ${CHARS.barista} edits a recipe card, and the OLD recipe keeps serving cups on the left while a ghostly shadow copy of the shop tests the NEW card on the right before switching over seamlessly. ${CHARS.style}`,
  },
  {
    id: '25-scaffold',
    prompt: `A magical blueprint photocopier on the street: ${CHARS.manager} inserts one single template page, and the machine produces a complete tiny new bubble tea shop in a cardboard box, with a mini counter, a mini menu board and one mini barista doll coming alive, ready to open. ${CHARS.customer} watches amazed. ${CHARS.style}`,
  },
  {
    id: '26-typed-client',
    prompt: `Close-up scene: ${CHARS.customer} holds a smartphone showing a drink ordering interface with cup icons; ${CHARS.manager} has just changed a recipe card on the wall of ${CHARS.shop}, and instantly the phone screen displays a bold red warning triangle with a crossed-out cup icon, connected by a glowing arrow back to the changed recipe card. ${CHARS.style}`,
  },
  {
    id: '27-transcript-eval',
    prompt: `A grading robot sits at a wooden desk reading photocopied pages of ${CHARS.ledger} like an exam paper, stamping green check marks on each page with a big rubber stamp; nobody is cooking, yet sealed cups from the past float above the pages being re-verified one by one. Shelves of copied exam papers line the wall. ${CHARS.style}`,
  },
  {
    id: '28-openapi-dual',
    prompt: `Split panel with two halves. LEFT: ${CHARS.manager} takes a dusty old instruction manual from a neighboring old-fashioned tea shop and slides it into a converting machine, which outputs shiny new standardized recipe cards that fly onto this shop's menu wall. RIGHT: this shop's menu board automatically prints itself into a neat standardized industry menu booklet, and shopkeepers from other stalls on the street eagerly grab copies. ${CHARS.style}`,
  },
  {
    id: '29-python-bridge',
    prompt: `Outside the window of ${CHARS.shop}, a friendly chef wearing a snake-patterned apron works in a small transparent glass booth; he passes finished topping trays and syrup bottles through a small service window; ${CHARS.barista} receives them on the other side and records everything into ${CHARS.ledger}; a repair toolbox sits beside the booth. ${CHARS.style}`,
  },
  {
    id: '30-memory-layers',
    prompt: `A wooden card catalog cabinet with three drawers of different sizes inside ${CHARS.shop}: a thin top drawer holding today's chat slips, a medium middle drawer holding regular-customer preference cards marked with sugar-level and ice icons, and a thick bottom drawer holding successful recipe route cards. ${CHARS.barista} opens the middle drawer and reads a preference card before starting a new cup for a familiar customer. ${CHARS.style}`,
  },
  {
    id: '31-path-memory',
    prompt: `A failed cup with a red flag sits on the counter of ${CHARS.shop}; ${CHARS.barista} pulls an old recipe route card from a box labeled with a trophy icon, carefully tastes a tiny sample from a small spoon first to verify, then follows the card's steps. In the corner, some very dusty faded old cards are being swept into a recycle bin by a small robot. ${CHARS.style}`,
  },
  {
    id: '32-multi-user',
    prompt: `An elegant entrance gate of ${CHARS.shop} with membership card readers; two customers, a young woman and a young man, each pass through and reach their own private glowing lockers in their own distinct colors. When the man peeks toward the woman's locker area, he sees only a smooth blank wall, as if nothing exists there at all. ${CHARS.style}`,
  },
  {
    id: '33-webhook-channel',
    prompt: `At the entrance of ${CHARS.shop}, a small cute delivery robot with antenna receives sealed order bags from external delivery platform couriers in different colored uniforms; the robot stamps each bag with a wax seal and places them into an orderly queue rack that feeds directly into the tea bar workflow, where ${CHARS.barista} picks up the next stamped order. ${CHARS.style}`,
  },
  {
    id: '34-ci-gates',
    prompt: `A factory-style quality inspection conveyor line at the back door of ${CHARS.shop} with six checkpoint gates in a row, each staffed by a small robot: gate one checks an ingredient list with a magnifier, gate two assembles cup parts, gate three test-shakes a sample cup, gate four verifies stamps and seals, gate five cross-checks the printed menu booklet, gate six replays ledger pages on a mini screen. A big green flag rises at the end of the line. ${CHARS.style}`,
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
  if (existingFile && !force) { console.log(`[${n}/${PANELS.length}] ${panel.id} 已存在，跳过`); continue }
  const ts = Date.now()
  console.log(`[${n}/${PANELS.length}] 生成 ${panel.id} …`)
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

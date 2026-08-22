#!/usr/bin/env node
/**
 * 智能奶茶店大冒险 —— 教学游戏贴图生成器
 * 调 MiniMax image-01-live 生成 12 张等距/Q 版贴图（场景底图 + 角色立绘 + 道具）。
 *
 * 用法：
 *   node docs/game/gen-sprites.mjs            # 生成全部（幂等：已存在则跳过）
 *   node docs/game/gen-sprites.mjs --only 3   # 只生成第 3 张（索引从 1 开始）
 *   node docs/game/gen-sprites.mjs --force    # 全部强制重生成
 *
 * 密钥：环境变量 MINIMAX_API_KEY，或仓库根 .env.local（gitignored）。
 * 产物：docs/game/img/<id>.png|.jpg + manifest.json（生成元数据，便于复现）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT_DIR = resolve(ROOT, 'docs/game/img')
const MANIFEST = resolve(OUT_DIR, 'manifest.json')
const ENDPOINT = 'https://api.minimaxi.com/v1/image_generation'
const SEED = 20260823

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

/** 统一画风：Q 版可爱 + 干净轮廓 + 纯色背景（角色/道具方便做圆形头像牌） */
const STYLE = {
  chibi: 'Adorable chibi Q-version cartoon style, big head small body, clean bold outlines, soft cel shading, kawaii proportions, warm cozy colors, gentle rim light. The single subject is perfectly centered and fills most of the frame, on a completely flat plain single-color background with no scenery, no shadow on the background, no gradient. Absolutely no text, no words, no letters, no numbers, no logos, no watermark.',
  iso: 'Cute 2.5D isometric diorama style, chibi proportions, clean bold outlines, soft cel shading, warm cozy evening lighting, dark warm color palette with teal and amber accents, highly detailed miniature scene viewed from above at a 45 degree isometric angle. Absolutely no text, no words, no letters, no numbers, no logos, no watermark.',
}

const SPRITES = [
  {
    id: 'shop-bg', ar: '4:3', style: STYLE.iso,
    prompt: 'A cozy cute bubble tea shop interior diorama: wooden counter with a tea shaker station and cup sealing machine on it, a big wooden menu board wall with little drink cup pictures, a pickup window with hanging order tickets, two small round wooden tables with stools, shelves of tea jars and tapioca pearl containers, warm ceiling lamps glowing.',
  },
  {
    id: 'character-customer', ar: '1:1', style: STYLE.chibi,
    prompt: 'A cheerful young man customer with short black hair, wearing a light blue t-shirt and a tiny backpack, waving one hand, standing full body facing left, on a flat plain soft cream background.',
  },
  {
    id: 'character-barista', ar: '1:1', style: STYLE.chibi,
    prompt: 'A friendly chubby bubble tea barista wearing a green apron, a white visor cap and rubber gloves, holding a steel shaker cup, standing full body facing right, on a flat plain soft mint green background.',
  },
  {
    id: 'character-manager', ar: '1:1', style: STYLE.chibi,
    prompt: 'A strict but kind shop manager in a dark navy suit with glasses, holding a clipboard under one arm, standing full body facing left, on a flat plain soft lavender background.',
  },
  {
    id: 'character-robot', ar: '1:1', style: STYLE.chibi,
    prompt: 'A cute square-headed tea-making robot with a single antenna, round glowing eyes, small tank treads, holding a sealed milk tea cup, standing full body facing left, on a flat plain soft sky blue background.',
  },
  {
    id: 'character-vip-a', ar: '1:1', style: STYLE.chibi,
    prompt: 'A middle-aged gentleman VIP customer with round glasses, neat combed hair, wearing a brown cardigan sweater, hands behind his back, standing full body facing left, on a flat plain soft peach background.',
  },
  {
    id: 'character-vip-b', ar: '1:1', style: STYLE.chibi,
    prompt: 'An elegant young woman VIP customer with long dark hair, wearing a purple dress and a small handbag, standing full body facing left, on a flat plain soft pink background.',
  },
  {
    id: 'prop-ledger', ar: '1:1', style: STYLE.chibi,
    prompt: 'A thick blue hardcover ledger book with a golden tea cup emblem on the cover and a red ribbon bookmark, slightly angled to show its thick pages, on a flat plain soft cream background.',
  },
  {
    id: 'prop-tea-cup', ar: '1:1', style: STYLE.chibi,
    prompt: 'One adorable sealed plastic milk tea cup with a dome lid, a fat straw, and dark tapioca pearls visible at the bottom, tiny happy face sticker on the cup, on a flat plain soft cream background.',
  },
  {
    id: 'prop-menu-board', ar: '1:1', style: STYLE.chibi,
    prompt: 'A wooden menu board with six little colorful drink cup pictures and tiny price dot icons, framed with warm string lights, hanging straight on, on a flat plain soft cream background.',
  },
  {
    id: 'scene-counter', ar: '4:3', style: STYLE.iso,
    prompt: 'A cute isometric close-up of a bubble tea counter station: wooden counter top with a steel shaker cup, tea brewing machine with glowing buttons, a cup sealing machine, jars of dark tapioca pearls, and a small computer screen showing a big question mark glow.',
  },
  {
    id: 'scene-archive', ar: '4:3', style: STYLE.iso,
    prompt: 'A cozy isometric archive room diorama: tall dark wooden shelves filled with thick colorful hardcover ledgers, a wooden ladder, a reading lectern with one open ledger and a warm desk lamp, rolling stacks of copied pages.',
  },
]

/** 带退避的生成调用 */
async function generate(apiKey, prompt, aspectRatio) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'image-01-live',
        prompt,
        aspect_ratio: aspectRatio,
        response_format: 'base64',
        n: 1,
        seed: SEED,
        prompt_optimizer: false,
        style: { style_type: '漫画', style_weight: 0.5 },
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
for (let i = 0; i < SPRITES.length; i++) {
  const n = i + 1
  if (onlyIdx !== undefined && n !== onlyIdx) continue
  const spr = SPRITES[i]
  const existing = manifest.find(m => m.id === spr.id)
  const existingFile = existing && existsSync(resolve(OUT_DIR, `${spr.id}.${existing.ext}`))
  if (existingFile && !force) { console.log(`[${n}/${SPRITES.length}] ${spr.id} 已存在，跳过`); continue }
  const ts = Date.now()
  console.log(`[${n}/${SPRITES.length}] 生成 ${spr.id} …`)
  try {
    const { b64, apiId } = await generate(apiKey, `${spr.prompt} ${spr.style}`, spr.ar)
    const buf = Buffer.from(b64, 'base64')
    const ext = extOf(buf)
    writeFileSync(resolve(OUT_DIR, `${spr.id}.${ext}`), buf)
    const entry = { id: spr.id, model: 'image-01-live', seed: SEED, apiId, ext, bytes: buf.length, ms: Date.now() - ts, prompt: spr.prompt }
    const rest = manifest.filter(m => m.id !== spr.id)
    rest.push(entry)
    writeFileSync(MANIFEST, JSON.stringify(rest, null, 2) + '\n')
    console.log(`  ✓ ${spr.id}.${ext}（${(buf.length / 1024).toFixed(0)}KB，${((Date.now() - ts) / 1000).toFixed(0)}s）`)
  } catch (error) {
    console.error(`  ✗ ${spr.id} 失败：${error.message}`)
    process.exitCode = 1
  }
}
console.log(`完成，总耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)

/**
 * Webhook 通道的纯函数（M3）—— 签名校验 / map 求值 / 会话 key 派生。
 *
 * 从 runtime.ts 抽出以便单测（timingSafeEqual 各分支无需 boot 应用）：
 * - `verifyWebhookSignature`：x-loom-signature 头（HMAC-SHA256(rawBody) 十六进制，
 *   容忍 `sha256=` 前缀）经 node:crypto timingSafeEqual 恒时比较；
 * - `applyWebhookMap`：作者 map(payload) → 文本；抛错/非字符串统一为可 400 的错误；
 * - `webhookSessionId`：sessionKey → 稳定会话 id（同 key 命中同一会话）。
 * @module @loom-sdk/web/webhook
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** 签名校验失败原因（401 形状的 code）。 */
export type SignatureFailure =
  | 'MISSING_SIGNATURE'
  | 'MALFORMED_SIGNATURE'
  | 'SIGNATURE_MISMATCH'

/** 签名校验结论。 */
export type SignatureVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: SignatureFailure; readonly reason: string }

/** 期望的 HMAC-SHA256 十六进制长度（32 字节 → 64 个 hex 字符）。 */
const HMAC_HEX_LENGTH = 64

/**
 * 校验 x-loom-signature 头：HMAC-SHA256(secret, rawBody) 的十六进制文本。
 *
 * 容忍 GitHub 风格的 `sha256=<hex>` 前缀；十六进制大小写不敏感。
 * 比较用 timingSafeEqual（长度不等直接失败——长度本身不是秘密）。
 *
 * @param rawBody - 原始请求体字节（签名对象，不能先 JSON 解析再序列化）。
 * @param header - 请求头的值（字符串、字符串数组或缺失）。
 * @param secret - 声明的 secret（非空字符串，defineApp 已校验）。
 */
export function verifyWebhookSignature(rawBody: string | Uint8Array, header: unknown, secret: string): SignatureVerdict {
  const provided = Array.isArray(header) ? header[0] : header
  if (typeof provided !== 'string' || provided.trim() === '') {
    return { ok: false, code: 'MISSING_SIGNATURE', reason: '缺少 x-loom-signature 请求头（该通道声明了 secret，必须携带签名）' }
  }
  const normalized = provided.trim().replace(/^sha256=/i, '')
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    return { ok: false, code: 'MALFORMED_SIGNATURE', reason: `x-loom-signature 不是 64 位十六进制 HMAC-SHA256 摘要：${provided.slice(0, 20)}` }
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(normalized.toLowerCase(), 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, code: 'SIGNATURE_MISMATCH', reason: 'x-loom-signature 与请求体的 HMAC-SHA256 不匹配' }
  }
  return { ok: true }
}

/** map 求值结论。 */
export type MapVerdict =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string }

/**
 * 求值作者的 map(payload)：非字符串返回与抛错统一为可 400 的错误（不建会话）。
 * @param map - 声明的 payload → 任务文本函数。
 * @param payload - 已解析的 JSON 请求体（空体按 {}）。
 */
export function applyWebhookMap(map: (payload: Record<string, unknown>) => string, payload: Record<string, unknown>): MapVerdict {
  let text: unknown
  try {
    text = map(payload)
  } catch (error) {
    return { ok: false, error: `map 抛错：${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: `map 必须返回非空字符串，收到 ${typeof text === 'string' ? JSON.stringify(text) : typeof text}` }
  }
  return { ok: true, text: text.trim() }
}

/** 会话 key 求值结论。 */
export type KeyVerdict =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly error: string }

/**
 * 求值作者的 sessionKey(payload)：抛错/非字符串统一为可 400 的错误（不建会话）。
 * @param sessionKey - 声明的 payload → 会话 key 函数。
 * @param payload - 已解析的 JSON 请求体。
 */
export function applyWebhookSessionKey(sessionKey: (payload: Record<string, unknown>) => string, payload: Record<string, unknown>): KeyVerdict {
  let key: unknown
  try {
    key = sessionKey(payload)
  } catch (error) {
    return { ok: false, error: `sessionKey 抛错：${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof key !== 'string' || key.trim() === '') {
    return { ok: false, error: `sessionKey 必须返回非空字符串，收到 ${typeof key === 'string' ? JSON.stringify(key) : typeof key}` }
  }
  return { ok: true, key: key.trim() }
}

/**
 * sessionKey → 稳定会话 id：`session-<app>-hook-<slug>-<hash8>`。
 * slug 保留 [A-Za-z0-9_-]，其余字符折叠为 `-`；hash8 是 key 的 sha256 前 8
 * 个十六进制字符，保证不同 key 不碰撞、同 key 必然命中同一会话。
 * @param appName - 应用名。
 * @param key - sessionKey 函数返回的原始 key。
 */
export function webhookSessionId(appName: string, key: string): string {
  const slug = key.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  const hash = createHmac('sha256', appName).update(key, 'utf8').digest('hex').slice(0, 8)
  return `session-${appName}-hook-${slug === '' ? 'x' : slug}-${hash}`
}

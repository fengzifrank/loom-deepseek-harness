/**
 * M3 单测：webhook 通道的纯函数 —— 签名校验（timingSafeEqual 各分支）、
 * map/sessionKey 求值、会话 id 派生。
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { applyWebhookMap, applyWebhookSessionKey, verifyWebhookSignature, webhookSessionId } from '../src/webhook.js'

const SECRET = 'whsec_test'
const BODY = JSON.stringify({ text: '查询连河村的地类面积', topic: 'village-check' })

const sign = (body: string, secret = SECRET): string => createHmac('sha256', secret).update(body).digest('hex')

describe('verifyWebhookSignature', () => {
  it('正确签名通过', () => {
    expect(verifyWebhookSignature(BODY, sign(BODY), SECRET)).toEqual({ ok: true })
  })

  it('容忍 sha256= 前缀与十六进制大写', () => {
    expect(verifyWebhookSignature(BODY, `sha256=${sign(BODY)}`, SECRET)).toEqual({ ok: true })
    expect(verifyWebhookSignature(BODY, sign(BODY).toUpperCase(), SECRET)).toEqual({ ok: true })
  })

  it('缺头 → MISSING_SIGNATURE（含空串与数组取首元素）', () => {
    for (const header of [undefined, null, '', '   ']) {
      const verdict = verifyWebhookSignature(BODY, header, SECRET)
      expect(verdict.ok).toBe(false)
      expect(verdict.ok && true || (verdict as { code: string }).code).toBe('MISSING_SIGNATURE')
    }
    expect(verifyWebhookSignature(BODY, [], SECRET)).toMatchObject({ ok: false, code: 'MISSING_SIGNATURE' })
  })

  it('非 64 位十六进制 → MALFORMED_SIGNATURE', () => {
    expect(verifyWebhookSignature(BODY, 'not-a-signature', SECRET)).toMatchObject({ ok: false, code: 'MALFORMED_SIGNATURE' })
    expect(verifyWebhookSignature(BODY, sign(BODY).slice(0, 63), SECRET)).toMatchObject({ ok: false, code: 'MALFORMED_SIGNATURE' })
    expect(verifyWebhookSignature(BODY, `${sign(BODY)}00`, SECRET)).toMatchObject({ ok: false, code: 'MALFORMED_SIGNATURE' })
  })

  it('签名不匹配（错 secret / 错 body / 改一字节）→ SIGNATURE_MISMATCH', () => {
    expect(verifyWebhookSignature(BODY, sign(BODY, 'whsec_other'), SECRET)).toMatchObject({ ok: false, code: 'SIGNATURE_MISMATCH' })
    expect(verifyWebhookSignature(`${BODY} `, sign(BODY), SECRET)).toMatchObject({ ok: false, code: 'SIGNATURE_MISMATCH' })
    const tampered = BODY.replace('连河村', '太平河村')
    expect(verifyWebhookSignature(tampered, sign(BODY), SECRET)).toMatchObject({ ok: false, code: 'SIGNATURE_MISMATCH' })
  })

  it('对 Uint8Array 请求体同样生效（原始字节为签名对象）', () => {
    const bytes = new TextEncoder().encode(BODY)
    expect(verifyWebhookSignature(bytes, sign(BODY), SECRET)).toEqual({ ok: true })
  })
})

describe('applyWebhookMap', () => {
  it('正常返回非空字符串（trim 后）', () => {
    expect(applyWebhookMap(payload => `【webhook】${String(payload.text)}`, { text: 'x' })).toEqual({ ok: true, text: '【webhook】x' })
    expect(applyWebhookMap(() => '  padded  ', {})).toEqual({ ok: true, text: 'padded' })
  })

  it('抛错 → ok:false 且错误信息含 map 抛错（400，不建会话）', () => {
    const verdict = applyWebhookMap(() => { throw new Error('text 必须是非空字符串') }, {})
    expect(verdict.ok).toBe(false)
    expect(verdict.ok || verdict.error).toContain('map 抛错')
    expect(verdict.ok || verdict.error).toContain('text 必须是非空字符串')
  })

  it('返回非字符串/空串 → ok:false', () => {
    expect(applyWebhookMap(() => 42 as unknown as string, {}).ok).toBe(false)
    expect(applyWebhookMap(() => '', {}).ok).toBe(false)
    expect(applyWebhookMap(() => '   ', {}).ok).toBe(false)
  })
})

describe('applyWebhookSessionKey', () => {
  it('正常求值 / 抛错 / 非字符串', () => {
    expect(applyWebhookSessionKey(payload => String(payload.topic), { topic: 'a' })).toEqual({ ok: true, key: 'a' })
    expect(applyWebhookSessionKey(() => { throw new Error('no topic') }, {}).ok).toBe(false)
    expect(applyWebhookSessionKey(() => undefined as unknown as string, {}).ok).toBe(false)
    expect(applyWebhookSessionKey(() => '', {}).ok).toBe(false)
  })
})

describe('webhookSessionId', () => {
  it('同 key 稳定、不同 key 不碰撞、非法字符折叠为 -', () => {
    const a = webhookSessionId('gis-platform', 'village-check')
    expect(webhookSessionId('gis-platform', 'village-check')).toBe(a)
    expect(a).toMatch(/^session-gis-platform-hook-village-check-[0-9a-f]{8}$/)
    expect(webhookSessionId('gis-platform', 'village-check-2')).not.toBe(a)
    const weird = webhookSessionId('gis-platform', '主题/核 对:连河')
    expect(weird).toMatch(/^session-gis-platform-hook-[^/:\s]*-[0-9a-f]{8}$/)
    expect(webhookSessionId('gis-platform', '中文主题')).toMatch(/^session-gis-platform-hook-(x|[^A-Za-z0-9_-])[0-9a-f]{8}$|-[0-9a-f]{8}$/)
  })

  it('超长 key 截断到 48 字符 slug 且仍稳定', () => {
    const long = 'k'.repeat(200)
    expect(webhookSessionId('app', long)).toBe(webhookSessionId('app', long))
    expect(webhookSessionId('app', long).length).toBeLessThanOrEqual('session-app-hook-'.length + 48 + 9)
  })
})

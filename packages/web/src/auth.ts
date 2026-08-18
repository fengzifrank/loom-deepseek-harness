/**
 * Loom 多用户（M7）：身份纯函数 —— 本地账号（node:crypto scrypt，零新依赖）+
 * HMAC-SHA256 签名 token + 请求身份解析。从 runtime.ts 抽出以便单测。
 *
 * 形态：
 * - `.loom/accounts.json`：`{ username: { salt, hash, createdAt } }`（scrypt，
 *   每用户独立 salt；登录比较用 timingSafeEqual，恒时）；
 * - `.loom/auth-secret`：首次生成持久化的 HMAC 密钥（64 字节随机）；
 * - token = `base64url(JSON{u,exp}) + "." + base64url(HMAC-SHA256(secret, 前段))`，
 *   默认 7 天过期；验签恒时比较。
 *
 * 身份解析优先级（runtime.resolveUser）：`Authorization: Bearer <token>`（本地
 * 账号，HMAC 验签）→ `x-loom-user` 头 / `?user=` query（匿名 UUID，宽松格式
 * 校验）；EventSource 不能带自定义头，SSE 支持 `?token=` query 等价解析。
 * @module @loom-sdk/web/auth
 */

import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 本地账号 token 的默认有效期（7 天）。 */
export const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 匿名 UUID 的宽松格式（8-64 个 URL 安全字符；`anon-` 前缀由生成器保证）。 */
export const ANON_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/

/** 用户名的合法字符与长度（3-32；字母数字与 _ . -）。 */
export const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/

/** 密码最短长度。 */
export const PASSWORD_MIN = 8

/** 账号文件里一条记录。 */
export interface AccountRecord {
  salt: string
  hash: string
  createdAt: string
}

/** 账号文件整体形态（username → 记录）。 */
export type AccountsFile = Record<string, AccountRecord>

/** 解析出的请求身份。 */
export interface LoomIdentity {
  userId: string
  /** local = 本地账号 token；anon = 匿名 UUID。 */
  kind: 'local' | 'anon'
  /** local 身份的用户名（anon 为 undefined）。 */
  username?: string
}

// ---------------------------------------------------------------------------
// 原子写（temp + rename；与会话索引共用语义）
// ---------------------------------------------------------------------------

/**
 * 原子写文件：先写 `<file>.<random>.tmp` 再 rename（读者永远看到完整文件或
 * 旧文件）。tmp 名带随机后缀——多个并发写同一目标文件时互不踩踏（固定名
 * `.tmp` 会让两个并发 writeFile 交错内容，rename 落盘损坏 JSON）。
 */
export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

// ---------------------------------------------------------------------------
// token：base64url(payload) + "." + base64url(HMAC)
// ---------------------------------------------------------------------------

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

/** 签发一枚本地账号 token（payload 为 JSON {u: userId, exp}）。 */
export function signToken(userId: string, secret: string, ttlMs = TOKEN_TTL_MS, now = Date.now()): string {
  const payload = b64url(JSON.stringify({ u: userId, exp: now + ttlMs }))
  const mac = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${mac}`
}

/**
 * 验一枚 token：形状拆解 → HMAC 恒时比较 → 过期检查。
 * @returns userId；任何一步失败返回 null（不区分原因，不泄露信息）。
 */
export function verifyToken(token: string, secret: string, now = Date.now()): string | null {
  const dot = token.indexOf('.')
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return null
  const payload = token.slice(0, dot)
  const mac = token.slice(dot + 1)
  let expected: string
  try {
    expected = createHmac('sha256', secret).update(payload).digest('base64url')
  } catch {
    return null
  }
  const a = Buffer.from(mac, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let parsed: { u?: unknown; exp?: unknown }
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u?: unknown; exp?: unknown }
  } catch {
    return null
  }
  if (typeof parsed.u !== 'string' || typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp)) return null
  if (parsed.exp <= now) return null
  return parsed.u
}

// ---------------------------------------------------------------------------
// 密码：scrypt（N=16384 默认；64 字节派生键；每用户独立 salt）
// ---------------------------------------------------------------------------

/** scrypt 派生（十六进制；salt 十六进制）。 */
export function hashPassword(password: string, saltHex: string): string {
  return scryptSync(password, Buffer.from(saltHex, 'hex'), 64).toString('hex')
}

/** 恒时比较两段十六进制派生键。 */
export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

// ---------------------------------------------------------------------------
// 账号存储（.loom/accounts.json + .loom/auth-secret）
// ---------------------------------------------------------------------------

/** 注册/登录结论。 */
export type AccountVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

/** 本地账号存储：加载/持久化 accounts.json 与 auth-secret（内存缓存）。 */
export class AccountStore {
  private accounts: AccountsFile = {}
  private secret: string | null = null
  private loaded = false

  constructor(
    private readonly accountsFile: string,
    private readonly secretFile: string,
  ) {}

  /** 启动加载（缺文件按空；坏 JSON fail-loud——账号库不可静默重建）。 */
  async load(): Promise<void> {
    if (this.loaded) return
    try {
      this.accounts = JSON.parse(await readFile(this.accountsFile, 'utf8')) as AccountsFile
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw new Error(`loom auth: 账号文件 ${this.accountsFile} 损坏：${String(error)}`)
      this.accounts = {}
    }
    this.loaded = true
  }

  /** HMAC 密钥：首次生成 64 字节随机并以文本形态原子持久化，之后原样复用。 */
  async hmacSecret(): Promise<string> {
    if (this.secret !== null) return this.secret
    try {
      const text = (await readFile(this.secretFile, 'utf8')).trim()
      if (text === '') throw new Error('空密钥')
      this.secret = text
    } catch {
      this.secret = randomBytes(64).toString('hex')
      await mkdir(dirname(this.secretFile), { recursive: true })
      await writeFile(`${this.secretFile}.tmp`, `${this.secret}\n`, 'utf8')
      await rename(`${this.secretFile}.tmp`, this.secretFile)
    }
    return this.secret
  }

  /** 注册：用户名/密码规则校验 + 重复检查（重复如实报——注册必须可发现）。 */
  async register(username: unknown, password: unknown): Promise<AccountVerdict & { userId?: string }> {
    await this.load()
    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
      return { ok: false, error: '用户名需为 3-32 个字符（字母开头，可含数字与 _ . -）' }
    }
    if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
      return { ok: false, error: `密码至少 ${PASSWORD_MIN} 个字符` }
    }
    if (this.accounts[username] !== undefined) {
      return { ok: false, error: `用户名 "${username}" 已被注册` }
    }
    const salt = randomBytes(16).toString('hex')
    const userId = `user-${username}`
    this.accounts[username] = { salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString() }
    await atomicWriteJson(this.accountsFile, this.accounts)
    return { ok: true, userId }
  }

  /** 登录：用户名/密码恒时比较；失败统一文案（不泄露用户名存在性）。 */
  async login(username: unknown, password: unknown): Promise<AccountVerdict & { userId?: string }> {
    await this.load()
    if (typeof username !== 'string' || typeof password !== 'string') {
      return { ok: false, error: '用户名或密码不正确' }
    }
    const record = this.accounts[username]
    if (record === undefined) {
      // 恒时比较一次假目标，避免"用户名不存在"提前返回的时序差。
      safeEqualHex(hashPassword(password, '00'.repeat(16)), 'ff'.repeat(64))
      return { ok: false, error: '用户名或密码不正确' }
    }
    if (!safeEqualHex(hashPassword(password, record.salt), record.hash)) {
      return { ok: false, error: '用户名或密码不正确' }
    }
    return { ok: true, userId: `user-${username}` }
  }

  /** token 的 userId 反查用户名（me 端点用；未知返回 null）。 */
  async usernameOf(userId: string): Promise<string | null> {
    await this.load()
    if (!userId.startsWith('user-')) return null
    const username = userId.slice('user-'.length)
    return this.accounts[username] !== undefined ? username : null
  }
}

// ---------------------------------------------------------------------------
// 请求身份解析
// ---------------------------------------------------------------------------

/** 解析身份的原始输入（runtime 从 req 头与 URL query 装配）。 */
export interface IdentityInput {
  /** Authorization 头原值（可缺省）。 */
  authorization?: unknown
  /** x-loom-user 头原值（匿名 UUID）。 */
  xLoomUser?: unknown
  /** ?token= query（SSE EventSource 不能带头）。 */
  tokenQuery?: string | null
  /** ?user= query（同上）。 */
  userQuery?: string | null
  /** 本地账号 HMAC 密钥（无 auth 声明时为 undefined，token 分支跳过）。 */
  secret: string | undefined
}

/**
 * 解析请求身份：Bearer token（本地账号，HMAC 验签）→ x-loom-user / ?user=
 * （匿名 UUID，宽松格式）。全部失败 → null。
 */
export function resolveIdentity(input: IdentityInput, now = Date.now()): LoomIdentity | null {
  const auth = Array.isArray(input.authorization) ? input.authorization[0] : input.authorization
  const tokenSources = [
    typeof auth === 'string' && auth.trim().toLowerCase().startsWith('bearer ') ? auth.trim().slice(7).trim() : null,
    input.tokenQuery,
  ]
  if (input.secret !== undefined) {
    for (const token of tokenSources) {
      if (typeof token !== 'string' || token === '') continue
      const userId = verifyToken(token, input.secret, now)
      if (userId !== null) return { userId, kind: 'local' }
    }
  }
  const anonSources = [input.xLoomUser, input.userQuery]
  for (const raw of anonSources) {
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value !== 'string') continue
    const userId = value.trim()
    // `user-` 前缀是本地账号的 userId 命名空间——匿名头携带该前缀一律拒绝，
    // 否则任何人可用 `x-loom-user: user-alice` 冒充本地账号 alice（越权访问
    // 其会话与记忆）。`hook:` 机器身份含冒号，本就不满足 ANON_ID_PATTERN。
    if (userId.startsWith('user-')) continue
    if (ANON_ID_PATTERN.test(userId)) return { userId, kind: 'anon' }
  }
  return null
}

/** 生成一个新匿名 userId（`anon-<uuid>`）。 */
export function newAnonUserId(): string {
  return `anon-${randomUUID()}`
}

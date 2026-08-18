/**
 * fastapi-admin e2e 测试助手（模式照抄 examples/legacy-erp/tests/helpers.ts）：
 * ① 前置探活——老系统（8001 /openapi.json）与 Redis（6379 RESP PING）都是
 *    **外部现成进程**（demo 依赖，测试不负责起停），任一不在 → describe.skipIf
 *    整体自跳（CI 无老系统时不红，本地全跑）；
 * ② bootLoom：compose → 临时 cordis.yml → 与 `loom dev` 同路径 boot（in-process，
 *    与应用共享 process.env——401 自愈用例据此注入坏 LOOM_IMPORT_TOKEN）；
 * ③ 老系统侧直查（登录拿 token + flat username 查询）——写路径的真实落库证据。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'tsx/esm/api'

export interface BootedLoom {
  base: string
  dispose: () => Promise<void>
  /** 临时 .loom 目录（afterAll 清理用）。 */
  outDir: string
}

/**
 * e2e 共用的匿名身份头（app.auth() 声明后，POST 状态变更需要身份）。
 */
export const ANON_HEADERS: Record<string, string> = { 'x-loom-user': 'anon-fa-e2e-0001' }

const require = createRequire(import.meta.url)

/** 本测试目录 / 应用根目录（vitest cwd 可能是仓库根，故从 import.meta.url 推导）。 */
export const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url))
export const APP_DIR = resolve(TESTS_DIR, '..')

/** 老系统基址（.env 可覆盖；缺省本机 8001——demo 常驻端口）。 */
export const LEGACY_BASE = (process.env.LEGACY_BASE_URL ?? 'http://127.0.0.1:8001').replace(/\/+$/, '')
/** 老系统 REST 前缀（openapi servers[0].url = /api/v1）。 */
export const LEGACY_API_BASE = `${LEGACY_BASE}/api/v1`

/** @loom-sdk/web 包根目录（从入口 lib/index.js 上溯两级）。 */
function sdkRoot(): string {
  return resolve(require.resolve('@loom-sdk/web'), '..', '..')
}

/** lib/runtime.js 是否已构建（集成测试的前置；未构建则自跳过）。 */
export function sdkBuilt(): boolean {
  try {
    return existsSync(join(sdkRoot(), 'lib', 'runtime.js'))
  } catch {
    return false
  }
}

/** runtime.js 的 file:/// URL（与 bin/loom.js 的推导一致）。 */
export function runtimeUrl(): string {
  return pathToFileURL(join(sdkRoot(), 'lib', 'runtime.js')).href
}

let tsxRegistered = false
/** 为 .ts 应用入口注册 tsx ESM 钩子（cli 子进程用 --import tsx，这里等价补上）。 */
export function ensureTsx(): void {
  if (tsxRegistered) return
  register()
  tsxRegistered = true
}

// ---------------------------------------------------------------------------
// 前置探活（外部依赖：老系统 + Redis；失败 → skipIf 自跳）
// ---------------------------------------------------------------------------

/** 老系统探活：GET /openapi.json 200（demo 常驻 8001，测试不自起）。 */
export async function legacyBackendUp(timeoutMs = 3_000): Promise<boolean> {
  try {
    const res = await fetch(`${LEGACY_BASE}/openapi.json`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

/** Redis 探活：裸 RESP 协议发 PING 等 +PONG（不依赖 redis-cli 可执行文件）。 */
export function redisUp(port = 6379, host = '127.0.0.1', timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = net.createConnection({ host, port })
    const done = (ok: boolean): void => {
      socket.destroy()
      resolvePromise(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.on('error', () => done(false))
    socket.on('connect', () => socket.write('*1\r\n$4\r\nPING\r\n'))
    socket.on('data', buffer => done(buffer.subarray(0, 5).toString() === '+PONG'))
  })
}

// ---------------------------------------------------------------------------
// 老系统侧直查（写路径的独立证据链：测试自己登录、自己查，不经 loom）
// ---------------------------------------------------------------------------

/** 用管理员账号登录老系统换 JWT（与 loom.import-env.ts 同款端点与字段）。 */
export async function legacyLogin(user: string, pass: string): Promise<string> {
  const res = await fetch(`${LEGACY_API_BASE}/system/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: user, password: pass }),
  })
  const body = (await res.json().catch(() => null)) as { code?: number, data?: { access_token?: string } } | null
  if (!res.ok || body?.code !== 0 || typeof body.data?.access_token !== 'string') {
    throw new Error(`老系统侧登录失败：HTTP ${res.status} code=${body?.code}`)
  }
  return body.data.access_token
}

/** 老系统用户行（直查断言用）。 */
export interface LegacyUserRow {
  id: number
  username: string
  name: string | null
  status: number
  role_ids: number[] | null
}

/**
 * 老系统侧按用户名精确查用户（flat `username` query 参数——实测有效过滤；
 * 生成物导入的 `search` JSON 参数老系统不解析，测试证据链不依赖它）。
 */
export async function legacyFindUser(token: string, username: string): Promise<LegacyUserRow | undefined> {
  const qs = new URLSearchParams({ page_no: '1', page_size: '20', username })
  const res = await fetch(`${LEGACY_API_BASE}/system/user/list?${qs}`, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`老系统侧查询失败：HTTP ${res.status}`)
  const body = (await res.json()) as { code: number, msg?: string, data: null | { items: Array<{ id: number, username: string, name: string | null, status: number, role_ids: number[] | null }> } }
  if (body.code !== 0 || body.data === null) throw new Error(`老系统侧查询异常：code=${body.code}——${body.msg ?? ''}`)
  return body.data.items.find(row => row.username === username)
}

/**
 * 老系统侧轮询等用户出现（写路径的落库证据）。实测老系统 create 的 HTTP 200
 * 返回先于数据对后续读可见（SQLite 模式异步落库，实测 ~6s 延迟——老系统行为，
 * 测试只能容忍不能改动），允许链断言必须轮询而非单查。
 */
export async function waitForUserAppear(token: string, username: string, timeoutMs = 20_000): Promise<LegacyUserRow | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = await legacyFindUser(token, username)
    if (row !== undefined) return row
    if (Date.now() > deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/**
 * 老系统侧轮询确认用户在可见性窗口内始终不出现（fail-closed 证据：拒绝的写
 * 一个字没落库）。窗口取可见延迟实测值（~6s）加余量。
 */
export async function assertUserNeverAppears(token: string, username: string, windowMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + windowMs
  while (Date.now() < deadline) {
    if (await legacyFindUser(token, username) !== undefined) return false
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return true
}

// ---------------------------------------------------------------------------
// bootLoom（与 legacy-erp helpers 同模式）
// ---------------------------------------------------------------------------

export interface BootOptions {
  /** 应用入口绝对路径。 */
  appModulePath: string
  /** 应用是否声明 policy（组合加入 user-approval）。 */
  withApproval: boolean
  /** 测试端口（避免与开发实例 4645 冲突）。 */
  port: number
  /** 临时输出目录名（位于 examples/fastapi-admin 下）。 */
  outDirName: string
}

/** boot 一个 Loom 应用（与 `loom dev` 相同的 compose + boot 路径）。 */
export async function bootLoom(opts: BootOptions): Promise<BootedLoom> {
  const { composeCordisYml } = await import('@loom-sdk/web')
  const { boot } = await import('@deepseek-ai/dsh-app-boot')
  const outDir = resolve(APP_DIR, opts.outDirName)
  // 预清理（幂等）：Windows 上句柄延迟释放可能留残留；先删再建保证干净目录。
  for (const delay of [0, 300, 1000, 2500]) {
    try {
      rmSync(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      break
    } catch (error) {
      if (delay === 2500) {
        const sidecars = ['sessions-index.json', 'accounts.json', 'auth-secret', 'memory.db']
        for (const name of sidecars) {
          try {
            rmSync(join(outDir, name), { force: true, maxRetries: 10, retryDelay: 200 })
          } catch { /* 目录已不存在 */ }
        }
        console.warn(`[loom-test] ${outDir} 目录级删除失败（EPERM quirk），已清空 sidecar 后继续`)
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
    }
  }
  mkdirSync(join(outDir, 'sessions'), { recursive: true })
  const configPath = join(outDir, 'cordis.yml')
  writeFileSync(configPath, composeCordisYml({
    runtimeUrl: runtimeUrl(),
    appModuleUrl: pathToFileURL(opts.appModulePath).href,
    outDir,
    port: opts.port,
    apiPrefix: '/~loom',
    withApproval: opts.withApproval,
    withSubagent: false,
  }), 'utf8')
  const ctx = await boot(`loom-fa-test-${opts.port}`, configPath)
  return {
    base: `http://127.0.0.1:${opts.port}/~loom`,
    outDir,
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

/** 清理临时 .loom 目录（Windows 句柄释放延迟——退避重试）。 */
export function cleanupDir(dir: string): void {
  for (const delay of [0, 300, 1000, 2500, 5000]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      return
    } catch {
      if (delay === 5000) {
        console.warn(`[loom-test] 清理 ${dir} 失败（句柄占用？）`)
        return
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
    }
  }
}

/** 简易 .env 读取（只认 KEY=VALUE；缺文件返回空）。 */
export function readEnv(dir: string): Record<string, string> {
  const env: Record<string, string> = {}
  try {
    const text = readFileSync(resolve(dir, '.env'), 'utf8')
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
      env[key] = value
    }
  } catch { /* 无 .env */ }
  return env
}

// ---------------------------------------------------------------------------
// SSE 读取助手（与 gis/legacy-erp helpers 同模式）
// ---------------------------------------------------------------------------

export interface SseCollector {
  events: Array<Record<string, any>>
  close: () => void
  /** 轮询等待 predicate 命中（返回首条命中事件）；超时抛错。 */
  wait: (predicate: (e: Record<string, any>) => boolean, timeoutMs: number, label: string) => Promise<Record<string, any>>
}

/** 挂一条实时 SSE（since=-1 全量），持续收集事件。 */
export async function openEventStream(base: string, sessionId: string): Promise<SseCollector> {
  const controller = new AbortController()
  const events: Array<Record<string, any>> = []
  const res = await fetch(`${base}/sessions/${encodeURIComponent(sessionId)}/events?since=-1`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  })
  if (!res.ok || res.body === null) throw new Error(`SSE 打开失败：${res.status}`)
  void (async () => {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index: number
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          for (const line of block.split('\n')) {
            if (!line.startsWith('data: ')) continue
            try { events.push(JSON.parse(line.slice(6))) } catch { /* 非 JSON 行忽略 */ }
          }
        }
      }
    } catch { /* 连接关闭 */ }
  })()
  const wait = async (predicate: (e: Record<string, any>) => boolean, timeoutMs: number, label: string) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = events.find(predicate)
      if (hit !== undefined) return hit
      if (Date.now() > deadline) {
        throw new Error(`等待 ${label} 超时（${timeoutMs}ms）；已收到事件类型：${events.map(e => e.type).join(', ') || '(无)'}`)
      }
      await new Promise(resolve => setTimeout(resolve, 120))
    }
  }
  return { events, close: () => controller.abort(), wait }
}

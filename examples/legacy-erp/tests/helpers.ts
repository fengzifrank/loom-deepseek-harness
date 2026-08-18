/**
 * legacy-erp 集成测试助手：① 起/停模拟老系统（legacy-server，node 子进程）；
 * ② bootLoom（compose → 临时 cordis.yml → boot，与 `loom dev` 同路径，模式照抄
 * examples/gis/tests/helpers.ts）。复用本包 node_modules（dsh-* 插件在依赖里）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'tsx/esm/api'

export interface BootedLegacy {
  base: string
  dispose: () => Promise<void>
}

export interface BootedLoom {
  base: string
  dispose: () => Promise<void>
  /** 临时 .loom 目录（afterAll 清理用）。 */
  outDir: string
}

/**
 * e2e 共用的匿名身份头（app.auth() 声明后，POST 状态变更需要身份）。
 */
export const ANON_HEADERS: Record<string, string> = { 'x-loom-user': 'anon-legacy-e2e-0001' }

const require = createRequire(import.meta.url)

/** 本测试目录 / 应用根目录（vitest cwd 可能是仓库根，故从 import.meta.url 推导）。 */
export const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url))
export const APP_DIR = resolve(TESTS_DIR, '..')
/** 老系统源码与数据。 */
export const LEGACY_DIR = join(APP_DIR, 'legacy-server')
export const STATE_PATH = join(LEGACY_DIR, 'data', 'erp-state.json')
export const ERP_DB_PATH = join(LEGACY_DIR, 'data', 'erp.db')

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
// 模拟老系统：起 / 停 / 探活
// ---------------------------------------------------------------------------

export interface LegacyBootOptions {
  /** 老系统端口（避免与演示实例 4710 冲突）。 */
  port: number
  /** 额外环境变量（如 LEGACY_API_KEY）。 */
  env?: Record<string, string>
}

/** 起模拟老系统（node legacy-server/server.mjs），等 /openapi.json 可达。 */
export async function bootLegacyServer(opts: LegacyBootOptions): Promise<BootedLegacy> {
  const child: ChildProcess = spawn(process.execPath, [join(LEGACY_DIR, 'server.mjs')], {
    cwd: LEGACY_DIR,
    env: { ...process.env, PORT: String(opts.port), ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', () => undefined) // 丢弃启动横幅，防 pipe 背压
  child.stderr?.on('data', chunk => process.stderr.write(`[legacy-server] ${chunk}`))
  const base = `http://127.0.0.1:${opts.port}`
  const deadline = Date.now() + 20_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`legacy-server 提前退出（code=${child.exitCode}）`)
    try {
      const res = await fetch(`${base}/openapi.json`)
      if (res.ok) break
    } catch { /* 未就绪，继续轮询 */ }
    if (Date.now() > deadline) {
      child.kill()
      throw new Error(`legacy-server ${base} 20s 内未就绪`)
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return {
    base,
    dispose: () => new Promise<void>(resolve => {
      child.once('exit', () => resolve())
      child.kill()
      setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3000).unref()
    }),
  }
}

// ---------------------------------------------------------------------------
// bootLoom（与 gis helpers 同模式）
// ---------------------------------------------------------------------------

export interface BootOptions {
  /** 应用入口绝对路径。 */
  appModulePath: string
  /** 应用是否声明 policy（组合加入 user-approval）。 */
  withApproval: boolean
  /** 应用是否声明任一 subagent（本应用未声明，恒 false）。 */
  withSubagent?: boolean
  /** 测试端口（避免与开发中的 4640 冲突）。 */
  port: number
  /** 临时输出目录名（位于 examples/legacy-erp 下）。 */
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
    ...(opts.withSubagent === undefined ? {} : { withSubagent: opts.withSubagent }),
  }), 'utf8')
  const ctx = await boot(`loom-legacy-test-${opts.port}`, configPath)
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
// SSE 读取助手（与 gis helpers 同模式）
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

/**
 * semantica-demo 的 e2e 助手（自包含版本，boot 语义与 examples/gis/tests/helpers.ts
 * 相同，只是目录锚定在本示例）+ semantica 就绪守卫（venv + --selftest）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'tsx/esm/api'

export interface BootedLoom {
  base: string
  dispose: () => Promise<void>
  outDir: string
}

export const ANON_HEADERS: Record<string, string> = { 'x-loom-user': 'anon-semantica-e2e' }

const require = createRequire(import.meta.url)
export const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url))
export const SEM_DIR = resolve(TESTS_DIR, '..')

/** venv 的 python 绝对路径（Windows/Linux 双态）。 */
export function venvPython(): string {
  return join(SEM_DIR, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
}

function sdkRoot(): string {
  return resolve(require.resolve('@loom-sdk/web'), '..', '..')
}

export function sdkBuilt(): boolean {
  try {
    return existsSync(join(sdkRoot(), 'lib', 'runtime.js'))
  } catch {
    return false
  }
}

let tsxRegistered = false
export function ensureTsx(): void {
  if (tsxRegistered) return
  register()
  tsxRegistered = true
}

/**
 * semantica 就绪守卫（结果缓存）：venv python 存在且 py_tools.py --selftest 通过
 * （60s 超时）。任何一步失败 → false，测试自跳过（CI 或未装环境不破）。
 */
let readyCache: boolean | undefined
export function semanticaReady(): boolean {
  if (readyCache !== undefined) return readyCache
  const py = venvPython()
  if (!existsSync(py)) {
    readyCache = false
    return readyCache
  }
  const probe = spawnSync(py, [join(SEM_DIR, 'py_tools.py'), '--selftest'], {
    timeout: 60_000,
    encoding: 'utf8',
    env: { ...process.env, SEMANTICA_DISABLE_PROGRESS: '1' },
  })
  readyCache = probe.status === 0
  if (!readyCache) {
    console.warn(`[semantica-e2e] selftest 未通过（status=${probe.status}）：${String(probe.stderr).slice(0, 300)}`)
  }
  return readyCache
}

export interface BootOptions {
  appModulePath: string
  withApproval?: boolean
  withPython?: boolean
  pythonConfig?: { command: string; cwd?: string; env?: Record<string, string>; restartLimit?: number; callTimeoutMs?: number }
  port: number
  outDirName: string
}

/** boot 一个 Loom 应用（与 loom dev 相同的 compose + boot 路径）。 */
export async function bootLoom(opts: BootOptions): Promise<BootedLoom> {
  const { composeCordisYml, resolveLlm } = await import('@loom-sdk/web')
  const { boot } = await import('@deepseek-ai/dsh-app-boot')
  ensureTsx()
  const appModule = (await import(pathToFileURL(opts.appModulePath).href)) as { default?: { spec?: unknown } }
  const appSpec = appModule.default?.spec as
    | {
        model: string
        provider?: string
        providers?: Record<string, unknown>
        agents?: Array<{ model?: string }>
        mcps?: Array<Record<string, unknown>>
        skills?: { dirs: string[] }
        python?: { command: string; cwd?: string; env?: Record<string, string>; restartLimit?: number; callTimeoutMs?: number }
      }
    | undefined
  if (appSpec === undefined) throw new Error(`bootLoom: ${opts.appModulePath} 缺少 defineApp default 导出`)
  const outDir = resolve(SEM_DIR, opts.outDirName)
  for (const delay of [0, 300, 1000, 2500]) {
    try {
      rmSync(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      break
    } catch (error) {
      if (delay === 2500) throw new Error(`bootLoom 预清理 ${outDir} 失败：${String(error)}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
    }
  }
  mkdirSync(join(outDir, 'sessions'), { recursive: true })
  const configPath = join(outDir, 'cordis.yml')
  const appDir = dirname(opts.appModulePath)
  const skillDirs = appSpec.skills?.dirs.map(dir => (isAbsolute(dir) ? dir : resolve(appDir, dir)))
  writeFileSync(configPath, composeCordisYml({
    runtimeUrl: pathToFileURL(join(sdkRoot(), 'lib', 'runtime.js')).href,
    appModuleUrl: pathToFileURL(opts.appModulePath).href,
    outDir,
    port: opts.port,
    apiPrefix: '/~loom',
    withApproval: opts.withApproval ?? false,
    llm: resolveLlm(appSpec),
    ...(appSpec.mcps === undefined || appSpec.mcps.length === 0 ? {} : { mcpServers: appSpec.mcps as never }),
    ...(skillDirs === undefined ? {} : { skillDirs }),
    // python 声明优先从应用 spec 读（应用自己声明了 app.python 就不必测试再传）。
    ...(appSpec.python === undefined && (opts.withPython === undefined || !opts.withPython) ? {} : {
      withPython: true,
      pythonConfig: appSpec.python ?? opts.pythonConfig,
    }),
  }), 'utf8')
  const ctx = await boot(`loom-semantica-test-${opts.port}`, configPath)
  return {
    base: `http://127.0.0.1:${opts.port}/~loom`,
    outDir,
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

export function cleanupDir(dir: string): void {
  for (const delay of [0, 300, 1000, 2500, 5000]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      return
    } catch (error) {
      if (delay === 5000) {
        console.warn(`[loom-test] 清理 ${dir} 失败（句柄占用？）：${String(error)}`)
        return
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
    }
  }
}

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

export interface SseCollector {
  events: Array<Record<string, any>>
  close: () => void
  wait: (predicate: (e: Record<string, any>) => boolean, timeoutMs: number, label: string) => Promise<Record<string, any>>
}

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
            if (line.startsWith('data: ')) {
              try { events.push(JSON.parse(line.slice(6))) } catch { /* 非 JSON 行忽略 */ }
            }
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

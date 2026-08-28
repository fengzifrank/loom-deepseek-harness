/**
 * 集成测试的 boot 助手：compose → 写临时 cordis.yml → boot（与 `loom dev` 同路径）。
 * 复用 gis-example 的 node_modules（dsh-* 插件均在其依赖里）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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
 * e2e 共用的匿名身份头（M7：应用声明 app.auth() 后，POST 状态变更需要身份；
 * x-loom-user 携带固定匿名 UUID，全部既有 e2e 共用同一匿名用户）。
 */
export const ANON_HEADERS: Record<string, string> = { 'x-loom-user': 'anon-e2e-fixed-0001' }

const require = createRequire(import.meta.url)

/** 本测试目录 / gis 应用根目录（vitest cwd 可能是仓库根，故从 import.meta.url 推导）。 */
export const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url))
export const GIS_DIR = resolve(TESTS_DIR, '..')

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

export interface BootOptions {
  /** 应用入口绝对路径。 */
  appModulePath: string
  /** 应用是否声明 policy（组合加入 user-approval）。 */
  withApproval: boolean
  /** 应用是否声明任一 subagent（组合加入 subagent 服务缝 + spawn provider）。 */
  withSubagent?: boolean
  /** 应用是否声明 app.python（组合加入 python-bridge 行，M6）。 */
  withPython?: boolean
  /** app.python 的配置（原样透传给桥插件，M6）。 */
  pythonConfig?: {
    command: string
    cwd?: string
    env?: Record<string, string>
    restartLimit?: number
    callTimeoutMs?: number
  }
  /** 测试端口（避免与开发中的 4620 冲突）。 */
  port: number
  /** 临时输出目录名（位于 examples/gis 下）。 */
  outDirName: string
}

/** boot 一个 Loom 应用（与 `loom dev` 相同的 compose + boot 路径）。 */
export async function bootLoom(opts: BootOptions): Promise<BootedLoom> {
  const { composeCordisYml, resolveLlm } = await import('@loom-sdk/web')
  const { boot } = await import('@deepseek-ai/dsh-app-boot')
  // M11：与 dev-worker 同路径——导入应用声明解析提供方路由（官方缺省向后兼容）。
  ensureTsx()
  const appModule = (await import(pathToFileURL(opts.appModulePath).href)) as { default?: { spec?: unknown } }
  const appSpec = appModule.default?.spec as
    | {
        model: string
        provider?: string
        providers?: Record<string, unknown>
        agents?: Array<{ model?: string }>
        mcps?: Array<Record<string, unknown>>
      }
    | undefined
  if (appSpec === undefined) throw new Error(`bootLoom: ${opts.appModulePath} 缺少 defineApp default 导出`)
  const outDir = resolve(GIS_DIR, opts.outDirName)
  // 预清理（幂等）：Windows 上上一轮的 afterAll 清理可能因句柄延迟释放失败而
  // 留下残留——带着旧 sidecar 索引 boot 会改变行为（M7 起 keyed 会话会被
  // 惰性恢复而不是新建）。先删再建，保证每轮测试都是干净目录。
  // 删除带重试（rmSync 原生 maxRetries + 外层退避）：上一轮进程 dispose 后
  // Windows 句柄释放有延迟，且 rmSync 对刚写过的目录有 EPERM quirk——
  // 一次性 rmSync 直接炸掉 beforeAll 是全量连跑时的 flake 源（见 QA 冲刺）。
  for (const delay of [0, 300, 1000, 2500]) {
    try {
      rmSync(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      break
    } catch (error) {
      if (delay === 2500) {
        // 目录级删除最终失败：兜底删掉**决定 boot 行为**的 sidecar 文件
        //（旧 sessions-index.json 会让 keyed 会话被惰性恢复；旧 accounts.json
        // 会让重复注册 400；旧 memory.db/auth-secret 同理）。残留的旧会话
        // jsonl 不影响行为（新会话 id 是新 uuid，不会被引用）。
        const sidecars = ['sessions-index.json', 'accounts.json', 'auth-secret', 'memory.db']
        const failedFiles: string[] = []
        for (const name of sidecars) {
          try {
            rmSync(join(outDir, name), { force: true, maxRetries: 10, retryDelay: 200 })
          } catch {
            failedFiles.push(name)
          }
        }
        if (failedFiles.length > 0) {
          throw new Error(`bootLoom 预清理 ${outDir} 失败（目录与 sidecar 文件均无法删除：${failedFiles.join(', ')}）：EPERM`)
        }
        console.warn(`[loom-test] ${outDir} 目录级删除失败（EPERM quirk），已清空 sidecar 文件后继续 boot`)
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
    llm: resolveLlm(appSpec),
    ...(appSpec.mcps === undefined || appSpec.mcps.length === 0 ? {} : { mcpServers: appSpec.mcps as never }),
    ...(opts.withSubagent === undefined ? {} : { withSubagent: opts.withSubagent }),
    ...(opts.withPython === undefined ? {} : { withPython: opts.withPython }),
    ...(opts.pythonConfig === undefined ? {} : { pythonConfig: opts.pythonConfig }),
  }), 'utf8')
  const ctx = await boot(`loom-test-${opts.port}`, configPath)
  return {
    base: `http://127.0.0.1:${opts.port}/~loom`,
    outDir,
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

/** 清理临时 .loom 目录（Windows 上 sqlite/jsonl 句柄释放略有延迟——退避重试 + rmSync 原生 maxRetries）。 */
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
// SSE 读取助手
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

/** 有界区间读取（?since&to 的 SSE 流服务端读完即收）。 */
export async function readEventRange(base: string, sessionId: string, since: number, to: number): Promise<Array<Record<string, any>>> {
  const res = await fetch(`${base}/sessions/${encodeURIComponent(sessionId)}/events?since=${since}&to=${to}`)
  if (!res.ok) throw new Error(`读取事件区间失败：${res.status}`)
  const text = await res.text()
  const events: Array<Record<string, any>> = []
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data: ')) continue
      try {
        const payload = JSON.parse(line.slice(6)) as Record<string, any>
        if (payload.type !== 'loom/replay-end') events.push(payload)
      } catch { /* 忽略 */ }
    }
  }
  return events
}

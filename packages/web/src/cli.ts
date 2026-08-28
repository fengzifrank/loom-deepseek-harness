/**
 * loom CLI —— 单命令开发体验：
 * - `loom dev [entry] [--no-web]`：一条命令起全套——watch 主进程 + 智能体服务
 *   worker 子进程（4620）+ Vite 前端子进程（5173，[web] 前缀透传，SIGINT 级联）。
 *   入口及其相对 import 的本地 .ts/.js 变更 → 先 check 新代码（模块级导入预检），
 *   过了才优雅重启 worker；check 失败保留上一个好进程并打印错误（对齐内核 HMR
 *   "失败保旧"）。
 * - `loom build [entry]`：调 vite build（产出 dist/）。
 * - `loom start [entry]`：生产模式——智能体服务 + dist/ 静态服务同端口（4620）。
 * - `loom new <name>`：脚手架生成可跑的最小应用。
 *
 * 本文件在 bin/loom.js 的子进程里运行（node --import tsx …），worker 经 fork
 * 再拉起（tsx 加载钩子经 execArgv 继承，可动态导入 .ts 入口；IPC 走 shutdown/
 * ready/boot-failed 消息——Windows 上信号处理不可靠，IPC 是唯一优雅通道）。
 * @module @loom-sdk/web/cli
 */

import { type ChildProcess, fork, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installFailLoud } from '@deepseek-ai/dsh-app-boot'
import { collectWatchFiles } from './watch.js'
import { scaffoldApp, sdkSpecFor } from './scaffold.js'
import { runWorker, importApp, resolveEntry } from './dev-worker.js'
import { generateClient } from './client-gen.js'
import { generateOpenapi, openapiToJson, type OpenapiDocument } from './openapi-gen.js'
import {
  generateImportModule,
  parseOpenapiSource,
  summarizeImportSource,
} from './openapi-import.js'
import { httpRouteOf } from './http-route.js'
import { runEval, slimSessionLog, type EvalSpec } from './eval.js'

const NAME = 'loom'
/** worker 从退出到判定"新进程没起来"的宽限（check 已过，这里兜底 EADDRINUSE 等）。 */
const BOOT_FAIL_GRACE_MS = 15_000
/** 优雅关闭等待，超时强杀。 */
const SHUTDOWN_TIMEOUT_MS = 4_000
/** 轮询间隔与重启去抖。 */
const POLL_MS = 700
const DEBOUNCE_MS = 300

function usage(): never {
  process.stderr.write([
    `用法：`,
    `  loom dev [entry] [--no-web]   # 一条命令：智能体服务(4620) + Vite(5173)；entry 默认 ./loom.app.ts`,
    `  loom build [entry]            # vite build → dist/`,
    `  loom start [entry]            # 生产模式：服务 + dist/ 同端口静态服务`,
    `  loom new <name>               # 脚手架生成最小应用（pnpm i && pnpm loom dev）`,
    `  loom client [entry] [-o f]    # 生成类型化客户端（默认 src/loom.client.ts）`,
    `  loom openapi [entry] [-o f]   # 导出 OpenAPI 3.1.0 文档（默认打印 stdout；-o openapi.json 幂等写）`,
    `  loom import-openapi <src> [-o f] [--base url] [--include glob] [--tag t]`,
    `                                # 导入 OpenAPI 文档（URL 或本地 JSON）生成 loom.openapi.ts 工具声明`,
    `  loom eval [dir=evals]         # 跑 transcript 评测（*.eval.ts，纯本地重放，零网络零 key）`,
    `  loom eval --slim <session.jsonl> [-o f]  # 从会话日志提取精简评测夹具`,
    ``,
  ].join('\n'))
  process.exit(1)
}

/** tsx 加载钩子的解析位置（与 bin/loom.js 同法）。 */
function tsxRegisterPath(): string {
  return import.meta.resolve('tsx')
}

/** dev-worker 的编译产物路径（lib/ 里与 cli.js 同目录）。 */
const DEV_WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'dev-worker.js')

/** fork 一个 worker（serve/check 共用；tsx 经 execArgv 生效）。 */
function forkWorker(entry: string, mode: 'serve' | 'check'): ChildProcess {
  return fork(DEV_WORKER_PATH, [entry, mode], {
    execArgv: ['--import', tsxRegisterPath()],
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  })
}

/** 优雅关闭 worker：IPC shutdown → 超时强杀。 */
function shutdownWorker(child: ChildProcess): Promise<void> {
  return new Promise(resolvePromise => {
    if (child.exitCode !== null || child.signalCode !== null) return resolvePromise()
    const hardKill = setTimeout(() => {
      child.kill('SIGKILL')
    }, SHUTDOWN_TIMEOUT_MS)
    child.once('exit', () => {
      clearTimeout(hardKill)
      resolvePromise()
    })
    if (child.connected) child.send({ type: 'shutdown' })
    else child.kill('SIGKILL')
  })
}

/** app 目录的 package.json 是否声明了 vite（决定 dev 是否拉起前端）。 */
function appHasVite(appDir: string): boolean {
  const pkgPath = join(appDir, 'package.json')
  if (!existsSync(pkgPath)) return false
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> }
    return (pkg.devDependencies?.vite ?? pkg.dependencies?.vite) !== undefined
  } catch {
    return false
  }
}

/** 拉起 vite（dev / build 共用；stdout/stderr 加 [web] 前缀透传）。 */
function spawnVite(appDir: string, args: string[]): ChildProcess {
  // vite 的 exports 不含 bin 子路径：经 './package.json'（已导出）定位包根再取 bin/vite.js。
  const vitePkgJson = createRequire(join(appDir, 'package.json')).resolve('vite/package.json')
  const viteEntry = join(dirname(vitePkgJson), 'bin', 'vite.js')
  const child = spawn(process.execPath, [viteEntry, ...args], {
    cwd: appDir,
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const prefix = (chunk: Buffer): string => chunk.toString('utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => `[web] ${line}`)
    .join('\n')
  child.stdout?.on('data', chunk => process.stdout.write(`${prefix(chunk)}\n`))
  child.stderr?.on('data', chunk => process.stderr.write(`${prefix(chunk)}\n`))
  return child
}

/** 优雅关闭 vite：stdin 'q'（TTY 场景）→ kill → 超时强杀（piped stdin 下 vite 不绑快捷键）。 */
function shutdownVite(child: ChildProcess): Promise<void> {
  return new Promise(resolvePromise => {
    if (child.exitCode !== null || child.signalCode !== null) return resolvePromise()
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(hardTimer)
      clearTimeout(softTimer)
      resolvePromise()
    }
    child.once('exit', finish)
    child.stdin?.write('q')
    const softTimer = setTimeout(() => child.kill(), 600)
    const hardTimer = setTimeout(() => child.kill('SIGKILL'), SHUTDOWN_TIMEOUT_MS)
  })
}

/** 解析 `dev [entry] [--no-web]` 形态参数。 */
function parseEntryArgs(args: string[]): { entry: string | undefined; noWeb: boolean } {
  let entry: string | undefined
  let noWeb = false
  for (const arg of args) {
    if (arg === '--no-web') noWeb = true
    else if (entry === undefined) entry = arg
    else usage()
  }
  return { entry, noWeb }
}

// ---------------------------------------------------------------------------
// loom dev：watch 主进程
// ---------------------------------------------------------------------------

async function devCommand(args: string[]): Promise<void> {
  const { entry, noWeb } = parseEntryArgs(args)
  const entryPath = resolve(process.cwd(), entry ?? './loom.app.ts')
  const appDir = dirname(entryPath)
  installFailLoud(NAME)

  let worker: ChildProcess | null = null
  let workerReady = false
  let vite: ChildProcess | null = null
  let disposed = false
  let restarting = false
  let pending = false

  const shutdownAll = (signal: string): void => {
    if (disposed) return
    disposed = true
    process.stderr.write(`loom: 收到 ${signal}，正在关闭……\n`)
    const tasks: Array<Promise<void>> = []
    if (worker !== null) tasks.push(shutdownWorker(worker))
    if (vite !== null) tasks.push(shutdownVite(vite))
    void Promise.all(tasks).then(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdownAll('SIGINT'))
  process.on('SIGTERM', () => shutdownAll('SIGTERM'))

  const startWorker = (reason: string): void => {
    // 防御：同一时刻只允许一个 serve worker（旧 worker 未退尽时不再 fork）。
    if (worker !== null && worker.exitCode === null && worker.signalCode === null) {
      process.stderr.write(`loom: worker 已在运行，跳过重复拉起（${reason}）\n`)
      return
    }
    const child = forkWorker(entryPath, 'serve')
    worker = child
    const born = Date.now()
    child.on('message', (message: { type?: string; error?: string }) => {
      if (message?.type === 'ready' && worker === child) workerReady = true
    })
    child.on('exit', (code, signal) => {
      // 陈旧事件守卫：只有"当前 worker"的退出才更新状态（防换新竞态误杀引用）。
      if (disposed || worker !== child) return
      worker = null
      workerReady = false
      const tail = `exit=${code}${signal === null ? '' : ` signal=${signal}`}`
      if (!workerReady && Date.now() - born < BOOT_FAIL_GRACE_MS) {
        // 启动即失败：错误已由 worker 打印（boot-failed 语义）。
        process.stderr.write(`loom: worker 启动失败（${tail}）。修复后保存文件将自动重试。\n`)
        return
      }
      process.stderr.write(`loom: worker 退出（${tail}）。\n`)
    })
  }

  // Vite 前端（app 目录声明了 vite 且未 --no-web 才拉起）。
  if (!noWeb && appHasVite(appDir)) {
    vite = spawnVite(appDir, [])
    process.stderr.write('loom: 前端已由本命令一并拉起（Vite，http://localhost:5173）；--no-web 可跳过\n')
    vite.on('exit', (code, signal) => {
      if (!disposed && code !== 0 && signal === null) {
        process.stderr.write(`loom: [web] vite 退出（code=${code}）——前端不可用，智能体服务继续\n`)
        vite = null
      }
    })
  }

  // ---- watch：轮询 mtime（Windows 上 fs.watch 的递归/可靠性与平台相关，轮询最稳） ----
  let watchSet = collectWatchFiles(entryPath)
  const mtimes = new Map<string, number>()
  const mtimeOf = (path: string): number => {
    try {
      return Math.trunc(statSync(path).mtimeMs)
    } catch {
      return 0
    }
  }
  for (const path of watchSet) mtimes.set(path, mtimeOf(path))
  process.stderr.write(`loom: watch ${watchSet.size} 个文件（入口及其相对 import）——保存即热重启 worker\n`)

  const reload = (changed: string): void => {
    if (restarting || disposed) return
    restarting = true
    process.stderr.write(`loom: 变更 ${changed}，预检新代码…\n`)
    // ① check：新代码模块级能过吗（语法/声明期错误在此暴露）。
    const checker = forkWorker(entryPath, 'check')
    checker.on('exit', code => {
      if (disposed) return
      if (code !== 0) {
        process.stderr.write('loom: 预检失败——保留上一个好进程继续服务，修复后保存将再次尝试\n')
        restarting = false
        return
      }
      // ② check 过了：优雅停旧 → 拉新（mtime 在停旧前刷新，防止自身触发再一轮）。
      void (async () => {
        watchSet = collectWatchFiles(entryPath)
        for (const path of watchSet) mtimes.set(path, mtimeOf(path))
        if (worker !== null) {
          process.stderr.write('loom: 预检通过，重启 worker…\n')
          await shutdownWorker(worker)
          worker = null
          workerReady = false
        }
        startWorker('reload')
        restarting = false
      })()
    })
  }

  const poll = (): void => {
    if (disposed || restarting || pending) return
    for (const path of collectWatchFiles(entryPath)) {
      if (!watchSet.has(path)) {
        watchSet.add(path)
        mtimes.set(path, mtimeOf(path))
        continue
      }
      const current = mtimeOf(path)
      if (current === 0) continue // 读不到 mtime（保存瞬间的原子替换）→ 下轮再看
      const known = mtimes.get(path)
      if (known === undefined) {
        mtimes.set(path, current)
        continue
      }
      if (current > known) {
        mtimes.set(path, current)
        pending = true
        const changed = path
        setTimeout(() => {
          pending = false
          reload(changed)
        }, DEBOUNCE_MS)
        return
      }
    }
  }
  setInterval(() => poll(), POLL_MS)

  startWorker('boot')
}

// ---------------------------------------------------------------------------
// loom build / start / new
// ---------------------------------------------------------------------------

async function buildCommand(args: string[]): Promise<void> {
  const { entry } = parseEntryArgs(args)
  const entryPath = resolve(process.cwd(), entry ?? './loom.app.ts')
  const appDir = dirname(entryPath)
  if (!appHasVite(appDir)) {
    process.stderr.write(`loom: ${appDir} 的 package.json 未声明 vite——loom build 只负责前端（vite build）\n`)
    process.exit(1)
  }
  process.stderr.write('loom: vite build → dist/\n')
  const child = spawnVite(appDir, ['build'])
  child.on('exit', code => process.exit(code ?? 1))
}

async function startCommand(args: string[]): Promise<void> {
  const { entry } = parseEntryArgs(args)
  await runWorker(entry, 'start')
}

async function newCommand(args: string[]): Promise<void> {
  const raw = args[0]
  if (raw === undefined || args.length > 1) usage()
  // 名字可以是 "demo"（当前目录）或 "path/to/demo"（父目录 + 名字）。
  const name = basename(raw)
  const parentDir = resolve(process.cwd(), dirname(raw))
  const appDir = scaffoldApp({ name, parentDir, sdkSpec: sdkSpecFor(parentDir) })
  process.stdout.write(
    [
      `loom: 已生成 ${appDir}`,
      ``,
      `  cd ${raw.replaceAll('\\', '/')}`,
      `  pnpm i`,
      `  pnpm loom dev      # http://localhost:5173 聊天；health http://127.0.0.1:4620/~loom/health`,
      ``,
      `无 DEEPSEEK_API_KEY 时服务可起（health 可用），对话需在 .env 配 key（见 .env.example）。`,
      ``,
    ].join('\n'),
  )
}

// ---------------------------------------------------------------------------
// loom client：类型化客户端生成（M4）
// ---------------------------------------------------------------------------

/** 解析 `client [entry] [-o out]` 形态参数。 */
function parseClientArgs(args: string[]): { entry: string | undefined; out: string | undefined } {
  let entry: string | undefined
  let out: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '-o' || arg === '--out') {
      if (out !== undefined || index + 1 >= args.length) usage()
      out = args[++index]
    } else if (entry === undefined && !arg.startsWith('-')) {
      entry = arg
    } else {
      usage()
    }
  }
  return { entry, out }
}

async function clientCommand(args: string[]): Promise<void> {
  const { entry, out } = parseClientArgs(args)
  const entryPath = resolveEntry(entry)
  const app = await importApp(entryPath)
  const source = generateClient(app)
  const outPath = out !== undefined ? resolve(process.cwd(), out) : join(dirname(entryPath), 'src', 'loom.client.ts')
  mkdirSync(dirname(outPath), { recursive: true })
  const existed = existsSync(outPath)
  const changed = !existed || readFileSync(outPath, 'utf8') !== source
  writeFileSync(outPath, source, 'utf8')

  const httpTools = app.spec.tools.filter(tool => tool.http !== undefined)
  const skipped = app.spec.tools.filter(tool => tool.http === undefined)
  const lines = [
    changed ? `loom: 已生成 ${outPath}` : `loom: ${outPath} 已是最新（无变更）`,
    `  工具客户端 ${httpTools.length} 个：${httpTools.map(tool => `${tool.http!.method} ${httpRouteOf(tool, app.spec.apiPrefix)}`).join('，') || '(无)'}`,
  ]
  if (skipped.length > 0) lines.push(`  跳过 ${skipped.length} 个（未声明 .http()）：${skipped.map(tool => tool.name).join('，')}`)
  lines.push(`  会话客户端 agent id 联合：${app.spec.agents.map(agent => agent.id).join(' | ') || '(无 agent)'}`)
  process.stdout.write(`${lines.join('\n')}\n`)
}

// ---------------------------------------------------------------------------
// loom openapi / import-openapi：双轨互通（M5）
// ---------------------------------------------------------------------------

async function openapiCommand(args: string[]): Promise<void> {
  const { entry, out } = parseClientArgs(args)
  const entryPath = resolveEntry(entry)
  const app = await importApp(entryPath)
  const source = openapiToJson(generateOpenapi(app))

  if (out === undefined) {
    process.stdout.write(source)
    return
  }
  const outPath = resolve(process.cwd(), out)
  mkdirSync(dirname(outPath), { recursive: true })
  const existed = existsSync(outPath)
  const changed = !existed || readFileSync(outPath, 'utf8') !== source
  writeFileSync(outPath, source, 'utf8')

  const httpTools = app.spec.tools.filter(tool => tool.http !== undefined)
  process.stdout.write([
    changed ? `loom: 已生成 ${outPath}` : `loom: ${outPath} 已是最新（无变更）`,
    `  OpenAPI 3.1.0：${httpTools.length} 个 operation（${httpTools.map(tool => `${tool.http!.method} ${httpRouteOf(tool, app.spec.apiPrefix)}`).join('，') || '(无 .http() 工具)'}）`,
    `  运行时活文档 GET ${app.spec.apiPrefix}/openapi.json 与本文件同源（同一份声明驱动）`,
    '',
  ].join('\n'))
}

/** 解析 `import-openapi <src> [-o out] [--base url] [--include glob] [--tag name]`。 */
function parseImportArgs(args: string[]): {
  src: string | undefined
  out: string | undefined
  base: string | undefined
  include: string | undefined
  tag: string | undefined
} {
  let src: string | undefined
  let out: string | undefined
  let base: string | undefined
  let include: string | undefined
  let tag: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const value = (): string => {
      if (index + 1 >= args.length) usage()
      return args[++index]!
    }
    if (arg === '-o' || arg === '--out') out = value()
    else if (arg === '--base') base = value()
    else if (arg === '--include') include = value()
    else if (arg === '--tag') tag = value()
    else if (src === undefined && !arg.startsWith('-')) src = arg
    else usage()
  }
  return { src, out, base, include, tag }
}

async function importOpenapiCommand(args: string[]): Promise<void> {
  const { src, out, base, include, tag } = parseImportArgs(args)
  if (src === undefined) usage()

  // 源解析：http(s) URL → fetch（Node 24 原生）；否则本地路径。
  let text: string
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src)
    if (!res.ok) {
      process.stderr.write(`loom: 拉取 ${src} 失败：HTTP ${res.status}\n`)
      process.exit(1)
    }
    text = await res.text()
  } else {
    const srcPath = resolve(process.cwd(), src)
    try {
      text = readFileSync(srcPath, 'utf8')
    } catch (error) {
      process.stderr.write(`loom: 读取 ${srcPath} 失败：${String(error)}\n`)
      process.exit(1)
    }
  }

  let doc: OpenapiDocument
  try {
    doc = parseOpenapiSource(text, src)
  } catch (error) {
    process.stderr.write(`loom: ${String(error)}\n`)
    process.exit(1)
  }

  const source = generateImportModule(doc, {
    ...(base === undefined ? {} : { base }),
    ...(include === undefined ? {} : { include }),
    ...(tag === undefined ? {} : { tag }),
  })
  const outPath = out !== undefined ? resolve(process.cwd(), out) : resolve(process.cwd(), 'loom.openapi.ts')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, source, 'utf8')

  const summary = summarizeImportSource(doc, {
    ...(base === undefined ? {} : { base }),
    ...(include === undefined ? {} : { include }),
    ...(tag === undefined ? {} : { tag }),
  })
  const warnCount = (source.match(/^ *\/\/ WARN\(openapi-import\)/gm) ?? []).length
  process.stdout.write([
    `loom: 已生成 ${outPath}`,
    `  导入 ${summary.tools} 个工具（跳过 ${summary.skippedMethods} 个 trace/options/head；过滤 ${summary.filtered} 个）`,
    `  降级警告 ${warnCount} 条（见文件内 WARN(openapi-import) 注释）`,
    `  接入：loom.app.ts 里 import { registerImportedTools } from './${basename(outPath).replace(/\.ts$/, '')}' 后一行 registerImportedTools(app)`,
    '',
  ].join('\n'))
}

// ---------------------------------------------------------------------------
// loom eval：transcript 评测（M4；纯本地重放，零网络零 key）
// ---------------------------------------------------------------------------

/** 解析 `eval [dir]` / `eval --slim <input> [-o out]` 形态参数。 */
function parseEvalArgs(args: string[]): { dir: string; slimInput: string | undefined; out: string | undefined } {
  let dir = 'evals'
  let slimInput: string | undefined
  let out: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--slim') {
      if (index + 1 >= args.length) usage()
      slimInput = args[++index]
    } else if (arg === '-o' || arg === '--out') {
      if (index + 1 >= args.length) usage()
      out = args[++index]
    } else if (!arg.startsWith('-') && dir === 'evals' && slimInput === undefined) {
      dir = arg
    } else {
      usage()
    }
  }
  return { dir, slimInput, out }
}

/** 从一个 .eval.ts 模块里收集用例（default 导出单个/数组，或具名 export evals）。 */
function specsOfModule(mod: Record<string, unknown>, file: string): EvalSpec[] {
  const candidates: unknown[] = []
  if (mod.default !== undefined) candidates.push(mod.default)
  if (mod.evals !== undefined) candidates.push(mod.evals)
  const specs: EvalSpec[] = []
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) specs.push(...(candidate as EvalSpec[]))
    else specs.push(candidate as EvalSpec)
  }
  const valid = specs.filter(spec => spec !== null && typeof spec === 'object' && typeof (spec as EvalSpec).name === 'string')
  if (valid.length === 0) {
    throw new Error(`${file} 未导出用例——default 导出 defineEval(...) 的返回值（或具名 export const evals = [...]）`)
  }
  return valid
}

async function evalCommand(args: string[]): Promise<void> {
  const { dir, slimInput, out } = parseEvalArgs(args)

  // --slim：从会话日志提取精简夹具（评测数据准备，不跑用例）。
  if (slimInput !== undefined) {
    const inputPath = resolve(process.cwd(), slimInput)
    const lines = slimSessionLog(readFileSync(inputPath, 'utf8').split(/\r?\n/))
    const text = `${lines.join('\n')}\n`
    if (out !== undefined) {
      const outPath = resolve(process.cwd(), out)
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, text, 'utf8')
      process.stdout.write(`loom: 已提取 ${lines.length} 条精简事件 → ${outPath}\n`)
    } else {
      process.stdout.write(text)
    }
    return
  }

  const evalsDir = resolve(process.cwd(), dir)
  if (!existsSync(evalsDir)) {
    process.stderr.write(`loom: 评测目录不存在：${evalsDir}\n`)
    process.exit(1)
  }
  const files = readdirSync(evalsDir)
    .filter(file => /\.(eval\.ts|eval\.mts|eval\.js|eval\.mjs)$/.test(file))
    .sort()
  if (files.length === 0) {
    process.stderr.write(`loom: ${evalsDir} 里没有 *.eval.ts 用例\n`)
    process.exit(1)
  }

  const specs: Array<{ spec: EvalSpec; file: string }> = []
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(evalsDir, file)).href)) as Record<string, unknown>
    for (const spec of specsOfModule(mod, file)) specs.push({ spec, file })
  }

  const results = []
  for (const { spec, file } of specs) {
    const result = await runEval(spec, { fixtureDir: evalsDir })
    results.push(result)
    if (result.verdict === 'pass') {
      process.stdout.write(`✓ ${result.name}（${spec.fixture}，${result.eventCount} 事件，${result.durationMs}ms）\n`)
    } else if (result.verdict === 'pass-with-caveats') {
      process.stdout.write(`⚠ ${result.name}（${spec.fixture}，${result.eventCount} 事件）满意但有保留：\n`)
      for (const caveat of result.caveats) process.stdout.write(`    - ${caveat}\n`)
    } else {
      process.stdout.write(`✗ ${result.name}（${file}）失败：${result.error}\n`)
    }
  }
  const failed = results.filter(result => !result.ok).length
  const withCaveats = results.filter(result => result.verdict === 'pass-with-caveats').length
  const passed = results.length - failed
  const summary = withCaveats > 0
    ? `loom eval: ${passed}/${results.length} 通过（其中 ${withCaveats} 例满意但有保留 ⚠）`
    : `loom eval: ${passed}/${results.length} 通过`
  process.stdout.write(`${summary}\n`)
  if (failed > 0) process.exit(1)
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0]
  switch (command) {
    case 'dev':
      await devCommand(argv.slice(1))
      break
    case 'build':
      await buildCommand(argv.slice(1))
      break
    case 'start':
      await startCommand(argv.slice(1))
      break
    case 'new':
      await newCommand(argv.slice(1))
      break
    case 'client':
      await clientCommand(argv.slice(1))
      break
    case 'openapi':
      await openapiCommand(argv.slice(1))
      break
    case 'import-openapi':
      await importOpenapiCommand(argv.slice(1))
      break
    case 'eval':
      await evalCommand(argv.slice(1))
      break
    default:
      usage()
  }
}

await main()

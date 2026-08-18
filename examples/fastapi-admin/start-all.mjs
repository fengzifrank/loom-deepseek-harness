#!/usr/bin/env node
/**
 * fastapi-admin demo 一键启动（Task 5）：编排三进程，探活一个再起下一个。
 *
 *   [redis]  Windows 版 Redis（tporadowski 5.0.14）—— 6379 未占用则启动，
 *            探活：裸 RESP 协议发 PING 等 +PONG（不依赖 redis-cli 在 PATH）
 *   [legacy] FastapiAdmin 老系统—— 8001 未占用
 *            则 `uv run main.py run --env=dev`（带阿里云 PyPI 镜像），探活：GET
 *            /openapi.json 200（FastAPI 天然暴露——一切对接的起点）
 *   [loom]   本示例（cwd = 本文件所在目录）`loom dev`——智能体 4645 + Vite 5175，
 *            探活：GET /~loom/health 200
 *
 * 语义：**已在跑的复用并打印"复用"，只收割自己拉起的进程**——Ctrl+C 级联退出
 * 时，复用的外部实例保持不动（打印提示）。这使 start-all 既能在一台干净机器上
 * 从零拉起全套，也能嵌进"老系统本来就常驻"的真实机房环境。
 *
 * Windows 杀树：taskkill /PID <pid> /T /F（loom dev 自身还有 vite 子进程，
 * 必须杀树）；非 Windows 退回 child.kill。
 *
 * 路径配置：Redis 目录与老系统目录经环境变量注入（见下方默认值）——
 *   LOOM_DEMO_REDIS_DIR  （默认 ../tools/redis，相对本仓库上一级）
 *   LOOM_DEMO_LEGACY_DIR （默认 ../FastapiAdmin/backend）
 *
 * 用法：node start-all.mjs   （或 pnpm start / 仓库根 pnpm demo:fa）
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = dirname(fileURLToPath(import.meta.url))
const WORKSPACE_DIR = resolve(APP_DIR, '../../..')
const IS_WINDOWS = process.platform === 'win32'

/** 本机拓扑（端口即计划文件里的分配：6379/8001/4645/5175）。 */
const REDIS_PORT = 6379
const LEGACY_PORT = 8001
const LOOM_PORT = 4645
const REDIS_DIR = process.env.LOOM_DEMO_REDIS_DIR ?? resolve(WORKSPACE_DIR, 'tools/redis')
const LEGACY_DIR = process.env.LOOM_DEMO_LEGACY_DIR ?? resolve(WORKSPACE_DIR, 'FastapiAdmin/backend')
const UV_INDEX_ARGS = ['--index', 'tuna=https://mirrors.aliyun.com/pypi/simple/'] // uv run 子命令的选项（须在 run 之后）

const c = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
}
const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })
const say = (tag, msg) => console.log(`${c.dim(stamp())} ${tag} ${msg}`)
const TAGS = { redis: c.cyan('[redis]'), legacy: c.yellow('[legacy]'), loom: c.green('[loom]'), boot: c.green('[start-all]') }

// ── 探活 ────────────────────────────────────────────────────────────────────

/** Redis 探活：RESP PING → +PONG（与 tests/helpers.ts 同款，零可执行文件依赖）。 */
function redisUp(port = REDIS_PORT, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise(resolvePromise => {
    const socket = net.createConnection({ host, port })
    const done = ok => { socket.destroy(); resolvePromise(ok) }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.on('error', () => done(false))
    socket.on('connect', () => socket.write('*1\r\n$4\r\nPING\r\n'))
    socket.on('data', buffer => done(buffer.subarray(0, 5).toString() === '+PONG'))
  })
}

/** HTTP 探活（fetch + 超时；只看状态码）。 */
async function httpOk(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

/** 轮询等待 predicate 为真；超时抛错（消息由调用方给足上下文）。 */
async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`${label} 探活超时（${timeoutMs}ms）`)
    await new Promise(r => setTimeout(r, 500))
  }
}

// ── 子进程记账 ───────────────────────────────────────────────────────────────

/** 本脚本拉起（因此退出时负责收割）的子进程。 */
const spawned = []
let shuttingDown = false

/** 把子进程 stdout/stderr 按行加前缀转发（不吞、不缓冲成块）。 */
function pipeWithPrefix(child, tag, tagColored) {
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null) continue
    let buffer = ''
    stream.setEncoding('utf8')
    stream.on('data', chunk => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line !== '') say(tagColored, line)
      }
    })
  }
  return tag
}

/** 级联退出：只杀 spawned 里的（复用的外部实例不动）；幂等。 */
function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  const mine = spawned.filter(entry => entry.child.exitCode === null)
  console.log('')
  say(TAGS.boot, `${reason}——级联退出${mine.length > 0 ? `（收割自己拉起的 ${mine.length} 个进程树）` : '（本脚本未拉起任何进程）'}`)
  for (const entry of mine) {
    if (entry.child.pid === undefined) continue
    if (IS_WINDOWS) {
      // /T 杀整棵树（loom dev 下挂 vite；uv 下挂 python）；/F 强杀（演示进程不追求优雅退出）。
      spawn('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      entry.child.kill('SIGTERM')
    }
  }
  // taskkill 是异步的；给一点时间让端口释放后再退（保留已设的 process.exitCode——
  // 启动失败路径是 1，Ctrl+C 路径是 0）。
  setTimeout(() => process.exit(process.exitCode ?? 0), 1200)
}

process.on('SIGINT', () => shutdown('收到 Ctrl+C (SIGINT)'))
process.on('SIGTERM', () => shutdown('收到 SIGTERM'))

/** 拉起一个受管子进程：失败（ENOENT 等）与意外退出都立即级联。 */
function launch(name, tagColored, command, args, opts) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  const entry = { name, child }
  spawned.push(entry)
  pipeWithPrefix(child, name, tagColored)
  child.on('error', error => {
    say(tagColored, c.red(`启动失败：${error.message}`))
    shutdown(`「${name}」启动失败`)
  })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    say(tagColored, c.red(`进程意外退出（code=${code} signal=${signal ?? ''}）`))
    shutdown(`「${name}」意外退出`)
  })
  return child
}

// ── 三段编排：探活一个再起下一个 ────────────────────────────────────────────

async function ensureRedis() {
  if (await redisUp()) {
    say(TAGS.redis, `复用已在运行的 Redis（127.0.0.1:${REDIS_PORT}，PONG）——本脚本退出时不会动它`)
    return
  }
  if (!existsSync(resolve(REDIS_DIR, 'redis-server.exe'))) {
    throw new Error(`未找到 ${REDIS_DIR}\\redis-server.exe（Task 1 的解压目录）`)
  }
  say(TAGS.redis, `启动 redis-server（${REDIS_DIR}，端口 ${REDIS_PORT}）`)
  launch('redis', TAGS.redis, resolve(REDIS_DIR, 'redis-server.exe'), ['--port', String(REDIS_PORT)], { cwd: REDIS_DIR })
  await waitUntil(() => redisUp(), 15_000, 'Redis PING')
  say(TAGS.redis, `就绪：PONG（端口 ${REDIS_PORT}）`)
}

async function ensureLegacy() {
  const openapiUrl = `http://127.0.0.1:${LEGACY_PORT}/openapi.json`
  if (await httpOk(openapiUrl)) {
    say(TAGS.legacy, `复用已在运行的老系统（${openapiUrl} 可达）——本脚本退出时不会动它`)
    return
  }
  if (!existsSync(resolve(LEGACY_DIR, 'main.py'))) {
    throw new Error(`未找到 ${LEGACY_DIR}\\main.py（Task 2 克隆的 FastapiAdmin）`)
  }
  // uv 在本机 Python Scripts 目录（D:\python13\Scripts）；子进程继承 PATH 即可解析，
  // 但显式兜底常见位置，报错信息给出明确修法。
  const uvCandidates = ['uv', 'D:\\python13\\Scripts\\uv.exe']
  const uv = uvCandidates.find(candidate => candidate === 'uv' || existsSync(candidate)) ?? 'uv'
  say(TAGS.legacy, `启动老系统（cwd ${LEGACY_DIR}，uv run main.py run --env=dev，端口 ${LEGACY_PORT}）`)
  launch('legacy', TAGS.legacy, uv, ['run', ...UV_INDEX_ARGS, 'main.py', 'run', '--env=dev'], { cwd: LEGACY_DIR })
  await waitUntil(() => httpOk(openapiUrl), 180_000, `老系统 ${openapiUrl}`)
  say(TAGS.legacy, `就绪：GET /openapi.json 200（对接的起点文档已可达）`)
}

async function ensureLoom() {
  const healthUrl = `http://127.0.0.1:${LOOM_PORT}/~loom/health`
  const loomJs = resolve(APP_DIR, 'node_modules', '@loom-sdk', 'web', 'bin', 'loom.js')
  if (await httpOk(healthUrl)) {
    say(TAGS.loom, `复用已在运行的 loom dev（${healthUrl} 可达）——本脚本退出时不会动它`)
    return
  }
  if (!existsSync(loomJs)) {
    throw new Error(`未找到 ${loomJs}（先在仓库根 pnpm install && pnpm build:sdk）`)
  }
  // 与 node_modules/.bin/loom.CMD 同款启动方式：node + 包内 bin/loom.js，
  // 并设 NODE_PATH 指向 pnpm 虚拟 store 的平铺 node_modules。
  const env = { ...process.env }
  const nodePath = 'F:\\deepseek\\loom\\node_modules\\.pnpm\\node_modules'
  env.NODE_PATH = env.NODE_PATH !== undefined && env.NODE_PATH !== '' ? `${nodePath};${env.NODE_PATH}` : nodePath
  say(TAGS.loom, `启动 loom dev（智能体 ${LOOM_PORT} + Vite 5175）`)
  launch('loom', TAGS.loom, process.execPath, [loomJs, 'dev'], { cwd: APP_DIR, env })
  await waitUntil(() => httpOk(healthUrl, 4000), 120_000, `loom ${healthUrl}`)
  say(TAGS.loom, `就绪：GET /~loom/health 200`)
}

async function main() {
  say(TAGS.boot, 'fastapi-admin demo 一键启动：Redis → 老系统 → loom dev（探活一个再起下一个）')
  await ensureRedis()
  await ensureLegacy()
  await ensureLoom()
  console.log('')
  say(TAGS.boot, '三进程就绪——demo 入口：')
  console.log(`    前端（浏览器打开）    http://localhost:5175`)
  console.log(`    智能体服务            http://127.0.0.1:${LOOM_PORT}/~loom/health`)
  console.log(`    老系统（FastapiAdmin） http://127.0.0.1:${LEGACY_PORT}/docs`)
  console.log(`    Redis                 127.0.0.1:${REDIS_PORT}`)
  console.log(c.dim('    Ctrl+C 级联退出（只收割本脚本拉起的进程；复用的外部实例保持不动）'))
}

main().catch(error => {
  say(TAGS.boot, c.red(`启动失败：${error instanceof Error ? error.message : String(error)}`))
  shutdown('启动失败')
  process.exitCode = 1
})

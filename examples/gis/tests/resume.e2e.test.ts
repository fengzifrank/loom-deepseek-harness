/**
 * M7 Part A e2e：会话持久化恢复（重启不失忆）。
 *
 * 证据链（真实进程，非 in-process dispose）：
 * 1. 起 dev-worker 子进程（与 `loom dev` 同路径）→ 建会话发消息（真 key）→
 *    等 turn/end completed；
 * 2. **SIGKILL 硬杀进程** → 重新 boot 同一 outDir（同一 .loom/sessions）；
 * 3. GET /agents/:id/sessions 列出该会话（sidecar 索引，title=首条消息前缀）；
 * 4. GET events?since=0 完整历史重现（首条 user/message 还在）；
 * 5. POST message 同一 sessionId 续聊 → 助手记得第一段对话的内容（agents.resume
 *    惰性恢复 + 会话日志续写）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GIS_DIR, cleanupDir, readEnv, sdkBuilt } from './helpers.js'

const env = readEnv(GIS_DIR)
const hasKey = process.env.DEEPSEEK_API_KEY !== undefined || env.DEEPSEEK_API_KEY !== undefined
if (process.env.DEEPSEEK_API_KEY === undefined && env.DEEPSEEK_API_KEY !== undefined) {
  process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY
}

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE_DIR = resolve(TESTS_DIR, 'fixtures', 'resume')
const PORT = 4627
const BASE = `http://127.0.0.1:${PORT}/~loom`
const require = createRequire(import.meta.url)

/** dev-worker 的编译产物路径（与 cli.ts 的 fork 同法）。 */
function devWorkerPath(): string {
  const sdkRoot = dirname(dirname(require.resolve('@loom-sdk/web')))
  return join(sdkRoot, 'lib', 'dev-worker.js')
}

interface WorkerHandle {
  child: ChildProcess
  stderr: string[]
}

/** 起一个真实 worker 进程并等 health 就绪（硬杀 → 重启即换进程）。 */
async function bootWorker(): Promise<WorkerHandle> {
  const child = spawn(process.execPath, ['--import', 'tsx', devWorkerPath(), 'loom.app.mjs', 'serve'], {
    cwd: FIXTURE_DIR,
    env: process.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const stderr: string[] = []
  child.stderr?.on('data', chunk => stderr.push(String(chunk)))
  const deadline = Date.now() + 60_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`worker 提前退出（code=${child.exitCode}）：\n${stderr.join('').slice(-2000)}`)
    try {
      const res = await fetch(`${BASE}/health`)
      if (res.ok) return { child, stderr }
    } catch { /* 还没就绪 */ }
    if (Date.now() > deadline) throw new Error(`worker 60s 未就绪：\n${stderr.join('').slice(-2000)}`)
    await new Promise(resolve => setTimeout(resolve, 400))
  }
}

/** 读一条会话的完整历史（有界 SSE：since=-1&to=∞ 服务端读完即收，不会挂住）。 */
async function readAllEvents(sessionId: string): Promise<Array<Record<string, any>>> {
  const res = await fetch(`${BASE}/agents/memory-keeper/sessions/${encodeURIComponent(sessionId)}/events?since=-1&to=1000000000`)
  if (!res.ok) throw new Error(`events 读取失败：${res.status}`)
  const text = await res.text()
  const events: Array<Record<string, any>> = []
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data: ')) continue
      try {
        const payload = JSON.parse(line.slice(6)) as Record<string, any>
        if (payload.type !== 'loom/replay-end') events.push(payload)
      } catch { /* 心跳注释行 */ }
    }
  }
  return events
}

describe.skipIf(!hasKey || !sdkBuilt())('M7 会话持久化恢复 e2e（杀进程 → 同 outDir 重启 → 续聊）', () => {
  let worker: WorkerHandle | undefined
  let sessionId = ''
  let firstTurnAssistantText = ''

  beforeAll(() => {
    rmSync(join(FIXTURE_DIR, '.loom'), { recursive: true, force: true })
  })

  afterAll(() => {
    worker?.child.kill()
    // Windows 句柄延迟释放 quirk：kill 后立即 rmSync 常 EPERM——退避重试兜底
    // （一次性 rmSync 直接炸掉 afterAll 是全量连跑时的 flake 源，见 QA 冲刺）。
    cleanupDir(join(FIXTURE_DIR, '.loom'))
  })

  it('第一段：boot → 建会话发消息 → turn/end completed', async () => {
    worker = await bootWorker()
    const created = await fetch(`${BASE}/agents/memory-keeper/sessions`, { method: 'POST' })
    expect(created.status).toBe(200)
    const { sessionId: sid } = (await created.json()) as { sessionId: string }
    sessionId = sid
    expect(sid).toMatch(/^session-resume-fixture-/)

    // 先开实时 SSE 再发消息（完整收集第一个 turn）。
    const controller = new AbortController()
    const collected: Array<Record<string, any>> = []
    const sse = await fetch(`${BASE}/agents/memory-keeper/sessions/${encodeURIComponent(sid)}/events?since=-1`, { signal: controller.signal })
    void (async () => {
      const reader = sse.body!.getReader()
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
                try { collected.push(JSON.parse(line.slice(6))) } catch { /* 忽略 */ }
              }
            }
          }
        }
      } catch { /* 连接关闭 */ }
    })()

    const sent = await fetch(`${BASE}/agents/memory-keeper/sessions/${encodeURIComponent(sid)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '我叫小明，我家住在连河村。请记住这两件事，然后一句话确认。' }),
    })
    expect(sent.status).toBe(200)

    const deadline = Date.now() + 180_000
    for (;;) {
      const turnEnd = collected.find(e => e.type === 'turn/end' && String(e.reason?.kind ?? e.reason) === 'completed')
      if (turnEnd !== undefined) break
      if (Date.now() > deadline) throw new Error(`等 turn/end 超时；已收到：${collected.map(e => e.type).join(', ')}`)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    firstTurnAssistantText = collected.filter(e => e.type === 'assistant/message').map(e => String(e.text)).join(' ')
    expect(firstTurnAssistantText).not.toBe('')
    controller.abort()
  }, 240_000)

  it('第二段：SIGKILL 硬杀 → 同一 outDir 重新 boot → 历史完整重现', async () => {
    // 稳定窗口：jsonl 持久化对 turn 尾部事件是异步落盘的——真实世界的"重启"
    // 发生在 turn 完成（含落盘）之后，而不是落盘进行中的毫秒级窗口；等 1.5s
    // 再杀，对齐真实场景（内核 flush 语义不在本测试的检验范围）。
    await new Promise(resolve => setTimeout(resolve, 1500))
    // 硬杀（Windows 上 SIGTERM 会被 dev-worker 的优雅关闭处理器接住——SIGKILL
    // 不可捕获，走 TerminateProcess，无优雅落盘机会——考验持久化）。
    worker!.child.kill('SIGKILL')
    console.error('[resume-e2e] SIGKILL 已发')
    await new Promise<void>(resolve => {
      if (worker!.child.exitCode !== null) return resolve()
      worker!.child.on('exit', () => resolve())
      setTimeout(resolve, 5000) // 兜底：进程死后句柄不触发时继续（端口已释放）
    })
    console.error('[resume-e2e] 旧进程已退，重新 boot')

    // 诊断：杀进程后看磁盘上会话日志落了多少事件（durability 证据）。
    try {
      const { readdirSync, readFileSync, statSync } = await import('node:fs')
      const sessionsRoot = join(FIXTURE_DIR, '.loom', 'sessions')
      const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
        const p = join(dir, name)
        return statSync(p).isDirectory() ? walk(p) : [p]
      })
      for (const file of walk(sessionsRoot)) {
        const types = readFileSync(file, 'utf8').split('\n').filter(Boolean)
          .map(line => { try { return String(JSON.parse(line).type) } catch { return '?' } })
        console.error(`[resume-e2e] 磁盘日志 ${file.split(/[\\/]/).pop()}：${types.length} 行（${types.join(',')}）`)
      }
    } catch (error) {
      console.error(`[resume-e2e] 磁盘日志读取失败：${String(error)}`)
    }

    worker = await bootWorker()
    console.error('[resume-e2e] 新进程就绪')

    // sidecar 索引在重启后仍列出该会话（title = 首条用户消息前缀）。
    const list = await fetch(`${BASE}/agents/memory-keeper/sessions`)
    console.error('[resume-e2e] 会话列表已取')
    expect(list.status).toBe(200)
    const body = (await list.json()) as { sessions: Array<{ sessionId: string; title: string; updatedAt: string }> }
    const mine = body.sessions.find(session => session.sessionId === sessionId)
    expect(mine).toBeDefined()
    expect(mine!.title).toContain('小明')

    // 完整历史重现（since=0 起）：首条 user/message 与助手答复都在。
    const events = await readAllEvents(sessionId)
    console.error(`[resume-e2e] 历史已重放（${events.length} 条）`)
    const userTexts = events.filter(e => e.type === 'user/message').map(e => String(e.text))
    expect(userTexts.some(text => text.includes('我叫小明'))).toBe(true)
    const assistantTexts = events.filter(e => e.type === 'assistant/message').map(e => String(e.text)).join(' ')
    expect(assistantTexts).not.toBe('')
  }, 120_000)

  it('第三段：同 sessionId 续聊 → 助手记得第一段对话（惰性 resume）', async () => {
    const controller = new AbortController()
    const collected: Array<Record<string, any>> = []
    const sse = await fetch(`${BASE}/agents/memory-keeper/sessions/${encodeURIComponent(sessionId)}/events?since=-1`, { signal: controller.signal })
    void (async () => {
      const reader = sse.body!.getReader()
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
                try { collected.push(JSON.parse(line.slice(6))) } catch { /* 忽略 */ }
              }
            }
          }
        }
      } catch { /* 连接关闭 */ }
    })()

    // 等历史重放收尾（首条 user/message 已到 + 稳定 1s），记下基线 seq——
    // 续聊断言只看基线之后的新事件，避免拿第一段的历史答案冒充。
    const replayDeadline = Date.now() + 20_000
    for (;;) {
      if (collected.some(e => e.type === 'user/message')) break
      if (Date.now() > replayDeadline) throw new Error('重启后历史重放未到达')
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
    const baselineSeq = collected.reduce((max, e) => Math.max(max, typeof e.seq === 'number' ? e.seq : max), 0)

    const sent = await fetch(`${BASE}/agents/memory-keeper/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '重启之后考考你：我叫什么名字？住在哪个村？只回答这两个答案。' }),
    })
    expect(sent.status).toBe(200)

    const deadline = Date.now() + 180_000
    for (;;) {
      const turnEnd = collected.find(e => e.type === 'turn/end' && typeof e.seq === 'number' && e.seq > baselineSeq && String(e.reason?.kind ?? e.reason) === 'completed')
      if (turnEnd !== undefined) break
      if (Date.now() > deadline) throw new Error(`等续聊 turn/end 超时；已收到：${collected.map(e => e.type).join(', ')}`)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    const newUser = collected.filter(e => e.type === 'user/message' && e.seq > baselineSeq).map(e => String(e.text)).join(' ')
    expect(newUser).toContain('考考你')
    const answer = collected.filter(e => e.type === 'assistant/message' && e.seq > baselineSeq).map(e => String(e.text)).join(' ')
    expect(answer).toContain('小明')
    expect(answer).toContain('连河村')
    controller.abort()
  }, 240_000)

  it('收尾证据：持久化文件确实在 fixture 的 .loom 下', () => {
    expect(existsSync(join(FIXTURE_DIR, '.loom', 'sessions-index.json'))).toBe(true)
  })
})

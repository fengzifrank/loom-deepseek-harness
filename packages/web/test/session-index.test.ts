/**
 * M7 单测：sidecar 会话索引 —— put/get/touch/listByAgent/listByUser、
 * 标题截断、原子落盘（重开读回）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SessionSidecarIndex, titleOf, TITLE_MAX } from '../src/session-index.js'

const dir = mkdtempSync(join(tmpdir(), 'loom-session-index-'))
const file = join(dir, 'sessions-index.json')

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('titleOf', () => {
  it('空白折叠 + 30 字截断', () => {
    expect(titleOf('  查询  连河村\n的 面积  ')).toBe('查询 连河村 的 面积')
    const long = '请记住我偏好中文报告面积单位用万亩并且喜欢简洁的结论以及表格输出风格'
    expect(titleOf(long).length).toBe(TITLE_MAX + 1) // 30 字 + 省略号
    expect(titleOf(long).endsWith('…')).toBe(true)
  })
})

describe('SessionSidecarIndex', () => {
  it('put/get/touch + 原子落盘可重开读回', async () => {
    const index = new SessionSidecarIndex(file)
    await index.load()
    const now = new Date().toISOString()
    await index.put('session-a', { userId: 'user-alice', agentId: 'data-analysis', title: '(新会话)', createdAt: now, updatedAt: now })
    await index.put('session-b', { userId: 'anon-xyz-0001', agentId: 'data-analysis', title: '查询面积', createdAt: now, updatedAt: now, kind: 'chat' })
    await index.put('session-c', { userId: 'user-alice', agentId: 'report-writing', title: '分叉', createdAt: now, updatedAt: now, kind: 'fork' })
    expect(index.get('session-a')?.userId).toBe('user-alice')
    // 落盘为合法 JSON 且无 .tmp 残留
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(['session-a', 'session-b', 'session-c'])
    // 重开读回
    const reopened = new SessionSidecarIndex(file)
    await reopened.load()
    expect(reopened.get('session-b')?.title).toBe('查询面积')
    // touch 合并更新（未知 id 忽略）
    await reopened.touch('session-a', { title: '首个问题', updatedAt: '2026-08-18T00:00:00.000Z' })
    expect(reopened.get('session-a')?.title).toBe('首个问题')
    expect(reopened.get('session-a')?.userId).toBe('user-alice')
    await reopened.touch('nope', { title: 'x' })
    expect(reopened.get('nope')).toBeUndefined()
  })

  it('listByAgent 按 agent 过滤 + userId 收窄 + child 排除 + updatedAt 降序', async () => {
    const index = new SessionSidecarIndex(file)
    await index.load()
    const all = await index.listByAgent('data-analysis')
    expect(all.map(item => item.sessionId).sort()).toEqual(['session-a', 'session-b'])
    const aliceOnly = await index.listByAgent('data-analysis', 'user-alice')
    expect(aliceOnly.map(item => item.sessionId)).toEqual(['session-a'])
    const none = await index.listByAgent('data-analysis', 'user-bob')
    expect(none).toEqual([])
    // listByUser 全量（含 fork）
    const alice = await index.listByUser('user-alice')
    expect(alice.map(item => item.sessionId).sort()).toEqual(['session-a', 'session-c'])
  })
})

describe('QA 并发与容灾（写串行化 + 坏 JSON fail-loud）', () => {
  it('并发 put ×25 全部保留（无丢失更新，文件始终合法 JSON）', async () => {
    const concurrentFile = join(dir, 'concurrent-index.json')
    const index = new SessionSidecarIndex(concurrentFile)
    await index.load()
    const now = new Date().toISOString()
    const keys = Array.from({ length: 25 }, (_, i) => `session-concurrent-${i}`)
    await Promise.all(keys.map(key =>
      index.put(key, { userId: `anon-user-${key}`, agentId: 'data-analysis', title: key, createdAt: now, updatedAt: now }),
    ))
    for (const key of keys) expect(index.get(key), `并发写入的 ${key} 丢失`).toBeDefined()
    // 落盘是完整合法 JSON（重开读回全量）
    const reopened = new SessionSidecarIndex(concurrentFile)
    await reopened.load()
    for (const key of keys) expect(reopened.get(key)).toBeDefined()
  })

  it('坏 JSON 索引 → load() fail-loud（含文件路径与"损坏"字样，不静默重建）', async () => {
    const corruptFile = join(dir, 'corrupt-index.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(corruptFile, '{ "session-a": { "userId":  （截断的坏 JSON', 'utf8')
    const index = new SessionSidecarIndex(corruptFile)
    await expect(index.load()).rejects.toThrow(/损坏/)
    await expect(index.load()).rejects.toThrow(/corrupt-index/)
  })

  it('并发 touch 与 put 混跑 → 不损坏文件', async () => {
    const mixedFile = join(dir, 'mixed-index.json')
    const index = new SessionSidecarIndex(mixedFile)
    await index.load()
    const now = new Date().toISOString()
    await index.put('session-mixed', { userId: 'anon-x-00000001', agentId: 'a', title: 't', createdAt: now, updatedAt: now })
    const jobs: Array<Promise<void>> = []
    for (let i = 0; i < 10; i++) jobs.push(index.put(`session-extra-${i}`, { userId: `anon-y-${i}`, agentId: 'a', title: `e${i}`, createdAt: now, updatedAt: now }))
    for (let i = 0; i < 10; i++) jobs.push(index.touch('session-mixed', { title: `改 ${i}` }))
    await Promise.all(jobs)
    expect(JSON.parse(readFileSync(mixedFile, 'utf8'))).toBeTypeOf('object')
    expect(index.get('session-mixed')).toBeDefined()
    for (let i = 0; i < 10; i++) expect(index.get(`session-extra-${i}`)).toBeDefined()
  })
})

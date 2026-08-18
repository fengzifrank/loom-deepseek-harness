/**
 * Loom 会话 sidecar 索引（M7）：`.loom/sessions-index.json`。
 *
 * `{ sessionId: { userId, agentId, title, createdAt, updatedAt, kind? } }`——
 * 会话创建时写入，惰性恢复（重启后 ownedSessions 未命中）时读取。内存缓存 +
 * 启动加载 + 原子写（temp + rename）。标题取首条用户消息前 30 字。
 * @module @loom-sdk/web/session-index
 */

import { readFile } from 'node:fs/promises'
import { atomicWriteJson } from './auth.js'

/** 会话类别：chat = 可恢复对话；fork = 只读回放分叉；child = subagent 子会话。 */
export type SessionIndexKind = 'chat' | 'fork' | 'child'

/** 索引里的一条会话记录。 */
export interface SessionIndexRecord {
  /** 会话归属用户（本地账号 userId 或匿名 UUID）。 */
  userId: string
  /** 创建该会话的 agent id（fork/child 为其父系 agent）。 */
  agentId: string
  /** 标题（首条用户消息前 30 字；未发言时为占位）。 */
  title: string
  createdAt: string
  updatedAt: string
  /** 缺省 chat。 */
  kind?: SessionIndexKind
}

/** 索引文件整体形态。 */
export type SessionsIndexFile = Record<string, SessionIndexRecord>

/** 标题截断长度（首条用户消息前 30 字）。 */
export const TITLE_MAX = 30

/** 由首条用户消息派生标题（空白折叠 + 前 30 字截断）。 */
export function titleOf(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= TITLE_MAX ? normalized : `${normalized.slice(0, TITLE_MAX)}…`
}

/**
 * sidecar 会话索引：内存缓存 + 落盘原子写。boot 时 load() 一次；之后 get 走
 * 缓存（同步），put/touch 更新缓存并写盘。
 *
 * 并发安全：put/touch 共享缓存 Map（set 之后序列化的是全量快照），但两个
 * 并发写盘的"序列化快照 → 落盘 rename"交错会丢失后写者之外的一方——
 * `writeChain` 把落盘排成串行链（每个写等上一个 rename 完成再取最新快照），
 * 保证并发 put 全部保留。
 */
export class SessionSidecarIndex {
  private cache = new Map<string, SessionIndexRecord>()
  private loaded = false
  /** 落盘串行链（尾 Promise；并发 put/touch 依序写盘，快照在各自轮次取最新）。 */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  /** 启动加载（缺文件按空索引；坏 JSON fail-loud——索引不可静默重建）。 */
  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as SessionsIndexFile
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [sessionId, record] of Object.entries(parsed)) {
          if (record !== null && typeof record === 'object' && typeof record.userId === 'string' && typeof record.agentId === 'string') {
            this.cache.set(sessionId, record)
          }
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw new Error(`loom session-index: 索引文件 ${this.file} 损坏：${String(error)}`)
    }
    this.loaded = true
  }

  /** 同步读缓存（热路径：所有权校验 / 惰性恢复查存在性）。 */
  get(sessionId: string): SessionIndexRecord | undefined {
    return this.cache.get(sessionId)
  }

  /** 串行落盘（本轮缓存全量快照；错误沿链抛给调用方，链本身继续可用）。 */
  private enqueueWrite(): Promise<void> {
    const next = this.writeChain.then(
      () => atomicWriteJson(this.file, Object.fromEntries(this.cache)),
      () => atomicWriteJson(this.file, Object.fromEntries(this.cache)),
    )
    this.writeChain = next.catch(() => undefined)
    return next
  }

  /** 写入/覆盖一条记录（缓存 + 原子落盘）。 */
  async put(sessionId: string, record: SessionIndexRecord): Promise<void> {
    await this.load()
    this.cache.set(sessionId, record)
    await this.enqueueWrite()
  }

  /** 合并更新（title/updatedAt 等；未知 id 忽略——不凭空造记录）。 */
  async touch(sessionId: string, patch: Partial<SessionIndexRecord>): Promise<void> {
    await this.load()
    const current = this.cache.get(sessionId)
    if (current === undefined) return
    this.cache.set(sessionId, { ...current, ...patch })
    await this.enqueueWrite()
  }

  /** 某 agent 的会话列表（updatedAt 降序）。userId 给定时按归属过滤。 */
  async listByAgent(agentId: string, userId?: string): Promise<Array<{ sessionId: string; record: SessionIndexRecord }>> {
    await this.load()
    return [...this.cache.entries()]
      .filter(([, record]) => record.agentId === agentId && (userId === undefined || record.userId === userId) && record.kind !== 'child')
      .map(([sessionId, record]) => ({ sessionId, record }))
      .sort((a, b) => (a.record.updatedAt < b.record.updatedAt ? 1 : -1))
  }

  /** 某用户的全部会话（updatedAt 降序）。 */
  async listByUser(userId: string): Promise<Array<{ sessionId: string; record: SessionIndexRecord }>> {
    await this.load()
    return [...this.cache.entries()]
      .filter(([, record]) => record.userId === userId)
      .map(([sessionId, record]) => ({ sessionId, record }))
      .sort((a, b) => (a.record.updatedAt < b.record.updatedAt ? 1 : -1))
  }

  /** 条目数（测试与 health 汇报）。 */
  async size(): Promise<number> {
    await this.load()
    return this.cache.size
  }
}

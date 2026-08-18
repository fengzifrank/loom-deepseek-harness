/**
 * loom memory 存储（M7）：node:sqlite `DatabaseSync`（Node ≥22.13 免 flag），
 * 零新依赖，模式照内核 session-query-sqlite（FTS5 读模型 + PRAGMA user_version
 * 版本门禁 fail-loud）。
 *
 * `.loom/memory.db`：
 * - `memories` 主表：id/user_id/agent_id/kind('fact'|'preference'|'skill'|'path')/
 *   content/source_session/source_seq/active/confidence/时间戳；
 *   M8 起新增 verified_at（最近一次重验时间，path 专用）与 path_signature
 *   （工具图签名，path 去重键）两列（schema v2，v1 库打开时自动迁移）；
 * - `memories_fts`：FTS5 全文虚表（unicode61），触发器同步——只索引 active=1；
 * - `extraction_log`：两阶段提取/决策审计（只进 DB，不往会话日志写自定义事件）。
 *
 * M8 路径记忆的衰减/重验规则（docs/path-memory.zh.md）：
 * - 重验成功 → verified_at=now、confidence +0.1（≤1.0）；重验失败 → confidence ×0.5；
 * - confidence < 0.3 → 软删（active=0，触发器同步摘除 FTS）；
 * - 时间衰减惰性求值：search(..., 'path') 读出后按 daysSince(verified_at ?? created_at)
 *   做 rank 惩罚重排（无后台任务）；被拒路径（verified_at=null、confidence=0.4）天然沉底。
 *
 * 中文检索：unicode61 不切分 CJK（整段连续汉字成一个 token，子串查不到），
 * 索引与查询两侧都做 **CJK unigram+bigram 分词**（`ftsTokenize`；查询侧
 * `ftsMatchExpr` 只取 bigram 提精度、bm25 排序）。
 * FTS 表为自含存储（不用 content= 外部内容表）：触发器直接 DELETE/INSERT
 * rowid 即可，避开外部内容表 'delete' 命令与内容列位置映射的脆弱性（另外
 * SQLite 不允许两个 AFTER UPDATE 触发器在同语句内各改一次 FTS 虚表——
 * UPDATE 用单触发器完成摘旧进新）。
 * @module @loom-sdk/web/memory-store
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 记忆类别（闭合枚举；'path' 留给 M8 路径记忆复用本表）。 */
export const MEMORY_KINDS = ['fact', 'preference', 'skill', 'path'] as const

/** 记忆类别类型。 */
export type MemoryKind = (typeof MEMORY_KINDS)[number]

/** 一条记忆（DB 行视图）。 */
export interface MemoryRecord {
  id: string
  userId: string
  agentId: string | null
  kind: MemoryKind
  content: string
  sourceSession: string | null
  sourceSeq: number | null
  active: boolean
  confidence: number
  /** M8：最近一次重验时间（ISO）；path 专用，未重验过/非 path 为 null。 */
  verifiedAt: string | null
  /** M8：工具图签名（toolSequenceSignature 的 sha256 hex）；path 去重键，非 path 为 null。 */
  pathSignature: string | null
  createdAt: string
  updatedAt: string
}

/** 新增/更新记忆的输入。 */
export interface MemoryUpsertInput {
  userId: string
  kind: MemoryKind
  content: string
  agentId?: string
  sourceSession?: string
  sourceSeq?: number
  confidence?: number
  /** M8：写入 path 时的初始重验时间（缺省 null = 未重验）。 */
  verifiedAt?: string
  /** M8：写入 path 时的工具图签名（去重键）。 */
  pathSignature?: string
}

/** M8 路径记忆 upsert 输入（写时按 user_id+path_signature 去重更新而非插新行）。 */
export interface PathUpsertInput {
  userId: string
  content: string
  /** 工具图签名（必填——无工具序列不成路径，调用方保证非空）。 */
  signature: string
  /** 结局：completed（重验语义）/ rejected（此路不通，降权）。 */
  outcome: 'completed' | 'rejected'
  agentId?: string
  sourceSession?: string
  sourceSeq?: number
}

// ---------------------------------------------------------------------------
// M8 路径记忆：衰减/重验常量与纯函数（存储语义集中在 store，便于单测）
// ---------------------------------------------------------------------------

/** 重验成功：confidence 增量（封顶 1.0）。 */
export const PATH_VERIFY_INCREMENT = 0.1
/** 重验失败：confidence 衰减倍率。 */
export const PATH_FAIL_DECAY = 0.5
/** 软删阈值：confidence 低于它即 active=0。 */
export const PATH_SOFT_DELETE_BELOW = 0.3
/** 被拒路径的初始/封顶置信度（降权而非盲选：沉在已验证路径之后）。 */
export const PATH_REJECTED_CONFIDENCE = 0.4
/** 时间衰减半衰期（天）：rank 乘以 exp(-days/30)。 */
export const PATH_DECAY_DAYS = 30

/**
 * 重验失败后的下一个 confidence（纯函数）：×0.5；低于阈值由调用方软删。
 */
export function nextConfidenceAfterFail(confidence: number): number {
  return confidence * PATH_FAIL_DECAY
}

/**
 * path 检索的重排分（纯函数）：FTS5 rank 是 bm25（越小越好、通常为负）——
 * 乘以 confidence 与时间衰减因子（均 ≤1 的正数）使失配/过期/被拒路径的 rank
 * 趋近 0（变差），fresh 高置信路径保持原序。days 为距 timeRef 的天数。
 */
export function pathRankPenalty(rank: number, confidence: number, days: number): number {
  return rank * confidence * Math.exp(-Math.max(0, days) / PATH_DECAY_DAYS)
}

// ---------------------------------------------------------------------------
// M8 工具图签名（路径去重键；纯函数）
// ---------------------------------------------------------------------------

/** 一次工具调用的签名输入（name + 参数对象；值不参与签名）。 */
export interface ToolCallShape {
  name: string
  args?: unknown
}

/** 参数值的类型形状（粗粒度：值本身不进签名——换村不换签名，见设计文档"路径过拟合"风险）。 */
function argValueShape(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value // string / number / boolean / object / undefined
}

/**
 * 工具调用序列的稳定签名（sha256 hex）：工具名序列 + 每次调用的参数形状
 * （键名集合排序 + 值的类型形状），不含参数值。同序列不同取值 → 同签名；
 * 不同序列/不同工具/不同键形 → 不同签名。
 */
export function toolSequenceSignature(calls: readonly ToolCallShape[]): string {
  const canonical = calls.map(call => {
    const args = call.args !== null && typeof call.args === 'object' && !Array.isArray(call.args)
      ? Object.keys(call.args as Record<string, unknown>)
        .sort()
        .map(key => `${key}:${argValueShape((call.args as Record<string, unknown>)[key])}`)
        .join(',')
      : ''
    return `${call.name}(${args})`
  }).join('→')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/** 一条提取审计（DB 行视图）。 */
export interface ExtractionLogRecord {
  id: string
  sessionId: string
  turn: number
  candidates: string
  decisions: string
  createdAt: string
}

/** loom memory 的 DB schema 版本（PRAGMA user_version）。 */
export const MEMORY_SCHEMA_VERSION = 2

// ---------------------------------------------------------------------------
// CJK 检索分词（索引与查询同构 → 子串/关键词语义）
// ---------------------------------------------------------------------------

/**
 * 全文分词：拉丁词保持整词；CJK 连续段切 **unigram+bigram**（"中文报告" →
 * 中/文/报/告/中文/文报/报告 七个 token）。双字词是中文最小表义单位——
 * 只做单字会过度匹配（"的/了"到处都是），只做双字则单字查询无法命中。
 * 索引侧全收；查询侧（ftsMatchExpr）只取 bigram 提精度，见其注释。
 */
export function ftsTokenize(text: string): string[] {
  const tokens: string[] = []
  const normalized = text.replace(/\s+/g, ' ')
  for (const run of normalized.split(' ')) {
    if (run === '') continue
    // 拉丁/数字词整词（unicode61 同款边界）。
    if (!/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/.test(run)) {
      tokens.push(run)
      continue
    }
    const chars = [...run]
    for (const ch of chars) tokens.push(ch)
    for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i]! + chars[i + 1]!)
  }
  return tokens
}

/** 兼容别名：旧名 ftsNormalize 返回空格拼接的分词串（触发器/索引侧使用）。 */
export function ftsNormalize(text: string): string {
  return ftsTokenize(text).join(' ')
}

/** FTS5 词项引用（内部双引号翻倍转义）。 */
function quoteTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`
}

/**
 * 构造 FTS5 MATCH 表达式：查询文本分词后各词作独立词项、词间 OR——
 * CJK 段只取 bigram（双字词够特异；单字会匹配到满屏"的/了"），单字段
 * 退化 unigram；拉丁词整词。rank（bm25）把命中多的排前面，topK 截断。
 */
export function ftsMatchExpr(query: string): string {
  const terms: string[] = []
  for (const run of query.replace(/\s+/g, ' ').split(' ')) {
    if (run === '') continue
    if (!/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/.test(run)) {
      terms.push(quoteTerm(run))
      continue
    }
    const chars = [...run]
    if (chars.length === 1) {
      terms.push(quoteTerm(chars[0]!))
      continue
    }
    for (let i = 0; i + 1 < chars.length; i++) terms.push(quoteTerm(chars[i]! + chars[i + 1]!))
  }
  return terms.length === 0 ? '""' : terms.join(' OR ')
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

interface MemoryRow {
  id: string
  user_id: string
  agent_id: string | null
  kind: string
  content: string
  source_session: string | null
  source_seq: number | null
  active: number
  confidence: number
  verified_at: string | null
  path_signature: string | null
  created_at: string
  updated_at: string
}

function toRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    kind: row.kind as MemoryKind,
    content: row.content,
    sourceSession: row.source_session,
    sourceSeq: row.source_seq,
    active: row.active === 1,
    confidence: row.confidence,
    verifiedAt: row.verified_at,
    pathSignature: row.path_signature,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 记忆存储。构造即打开（同步）；`close()` 幂等。schema 版本策略：
 * - version 0（新库）→ 建 v2 schema；
 * - version 1（M7 库）→ **带迁移**：ALTER TABLE 补 verified_at / path_signature
 *   两列升 v2（数据原样保留——M7 的库不能因为加列就打不开）；
 * - version 2 → 直接用；
 * - 其余（未来版本）→ fail-loud 拒绝打开（不静默迁移未知 schema）。
 */
export class MemoryStore {
  private readonly db: import('node:sqlite').DatabaseSync

  constructor(file: string) {
    const actual = file === ':memory:' ? file : resolve(file)
    if (actual !== ':memory:') mkdirSync(dirname(actual), { recursive: true })
    this.db = new DatabaseSync(actual)
    try {
      const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (version !== 0 && version !== 1 && version !== MEMORY_SCHEMA_VERSION) {
        throw new Error(
          `loom memory: ${actual} 的 schema 版本是 ${version}，本版本要求 ${MEMORY_SCHEMA_VERSION}`
          + '——版本不符拒绝打开（不静默迁移未知版本；请检查 SDK 版本或换目录）',
        )
      }
      this.ensureSchema()
      if (version === 1) this.migrateV1ToV2()
      this.db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  /**
   * v1 → v2 迁移：memories 补 verified_at / path_signature 两列（既有行取
   * NULL——非 path 记忆本就不用它们；FTS 触发器只依赖 content/active/rowid，
   * 加列不影响同步）。ensureSchema 先跑（IF NOT EXISTS 不动 v1 已有表），
   * 迁移幂等：列已存在时跳过（重复打开半迁移库不自爆）。
   */
  private migrateV1ToV2(): void {
    const columns = this.db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>
    const names = new Set(columns.map(column => column.name))
    this.db.exec('BEGIN')
    try {
      if (!names.has('verified_at')) this.db.exec('ALTER TABLE memories ADD COLUMN verified_at TEXT')
      if (!names.has('path_signature')) this.db.exec('ALTER TABLE memories ADD COLUMN path_signature TEXT')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL,
        agent_id       TEXT,
        kind           TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'skill', 'path')),
        content        TEXT NOT NULL,
        source_session TEXT,
        source_seq     INTEGER,
        active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        confidence     REAL NOT NULL DEFAULT 1.0,
        verified_at    TEXT,
        path_signature TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      ) STRICT;

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tokenize = 'unicode61');

      -- 只索引 active=1。注意：UPDATE 必须用**单个**触发器完成"摘旧 + 进新"——
      -- 两个 AFTER UPDATE 触发器各自改 FTS 虚表会在同语句内触发 SQLite
      -- "constraint failed"（虚表多次写入限制）；无条件 DELETE 对未索引行是
      -- no-op，INSERT...SELECT 用 WHERE 实现"仅 active=1 才进索引"。
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories WHEN new.active = 1 BEGIN
        INSERT INTO memories_fts (rowid, content) VALUES (new.rowid, fts_tokenized(new.content));
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        DELETE FROM memories_fts WHERE rowid = old.rowid;
        INSERT INTO memories_fts (rowid, content) SELECT new.rowid, fts_tokenized(new.content) WHERE new.active = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        DELETE FROM memories_fts WHERE rowid = old.rowid;
      END;

      CREATE TABLE IF NOT EXISTS extraction_log (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn       INTEGER NOT NULL,
        candidates TEXT NOT NULL,
        decisions  TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `)
    // fts_tokenized：应用定义的 SQL 函数（CJK 单字切分），供触发器同步索引。
    this.db.function('fts_tokenized', { deterministic: true, varargs: false }, (text: unknown) => ftsNormalize(typeof text === 'string' ? text : ''))
  }

  /** 关闭（幂等）。 */
  close(): void {
    this.db.close()
  }

  private now(): string {
    return new Date().toISOString()
  }

  /** 新增一条记忆（active=1）。 */
  insert(input: MemoryUpsertInput): MemoryRecord {
    if (!MEMORY_KINDS.includes(input.kind)) throw new Error(`loom memory: 未知记忆类别 "${String(input.kind)}"`)
    const content = input.content.trim()
    if (content === '') throw new Error('loom memory: content 不能为空')
    const now = this.now()
    const record: MemoryRow = {
      id: randomUUID(),
      user_id: input.userId,
      agent_id: input.agentId ?? null,
      kind: input.kind,
      content,
      source_session: input.sourceSession ?? null,
      source_seq: input.sourceSeq ?? null,
      active: 1,
      confidence: input.confidence ?? 1.0,
      verified_at: input.verifiedAt ?? null,
      path_signature: input.pathSignature ?? null,
      created_at: now,
      updated_at: now,
    }
    this.db.prepare(
      'INSERT INTO memories (id, user_id, agent_id, kind, content, source_session, source_seq, active, confidence, verified_at, path_signature, created_at, updated_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(record.id, record.user_id, record.agent_id, record.kind, record.content, record.source_session, record.source_seq, record.active, record.confidence, record.verified_at, record.path_signature, record.created_at, record.updated_at)
    return toRecord(record)
  }

  /** 按 id 取（含已停用；不存在/跨用户返回 undefined）。 */
  get(id: string, userId?: string): MemoryRecord | undefined {
    const row = userId === undefined
      ? this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined
      : this.db.prepare('SELECT * FROM memories WHERE id = ? AND user_id = ?').get(id, userId) as MemoryRow | undefined
    return row === undefined ? undefined : toRecord(row)
  }

  // -------------------------------------------------------------------------
  // M8 路径记忆：upsert（签名去重）与重验回写
  // -------------------------------------------------------------------------

  /**
   * 写入一条路径记忆（写时去重）：同 userId 且同 path_signature 的活跃 path
   * 只保留一条——命中则更新该行而非插新行：
   * - outcome='completed'：一次成功重放（等价一次重验）——verified_at=now、
   *   confidence +0.1（≤1.0）；新行则 confidence=1.0、verified_at=now；
   * - outcome='rejected'：此路不通记录——新行 confidence=0.4、verified_at=NULL；
   *   命中既有行时 content 刷新、confidence ×0.5（低于 0.3 软删），verified_at 不动
   *   （一次失败不抹掉既有重验时间，但连续失败会把路径压没）。
   * 返回最终行（软删时该行 active=false）。
   */
  upsertPath(input: PathUpsertInput): MemoryRecord {
    const content = input.content.trim()
    if (content === '') throw new Error('loom memory: content 不能为空')
    if (input.signature.trim() === '') throw new Error('loom memory: path 记忆必须带工具图签名（signature）')
    const existing = this.db.prepare(
      "SELECT * FROM memories WHERE user_id = ? AND kind = 'path' AND path_signature = ? AND active = 1",
    ).get(input.userId, input.signature) as MemoryRow | undefined

    if (existing === undefined) {
      return this.insert({
        userId: input.userId,
        kind: 'path',
        content,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        ...(input.sourceSession === undefined ? {} : { sourceSession: input.sourceSession }),
        ...(input.sourceSeq === undefined ? {} : { sourceSeq: input.sourceSeq }),
        confidence: input.outcome === 'completed' ? 1.0 : PATH_REJECTED_CONFIDENCE,
        ...(input.outcome === 'completed' ? { verifiedAt: this.now() } : {}),
        pathSignature: input.signature,
      })
    }

    // 命中同签名：更新而非插新行（同一路径只留 verified_at 最新的表述）。
    const now = this.now()
    if (input.outcome === 'completed') {
      const confidence = Math.min(1, existing.confidence + PATH_VERIFY_INCREMENT)
      this.db.prepare(
        'UPDATE memories SET content = ?, confidence = ?, verified_at = ?, updated_at = ?,'
        + ' agent_id = COALESCE(?, agent_id), source_session = COALESCE(?, source_session), source_seq = COALESCE(?, source_seq)'
        + ' WHERE id = ?',
      ).run(content, confidence, now, now, input.agentId ?? null, input.sourceSession ?? null, input.sourceSeq ?? null, existing.id)
    } else {
      const confidence = nextConfidenceAfterFail(existing.confidence)
      const active = confidence < PATH_SOFT_DELETE_BELOW ? 0 : 1
      this.db.prepare('UPDATE memories SET content = ?, confidence = ?, active = ?, updated_at = ? WHERE id = ?')
        .run(content, confidence, active, now, existing.id)
    }
    return this.get(existing.id)!
  }

  /**
   * 重验成功回写：verified_at=now、confidence +0.1（≤1.0）。
   * 只作用于该用户的活跃 path（id 不属于该用户/非 path/已软删一律跳过）。
   */
  markPathsVerified(ids: readonly string[], userId: string): MemoryRecord[] {
    const now = this.now()
    const out: MemoryRecord[] = []
    for (const id of ids) {
      const row = this.db.prepare(
        "SELECT * FROM memories WHERE id = ? AND user_id = ? AND kind = 'path' AND active = 1",
      ).get(id, userId) as MemoryRow | undefined
      if (row === undefined) continue
      this.db.prepare('UPDATE memories SET verified_at = ?, confidence = ?, updated_at = ? WHERE id = ?')
        .run(now, Math.min(1, row.confidence + PATH_VERIFY_INCREMENT), now, id)
      out.push(this.get(id)!)
    }
    return out
  }

  /**
   * 重验失败回写：confidence ×0.5；低于 0.3 软删（active=0，触发器摘除 FTS）。
   * 返回每条路径的处置（测试断言衰减轨迹用）。
   */
  markPathsFailed(ids: readonly string[], userId: string): Array<{ id: string; confidence: number; active: boolean }> {
    const out: Array<{ id: string; confidence: number; active: boolean }> = []
    for (const id of ids) {
      const row = this.db.prepare(
        "SELECT * FROM memories WHERE id = ? AND user_id = ? AND kind = 'path' AND active = 1",
      ).get(id, userId) as MemoryRow | undefined
      if (row === undefined) {
        out.push({ id, confidence: 0, active: false })
        continue
      }
      const confidence = nextConfidenceAfterFail(row.confidence)
      const active = confidence < PATH_SOFT_DELETE_BELOW ? 0 : 1
      this.db.prepare('UPDATE memories SET confidence = ?, active = ?, updated_at = ? WHERE id = ?')
        .run(confidence, active, this.now(), id)
      out.push({ id, confidence, active: active === 1 })
    }
    return out
  }

  /** 编辑内容（PUT 路由；触发器自动重建 FTS 索引）。 */
  updateContent(id: string, content: string, userId: string): MemoryRecord | undefined {
    const trimmed = content.trim()
    if (trimmed === '') throw new Error('loom memory: content 不能为空')
    const result = this.db.prepare('UPDATE memories SET content = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(trimmed, this.now(), id, userId)
    if (result.changes === 0) return undefined
    return this.get(id, userId)
  }

  /** 软删（active=0；FTS 索引随之摘除）。 */
  deactivate(id: string, userId: string): boolean {
    return this.db.prepare('UPDATE memories SET active = 0, updated_at = ? WHERE id = ? AND user_id = ? AND active = 1')
      .run(this.now(), id, userId).changes > 0
  }

  /** 物理删除（测试与彻底清理）。 */
  delete(id: string, userId?: string): boolean {
    return userId === undefined
      ? this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0
      : this.db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(id, userId).changes > 0
  }

  /** 某用户的记忆列表（默认 active=1；updatedAt 降序）。 */
  list(userId: string, opts: { includeInactive?: boolean; kind?: MemoryKind; limit?: number } = {}): MemoryRecord[] {
    const clauses = ['user_id = ?']
    const args: unknown[] = [userId]
    if (opts.includeInactive !== true) clauses.push('active = 1')
    if (opts.kind !== undefined) {
      clauses.push('kind = ?')
      args.push(opts.kind)
    }
    args.push(opts.limit ?? 200)
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`,
    ).all(...(args as import('node:sqlite').SQLInputValue[])) as unknown as MemoryRow[]
    return rows.map(toRecord)
  }

  /**
   * 全文检索（FTS top-k）：同 userId（可再按 kind 收窄），按 rank 升序。
   * 空查询返回 []（不做全表扫描）。
   *
   * kind='path' 时启用 M8 衰减重排：过取（limit×4，≥12）后按
   * `pathRankPenalty(rank, confidence, daysSince(verified_at ?? created_at))`
   * 重排再截断——过期/低置信/被拒路径沉底但不隐藏（惰性求值，无后台任务）。
   */
  search(userId: string, query: string, limit = 5, kind?: MemoryKind): MemoryRecord[] {
    const trimmed = query.trim()
    if (trimmed === '') return []
    const expr = ftsMatchExpr(trimmed)
    const fetchLimit = kind === 'path' ? Math.max(limit * 4, 12) : limit
    const rows = kind === undefined
      ? this.db.prepare(
        'SELECT m.*, f.rank AS fts_rank FROM memories_fts f JOIN memories m ON m.rowid = f.rowid'
        + ' WHERE memories_fts MATCH ? AND m.user_id = ? AND m.active = 1'
        + ' ORDER BY rank LIMIT ?',
      ).all(expr, userId, fetchLimit) as unknown as Array<MemoryRow & { fts_rank: number }>
      : this.db.prepare(
        'SELECT m.*, f.rank AS fts_rank FROM memories_fts f JOIN memories m ON m.rowid = f.rowid'
        + ' WHERE memories_fts MATCH ? AND m.user_id = ? AND m.active = 1 AND m.kind = ?'
        + ' ORDER BY rank LIMIT ?',
      ).all(expr, userId, kind, fetchLimit) as unknown as Array<MemoryRow & { fts_rank: number }>
    if (kind !== 'path') return rows.map(toRecord)
    const nowMs = Date.now()
    const DAY_MS = 24 * 60 * 60 * 1000
    return rows
      .map(row => {
        const timeRef = row.verified_at ?? row.created_at
        const days = (nowMs - Date.parse(timeRef)) / DAY_MS
        return { row, score: pathRankPenalty(row.fts_rank, row.confidence, Number.isFinite(days) ? days : 0) }
      })
      .sort((a, b) => a.score - b.score)
      .slice(0, limit)
      .map(entry => toRecord(entry.row))
  }

  /** 写一条两阶段提取审计（candidates/decisions 为 JSON 文本）。 */
  logExtraction(sessionId: string, turn: number, candidates: unknown, decisions: unknown): void {
    this.db.prepare('INSERT INTO extraction_log (id, session_id, turn, candidates, decisions, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), sessionId, turn, JSON.stringify(candidates ?? []), JSON.stringify(decisions ?? []), this.now())
  }

  /** 最近审计（测试与诊断）。 */
  recentExtractions(limit = 20): ExtractionLogRecord[] {
    const rows = this.db.prepare('SELECT * FROM extraction_log ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{
      id: string; session_id: string; turn: number; candidates: string; decisions: string; created_at: string
    }>
    return rows.map(row => ({
      id: row.id,
      sessionId: row.session_id,
      turn: row.turn,
      candidates: row.candidates,
      decisions: row.decisions,
      createdAt: row.created_at,
    }))
  }
}

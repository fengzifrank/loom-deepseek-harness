/**
 * M7 单测：MemoryStore（node:sqlite FTS5）—— CRUD、中文全文检索、
 * 用户隔离、软删（FTS 摘除）、user_version 版本门禁、提取审计。
 * M8 追加：v1→v2 带迁移（verified_at/path_signature 补列）、工具图签名、
 * path upsert 签名去重、重验回写（±confidence、软删）、path 检索时间衰减重排。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import {
  MemoryStore,
  MEMORY_SCHEMA_VERSION,
  PATH_REJECTED_CONFIDENCE,
  ftsNormalize,
  nextConfidenceAfterFail,
  pathRankPenalty,
  toolSequenceSignature,
} from '../src/memory-store.js'

const dir = mkdtempSync(join(tmpdir(), 'loom-memory-store-'))
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('MemoryStore', () => {
  it('insert/get/list 基础 CRUD + kind 闭合校验', () => {
    const store = new MemoryStore(':memory:')
    const record = store.insert({ userId: 'user-alice', kind: 'preference', content: '用户偏好中文报告，面积单位用万亩' })
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(store.get(record.id)?.content).toContain('万亩')
    expect(store.list('user-alice').map(item => item.kind)).toEqual(['preference'])
    expect(() => store.insert({ userId: 'u', kind: 'nope' as 'fact', content: 'x' })).toThrow(/记忆类别/)
    expect(() => store.insert({ userId: 'u', kind: 'fact', content: '   ' })).toThrow(/不能为空/)
    store.close()
  })

  it('FTS 中文检索：整句子串与单字命中；英文整词', () => {
    const store = new MemoryStore(':memory:')
    store.insert({ userId: 'u1', kind: 'preference', content: '用户偏好中文报告，面积单位用万亩' })
    store.insert({ userId: 'u1', kind: 'fact', content: '用户负责连河村的耕地保护工作' })
    store.insert({ userId: 'u1', kind: 'skill', content: 'User writes Python tools' })
    expect(store.search('u1', '中文报告', 5).map(item => item.kind)).toEqual(['preference'])
    expect(store.search('u1', '亩', 5).map(item => item.kind)).toEqual(['preference'])
    expect(store.search('u1', '连河村', 5).map(item => item.kind)).toEqual(['fact'])
    expect(store.search('u1', 'python', 5).map(item => item.kind)).toEqual(['skill'])
    expect(store.search('u1', '不存在的词组', 5)).toEqual([])
    expect(store.search('u1', '   ', 5)).toEqual([]) // 空查询不扫表
    store.close()
  })

  it('用户隔离：bob 搜不到 alice 的记忆', () => {
    const store = new MemoryStore(':memory:')
    store.insert({ userId: 'user-alice', kind: 'fact', content: '用户偏好中文报告' })
    store.insert({ userId: 'user-bob', kind: 'fact', content: '用户偏好英文报告' })
    expect(store.search('user-alice', '报告', 5).map(item => item.content)).toEqual(['用户偏好中文报告'])
    expect(store.list('user-bob').map(item => item.content)).toEqual(['用户偏好英文报告'])
    // 跨用户 get/update/delete 一律 miss
    const aliceRecord = store.list('user-alice')[0]!
    expect(store.get(aliceRecord.id, 'user-bob')).toBeUndefined()
    expect(store.updateContent(aliceRecord.id, '改写', 'user-bob')).toBeUndefined()
    expect(store.deactivate(aliceRecord.id, 'user-bob')).toBe(false)
    store.close()
  })

  it('updateContent 重建索引；软删后搜不到、list 不含；delete 物理删', () => {
    const store = new MemoryStore(':memory:')
    const record = store.insert({ userId: 'u1', kind: 'preference', content: '用户喜欢简洁结论' })
    expect(store.search('u1', '简洁', 5).length).toBe(1)
    store.updateContent(record.id, '用户喜欢详尽推导过程', 'u1')
    expect(store.search('u1', '简洁', 5)).toEqual([])
    expect(store.search('u1', '详尽', 5).length).toBe(1)
    expect(store.deactivate(record.id, 'u1')).toBe(true)
    expect(store.search('u1', '详尽', 5)).toEqual([])
    expect(store.list('u1')).toEqual([])
    expect(store.list('u1', { includeInactive: true }).length).toBe(1) // 软删可查回
    expect(store.delete(record.id, 'u1')).toBe(true)
    expect(store.list('u1', { includeInactive: true })).toEqual([])
    store.close()
  })

  it('user_version 不符拒绝打开（fail-loud，不静默迁移）', () => {
    const other = join(dir, 'future.db')
    const future = new MemoryStore(other)
    future.close()
    // 手写 user_version=99（模拟未来版本写的库）
    const raw = new DatabaseSync(other)
    raw.exec('PRAGMA user_version = 99')
    raw.close()
    expect(() => new MemoryStore(other)).toThrow(/schema 版本是 99/)
    expect(() => new MemoryStore(other)).toThrow(/拒绝打开/)
  })

  it('提取审计落 extraction_log', () => {
    const store = new MemoryStore(':memory:')
    store.logExtraction('session-x', 3, [{ kind: 'fact', content: 'a' }], [{ op: 'ADD', content: 'a' }])
    const logs = store.recentExtractions(1)
    expect(logs[0]!.sessionId).toBe('session-x')
    expect(logs[0]!.turn).toBe(3)
    expect(JSON.parse(logs[0]!.candidates)).toEqual([{ kind: 'fact', content: 'a' }])
    store.close()
  })

  it('落盘文件存在并可重开（active/FTS 状态延续）', () => {
    const file = join(dir, 'persist.db')
    const store = new MemoryStore(file)
    store.insert({ userId: 'u1', kind: 'skill', content: '用户会写 cordis 插件' })
    store.close()
    expect(existsSync(file)).toBe(true)
    const reopened = new MemoryStore(file)
    expect(reopened.search('u1', 'cordis', 5).length).toBe(1)
    reopened.close()
  })
})

describe('M8：v1 → v2 schema 迁移（M7 库要保——带迁移而非 fail-loud）', () => {
  /** 手工造一个 v1 形态的库（无 verified_at/path_signature 列，user_version=1）。 */
  function craftV1(file: string): void {
    const raw = new DatabaseSync(file)
    raw.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'skill', 'path')),
        content TEXT NOT NULL, source_session TEXT, source_seq INTEGER,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE VIRTUAL TABLE memories_fts USING fts5(content, tokenize = 'unicode61');
      CREATE TABLE extraction_log (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn INTEGER NOT NULL,
        candidates TEXT NOT NULL, decisions TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 1;
    `)
    raw.prepare('INSERT INTO memories (id, user_id, kind, content, active, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0.7, ?, ?)')
      .run('m-old', 'user-alice', 'preference', '用户偏好中文报告（v1 遗留）', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
    raw.close()
  }

  it('v1 库打开自动迁移：数据完整 + 两列补齐 + user_version=2', () => {
    const file = join(dir, 'v1-legacy.db')
    craftV1(file)
    const store = new MemoryStore(file) // 不抛错即迁移成功
    const migrated = store.get('m-old')
    expect(migrated).not.toBeUndefined()
    expect(migrated!.content).toContain('v1 遗留')
    expect(migrated!.confidence).toBe(0.7)
    expect(migrated!.verifiedAt).toBeNull() // 新列默认 NULL
    expect(migrated!.pathSignature).toBeNull()
    // user_version 已升 2
    const raw = new DatabaseSync(file)
    expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    // 迁移后读写正常（新列可写）
    const path = store.upsertPath({ userId: 'user-alice', content: '查询地类占比：gis_query_land_types(region)', signature: 'sig-1', outcome: 'completed' })
    expect(path.verifiedAt).not.toBeNull()
    expect(path.pathSignature).toBe('sig-1')
    store.close()
    raw.close()
    // 重开已迁移库：不再迁移、不报错
    const reopened = new MemoryStore(file)
    expect(reopened.list('user-alice').length).toBe(2)
    reopened.close()
  })

  it('新库直接建 v2（含两列）；版本常量 = 2', () => {
    expect(MEMORY_SCHEMA_VERSION).toBe(2)
    const store = new MemoryStore(':memory:')
    const record = store.insert({ userId: 'u', kind: 'fact', content: 'x' })
    expect(record.verifiedAt).toBeNull()
    store.close()
  })
})

describe('M8：toolSequenceSignature（工具图签名）', () => {
  it('同序列不同参数值 → 同签名；键序无关', () => {
    const a = toolSequenceSignature([
      { name: 'gis_query_land_types', args: { region: '连河村' } },
      { name: 'gis_render_pie_chart', args: { title: '各村占比', items: [{ name: '连河村', value: 42 }] } },
    ])
    const b = toolSequenceSignature([
      { name: 'gis_query_land_types', args: { region: '李家村' } },
      { name: 'gis_render_pie_chart', args: { items: [], title: '另一个标题' } }, // 键序颠倒、值不同
    ])
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('不同序列/不同工具/不同参数形状 → 不同签名', () => {
    const base = toolSequenceSignature([{ name: 'gis_query_land_types', args: { region: 'x' } }])
    expect(toolSequenceSignature([{ name: 'gis_query_land_types', args: { region: 'x' } }, { name: 'gis_focus_map', args: { region: 'x' } }])).not.toBe(base) // 序列加长
    expect(toolSequenceSignature([{ name: 'gis_focus_map', args: { region: 'x' } }])).not.toBe(base) // 不同工具
    expect(toolSequenceSignature([{ name: 'gis_query_land_types', args: { region: 'x', extra: 1 } }])).not.toBe(base) // 键集合不同
    expect(toolSequenceSignature([{ name: 'gis_query_land_types', args: { region: 42 } }])).not.toBe(base) // 类型形状不同
    expect(toolSequenceSignature([{ name: 'gis_query_land_types' }])).not.toBe(base) // 无参数
  })

  it('空序列稳定（固定值）；非对象 args 不炸', () => {
    expect(toolSequenceSignature([])).toBe(toolSequenceSignature([]))
    expect(() => toolSequenceSignature([{ name: 't', args: null }, { name: 't2', args: [1, 2] }])).not.toThrow()
  })
})

describe('M8：upsertPath（签名去重）与重验回写', () => {
  it('同签名只保留一条：completed upsert 更新 verified_at/confidence 而非插新行', () => {
    const store = new MemoryStore(':memory:')
    const sig = toolSequenceSignature([{ name: 'gis_query_land_types', args: { region: 'x' } }])
    const first = store.upsertPath({ userId: 'u1', content: '查询占比：gis_query_land_types(region)', signature: sig, outcome: 'completed' })
    expect(first.confidence).toBe(1.0)
    expect(first.verifiedAt).not.toBeNull()
    const second = store.upsertPath({ userId: 'u1', content: '查询占比（改写表述）：gis_query_land_types(region)', signature: sig, outcome: 'completed' })
    expect(second.id).toBe(first.id) // 同一行更新
    expect(second.content).toContain('改写表述')
    expect(store.list('u1', { kind: 'path' }).length).toBe(1)
    // 不同签名 → 新行；不同用户同签名 → 各自一行（隔离）
    store.upsertPath({ userId: 'u1', content: '另一条路径：gis_focus_map(region)', signature: 'sig-other', outcome: 'completed' })
    store.upsertPath({ userId: 'u2', content: 'u2 的同名路径', signature: sig, outcome: 'completed' })
    expect(store.list('u1', { kind: 'path' }).length).toBe(2)
    expect(store.list('u2', { kind: 'path' }).length).toBe(1)
    store.close()
  })

  it('rejected 路径：confidence=0.4、verified_at=null；命中既有行 ×0.5 不抹 verified_at', () => {
    const store = new MemoryStore(':memory:')
    const rej = store.upsertPath({ userId: 'u1', content: '此路不通：直接写库被拒（缺权限）', signature: 'sig-rej', outcome: 'rejected' })
    expect(rej.confidence).toBe(PATH_REJECTED_CONFIDENCE)
    expect(rej.verifiedAt).toBeNull()
    // 既有 verified 路径记一次 rejected → confidence ×0.5，verified_at 保留
    const ok = store.upsertPath({ userId: 'u1', content: '查询占比：A → B', signature: 'sig-ok', outcome: 'completed' })
    const verifiedAt = ok.verifiedAt
    const degraded = store.upsertPath({ userId: 'u1', content: '此路不通：A → B（B 工具下线）', signature: 'sig-ok', outcome: 'rejected' })
    expect(degraded.id).toBe(ok.id)
    expect(degraded.confidence).toBe(0.5)
    expect(degraded.verifiedAt).toBe(verifiedAt)
    store.close()
  })

  it('重验链：失败 ×3 → 0.5 → 0.25 → 软删（active=0 + FTS 摘除）；成功 +0.1 封顶 1', () => {
    const store = new MemoryStore(':memory:')
    const sig = toolSequenceSignature([{ name: 'gis_query_land_types', args: { region: 'x' } }])
    const path = store.upsertPath({ userId: 'u1', content: '查询各村地类占比：gis_query_land_types(region)', signature: sig, outcome: 'completed' })
    expect(store.search('u1', '地类占比', 5, 'path').length).toBe(1)

    // 失败 1：1.0 → 0.5（仍活跃）
    const after1 = store.markPathsFailed([path.id], 'u1')
    expect(after1).toEqual([{ id: path.id, confidence: 0.5, active: true }])
    expect(nextConfidenceAfterFail(1.0)).toBe(0.5)
    // 失败 2：0.5 → 0.25 < 0.3 → 软删 + FTS 摘除
    const after2 = store.markPathsFailed([path.id], 'u1')
    expect(after2).toEqual([{ id: path.id, confidence: 0.25, active: false }])
    expect(store.get(path.id)!.active).toBe(false)
    expect(store.search('u1', '地类占比', 5, 'path')).toEqual([])
    // 失败 3：已软删 → no-op（处置面如实汇报 inactive）
    const after3 = store.markPathsFailed([path.id], 'u1')
    expect(after3).toEqual([{ id: path.id, confidence: 0, active: false }])
    expect(store.get(path.id)!.confidence).toBe(0.25) // 不再变化

    // 成功回写：verified_at 刷新 + confidence +0.1（≤1.0 封顶）
    const path2 = store.upsertPath({ userId: 'u1', content: '排名变化：gis_rank_change(region)', signature: 'sig-2', outcome: 'rejected' })
    const verified = store.markPathsVerified([path2.id], 'u1')
    expect(verified.length).toBe(1)
    expect(verified[0]!.confidence).toBe(0.5) // 0.4 + 0.1
    expect(verified[0]!.verifiedAt).not.toBeNull()
    // 跨用户回写不生效（隔离）
    expect(store.markPathsVerified([path2.id], 'u2')).toEqual([])
    expect(store.markPathsFailed([path2.id], 'u2')).toEqual([{ id: path2.id, confidence: 0, active: false }])
    store.close()
  })

  it('path 检索时间衰减重排：过期的已验证路径沉到新鲜的被拒路径之后（降权非隐藏）', () => {
    const file = join(dir, 'decay.db')
    const store = new MemoryStore(file)
    // 两条都命中"地类占比"：一条 90 天前重验（衰减重），一条刚记的被拒路径（confidence 0.4 但新鲜）
    const oldVerified = store.upsertPath({ userId: 'u1', content: '查询各村地类占比：旧路径', signature: 'sig-old', outcome: 'completed' })
    const freshRejected = store.upsertPath({ userId: 'u1', content: '查询各村地类占比：此路不通的新尝试', signature: 'sig-new', outcome: 'rejected' })
    store.close()
    // 把 oldVerified 的 verified_at 手改到 90 天前（惰性衰减：读出时按 days 惩罚）。
    // 注意 raw 连接要注册 fts_tokenized（触发器同步 FTS 依赖它），否则 UPDATE 炸。
    const raw = new DatabaseSync(file)
    raw.function('fts_tokenized', { deterministic: true }, (text: unknown) => ftsNormalize(typeof text === 'string' ? text : ''))
    raw.prepare('UPDATE memories SET verified_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(), oldVerified.id)
    raw.close()
    const reopened = new MemoryStore(file)
    const hits = reopened.search('u1', '地类占比', 5, 'path')
    expect(hits.length).toBe(2) // 降权非隐藏：两条都在
    expect(hits[0]!.id).toBe(freshRejected.id) // 过期重验路径沉底
    expect(hits[1]!.id).toBe(oldVerified.id)
    // pathRankPenalty 纯函数：天数越大 rank 越趋 0（bm25 rank 为负，趋 0 = 变差）
    expect(pathRankPenalty(-10, 1, 0)).toBe(-10)
    expect(pathRankPenalty(-10, 1, 30)).toBeGreaterThan(-10)
    expect(pathRankPenalty(-10, 0.4, 0)).toBeGreaterThan(-10)
    reopened.close()
  })
})

describe('QA #10 回归：FTS5 查询语法注入面（转义后全部按字面词项处理）', () => {
  it('特殊字符 query（引号/AND/OR/NEAR/星号/脱字符/混合）不抛错、不改语义', () => {
    const store = new MemoryStore(':memory:')
    store.insert({ userId: 'u1', kind: 'fact', content: '用户喜欢简洁的中文报告' })
    store.insert({ userId: 'u1', kind: 'fact', content: 'AND THEN report style NEAR( never "quoted" * star' })
    store.insert({ userId: 'u1', kind: 'preference', content: '用户偏好 dark mode' })

    // 引号族：不抛 FTS5 语法错、不越权改 MATCH 语义（字面量或空集）
    for (const q of ['"', '""', '"""', '""""', '种"类', 'foo"bar']) {
      expect(() => store.search('u1', q, 5), `query=${JSON.stringify(q)} 不应抛错`).not.toThrow()
    }
    // FTS5 运算符关键字：被引号包裹成字面词项——只命中字面含该词的行
    expect(store.search('u1', 'AND', 5).map(r => r.content)).toEqual(['AND THEN report style NEAR( never "quoted" * star'])
    expect(store.search('u1', 'OR', 5)).toEqual([])
    // NEAR( / ^ / * 不展开为语法（NEAR( 是字面 token；* 在引号内无前缀语义）
    expect(store.search('u1', 'NEAR(', 5).length).toBe(1)
    expect(store.search('u1', '*', 5)).toEqual([])
    // 组合词仍按 OR 词项命中（AND 不当运算符——命中文面含 AND 的行）
    expect(store.search('u1', 'user AND admin', 5).map(r => r.content)).toEqual(['AND THEN report style NEAR( never "quoted" * star'])
    // 中文与注入混合不炸
    expect(store.search('u1', 'NEAR(报告 中文)', 5).map(r => r.content)).toEqual(['用户喜欢简洁的中文报告'])
    // 空白/纯引号查询 → 空集（不报错）
    expect(store.search('u1', '   ', 5)).toEqual([])
    // 用户隔离在注入面下依旧成立（u2 一律空集）
    for (const q of ['AND', '"', 'NEAR(', '中文报告']) expect(store.search('u2', q, 5)).toEqual([])
    store.close()
  })
})

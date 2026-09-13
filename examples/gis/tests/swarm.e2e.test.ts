/**
 * 群体智能（M15）e2e：
 *
 * 无 key 段：boot → health 汇报 swarms 元数据（topology/depth/memory/members）
 * + entry 注册为普通 agent + 成员子规格的 mesh 可见性（researcher 的 visibleTo 含 writer）。
 *
 * 带 key A（兄弟记忆传递——群体记忆实弹）：lead 依次委派 researcher（查数据 +
 * swarm_note 记群体笔记）与 writer（swarm_recall 检索 + 总结）→ 子会话事件流
 * 证据：researcher 子会话有 swarm_note 调用；writer 子会话 swarm_recall 命中
 * count ≥ 1 且内容含 researcher 记的面积数字。
 *
 * 带 key B（mesh 深度 2——对等委派实弹）：lead 只委派 researcher，researcher
 * 依 persona 纪律**自己**再委派 writer → 证据：researcher 子会话流出现第二级
 * loom/subagent-started（parent = researcher 子会话），结果逐级回流，lead 轮 completed。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import {
  ANON_HEADERS, bootLoom, cleanupDir, ensureTsx, GIS_DIR, openEventStream, readEnv, readEventRange, sdkBuilt, type BootedLoom,
} from './helpers.js'

const env = readEnv(GIS_DIR)
const hasKey = process.env.DEEPSEEK_API_KEY !== undefined || env.DEEPSEEK_API_KEY !== undefined
if (process.env.DEEPSEEK_API_KEY === undefined && env.DEEPSEEK_API_KEY !== undefined) {
  process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY
}

/** 每套件独立 outDir/端口：Windows 上前一套件 dispose 后句柄释放有延迟，
 * 共享目录会让下一套件的 boot 预清理 EPERM（budget.e2e 同款对策）。 */
const boot = (outDirName: string, port: number) => bootLoom({
  appModulePath: join(GIS_DIR, 'tests', 'swarm-app.ts'),
  withApproval: false,
  withSubagent: true, // swarm 展开为 subagents → 组合带 subagent 服务缝
  port,
  outDirName,
})

describe.skipIf(!sdkBuilt())('群体智能 e2e：注册与元数据（无 key）', () => {
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    ensureTsx()
    loom = await boot('.loom-swarm-e2e', 4655)
  }, 180_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(GIS_DIR, '.loom-swarm-e2e'))
  })

  it('health：swarms 元数据 + entry agent + mesh 可见性', async () => {
    const res = await fetch(`${loom!.base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.app).toBe('swarm-demo')
    expect(body.agents).toEqual(['pod-lead'])
    expect(body.swarms).toEqual([
      { name: 'pod', topology: 'mesh', depth: 2, memory: true, entry: 'pod-lead', members: ['researcher', 'writer'] },
    ])
    const researcher = body.subagents.find((s: any) => s.id === 'researcher')
    expect(researcher.visibleTo).toEqual(['pod-lead', 'writer'])
  })
})

describe.skipIf(!sdkBuilt() || !hasKey)('群体智能 e2e A：兄弟记忆传递（带 key）', () => {
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    ensureTsx()
    loom = await boot('.loom-swarm-a', 4656)
  }, 180_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(GIS_DIR, '.loom-swarm-a'))
  })

  it('researcher 记群体笔记 → writer 检索命中（子会话事件流证据）', async () => {
    const created = await fetch(`${loom!.base}/agents/pod-lead/sessions`, { method: 'POST', headers: ANON_HEADERS })
    expect(created.status).toBe(200)
    const { sessionId } = (await created.json()) as { sessionId: string }
    const sse = await openEventStream(loom!.base, sessionId)
    try {
      const sent = await fetch(`${loom!.base}/agents/pod-lead/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ANON_HEADERS },
        body: JSON.stringify({
          text: '请依次完成：① 委派 researcher 查询连河村全部作物面积，并把每种作物的亩数用 swarm_note 记入群体笔记；② 委派 writer 用 swarm_recall 检索群体笔记，按检索到的数字写一句收成结构总结。',
        }),
      })
      expect(sent.status).toBe(200)

      // 证据 1：两个子会话被拉起（researcher 在前 writer 在后）
      await sse.wait(e => e.type === 'loom/subagent-started' && e.spec === 'researcher', 180_000, 'researcher 拉起')
      const writerStarted = await sse.wait(e => e.type === 'loom/subagent-started' && e.spec === 'writer', 180_000, 'writer 拉起')
      expect(typeof writerStarted.childSessionId).toBe('string')
      const started = sse.events.filter(e => e.type === 'loom/subagent-started')
      const researcherChild = started.find(e => e.spec === 'researcher')!.childSessionId as string
      const writerChild = writerStarted.childSessionId as string

      await sse.wait(e => e.type === 'turn/end' && String(e.reason?.kind ?? e.reason) === 'completed', 300_000, 'lead 轮完成')

      // 证据 2：researcher 子会话真实调了 swarm_note（有界回放）
      const rEvents = await readEventRange(loom!.base, researcherChild, -1, 1_000_000_000)
      const noteCall = rEvents.find(e => e.type === 'tool/call' && e.name === 'swarm_note')
      expect(noteCall).toBeDefined()
      expect(String(noteCall!.args?.content)).toContain('1200')

      // 证据 3：writer 子会话 swarm_recall 命中 researcher 的笔记（跨成员传递成立）
      const wEvents = await readEventRange(loom!.base, writerChild, -1, 1_000_000_000)
      const recallCall = wEvents.find(e => e.type === 'tool/call' && e.name === 'swarm_recall')
      expect(recallCall).toBeDefined()
      const recallResult = wEvents.find(e => e.type === 'tool/result' && e.callSeq === recallCall!.seq)
      expect(recallResult?.isError).toBeFalsy()
      const items = (recallResult?.value as { items?: Array<{ content: string }> })?.items ?? []
      expect(items.length).toBeGreaterThanOrEqual(1)
      expect(items.some(item => item.content.includes('1200'))).toBe(true)
    } finally {
      sse.close()
    }
  }, 600_000)
})

describe.skipIf(!sdkBuilt() || !hasKey)('群体智能 e2e B：mesh 深度 2 对等委派（带 key）', () => {
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    ensureTsx()
    loom = await boot('.loom-swarm-b', 4657)
  }, 180_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(GIS_DIR, '.loom-swarm-b'))
  })

  it('researcher 自己委派 writer（第二级拉起，parent = researcher 子会话）', async () => {
    const created = await fetch(`${loom!.base}/agents/pod-lead/sessions`, { method: 'POST', headers: ANON_HEADERS })
    expect(created.status).toBe(200)
    const { sessionId } = (await created.json()) as { sessionId: string }
    const sse = await openEventStream(loom!.base, sessionId)
    try {
      const sent = await fetch(`${loom!.base}/agents/pod-lead/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ANON_HEADERS },
        body: JSON.stringify({
          text: '委派 researcher 完成任务：① 用 swarm_query 查连河村水稻面积；② 把亩数用 swarm_note 记入群体笔记；③ 然后由 researcher **自己**用 subagent 工具委派 writer，让 writer 用 swarm_recall 检索笔记并润色成一句结论。你（组长）不要再直接委派 writer。',
        }),
      })
      expect(sent.status).toBe(200)

      // 证据 1：lead 流只拉起 researcher（writer 不是 lead 直接拉的）。
      await sse.wait(e => e.type === 'loom/subagent-started' && e.spec === 'researcher', 180_000, 'researcher 拉起')
      const leadStarts = sse.events.filter(e => e.type === 'loom/subagent-started')
      const researcherChild = leadStarts.find(e => e.spec === 'researcher')!.childSessionId as string

      // 合成事件（loom/*）不落日志——第二级拉起的证据要挂 researcher 子会话的
      // 实时 SSE（拉起后立刻订阅，实时段能收到它后续推的一切）。
      const childStream = await openEventStream(loom!.base, researcherChild)
      try {
        await sse.wait(e => e.type === 'turn/end' && String(e.reason?.kind ?? e.reason) === 'completed', 400_000, 'lead 轮完成')

        // 证据 2：researcher 子会话流出现第二级 loom/subagent-started（writer，parent=researcher 子会话）
        const secondLevel = await childStream.wait(e => e.type === 'loom/subagent-started' && e.spec === 'writer', 30_000, '第二级 writer 拉起')
        expect(secondLevel.parentSessionId).toBe(researcherChild)

        // 证据 3：lead 没直接拉 writer；深度 2 被内核接受——researcher 轮 completed
        const finalLeadStarts = sse.events.filter(e => e.type === 'loom/subagent-started')
        expect(finalLeadStarts.some(e => e.spec === 'writer')).toBe(false)
        const researcherTurns = childStream.events.filter(e => e.type === 'turn/end')
        expect(researcherTurns.length).toBeGreaterThanOrEqual(1)
        expect(researcherTurns.every(e => String(e.reason?.kind ?? e.reason) === 'completed')).toBe(true)
      } finally {
        childStream.close()
      }
    } finally {
      sse.close()
    }
  }, 600_000)
})

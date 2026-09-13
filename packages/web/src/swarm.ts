/**
 * 群体智能（Swarm）声明的编译器（M15）—— 纯函数，从 runtime 抽出以便单测。
 *
 * 设计出处（诚实标注）：拓扑图与"命名空间群体记忆"两个模式移植自 ruflo 的
 * 概念层（TopologyManager / ns: 前缀共享记忆），**零代码引入**；ruflo 的
 * 共识算法（Raft/Paxos/拜占庭）、守护进程、选举/重平衡明确不移植——子智能体
 * 协调靠拓扑可见性 + 群体记忆 + 内核单调深度帽（maxDepth）已足够且可审计。
 *
 * `app.swarm()` 在**声明期**展开为既有原语：entry → spec.agents、members →
 * spec.subagents（visibleTo 按拓扑计算），spec.swarms 只留运行时元数据——
 * compose/dev-worker 零改动。编译产物：
 * - entryAgent：入口智能体（HTTP 寻址 /agents/{entry}/sessions）
 * - memberSubagents：成员子规格（工具清单含保留名注入：委派工具/群体记忆工具）
 * - meta：拓扑元数据（topology/depth/memory/memberIds——runtime 消费）
 * @module @loom-sdk/web/swarm
 */

import type { SubagentSpec, SwarmMeta, SwarmSpec } from './types.js'

/** 内核委派工具名（全局层注册，M15 起由 runtime 统一注册、调用者感知可见性）。 */
export const DELEGATION_TOOL_NAME = 'subagent'

/** 群体记忆工具（全局层注册；会话树命名空间合成 userId `swarm:{rootSessionId}`）。 */
export const SWARM_MEMORY_TOOL_NAMES = ['swarm_note', 'swarm_recall'] as const

/** 子规格工具清单里允许出现的保留名（不是 app.tool 声明的工具，由 runtime 注册）。 */
export const RESERVED_SUB_TOOLS: ReadonlySet<string> = new Set([DELEGATION_TOOL_NAME, ...SWARM_MEMORY_TOOL_NAMES])

/** 深度上限封顶（防 mesh 对等委派递归失控；内核另有单调深度做硬终止）。 */
export const SWARM_MAX_DEPTH = 3

/** 群体记忆纪律（注入成员 persona；编译期注入故可单测）。 */
const MEMORY_DISCIPLINE = [
  '群体协作纪律：值得共享给同伴的发现（数据、结论、线索），立即调用 swarm_note 记入群体笔记（content 写清要点，tag 可选）；',
  '需要同伴的发现时，先调用 swarm_recall 检索群体笔记再行动，不要重复劳动。',
].join('')

/** mesh 对等委派纪律（注入成员 persona）。 */
const PEER_DELEGATION_DISCIPLINE = (peers: readonly string[]) =>
  `必要时可用 subagent 工具把子任务委派给同伴（spec 填同伴 id：${peers.join(' / ')}），拿到结果后汇总回你的任务。`

/** 编译输入上下文（声明现场的既有状态，用于冲突校验）。 */
export interface SwarmCompileContext {
  readonly toolNames: readonly string[]
  readonly allToolNames: readonly string[]
  readonly agentIds: readonly string[]
  readonly subagentIds: readonly string[]
  readonly swarmNames: readonly string[]
}

/** 编译产物。 */
export interface CompiledSwarm {
  readonly meta: SwarmMeta
  readonly entryAgent: { id: string; persona: string; tools?: string[] }
  readonly memberSubagents: readonly SubagentSpec[]
}

/**
 * 校验 + 展开（诚实失败：id 冲突 / 空成员 / 深度越界 / 工具悬空引用全部声明期抛错）。
 * 纯函数——不修改入参，产物由声明器 push 进 spec。
 */
export function compileSwarm(name: string, spec: SwarmSpec, ctx: SwarmCompileContext): CompiledSwarm {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('app.swarm() 的 name 必须是非空字符串')
  if (ctx.swarmNames.includes(name)) throw new Error(`app.swarm("${name}")：重复的群体名`)
  if (spec.topology !== 'hierarchical' && spec.topology !== 'mesh') {
    throw new Error(`app.swarm("${name}") 的 topology 必须是 "hierarchical" / "mesh"，收到 ${JSON.stringify(spec.topology)}`)
  }
  if (!Array.isArray(spec.members) || spec.members.length === 0) {
    throw new Error(`app.swarm("${name}")：members 至少一个成员`)
  }

  const memory = spec.memory === true
  const depth = spec.depth ?? (spec.topology === 'mesh' ? 2 : 1)
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > SWARM_MAX_DEPTH) {
    throw new Error(`app.swarm("${name}") 的 depth 必须是 1..${SWARM_MAX_DEPTH} 的整数，收到 ${JSON.stringify(spec.depth)}`)
  }
  if (spec.topology === 'mesh' && depth < 2) {
    throw new Error(`app.swarm("${name}")：mesh 拓扑需要 depth ≥ 2（对等委派要留一层），收到 ${depth}`)
  }

  // id 冲突校验：entry/成员之间互不重名，且不与既有 agent/subagent 重名。
  const ids = [spec.entry.id, ...spec.members.map(member => member.id)]
  if (new Set(ids).size !== ids.length) {
    throw new Error(`app.swarm("${name}")：entry 与成员的 id 存在重复（${ids.join(', ')}）`)
  }
  for (const id of ids) {
    if (ctx.agentIds.includes(id)) throw new Error(`app.swarm("${name}")：id "${id}" 与已声明的智能体冲突`)
    if (ctx.subagentIds.includes(id)) throw new Error(`app.swarm("${name}")：id "${id}" 与已声明的子智能体冲突`)
  }
  if (typeof spec.entry.persona !== 'string' || spec.entry.persona.trim() === '') {
    throw new Error(`app.swarm("${name}") 的 entry.persona 必须是非空字符串`)
  }

  // 工具引用校验（与 agent/subagent 同规：工具先声明后引用）。
  const declared = new Set(ctx.toolNames)
  const checkTools = (who: string, tools: readonly string[] | undefined): void => {
    if (tools === undefined) return
    for (const toolName of tools) {
      if (!declared.has(toolName)) {
        throw new Error(`app.swarm("${name}")：${who} 引用了未声明的工具 "${toolName}"——工具须先 app.tool(...) 声明`)
      }
    }
  }
  checkTools(`entry "${spec.entry.id}"`, spec.entry.tools)
  for (const member of spec.members) {
    if (typeof member.id !== 'string' || member.id.trim() === '') throw new Error(`app.swarm("${name}")：成员 id 必须是非空字符串`)
    if (typeof member.persona !== 'string' || member.persona.trim() === '') {
      throw new Error(`app.swarm("${name}")：成员 "${member.id}" 的 persona 必须是非空字符串`)
    }
    checkTools(`成员 "${member.id}"`, member.tools)
  }

  const memberIds = spec.members.map(member => member.id)
  const swarmTools = memory ? [...SWARM_MEMORY_TOOL_NAMES] : []

  // entry：persona 注入委派指引（+ 记忆纪律）；工具清单显式化并追加群体工具。
  const entryPersona = [
    spec.entry.persona,
    `可委派成员：${memberIds.join(' / ')}——用 subagent 工具委派（spec 填成员 id，task 写清目标与验收）。`,
    ...(memory ? [MEMORY_DISCIPLINE] : []),
  ].join('\n')
  const entryTools = [...(spec.entry.tools ?? ctx.allToolNames), ...swarmTools]

  // 成员：visibleTo 按拓扑（hierarchical → 入口；mesh → 入口 + 同伴）；
  // 工具清单显式化（含保留名注入：mesh 加委派工具；memory 加群体工具）。
  const memberSubagents: SubagentSpec[] = spec.members.map(member => {
    const peers = memberIds.filter(id => id !== member.id)
    const visibleTo = spec.topology === 'mesh' ? [spec.entry.id, ...peers] : [spec.entry.id]
    const persona = [
      member.persona,
      member.role !== undefined ? `你的角色：${member.role}。` : '',
      ...(memory ? [MEMORY_DISCIPLINE] : []),
      ...(spec.topology === 'mesh' && depth >= 2 ? [PEER_DELEGATION_DISCIPLINE(peers)] : []),
    ].filter(line => line !== '').join('\n')
    const tools = [
      ...(member.tools ?? ctx.allToolNames),
      ...(spec.topology === 'mesh' ? [DELEGATION_TOOL_NAME] : []),
      ...swarmTools,
    ]
    return { id: member.id, persona, tools, visibleTo }
  })

  const meta: SwarmMeta = { name, topology: spec.topology, depth, memory, entryId: spec.entry.id, memberIds }
  return { meta, entryAgent: { id: spec.entry.id, persona: entryPersona, tools: entryTools }, memberSubagents }
}

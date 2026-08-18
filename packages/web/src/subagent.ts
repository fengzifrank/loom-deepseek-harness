/**
 * 子智能体声明的编译器（M3）—— 纯函数，从 runtime.ts 抽出以便单测。
 *
 * 把 app.subagent(...) 声明编译为：
 * - `byParent`：父 agent id → 可见子规格列表（决定谁的作用域里注册 `subagent` 工具）；
 * - `globalToolNames`：所有子规格引用的工具名并集——这些工具必须进内核
 *   **全局工具层**（子 agent 的 toolFilter 只作用于全局层，见 dsh-tools
 *   ToolRestriction 与 dsh-subagent applyChildComposition）；
 * - `toolFilterOf`：子规格 → 内核 toolFilter（allow-list；缺省 = 应用全部工具）。
 * @module @loom-sdk/web/subagent
 */

import type { AppSpec, SubagentSpec } from './types.js'

/** subagent 声明的编译产物。 */
export interface CompiledSubagents {
  /** 父 agent id → 该父可见的子规格（按声明顺序）。 */
  readonly byParent: ReadonlyMap<string, readonly SubagentSpec[]>
  /** 子规格引用的工具名并集（这些工具需注册进内核全局层）。 */
  readonly globalToolNames: ReadonlySet<string>
  /** 子规格 id → 规格。 */
  readonly byId: ReadonlyMap<string, SubagentSpec>
  /** 子规格 → 内核 toolFilter（undefined = 不限制 = 全局层全部可见）。 */
  readonly toolFilterOf: (spec: SubagentSpec) => { allow: string[] } | undefined
}

/** 校验 + 编译（引用完整性：诚实失败优于静默缺工具/缺父）。 */
export function compileSubagents(spec: Pick<AppSpec, 'tools' | 'agents' | 'subagents'>): CompiledSubagents {
  const toolNames = new Set(spec.tools.map(tool => tool.name))
  const agentIds = new Set(spec.agents.map(agent => agent.id))
  const allToolNames = spec.tools.map(tool => tool.name)

  for (const sub of spec.subagents) {
    if (sub.tools !== undefined) {
      for (const toolName of sub.tools) {
        if (!toolNames.has(toolName)) {
          throw new Error(`loom-runtime: 子智能体 "${sub.id}" 引用了未声明的工具 "${toolName}"`)
        }
      }
    }
    if (sub.visibleTo.length === 0) {
      throw new Error(`loom-runtime: 子智能体 "${sub.id}" 的 visibleTo 不能为空（至少一个父 agent 才能委派它）`)
    }
    for (const parentId of sub.visibleTo) {
      if (!agentIds.has(parentId)) {
        throw new Error(`loom-runtime: 子智能体 "${sub.id}" 的 visibleTo 引用了未声明的智能体 "${parentId}"`)
      }
    }
  }

  const byParent = new Map<string, SubagentSpec[]>()
  for (const sub of spec.subagents) {
    for (const parentId of sub.visibleTo) {
      const list = byParent.get(parentId) ?? []
      list.push(sub)
      byParent.set(parentId, list)
    }
  }

  const globalToolNames = new Set<string>()
  for (const sub of spec.subagents) {
    for (const name of sub.tools ?? allToolNames) globalToolNames.add(name)
  }

  return {
    byParent,
    globalToolNames,
    byId: new Map(spec.subagents.map(sub => [sub.id, sub])),
    toolFilterOf: (sub: SubagentSpec) => (sub.tools === undefined ? undefined : { allow: [...sub.tools] }),
  }
}

/**
 * 父 agent 的全局工具 deny-list：子规格引用的全局工具中，该父声明不可见的部分。
 * 返回空数组表示无需限制（该父看得见全部全局工具）。runtime 在父的作用域里
 * `agentCtx.tools.restrict({ deny })`，保持 M1 "每 agent 不同工具集" 语义不被
 * 全局注册破坏（restrict 只作用于全局层，不影响该父自己的作用域注册）。
 */
export function denyListForAgent(compiled: CompiledSubagents, visibleTools: string[]): string[] {
  const visible = new Set(visibleTools)
  return [...compiled.globalToolNames].filter(name => !visible.has(name))
}

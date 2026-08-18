/**
 * Schema 工效学（DX 冲刺）：
 * - `schemasteryToOutputDsl()`：把 `@deepseek-ai/schemastery` 的 `z.object({...})`
 *   实例转换为 Loom 的 output JSON Schema DSL（`.output(z.object({...}))` 重载）。
 *   required 由可选性推导：`meta.required === true` 或（未显式 `required(false)` 且
 *   无 `default`）→ `required: true`；有 default / 显式 required(false) → 可省字段。
 * - 声明期守门（纯函数，console.warn / throw 由调用方决定时机）：
 *   `outputRootIssues()`：output 根为 object 且无 properties → 坑位指路（M1 踩过）。
 *   `inputArrayIssues()`：input 里 `{ type: 'array' }` 缺 `items` → 坑位指路。
 *
 * 全部纯函数（除 console.warn），单测友好。@module @loom-sdk/web/schema
 */

import type { ToolInputDSL, ToolOutputDSL } from './types.js'

/** schemastery 实例的 Loom 结构视图（duck-typed，避免公开其全局类型）。 */
export interface LoomZSchema {
  readonly uid: number
  readonly type: string
  readonly meta?: {
    required?: boolean
    description?: string | Record<string, string>
    default?: unknown
  }
  readonly inner?: LoomZSchema
  readonly dict?: Record<string, LoomZSchema>
  readonly list?: readonly LoomZSchema[]
  readonly value?: unknown
}

/** 运行时识别 schemastery 实例（可调用函数 + uid/meta 是其每实例必有的形状；DSL 字面量没有）。 */
export function isSchemastery(value: unknown): value is LoomZSchema {
  if (value === null) return false
  if (typeof value !== 'object' && typeof value !== 'function') return false
  const node = value as { uid?: unknown; meta?: unknown }
  return typeof node.uid === 'number' && typeof node.meta === 'object' && node.meta !== null
}

/** meta.description 的字符串形态（i18n Dict 取首个值）。 */
function descriptionOf(schema: LoomZSchema): string | undefined {
  const desc = schema.meta?.description
  if (typeof desc === 'string') return desc === '' ? undefined : desc
  if (desc !== null && typeof desc === 'object') {
    const first = Object.values(desc).find(value => typeof value === 'string' && value !== '')
    return first === undefined ? undefined : String(first)
  }
  return undefined
}

/** schemastery 字段的可选性：显式 required(false) → 可选；作者显式 default → 可选；其余 → 必填。 */
function isRequired(schema: LoomZSchema): boolean {
  const meta = schema.meta
  if (meta?.required === false) return false
  if (meta !== undefined && 'default' in meta) {
    // array/object 节点自动挂 meta.default = [] / {}（框架内置），不是作者意图，不算可选。
    const autoEmpty = (schema.type === 'array' && Array.isArray(meta.default) && meta.default.length === 0)
      || (schema.type === 'object' && meta.default !== null && typeof meta.default === 'object' && !Array.isArray(meta.default) && Object.keys(meta.default).length === 0)
    if (!autoEmpty) return false
  }
  return true
}

/** JS 值 → kernel DSL 的标量 type 名。 */
function scalarTypeOf(value: unknown): 'string' | 'number' | 'boolean' | 'null' {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (value === null) return 'null'
  return 'string'
}

/**
 * schemastery 实例 → Loom output DSL 节点。未覆盖的 type（transform/tuple/is/…）
 * 落为 `{ type: 'json' }` 并 warn 指路（诚实降级优于静默错 schemas）。
 */
export function schemasteryToDsl(schema: LoomZSchema, path = 'output'): Record<string, unknown> {
  const description = descriptionOf(schema)
  const annotate = (node: Record<string, unknown>): Record<string, unknown> =>
    description === undefined ? node : { ...node, description }

  switch (schema.type) {
    case 'string':
    case 'date':
    case 'regExp':
      return annotate({ type: 'string' })
    case 'number':
    case 'natural':
    case 'percent':
      return annotate({ type: 'number' })
    case 'boolean':
      return annotate({ type: 'boolean' })
    case 'object': {
      const dict = schema.dict ?? {}
      const properties: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(dict)) {
        const node = schemasteryToDsl(child, `${path}.${key}`)
        properties[key] = isRequired(child) ? { ...node, required: true } : node
      }
      return annotate({ type: 'object', properties })
    }
    case 'array': {
      if (schema.inner === undefined) return annotate({ type: 'array' })
      return annotate({ type: 'array', items: schemasteryToDsl(schema.inner, `${path}[]`) })
    }
    case 'union':
    case 'intersect': {
      const list = schema.list ?? []
      if (list.length === 0) return annotate({ type: 'json' })
      const branches = list.map((branch, index) => schemasteryToDsl(branch, `${path}|${index}`))
      // 同形分支去重（如 z.date() 的 is(Date) 与 transform(string) 都投影为 string）。
      const unique = branches.filter((branch, index) => branches.findIndex(other => JSON.stringify(other) === JSON.stringify(branch)) === index)
      if (unique.length === 1) return annotate(unique[0]!)
      return annotate({ oneOf: unique })
    }
    case 'is': {
      // 实例校验节点：按构造器名落标量（Date 在 canonical JSON 里就是字符串）。
      const ctor = typeof schema.constructor === 'function' ? schema.constructor.name : schema.constructor
      if (ctor === 'Date' || ctor === 'String') return annotate({ type: 'string' })
      if (ctor === 'Number') return annotate({ type: 'number' })
      if (ctor === 'Boolean') return annotate({ type: 'boolean' })
      return annotate(jsonFallback(path, `is(${String(ctor)})`))
    }
    case 'transform': {
      if (schema.inner !== undefined) return annotate(schemasteryToDsl(schema.inner, path))
      return annotate(jsonFallback(path, 'transform'))
    }
    case 'const': {
      const value = schema.value
      return annotate({ type: scalarTypeOf(value), const: value })
    }
    default:
      return annotate(jsonFallback(path, schema.type))
  }
}

/** 未覆盖类型的降级节点 + 一条 warn（诚实降级优于静默错 schema）。 */
function jsonFallback(path: string, type: string): Record<string, unknown> {
  console.warn(`[loom] .output() 的 schemastery 节点 "${path}" 类型 "${type}" 不在 kernel DSL 覆盖内，已按 { type: 'json' }（任意 canonical JSON）处理`)
  return { type: 'json' }
}

/** `.output(z.object({...}))` 重载的入口：根必须是 object，否则直接 throw。 */
export function schemasteryToOutputDsl(schema: LoomZSchema): ToolOutputDSL {
  if (schema.type !== 'object') {
    throw new Error(`.output(z.object({...})) 要求根节点是 z.object（收到 z.${schema.type}）——output 是工具返回值的对象形状`)
  }
  return schemasteryToDsl(schema)
}

// ---------------------------------------------------------------------------
// 声明期守门（第 7 项并入）
// ---------------------------------------------------------------------------

/** 浅取 DSL 节点字段（容错非对象形态）。 */
function asNode(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * output 根形状问题：根是 object 但没有 properties（或空）→ 返回指路文案。
 * 这是 M1 踩过的坑（模型把整个返回值当不透明对象），声明期 warn 一次。
 */
export function outputRootIssues(dsl: unknown): string[] {
  const node = asNode(dsl)
  if (node === null) return []
  if (node.type !== 'object') return []
  const properties = asNode(node.properties)
  if (properties !== null && Object.keys(properties).length > 0) return []
  return [
    'output 根是 object 但没有 properties——模型将看不到返回字段结构，'
    + '请如实声明每个返回字段（如 .output(z.object({ total: z.number() }))），'
    + '或至少 .output({ type: "json" }) 明示任意 canonical JSON',
  ]
}

/** input 树里 `{ type: 'array' }` 缺 `items` 的节点路径（模型只能瞎猜元素结构）。 */
export function inputArrayIssues(dsl: unknown, path = 'input'): string[] {
  const issues: string[] = []
  const visit = (value: unknown, at: string): void => {
    const node = asNode(value)
    if (node === null) return
    if (node.type === 'array' && node.items === undefined) {
      issues.push(`${at} 声明了 array 但缺 items——请补 items 元素结构（如 items: { type: 'object', properties: {...} }），模型才能正确构造数组元素`)
      return
    }
    if (node.type === 'array' && node.items !== undefined) {
      visit(node.items, `${at}[]`)
      return
    }
    if (node.type === 'object' && node.properties !== undefined) {
      for (const [key, child] of Object.entries(asNode(node.properties) ?? {})) {
        visit(child, `${at}.${key}`)
      }
    }
  }
  const root = asNode(dsl)
  if (root === null) return issues
  for (const [key, child] of Object.entries(root)) {
    visit(child, `${path}.${key}`)
  }
  return issues
}

/** 守门入口：对一次 .input() 声明 warn 所有坑位。 */
export function warnInputDslIssues(toolName: string, dsl: ToolInputDSL): void {
  for (const issue of inputArrayIssues(dsl)) {
    console.warn(`[loom] tool("${toolName}").input()：${issue}`)
  }
}

/** 守门入口：对一次 .output() 声明 warn 所有坑位。 */
export function warnOutputDslIssues(toolName: string, dsl: ToolOutputDSL): void {
  for (const issue of outputRootIssues(dsl)) {
    console.warn(`[loom] tool("${toolName}").output()：${issue}`)
  }
}

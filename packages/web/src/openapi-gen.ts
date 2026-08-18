/**
 * `loom openapi` 生成器（M5 Feature A）：AppSpec → OpenAPI 3.1.0 文档。
 *
 * 确定性纯函数：无时间戳、无随机、键序稳定——同一声明 →
 * `JSON.stringify(doc, null, 2)` 字节相同（快照单测 + CI 新鲜度门的前提）。
 *
 * 文档即运行时校验：`dslToJsonSchema` 与 runtime 的 normalizeDsl 对齐——
 * object 节点补 `additionalProperties:false`（封闭对象），字段级 `required:true`
 * 提升为 JSON Schema 顶层的 `required` 数组，`type:'json'` → `{}`（任意
 * canonical JSON）+ description。GET/HEAD/DELETE 的 query 值按编码约定是
 * JSON.stringify 后的字符串（与服务端 parseScalar 对称），数组/对象参数标
 * `x-loom-query-json: true` 扩展，`loom import-openapi` 识别它忠实往返。
 * @module @loom-sdk/web/openapi-gen
 */

import type { App, ToolSpec } from './types.js'
import { httpRouteOf } from './http-route.js'

/** OpenAPI 3.1.0 文档（宽松结构视图；见 generateOpenapi 的产出形状）。 */
export type OpenapiDocument = { readonly [key: string]: unknown }

/** 生成物版本号（info.version；语义化版本从 0.1.0 起步，与 SDK 同步演进）。 */
export const OPENAPI_DOC_VERSION = '0.1.0'

/** 走 query 序列化的方法（与 runtime 的 .http() handler 对齐）。 */
const QUERY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'DELETE'])

// ---------------------------------------------------------------------------
// DSL → JSON Schema
// ---------------------------------------------------------------------------

/** 容错取对象节点（数组/原始值 → null）。 */
function asNode(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** DSL 节点的 description（非字符串视为缺省）。 */
function descriptionOf(node: Record<string, unknown>): string | undefined {
  return typeof node.description === 'string' && node.description !== '' ? node.description : undefined
}

/** 按 DSL 语义取类型名（type 字段必须是受支持的字符串；`json` 单独处理）。 */
function typeOf(node: Record<string, unknown>): string | undefined {
  return typeof node.type === 'string' && node.type !== '' ? node.type : undefined
}

/**
 * 一个 Loom DSL 节点 → JSON Schema 节点（确定性：键序固定为
 * type → description → const → enum → oneOf → items → properties →
 * required → additionalProperties）。
 *
 * - 字段级 `required: true` 由父级 object 收进顶层 `required` 数组（本函数
 *   对单节点会剔除 required 键——它不是 schema 关键字）；
 * - `type:'object'` 递归补 `additionalProperties:false`（对齐 normalizeDsl，
 *   文档即运行时校验）；
 * - `type:'json'` → `{}`（+description）——任意 canonical JSON；
 * - oneOf / const / enum / items 递归保留。
 */
export function dslToJsonSchema(value: unknown): Record<string, unknown> {
  const node = asNode(value)
  if (node === null) return {}

  const description = descriptionOf(node)
  const out: Record<string, unknown> = {}

  // oneOf：分支递归（联合形状）。
  if (Array.isArray(node.oneOf)) {
    out.oneOf = node.oneOf.map(branch => dslToJsonSchema(branch))
    if (description !== undefined) out.description = description
    return out
  }

  const type = typeOf(node)
  if (type !== undefined && type !== 'json') out.type = type

  // const / enum：受支持的 JSON 原语照实保留。
  if ('const' in node && (typeof node.const === 'string' || typeof node.const === 'number' || typeof node.const === 'boolean' || node.const === null)) {
    out.const = node.const
  }
  if (Array.isArray(node.enum)) {
    out.enum = node.enum.map(item => (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null ? item : null))
  }

  if (type === 'array') {
    out.items = node.items === undefined ? {} : dslToJsonSchema(node.items)
  } else if (type === 'object') {
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    const table = asNode(node.properties) ?? {}
    for (const [key, childValue] of Object.entries(table)) {
      const child = asNode(childValue)
      if (child !== null && child.required === true) required.push(key)
      properties[key] = dslToJsonSchema(childValue)
    }
    if (Object.keys(properties).length > 0) out.properties = properties
    if (required.length > 0) out.required = required
    // 封闭对象：对齐 runtime normalizeDsl（作者省略 → false；显式布尔照写）。
    out.additionalProperties = typeof node.additionalProperties === 'boolean' ? node.additionalProperties : false
  }
  // type:'json'（或无法识别的节点）→ {}：任意 canonical JSON。

  if (description !== undefined) out.description = description
  return out
}

/**
 * 输入 DSL 属性表 → JSON Schema（根始终是 object：字段级 required 提升，
 * additionalProperties:false 对齐运行时校验）。非对象产物（防御路径）包一层。
 */
function inputTableToJsonSchema(table: unknown): Record<string, unknown> {
  const node = asNode(table)
  if (node === null) return {}
  // 表本身就是属性表：构造成 object 节点再走 dslToJsonSchema。
  const schema = dslToJsonSchema({ type: 'object', properties: node })
  return schema.type === 'object' ? schema : { type: 'object', properties: { value: schema } }
}

/**
 * 该 schema 是否需要 query 值的 JSON 编码约定（数组/对象/任意 JSON——
 * 标量可以原样传输，服务端 parseScalar 都能解析，复杂值必须 JSON.stringify）。
 */
function needsQueryJsonEncoding(schema: Record<string, unknown>): boolean {
  if (schema.oneOf !== undefined) return true
  const type = schema.type
  return type !== 'string' && type !== 'number' && type !== 'integer' && type !== 'boolean' && type !== 'null'
}

// ---------------------------------------------------------------------------
// 操作（operation）生成
// ---------------------------------------------------------------------------

/** 一个 .http() 工具的 tags：能看见该工具的 agent id（声明序，确定性）。 */
function tagsOf(tool: ToolSpec, app: App): string[] {
  const allTools = app.spec.tools.map(t => t.name)
  return app.spec.agents
    .filter(agent => (agent.tools ?? allTools).includes(tool.name))
    .map(agent => agent.id)
}

/** input 属性表 → query 参数列表（逐字段；复杂值带 x-loom-query-json 扩展）。 */
function queryParametersOf(tool: ToolSpec): Array<Record<string, unknown>> {
  const table = asNode(tool.parameters) ?? {}
  return Object.entries(table).map(([name, fieldValue]) => {
    const schema = dslToJsonSchema(fieldValue)
    const field = asNode(fieldValue)
    return {
      name,
      in: 'query',
      required: field?.required === true,
      description: descriptionOf(field ?? {}),
      ...(needsQueryJsonEncoding(schema) ? { 'x-loom-query-json': true } : {}),
      schema,
    }
  })
}

/** 500 响应（运行时 .http() 的失败形状：{ok:false, error, tool}）。 */
function errorResponse(): Record<string, unknown> {
  return {
    description: '工具执行失败（策略拒绝/审批超时为 403；此处为 500 形状：{ok:false, error, tool}）',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', const: false },
            error: { type: 'string' },
            tool: { type: 'string' },
          },
          required: ['ok', 'error', 'tool'],
          additionalProperties: false,
        },
      },
    },
  }
}

/** 一个工具 → 一个 operation 对象。 */
function operationOf(tool: ToolSpec, app: App): { method: string; operation: Record<string, unknown> } {
  const method = tool.http!.method.toUpperCase()
  const operation: Record<string, unknown> = {
    operationId: tool.name,
    summary: tool.description,
  }
  const tags = tagsOf(tool, app)
  if (tags.length > 0) operation.tags = tags

  if (QUERY_METHODS.has(method)) {
    operation.parameters = queryParametersOf(tool)
  } else {
    operation.requestBody = {
      required: Object.values(asNode(tool.parameters) ?? {}).some(field => asNode(field)?.required === true),
      content: { 'application/json': { schema: inputTableToJsonSchema(tool.parameters) } },
    }
  }

  operation.responses = {
    '200': {
      description: `工具 ${tool.name} 的返回值（output DSL 声明的形状）`,
      content: { 'application/json': { schema: dslToJsonSchema(tool.output) } },
    },
    '500': errorResponse(),
  }
  return { method, operation }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 从 AppSpec 生成 OpenAPI 3.1.0 文档（确定性：无时间戳、键序稳定）。
 * @param app - defineApp 产物（loom openapi 导入应用入口后拿到）。
 */
export function generateOpenapi(app: App): OpenapiDocument {
  const paths: Record<string, Record<string, unknown>> = {}
  const httpTools = app.spec.tools.filter(tool => tool.http !== undefined)
  for (const tool of httpTools) {
    const route = httpRouteOf(tool, app.spec.apiPrefix)
    const { method, operation } = operationOf(tool, app)
    const item = paths[route] ?? {}
    item[method.toLowerCase()] = operation
    paths[route] = item
  }
  return {
    openapi: '3.1.0',
    info: { title: app.name, version: OPENAPI_DOC_VERSION },
    servers: [{ url: `http://127.0.0.1:${app.spec.port}` }],
    tags: app.spec.agents.map(agent => ({ name: agent.id, description: `agent "${agent.id}" 可见的工具（persona 作用域）` })),
    paths,
  }
}

/** 文档的规范序列化（loom openapi 与 runtime /openapi.json 共用）。 */
export function openapiToJson(doc: OpenapiDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

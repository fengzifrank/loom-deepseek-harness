/**
 * `loom client` 生成器（M4）：导入应用声明（AppSpec）→ 生成一个类型化客户端
 * TS 文件（默认 src/loom.client.ts）。
 *
 * 生成物两块：
 * 1. `loomTools`：对声明了 `.http()` 的工具生成类型化函数——入参类型
 *    `InferToolArgs<入参 DSL 字面量>`、返回类型 `InferToolOutput<output DSL 字面量>`
 *    （两个条件类型映射都来自 @loom-sdk/web，同一份声明驱动运行时/校验/客户端）；
 *    GET 走 query 序列化，POST 走 JSON body（与 runtime 的 parseScalar/readJsonBody
 *    对称）。未声明 `.http()` 的工具生成注释说明。
 * 2. `loomSessions`：会话客户端——agent id 是字面量联合类型（拼写错误编译期即
 *    报）；`createSession` / `sendMessage` 类型化封装；`streamEvents` 返回投影
 *    事件流的 AsyncIterable（fetch 流式解析 SSE，浏览器与 Node 通用）。
 *
 * 生成物只 `import type`（零运行时依赖），加入 typecheck 项目即可保证其类型
 * 正确；输出确定性（同一 AppSpec → 字节相同），适合快照测试与 CI 新鲜度门。
 * @module @loom-sdk/web/client-gen
 */

import type { App, ToolSpec } from './types.js'
import { httpRouteOf } from './http-route.js'

/** 生成选项。 */
export interface GenerateClientOptions {
  /** API 基址（写入生成物默认值；浏览器下通常走同源代理）。缺省取应用 apiPrefix。 */
  baseUrl?: string
}

// ---------------------------------------------------------------------------
// DSL → TS 字面量类型文本（确定性序列化；值必须已是纯 JSON——schemastery
// 转换后的 output DSL 满足；防御性地把函数/undefined 叶子静默剔除）
// ---------------------------------------------------------------------------

/** 标识符安全的属性键（否则 JSON 引号）。 */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** 一个 DSL 节点 → TS 字面量类型文本（缩进感知，对象/数组多行、标量单行）。 */
function dslToTsType(value: unknown, indent: number): string {
  const pad = '  '.repeat(indent)
  const inner = '  '.repeat(indent + 1)
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[\n${value.map(item => `${inner}${dslToTsType(item, indent + 1)},`).join('\n')}\n${pad}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    const lines = entries.map(([key, child]) => {
      const prop = IDENT.test(key) ? key : JSON.stringify(key)
      return `${inner}${prop}: ${dslToTsType(child, indent + 1)},`
    })
    return `{\n${lines.join('\n')}\n${pad}}`
  }
  // 函数等非 JSON 值：DSL 里不应出现（plainDsl 已剔除），防御兜底。
  return 'unknown'
}

/** 深拷贝 DSL 并剔除函数/undefined 叶子（防御；正常不会命中）。 */
function plainDsl(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return typeof value === 'function' || typeof value === 'undefined' ? { type: 'json' } : value
  if (Array.isArray(value)) return value.map(plainDsl)
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === 'function' || typeof child === 'undefined') continue
    out[key] = plainDsl(child)
  }
  return out
}

/** snake_case / 任意工具名 → PascalCase 类型别名前缀（非法段丢弃，保持确定性）。 */
export function pascalAlias(name: string): string {
  const parts = name.split(/[^A-Za-z0-9$]+/).filter(part => part !== '')
  const joined = parts.map(part => part[0]!.toUpperCase() + part.slice(1)).join('')
  return /^[A-Za-z$]/.test(joined) ? joined : `Tool${joined}`
}

/** 工具名是否可直接作对象方法名。 */
const isMethodName = (name: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)

/**
 * 工具的完整路由（与 runtime 注册一致：自定义 path 原样（服务器根绝对），
 * 缺省 `${apiPrefix}/api/<name>`）→ 生成物里的 URL 表达式。落在 apiPrefix 下
 * 的走 `${loomBaseUrl}` 相对拼接；根绝对的自定义 path 不经基址（如 Vite 代理
 * 场景需自行转发该路径）。
 */
function routeUrlExpr(tool: ToolSpec, apiPrefix: string): { doc: string; expr: string } {
  const full = httpRouteOf(tool, apiPrefix)
  if (full === apiPrefix || full.startsWith(`${apiPrefix}/`)) {
    return { doc: full, expr: `\${loomBaseUrl}${full.slice(apiPrefix.length)}` }
  }
  return { doc: full, expr: full }
}

/**
 * 生成一个 .http() 工具的段：两个类型别名（Args/Output）+ loomTools 对象内的
 * 方法文本。GET/HEAD/DELETE 走 query 序列化；其余（POST/PUT/PATCH…）走 JSON body。
 */
function toolSection(tool: ToolSpec, apiPrefix: string): { types: string[]; method: string[] } {
  const alias = pascalAlias(tool.name)
  const argsType = `${alias}Args`
  const outputType = `${alias}Output`
  const method = tool.http!.method.toUpperCase()
  const route = routeUrlExpr(tool, apiPrefix)
  const types = [
    `/** ${tool.name} 的入参（由 .input() DSL 经 InferToolArgs 推导）。 */`,
    `export type ${argsType} = InferToolArgs<${dslToTsType(plainDsl(tool.parameters), 1)}>`,
    '',
    `/** ${tool.name} 的返回（由 .output() DSL 经 InferToolOutput 推导）。 */`,
    `export type ${outputType} = InferToolOutput<${dslToTsType(plainDsl(tool.output), 1)}>`,
  ]
  const isQueryLike = method === 'GET' || method === 'HEAD' || method === 'DELETE'
  const methodLines = isQueryLike
    ? [
      `  /** ${method} ${route.doc} */`,
      `  async ${tool.name}(args: ${argsType} = {}, init?: RequestInit): Promise<${outputType}> {`,
      `    return loomFetch<${outputType}>(\`${route.expr}\${loomQuery(args as Record<string, unknown>)}\`, { ...init, method: '${method}' })`,
      '  },',
    ]
    : [
      `  /** ${method} ${route.doc} */`,
      `  async ${tool.name}(args: ${argsType}, init?: RequestInit): Promise<${outputType}> {`,
      `    return loomFetch<${outputType}>(\`${route.expr}\`, {`,
      '      ...init,',
      `      method: '${method}',`,
      "      headers: { 'content-type': 'application/json', ...(init?.headers as Record<string, string> | undefined) },",
      '      body: JSON.stringify(args),',
      '    })',
      '  },',
    ]
  return { types, method: methodLines }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 从 AppSpec 生成类型化客户端源码（确定性输出：同一声明 → 字节相同）。
 * @param app - defineApp 产物（loom client 导入应用入口后拿到）。
 * @param opts - baseUrl 覆盖（缺省取应用 apiPrefix，走浏览器同源代理）。
 */
export function generateClient(app: App, opts: GenerateClientOptions = {}): string {
  const spec = app.spec
  const baseUrl = (opts.baseUrl ?? spec.apiPrefix).replace(/\/+$/, '') || '/~loom'
  const agentUnion = spec.agents.length === 0 ? 'never' : spec.agents.map(agent => `'${agent.id}'`).join(' | ')

  const head = [
    '/**',
    " * AUTO-GENERATED by 'loom client' — 勿手改，运行 pnpm loom client 重新生成",
    ' *',
    ` * 应用 ${app.name} 的类型化客户端（M4）：`,
    ' * - loomTools：声明了 .http() 的工具 → 类型化 fetch 封装（入参 InferToolArgs、',
    ' *   返回 InferToolOutput，类型映射来自 @loom-sdk/web——同一份声明驱动运行时与客户端）；',
    ' * - loomSessions：会话客户端（agent id 为字面量联合类型；createSession /',
    ' *   sendMessage 类型化；streamEvents 返回投影事件流的 AsyncIterable）。',
    ' */',
    "import type { InferToolArgs, InferToolOutput } from '@loom-sdk/web'",
  ].join('\n')

  const runtimeHelpers = [
    '',
    '/** API 基址：浏览器缺省走同源代理（如 Vite 的 /~loom → 127.0.0.1:4620）；Node/测试可用 configureLoomClient 覆盖。 */',
    `let loomBaseUrl = '${baseUrl}'`,
    '',
    '/** 默认请求头（M7：app.auth 声明后放身份——token 或 x-loom-user；SSE 的 fetch 也带）。 */',
    'let loomDefaultHeaders: Record<string, string> = {}',
    '',
    '/** 覆盖基址（如 http://127.0.0.1:4620/~loom）与默认请求头。 */',
    'export function configureLoomClient(opts: { baseUrl: string; headers?: Record<string, string> }): void {',
    "  loomBaseUrl = opts.baseUrl.replace(/\\/+$/, '')",
    '  if (opts.headers !== undefined) loomDefaultHeaders = opts.headers',
    '}',
    '',
    '/** 投影事件（SSE 白名单载荷；seq 是唯一顺序权威）。 */',
    'export interface LoomClientEvent {',
    '  seq?: number',
    '  type: string',
    '  [key: string]: unknown',
    '}',
    '',
    'async function loomFetch<T>(url: string, init?: RequestInit): Promise<T> {',
    '  const res = await fetch(url, { ...init, headers: { ...loomDefaultHeaders, ...(init?.headers as Record<string, string> | undefined) } })',
    '  const body = (await res.json().catch(() => ({}))) as T & { error?: string }',
    "  if (!res.ok) throw new Error(body.error ?? `loom client: ${res.status} ${res.statusText} ${url}`)",
    '  return body',
    '}',
    '',
    '/** query 序列化：标量原样、数组/对象 JSON 化（与服务端 parseScalar 对称解析）。 */',
    'function loomQuery(args: Record<string, unknown>): string {',
    '  const params = new URLSearchParams()',
    '  for (const [key, value] of Object.entries(args)) {',
    '    if (value === undefined) continue',
    "    params.set(key, typeof value === 'string' ? value : JSON.stringify(value))",
    '  }',
    "  const text = params.toString()",
    "  return text === '' ? '' : `?${text}`",
    '}',
  ].join('\n')

  const httpTools = spec.tools.filter(tool => tool.http !== undefined && isMethodName(tool.name))
  const skipped = spec.tools.filter(tool => tool.http === undefined || !isMethodName(tool.name))
  const typeBlocks: string[] = []
  const methodBlocks: string[] = []
  for (const tool of httpTools) {
    const section = toolSection(tool, spec.apiPrefix)
    typeBlocks.push(section.types.join('\n'))
    methodBlocks.push(section.method.join('\n'))
  }
  if (skipped.length > 0) {
    methodBlocks.push(
      skipped.map(tool => `  // ${tool.name}：未声明 .http()，跳过；在声明处加 .http(method) 后重新生成`).join('\n'),
    )
  }
  const toolsSection = [
    '',
    '// ————————————————————————————————————————————————',
    '// 工具客户端（.http() 第二张面孔的类型化封装）',
    '// ————————————————————————————————————————————————',
    '',
    typeBlocks.join('\n\n'),
    '',
    '/** 各工具的调用端（服务端形状变化后重新生成，编译期即可发现调用点破坏）。 */',
    'export const loomTools = {',
    methodBlocks.join('\n'),
    '}',
  ].join('\n')

  const sessionsSection = [
    '',
    '// ————————————————————————————————————————————————',
    '// 会话客户端（agent id 为字面量联合类型）',
    '// ————————————————————————————————————————————————',
    '',
    '/** 应用声明的智能体 id（字面量联合——传错 id 编译期即报）。 */',
    `export type LoomAgentId = ${agentUnion}`,
    '',
    '/** 会话操作（创建 / 发消息 / 事件流）。 */',
    'export const loomSessions = {',
    '  /** POST /agents/:agentId/sessions → { sessionId } */',
    '  async createSession(agentId: LoomAgentId, init?: RequestInit): Promise<{ sessionId: string; agentId: string }> {',
    "    return loomFetch(`${loomBaseUrl}/agents/${encodeURIComponent(agentId)}/sessions`, { ...init, method: 'POST' })",
    '  },',
    '',
    '  /** POST /agents/:agentId/sessions/:sessionId/messages（进度走 streamEvents）。 */',
    '  async sendMessage(',
    '    agentId: LoomAgentId,',
    '    sessionId: string,',
    '    text: string,',
    '    init?: RequestInit,',
    '  ): Promise<{ ok: true; sessionId: string }> {',
    '    return loomFetch(`${loomBaseUrl}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/messages`, {',
    "      ...init,",
    "      method: 'POST',",
    "      headers: { 'content-type': 'application/json', ...(init?.headers as Record<string, string> | undefined) },",
    '      body: JSON.stringify({ text }),',
    '    })',
    '  },',
    '',
    '  /** GET …/events?since=N —— 投影事件流（SSE）的 AsyncIterable；for await...of 消费，abort 即拆除连接。 */',
    '  async *streamEvents(',
    '    agentId: LoomAgentId,',
    '    sessionId: string,',
    '    opts: { since?: number; signal?: AbortSignal } = {},',
    '  ): AsyncIterable<LoomClientEvent> {',
    '    const since = opts.since ?? -1',
    '    const url = `${loomBaseUrl}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/events?since=${since}`',
    "    const res = await fetch(url, { signal: opts.signal, headers: { accept: 'text/event-stream', ...loomDefaultHeaders } })",
    '    if (!res.ok || res.body === null) throw new Error(`loom client: SSE 打开失败 ${res.status} ${url}`)',
    '    const reader = res.body.getReader()',
    "    const decoder = new TextDecoder()",
    "    let buffer = ''",
    '    try {',
    '      for (;;) {',
    '        const { done, value } = await reader.read()',
    '        if (done) break',
    '        buffer += decoder.decode(value, { stream: true })',
    '        let index: number',
    "        while ((index = buffer.indexOf('\\n\\n')) >= 0) {",
    '          const block = buffer.slice(0, index)',
    '          buffer = buffer.slice(index + 2)',
    "          for (const line of block.split('\\n')) {",
    "            if (!line.startsWith('data: ')) continue",
    '            try {',
    '              yield JSON.parse(line.slice(6)) as LoomClientEvent',
    '            } catch { /* 非 JSON 行（心跳注释等）忽略 */ }',
    '          }',
    '        }',
    '      }',
    '    } finally {',
    '      await reader.cancel().catch(() => undefined)',
    '    }',
    '  },',
    '}',
  ].join('\n')

  return `${head}\n${runtimeHelpers}\n${toolsSection}\n${sessionsSection}\n`
}

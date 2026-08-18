/**
 * `loom import-openapi` 生成器（M5 Feature B）：OpenAPI 3.x 文档 → Loom 工具
 * 声明模块（TS 源码文本）。
 *
 * 双轨互通的另一半：`loom openapi` 把应用导出成文档，本模块把（任意的）
 * OpenAPI 文档反向生成 `registerImportedTools(app)`——用户在 loom.app.ts 里
 * 一行接入，外部 API 立即获得模型面孔 + HTTP 面孔 + 策略/审批。
 *
 * 诚实降级纪律：`jsonSchemaToDsl` 只把有把握的 JSON Schema 子集落成 Loom DSL
 * （本地 $ref 展开 / allOf 浅合并 / type·enum·const·items·oneOf / 可空联合），
 * 落不了的（anyOf 混合分支、format/min·max 约束等）降级为
 * `{ type: 'json' }` 或裸类型，并在生成文件对应位置上方留
 * `// WARN(openapi-import): …已降级…` 注释——宁可少承诺，不可静默错 schemas。
 *
 * 生成物确定性：无时间戳、遍历序稳定（paths 键序 × 固定方法序）、同一文档 →
 * 字节相同。execute 是真 fetch（基址 servers[0].url / --base 覆盖；路径参数
 * 替换；x-loom-query-json 忠实往返；exec.signal 透传；非 2xx 抛错带状态码与
 * 响应体前 200 字符）。
 * @module @loom-sdk/web/openapi-import
 */

import { globToRegExp } from './policy.js'
import type { OpenapiDocument } from './openapi-gen.js'

// M8：jsonSchemaToDsl 转换器已随 Python 工具桥抽至 dsh-python-tools（同一实现，
// 这里反向复用并原样再导出——@loom-sdk/web 公共 API 不变）。
import { jsonSchemaToDsl, type ConvertContext } from 'dsh-python-tools'
export { jsonSchemaToDsl }
export type { ConvertContext }

/** 纯 JSON 对象判定（本模块枚举/取值共用）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 生成选项。 */
export interface GenerateImportOptions {
  /** 基址覆盖（缺省取 servers[0].url；文档无 servers 时占位并注释说明）。 */
  base?: string
  /** 工具名 glob 过滤（复用策略 glob 语义：`*` 任意序列、`?` 单字符）。 */
  include?: string
  /** 只导入带该 tag 的 operation。 */
  tag?: string
}

/** 一条降级警告（path 定位生成物的 input/output 位置；注释据此归位）。 */
export interface ImportWarning {
  readonly path: string
  readonly message: string
}

// ---------------------------------------------------------------------------
// 文档校验与解析（纯函数；错误信息中文清晰）
// ---------------------------------------------------------------------------

/** 校验最小形状：JSON 对象、openapi 3.x、paths 为对象。 */
export function validateOpenapiDocument(doc: unknown): asserts doc is OpenapiDocument {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`OpenAPI 文档必须是 JSON 对象，收到 ${doc === null ? 'null' : Array.isArray(doc) ? '数组' : typeof doc}`)
  }
  const node = doc as Record<string, unknown>
  const version = node.openapi
  if (typeof version !== 'string' || !version.startsWith('3.')) {
    throw new Error(
      `OpenAPI 文档缺少有效的 "openapi" 版本号（当前仅支持 3.x，收到 ${JSON.stringify(version)}）`
      + '——请确认源是 OpenAPI 3.x 文档（Swagger 2.0 需先升级转换）',
    )
  }
  if (node.paths === undefined) throw new Error('OpenAPI 文档缺少 "paths" 对象——没有可导入的 operation')
  if (node.paths === null || typeof node.paths !== 'object' || Array.isArray(node.paths)) {
    throw new Error('OpenAPI 文档的 "paths" 必须是对象（路径 → Path Item）')
  }
}

/** 疑似 YAML 的启发式检测（首段不是 { 或 [ 且出现 openapi:/paths: 等顶层键）。 */
function looksLikeYaml(text: string): boolean {
  if (/^\s*[{\[]/.test(text)) return false
  const head = text.slice(0, 1024)
  return /^\s*(openapi|info|paths|servers)\s*:/m.test(head)
}

/** YAML → JSON 的转换提示（写进错误信息，用户可直接复制执行）。 */
const YAML_HINT
  = '可先转换：python -c "import yaml,json,sys; json.dump(yaml.safe_load(open(sys.argv[1], encoding=\'utf-8\')), open(sys.argv[2], \'w\', encoding=\'utf-8\'), ensure_ascii=False)" in.yaml out.json'
    + '，或使用任意 YAML→JSON 在线转换工具'

/**
 * 解析源文本为 OpenAPI 文档（只支持 JSON；YAML 特征检测 → 明确报错指路）。
 * @param text - 源文档全文（URL 拉取或本地读取由调用方完成）。
 * @param label - 源描述（错误信息定位用，如 URL 或文件路径）。
 */
export function parseOpenapiSource(text: string, label = '源文档'): OpenapiDocument {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (error) {
    if (looksLikeYaml(text)) {
      throw new Error(`${label} 不是合法 JSON（疑似 YAML 格式的 OpenAPI 文档）——loom import-openapi 只支持 JSON；${YAML_HINT}`)
    }
    throw new Error(`${label} 不是合法 JSON：${String(error)}`)
  }
  validateOpenapiDocument(doc)
  return doc
}

// ---------------------------------------------------------------------------
// 工具名规范化
// ---------------------------------------------------------------------------

/** operationId / 路径 → snake_case 工具名（camelCase 拆分、非法字符→下划线、统一小写）。 */
export function snakeCaseOperationName(raw: string): string {
  const snake = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  return snake === '' ? 'op' : snake
}

/** 路径 → 合法工具名段（只替换非法字符，不拆 camelCase——路径段名保持原样）。 */
function sanitizePathName(path: string): string {
  const sanitized = path
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  return sanitized === '' ? 'root' : sanitized
}

// ---------------------------------------------------------------------------
// operation 枚举（过滤/命名/去重的唯一实现；生成与统计共用）
// ---------------------------------------------------------------------------

/** Path Item 上我们关心的方法（固定遍历序，确定性）。 */
const HTTP_METHODS: readonly string[] = ['get', 'post', 'put', 'patch', 'delete', 'trace', 'options', 'head']
/** 暂不支持、跳过并注释的方法。 */
const SKIP_METHODS: ReadonlySet<string> = new Set(['trace', 'options', 'head'])
/** 写操作（声明上方给 policy 建议）。 */
const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
/** 只读方法（导入工具的 query 字段集合；body 字段并入 query 并注明）。 */
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'DELETE'])

/** 一个 OpenAPI parameter 条目（pathItem 级 + operation 级合并后）。 */
interface ParamEntry {
  readonly name: string
  readonly in: string
  readonly required: boolean
  readonly description: string | undefined
  readonly schema: unknown
  readonly queryJson: boolean
}

/** 一次导入源枚举的结果。 */
interface CollectedOps {
  readonly tools: Array<{
    readonly toolName: string
    readonly method: string
    readonly path: string
    readonly operation: Record<string, unknown>
    readonly parameters: ParamEntry[]
  }>
  /** 跳过的 trace/options/head（生成注释行）。 */
  readonly skippedMethods: Array<{ method: string; path: string }>
  /** 被 --include/--tag 过滤掉的 operation 数。 */
  readonly filtered: number
}

/** 本地 JSON 指针解析（#/components/schemas/Foo 等；~0/~1 还原）。 */
function resolvePointer(doc: unknown, ref: string): unknown {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined
  let current: unknown = doc
  for (const raw of ref.slice(2).split('/')) {
    if (current === null || typeof current !== 'object') return undefined
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    current = (current as Record<string, unknown>)[key]
    if (current === undefined) return undefined
  }
  return current
}

/** 取节点的非空字符串 description，否则 undefined。 */
function descriptionOf(node: Record<string, unknown>): string | undefined {
  const value = node.description
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 解析一个 parameter 条目（$ref 到 #/components/parameters/... 也支持）。 */
function toParamEntry(raw: unknown, doc: OpenapiDocument): ParamEntry | undefined {
  let node = raw
  if (isPlainObject(node) && typeof node.$ref === 'string') {
    const target = resolvePointer(doc, node.$ref)
    if (target === undefined) return undefined
    node = target
  }
  if (!isPlainObject(node) || typeof node.name !== 'string') return undefined
  const schema = node.schema ?? { type: 'string' }
  const queryJson = node['x-loom-query-json'] === true
    || (isPlainObject(node.schema) && node.schema['x-loom-query-json'] === true)
  return {
    name: node.name,
    in: typeof node.in === 'string' ? node.in : 'query',
    required: node.required === true,
    description: descriptionOf(node),
    schema,
    queryJson,
  }
}

/** 枚举全部 operation：方法小写→大写；命名/去重；--include/--tag 过滤。 */
function collectOperations(doc: OpenapiDocument, opts: GenerateImportOptions): CollectedOps {
  const includeRe = opts.include === undefined ? undefined : globToRegExp(opts.include)
  const tagFilter = opts.tag
  const tools: CollectedOps['tools'] = []
  const skippedMethods: CollectedOps['skippedMethods'] = []
  let filtered = 0
  const usedNames = new Set<string>()

  const paths = doc.paths as Record<string, unknown>
  for (const [path, pathItemRaw] of Object.entries(paths)) {
    if (!isPlainObject(pathItemRaw)) continue
    const sharedParams = Array.isArray(pathItemRaw.parameters)
      ? pathItemRaw.parameters.map(p => toParamEntry(p, doc)).filter((p): p is ParamEntry => p !== undefined)
      : []
    for (const method of HTTP_METHODS) {
      const opRaw = pathItemRaw[method]
      if (opRaw === undefined) continue
      if (SKIP_METHODS.has(method)) {
        skippedMethods.push({ method: method.toUpperCase(), path })
        continue
      }
      if (!isPlainObject(opRaw)) continue
      const tags = Array.isArray(opRaw.tags) ? opRaw.tags.filter(t => typeof t === 'string') : []
      if (tagFilter !== undefined && !tags.includes(tagFilter)) {
        filtered++
        continue
      }
      // 工具名：operationId snake_case 化；缺省由路径段 + 方法拼出（不再二次
      // 拆 camelCase，路径段名保持原样）；去重加序号。
      const base = typeof opRaw.operationId === 'string' && opRaw.operationId.trim() !== ''
        ? snakeCaseOperationName(opRaw.operationId)
        : `${sanitizePathName(path)}_${method}`
      let toolName = base
      for (let n = 2; usedNames.has(toolName); n++) toolName = `${base}_${n}`
      usedNames.add(toolName)
      if (includeRe !== undefined && !includeRe.test(toolName)) {
        filtered++
        continue
      }
      const opParams = Array.isArray(opRaw.parameters)
        ? opRaw.parameters.map(p => toParamEntry(p, doc)).filter((p): p is ParamEntry => p !== undefined)
        : []
      // operation 级同名（name+in）覆盖 pathItem 级。
      const merged = [...sharedParams.filter(shared => !opParams.some(p => p.name === shared.name && p.in === shared.in)), ...opParams]
      tools.push({ toolName, method: method.toUpperCase(), path, operation: opRaw, parameters: merged })
    }
  }
  return { tools, skippedMethods, filtered }
}

/** 枚举结果的统计视图（CLI 汇总打印用）。 */
export function summarizeImportSource(
  doc: OpenapiDocument,
  opts: GenerateImportOptions = {},
): { tools: number; skippedMethods: number; filtered: number } {
  const collected = collectOperations(doc, opts)
  return { tools: collected.tools.length, skippedMethods: collected.skippedMethods.length, filtered: collected.filtered }
}

// ---------------------------------------------------------------------------
// DSL → TS 字面量（确定性序列化）
// ---------------------------------------------------------------------------

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** 紧凑单行形态的长度上限（超过或任一子节点放不下 → 多行渲染）。 */
const COMPACT_MAX = 100

/** 尝试渲染紧凑单行形态；放不下返回 undefined（父级随之退多行）。 */
function tsCompact(value: unknown): string | undefined {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const parts = value.map(item => tsCompact(item))
    if (parts.some(part => part === undefined)) return undefined
    const text = `[${parts.join(', ')}]`
    return text.length <= COMPACT_MAX ? text : undefined
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    const parts = entries.map(([key, child]) => {
      const compact = tsCompact(child)
      return compact === undefined ? undefined : `${IDENT.test(key) ? key : JSON.stringify(key)}: ${compact}`
    })
    if (parts.some(part => part === undefined)) return undefined
    const text = `{ ${parts.join(', ')} }`
    return text.length <= COMPACT_MAX ? text : undefined
  }
  return undefined
}

/** 任意纯 JSON 值 → TS 字面量文本（短节点单行，长对象/数组多行）。 */
function tsValue(value: unknown, indent: number): string {
  const compact = tsCompact(value)
  if (compact !== undefined) return compact
  const pad = '  '.repeat(indent)
  const inner = '  '.repeat(indent + 1)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[\n${value.map(item => `${inner}${tsValue(item, indent + 1)},`).join('\n')}\n${pad}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    const lines = entries.map(([key, child]) => `${inner}${IDENT.test(key) ? key : JSON.stringify(key)}: ${tsValue(child, indent + 1)},`)
    return `{\n${lines.join('\n')}\n${pad}}`
  }
  return 'undefined'
}

// ---------------------------------------------------------------------------
// 生成器主体
// ---------------------------------------------------------------------------

/** 安全认证方案检测（bearer / apiKey header 落头；其余 TODO 注释）。 */
interface SecurityPlan {
  readonly hasSchemes: boolean
  /** 头名 → 值模板（${token} 占位）。 */
  readonly headerLines: Array<[string, string]>
  readonly notes: string[]
}

function detectSecurity(doc: OpenapiDocument): SecurityPlan {
  const schemes = (doc.components as Record<string, unknown> | undefined)?.securitySchemes
  if (!isPlainObject(schemes) || Object.keys(schemes).length === 0) {
    return { hasSchemes: false, headerLines: [], notes: [] }
  }
  const headerLines: Array<[string, string]> = []
  const notes: string[] = []
  for (const [name, schemeRaw] of Object.entries(schemes)) {
    if (!isPlainObject(schemeRaw)) continue
    if (schemeRaw.type === 'http' && schemeRaw.scheme === 'bearer') {
      headerLines.push(['authorization', 'Bearer ${token}'])
    } else if (schemeRaw.type === 'http') {
      notes.push(`scheme "${name}"（http/${String(schemeRaw.scheme)}）非 bearer，按需补认证头`)
    } else if (schemeRaw.type === 'apiKey' && schemeRaw.in === 'header' && typeof schemeRaw.name === 'string') {
      headerLines.push([schemeRaw.name, '${token}'])
    } else if (schemeRaw.type === 'apiKey') {
      notes.push(`apiKey "${name}" 位置 ${String(schemeRaw.in)}——按 spec 注入到对应位置`)
    } else {
      notes.push(`scheme "${name}"（${String(schemeRaw.type)}）需自行换取令牌后注入`)
    }
  }
  return { hasSchemes: true, headerLines, notes }
}

/** requestBody → body 字段计划（object 根展开；非 object 根收进单字段 body）。 */
function bodyFieldPlan(
  toolName: string,
  method: string,
  operation: Record<string, unknown>,
  isRead: boolean,
  ctx: ConvertContext,
): { fields: string[]; table: Record<string, unknown> } {
  let bodyRaw: unknown = operation.requestBody
  if (isPlainObject(bodyRaw) && typeof bodyRaw.$ref === 'string') {
    const target = ctx.resolve(bodyRaw.$ref)
    if (target !== undefined) bodyRaw = target
  }
  if (!isPlainObject(bodyRaw)) return { fields: [], table: {} }
  const content = isPlainObject(bodyRaw.content) ? bodyRaw.content : {}
  const json = isPlainObject(content['application/json']) ? content['application/json'] : undefined
  if (json === undefined || json.schema === undefined) {
    ctx.warn('input.body', `${toolName} 的 requestBody 缺少 application/json schema，body 字段未导入`)
    return { fields: [], table: {} }
  }
  const dsl = jsonSchemaToDsl(json.schema, ctx, 'input.body')
  if (dsl.type === 'object' && isPlainObject(dsl.properties)) {
    if (isRead) ctx.warn('input.body', `${toolName} 是只读方法但声明了 requestBody——body 字段已并入 query（Loom 只读方法不读 body）`)
    return { fields: Object.keys(dsl.properties), table: dsl.properties }
  }
  const note = isRead ? '原 requestBody（任意 JSON，经 query 传输）' : '原 requestBody（非 object 根整体收进 body 字段）'
  ctx.warn('input.body', `${toolName} 的 requestBody 根不是 object，已整体收进单字段 body`)
  return { fields: ['body'], table: { body: { ...dsl, required: bodyRaw.required !== false, description: note } } }
}

/** 路径模板 → 生成代码里的模板字面量（{id} → encodeURIComponent 替换）。 */
function pathTemplateExpr(path: string, pathParams: readonly ParamEntry[]): string {
  let template = path
  for (const param of pathParams) {
    template = template.replaceAll(`{${param.name}}`, `\${encodeURIComponent(String(args[${JSON.stringify(param.name)}] ?? ''))}`)
  }
  return template
}

/** 组装一个工具的完整段（声明 + execute 真 fetch）。 */
function toolSection(entry: CollectedOps['tools'][number], doc: OpenapiDocument, security: SecurityPlan): string[] {
  const { toolName, method, path, operation, parameters } = entry
  const isRead = READ_METHODS.has(method)
  const warnings: ImportWarning[] = []
  const ctx: ConvertContext = {
    resolve: ref => resolvePointer(doc, ref),
    warn: (at, message) => { warnings.push({ path: at, message }) },
  }

  // ---- 字段归类 --------------------------------------------------------------
  const pathParams = parameters.filter(p => p.in === 'path')
  // 路径模板里的 {x} 必须有对应参数；缺失按必填 string 兜底（并注明）。
  const templateNames = [...path.matchAll(/\{([^}/]+)\}/g)].map(match => match[1]!)
  for (const name of templateNames) {
    if (!pathParams.some(p => p.name === name)) {
      warnings.push({ path: `input.${name}`, message: `路径参数 {${name}} 未在 parameters 声明，已按必填 string 兜底` })
      pathParams.push({ name, in: 'path', required: true, description: undefined, schema: { type: 'string' }, queryJson: false })
    }
  }
  const queryParams = parameters.filter(p => p.in === 'query')

  const inputTable: Record<string, unknown> = {}
  for (const param of pathParams) {
    const field = jsonSchemaToDsl(param.schema, ctx, `input.${param.name}`)
    const description = [param.description, `原路径参数（${method} ${path} 的 {${param.name}}）`].filter(Boolean).join('；')
    inputTable[param.name] = { ...field, required: true, description }
  }
  for (const param of queryParams) {
    const field = jsonSchemaToDsl(param.schema, ctx, `input.${param.name}`)
    inputTable[param.name] = {
      ...field,
      ...(param.required ? { required: true } : {}),
      ...(param.description === undefined ? {} : { description: param.description }),
    }
  }
  const body = bodyFieldPlan(toolName, method, operation, isRead, ctx)
  Object.assign(inputTable, body.table)

  // ---- 输出 ------------------------------------------------------------------
  const responses = isPlainObject(operation.responses) ? operation.responses : {}
  const okResponseRaw = responses['200'] ?? responses['201'] ?? responses['default']
  let outputDsl: Record<string, unknown>
  if (okResponseRaw === undefined) {
    warnings.push({ path: 'output', message: `${toolName} 未声明成功响应（200/201/default），输出按任意 JSON 处理` })
    outputDsl = { type: 'json' }
  } else {
    let okResponse: unknown = okResponseRaw
    if (isPlainObject(okResponse) && typeof okResponse.$ref === 'string') {
      const target = ctx.resolve(okResponse.$ref)
      if (target !== undefined) okResponse = target
    }
    const content = isPlainObject(okResponse) && isPlainObject(okResponse.content) ? okResponse.content : undefined
    const json = isPlainObject(content?.['application/json']) ? content!['application/json'] as Record<string, unknown> : undefined
    if (json === undefined || json.schema === undefined) {
      warnings.push({ path: 'output', message: `${toolName} 的成功响应缺少 application/json schema，输出按任意 JSON 处理` })
      outputDsl = { type: 'json' }
    } else {
      outputDsl = jsonSchemaToDsl(json.schema, ctx, 'output')
    }
  }

  // ---- 描述（summary + description + tags + 来源） ------------------------------
  const descParts: string[] = []
  if (typeof operation.summary === 'string' && operation.summary !== '') descParts.push(operation.summary)
  if (typeof operation.description === 'string' && operation.description !== '') descParts.push(operation.description)
  const tags = Array.isArray(operation.tags) ? operation.tags.filter(t => typeof t === 'string') : []
  if (tags.length > 0) descParts.push(`来源标签：${tags.join('、')}`)
  descParts.push(`导入自 OpenAPI 文档：${method} ${path}`)

  // ---- WARN 注释归位（input.* → .input 上方；output → .output 上方） ------------
  const inputWarns = warnings.filter(w => w.path.startsWith('input'))
  const outputWarns = warnings.filter(w => w.path.startsWith('output'))
  const warnLine = (w: ImportWarning): string => `    // WARN(openapi-import): ${w.path}——${w.message}`

  // ---- execute 真 fetch 代码 ---------------------------------------------------
  const hasQuery = queryParams.length > 0
  const hasBody = body.fields.length > 0 && !isRead
  const template = pathTemplateExpr(path, pathParams)

  const lines: string[] = []
  lines.push('  app')
  lines.push(`    .tool(${JSON.stringify(toolName)})`)
  lines.push(`    .description(${JSON.stringify(descParts.join('\n\n'))})`)
  for (const warning of inputWarns) lines.push(warnLine(warning))
  lines.push(`    .input(${tsValue(inputTable, 2)})`)
  for (const warning of outputWarns) lines.push(warnLine(warning))
  lines.push(`    .output(${tsValue(outputDsl, 2)})`)
  if (WRITE_METHODS.has(method)) {
    lines.push(`    // 建议：app.policy 中为该写操作配置 approve（${method} ${path}——真实写操作应走人工审批）`)
  }
  lines.push(`    .http(${JSON.stringify(method)})`)
  lines.push('    .execute(async (args, exec) => {')
  lines.push(`    const path = \`${template}\``)
  if (hasQuery) {
    lines.push('    const query = new URLSearchParams()')
    for (const param of queryParams) {
      const key = JSON.stringify(param.name)
      lines.push(param.queryJson
        ? `    if (args[${key}] !== undefined) query.set(${key}, JSON.stringify(args[${key}])) // x-loom-query-json：值是 JSON 编码字符串`
        : `    if (args[${key}] !== undefined) query.set(${key}, encodeQueryValue(args[${key}]))`)
    }
    lines.push("    const qs = query.toString()")
    lines.push('    const url = `${loomImportBase}${path}${qs === "" ? "" : `?${qs}`}`')
  } else {
    lines.push('    const url = `${loomImportBase}${path}`')
  }
  if (hasBody) lines.push(`    const payload = pick(args, ${JSON.stringify(body.fields)})`)
  lines.push('    const res = await fetch(url, {')
  lines.push(`      method: ${JSON.stringify(method)},`)
  lines.push('      signal: exec.signal,')
  // headers 单键合并（认证 + content-type），避免对象字面量重复键。
  if (security.hasSchemes && hasBody) {
    lines.push("      headers: { 'content-type': 'application/json', ...(token === undefined ? {} : authHeaders(token)) },")
    lines.push('      body: JSON.stringify(payload),')
  } else if (security.hasSchemes) {
    lines.push('      headers: { ...(token === undefined ? {} : authHeaders(token)) },')
  } else if (hasBody) {
    lines.push("      headers: { 'content-type': 'application/json' },")
    lines.push('      body: JSON.stringify(payload),')
  }
  lines.push('    })')
  lines.push('    if (!res.ok) {')
  lines.push("      const text = await res.text().catch(() => '')")
  lines.push(`      throw new Error(\`${toolName} 调用失败：HTTP \${res.status}——\${text.slice(0, 200)}\`)`)
  lines.push('    }')
  if (outputDsl.type === 'json') lines.push('    // 输出已降级为任意 JSON（见上方 WARN）：结果原样返回')
  lines.push('    return await res.json()')
  lines.push('    })')
  return lines
}

/**
 * 从 OpenAPI 3.x 文档生成 Loom 工具声明模块（确定性 TS 源码文本）。
 * 产物：AUTO-GENERATED 头 + `registerImportedTools(app)`——用户在 loom.app.ts
 * 里 `import { registerImportedTools } from './loom.openapi'` 后一行接入。
 */
export function generateImportModule(doc: OpenapiDocument, opts: GenerateImportOptions = {}): string {
  validateOpenapiDocument(doc)
  const security = detectSecurity(doc)
  const collected = collectOperations(doc, opts)

  const servers = Array.isArray(doc.servers) ? doc.servers : []
  const firstServer = isPlainObject(servers[0]) && typeof servers[0]!.url === 'string' ? servers[0]!.url : undefined
  const base = (opts.base ?? firstServer ?? 'http://127.0.0.1').replace(/\/+$/, '')
  const baseNote = opts.base !== undefined
    ? '（--base 覆盖）'
    : firstServer === undefined
      ? '（源头未声明 servers，占位基址——请用 configureImportedClient 或 --base 覆盖）'
      : '（源头 servers[0].url）'

  const head = [
    '/**',
    " * AUTO-GENERATED by 'loom import-openapi' — 勿手改；源头文档变更后重新生成。",
    ' *',
    ` * OpenAPI ${String(doc.openapi)} → ${collected.tools.length} 个 Loom 工具`,
    ...(collected.skippedMethods.length > 0 ? [` * （跳过 ${collected.skippedMethods.length} 个 trace/options/head operation）`] : []),
    ...(collected.filtered > 0 ? [` * （过滤 ${collected.filtered} 个 operation）`] : []),
    ' *',
    " * 接入：在 loom.app.ts 里 import { registerImportedTools } from './<本文件名>'，",
    ' * 然后一行 registerImportedTools(app)——外部 API 即获得模型面孔 + HTTP 面孔，',
    ' * 策略/审批/投影照常生效（写操作声明处有 approve 建议）。',
    ' * 降级说明：源头 schema 里 Loom DSL 不覆盖的部分已诚实降级，见各处 WARN(openapi-import) 注释。',
    ' */',
    "import type { App } from '@loom-sdk/web'",
    '',
    `/** API 基址 ${baseNote}。 */`,
    `let loomImportBase = ${JSON.stringify(base)}`,
    '',
    '/** 覆盖基址（如指向本地代理 / 测试实例）。 */',
    'export function configureImportedClient(opts: { baseUrl: string }): void {',
    "  loomImportBase = opts.baseUrl.replace(/\\/+$/, '')",
    '}',
  ]

  const helpers: string[] = []
  if (security.hasSchemes) {
    helpers.push(
      '',
      '// 源头声明了 securitySchemes：token 缺省读 LOOM_IMPORT_TOKEN 环境变量。',
      '// TODO: 按需注入认证头（bearer → Authorization；apiKey 按声明位置）',
      ...security.notes.map(note => `// TODO: 按需注入认证头——${note}`),
      'const token = process.env.LOOM_IMPORT_TOKEN',
      '',
      '/** 认证头（bearer → Authorization；apiKey 按声明的 header 名注入）。 */',
      'function authHeaders(token: string): Record<string, string> {',
      '  return {',
      ...security.headerLines.map(([name, expr]) => `    ${JSON.stringify(name)}: \`${expr}\`,`),
      '  }',
      '}',
    )
  }
  helpers.push(
    '',
    '/** 从 args 里挑出指定字段（undefined 跳过；requestBody 组装用）。 */',
    'function pick(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {',
    '  const out: Record<string, unknown> = {}',
    '  for (const key of keys) {',
    '    const value = args[key]',
    '    if (value !== undefined) out[key] = value',
    '  }',
    '  return out',
    '}',
    '',
    '/** query 值编码：标量原样，复杂值 JSON 编码（与服务端 parseScalar 对称）。 */',
    'function encodeQueryValue(value: unknown): string {',
    "  return typeof value === 'string' ? value : JSON.stringify(value)",
    '}',
  )

  const body: string[] = []
  body.push('export function registerImportedTools(app: App): void {')
  for (const entry of collected.tools) {
    body.push(...toolSection(entry, doc, security))
  }
  for (const skipped of collected.skippedMethods) {
    body.push(`  // 跳过 ${skipped.method} ${skipped.path}（trace/options/head 暂不支持）`)
  }
  if (collected.tools.length === 0) {
    body.push('  // （没有可导入的 operation——检查 paths / --include / --tag 过滤条件）')
  }
  body.push('}')

  return `${[...head, ...helpers].join('\n')}\n\n${body.join('\n')}\n`
}

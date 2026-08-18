/**
 * JSON Schema → dsh-tools defineTool DSL 转换器（诚实降级）。
 *
 * 自 @loom-sdk/web 的 openapi-import.ts 抽出（M8 插件化：Python 工具桥与该
 * 转换器同属"把外部 schema 落成内核工具 DSL"的通用能力，dsh-python-tools
 * 作为独立 dsh 插件包持有它，loom 的 openapi-import 反向复用）。
 *
 * 诚实降级纪律：只把有把握的 JSON Schema 子集落成 DSL（本地 $ref 展开 /
 * allOf 浅合并 / type·enum·const·items·oneOf / 可空联合），落不了的
 * （anyOf 混合分支、format/min·max 约束等）降级为 `{ type: 'json' }` 或裸
 * 类型，并经 ctx.warn 收集警告——宁可少承诺，不可静默错 schema。
 * @module dsh-python-tools/convert
 */

/** jsonSchemaToDsl 的转换上下文（$ref 解析 + 降级警告收集）。 */
export interface ConvertContext {
  /** 解析本地 JSON 指针（#/components/schemas/... 等）；未命中返回 undefined。 */
  resolve(ref: string): unknown
  /** 收集降级警告。 */
  warn(path: string, message: string): void
}

/** 无操作的缺省上下文（纯函数单测直接传 schema 即可）。 */
const NOOP_CTX: ConvertContext = { resolve: () => undefined, warn: () => undefined }

/** 会触发降级警告的常见约束关键字（DSL 不覆盖，只能丢弃并注明）。 */
const CONSTRAINT_KEYS: readonly string[] = [
  'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength',
  'pattern', 'minItems', 'maxItems', 'uniqueItems', 'multipleOf', 'minProperties', 'maxProperties',
  'patternProperties', 'propertyNames', 'dependentRequired', 'dependencies', 'if', 'then', 'else',
  'not', 'contains', 'prefixItems', 'externalDocs', 'deprecated', 'readOnly', 'writeOnly', 'xml',
  'example', 'examples', 'default', 'title', 'discriminator', 'unevaluatedProperties', 'unevaluatedItems',
]

/** 递归深度上限（循环 $ref 兜底；正常 schema 远达不到）。 */
const MAX_DEPTH = 16

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function descriptionOf(node: Record<string, unknown>): string | undefined {
  return typeof node.description === 'string' && node.description !== '' ? node.description : undefined
}

/** DSL 对象节点的浅合并（allOf 用）：properties 按键合并（字段级 required 随字段走）。 */
function mergeDslObjects(branches: Array<Record<string, unknown>>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const branch of branches) {
    Object.assign(properties, isPlainObject(branch.properties) ? branch.properties : {})
  }
  return { type: 'object', properties }
}

/** const / enum → DSL（值必须是同族 JSON 原语）。 */
function constOrEnum(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const kindOf = (item: unknown): 'string' | 'number' | 'boolean' | 'null' | undefined =>
    typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null
      ? (typeof item as 'string' | 'number' | 'boolean' | 'null')
      : undefined
  if ('const' in value) {
    const kind = kindOf(value.const)
    if (kind === undefined) return undefined
    return { type: kind, const: value.const }
  }
  if (Array.isArray(value.enum)) {
    const kinds = new Set(value.enum.map(kindOf))
    if (kinds.has(undefined) || kinds.size !== 1) return undefined
    return { type: [...kinds][0]!, enum: [...value.enum] }
  }
  return undefined
}

/** 内部转换器（depth 计数防循环 $ref）。 */
function convert(value: unknown, ctx: ConvertContext, path: string, depth: number): Record<string, unknown> {
  const warnJson = (message: string): Record<string, unknown> => {
    ctx.warn(path, `${message}，已降级为 { type: 'json' }（任意 canonical JSON）`)
    return { type: 'json' }
  }
  if (depth >= MAX_DEPTH) return warnJson('嵌套/循环引用超过深度上限')
  if (!isPlainObject(value)) return warnJson(`schema 不是对象（${typeof value}）`)

  // 本地 $ref：#/components/schemas/... 展开（换名续转，循环由深度上限兜底）。
  if (typeof value.$ref === 'string') {
    const ref = value.$ref
    const target = ctx.resolve(ref)
    if (target === undefined) return warnJson(`无法解析 $ref "${ref}"（仅支持 #/components/... 本地引用）`)
    const at = ref.replace(/^#\/components\/schemas\//, '') || ref
    const converted = convert(target, ctx, `${path}→${at}`, depth + 1)
    return descriptionOf(value) === undefined ? converted : { ...converted, description: descriptionOf(value) }
  }

  const description = descriptionOf(value)

  // allOf：浅合并（各分支递归转换后合并 properties）。
  if (Array.isArray(value.allOf)) {
    const branches = value.allOf.map((branch, index) => convert(branch, ctx, `${path}.allOf[${index}]`, depth + 1))
    if (branches.some(branch => branch.type !== 'object')) {
      return warnJson('allOf 含非 object 分支，无法浅合并')
    }
    const merged = mergeDslObjects(branches)
    ctx.warn(path, 'allOf 已按浅合并展开（properties 取并集，分支约束丢弃）')
    return description === undefined ? merged : { ...merged, description }
  }

  // anyOf：可空两分支（FastAPI 的 Optional[X]：anyOf:[T,{type:'null'}]）直接发
  // oneOf:[T,{type:'null'}]——内核校验支持 oneOf，null 由类型本身表达。不再降级为
  // "类型 + description 注记"：注记形态的 DSL 会被内核严格校验拒绝 null
  // （INVALID_TOOL_OUTPUT）。单分支直接采用；其余混合分支诚实降级 json。
  if (Array.isArray(value.anyOf)) {
    const branches = value.anyOf.map((branch, index) => convert(branch, ctx, `${path}.anyOf[${index}]`, depth + 1))
    const unique = branches.filter((branch, index) => branches.findIndex(other => JSON.stringify(other) === JSON.stringify(branch)) === index)
    const nonNull = unique.filter(branch => branch.type !== 'null')
    if (unique.length === 1) {
      ctx.warn(path, 'anyOf 单分支已直接采用')
      return unique[0]!
    }
    if (nonNull.length === 1 && unique.length === 2) {
      const base = nonNull[0]!
      if (base.type === 'json' && Object.keys(base).length === 1) {
        return warnJson('anyOf 可空联合的非空分支无法转换')
      }
      return description === undefined ? { oneOf: [base, { type: 'null' }] } : { oneOf: [base, { type: 'null' }], description }
    }
    return warnJson('anyOf 多分支联合不在 DSL 覆盖内')
  }

  // oneOf：分支递归保留；分支降级为 json 时联合失去意义 → json。
  if (Array.isArray(value.oneOf)) {
    const branches = value.oneOf.map((branch, index) => convert(branch, ctx, `${path}.oneOf[${index}]`, depth + 1))
    if (branches.some(branch => branch.type === 'json' && Object.keys(branch).length === 1)) {
      return warnJson('oneOf 的某分支无法转换，整个联合按 json 处理')
    }
    return description === undefined ? { oneOf: branches } : { oneOf: branches, description }
  }

  // type 数组：["X","null"]（JSON Schema 2020-12 可空形态）→ oneOf:[X,{type:'null'}]
  // （内核校验支持 oneOf，null 由类型表达——不再用 description 注记）；其余联合降级。
  if (Array.isArray(value.type)) {
    const types = value.type.filter((t): t is string => typeof t === 'string')
    const nonNull = types.filter(t => t !== 'null')
    if (nonNull.length === 1 && types.length === nonNull.length + 1) {
      const out = typedNode(nonNull[0]!, value, ctx, path, depth)
      if (out.type === 'json' && Object.keys(out).length === 1) return out
      return { oneOf: [out, { type: 'null' }] }
    }
    return warnJson(`type 数组 [${types.join(', ')}] 不在覆盖内`)
  }

  const type = typeof value.type === 'string' && value.type !== '' ? value.type : undefined
  if (type === undefined) {
    if ('const' in value || 'enum' in value) {
      const ce = constOrEnum(value)
      if (ce !== undefined) return ce
      return warnJson('const/enum 值不是同族 JSON 原语')
    }
    return warnJson('schema 未声明 type（无 const/enum 可推断）')
  }

  const node = typedNode(type, value, ctx, path, depth)
  // 约束关键字：能落 type 就落，约束丢弃但注明（诚实降级）。
  const dropped = CONSTRAINT_KEYS.filter(key => value[key] !== undefined)
  if (dropped.length > 0 && node.type !== 'json') {
    const detail = dropped.map(key => (value[key] === null || typeof value[key] !== 'object' ? `${key}=${JSON.stringify(value[key])}` : key)).join('、')
    ctx.warn(path, `约束 ${detail} 不在 DSL 覆盖内，已丢弃（保留类型）`)
  }
  return node
}

/** 有 type 的节点：标量 / array / object / 未知。 */
function typedNode(type: string, value: Record<string, unknown>, ctx: ConvertContext, path: string, depth: number): Record<string, unknown> {
  const description = descriptionOf(value)
  const annotate = (node: Record<string, unknown>): Record<string, unknown> =>
    description === undefined ? node : { ...node, description }

  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean' || type === 'null') {
    if ('const' in value || 'enum' in value) {
      const ce = constOrEnum(value)
      if (ce === undefined) {
        ctx.warn(path, 'const/enum 值不是同族 JSON 原语，已降级')
        return annotate({ type: 'json' })
      }
      return annotate(ce)
    }
    return annotate({ type })
  }
  if (type === 'array') {
    if (value.items === undefined) return annotate({ type: 'array' })
    return annotate({ type: 'array', items: convert(value.items, ctx, `${path}[]`, depth + 1) })
  }
  if (type === 'object') {
    // 开放字典（additionalProperties 是 schema 的 map 形状）：封闭对象会改变语义，诚实降级 json。
    if (isPlainObject(value.additionalProperties)) {
      ctx.warn(path, 'additionalProperties 映射（开放字典）不在 Loom DSL 覆盖内')
      return annotate({ type: 'json' })
    }
    const table = isPlainObject(value.properties) ? value.properties : {}
    // 开放对象（未声明 properties 且未显式封闭）：JSON Schema 语义是任意键，
    // 封闭成空对象会改变语义 → json。（显式 additionalProperties:false 的空对象
    // 是 `{type:'object'}` 的同构物，照常转换。）
    if (Object.keys(table).length === 0 && value.additionalProperties !== false) {
      ctx.warn(path, '开放对象（未声明 properties）不在 DSL 覆盖内')
      return annotate({ type: 'json' })
    }
    const properties: Record<string, unknown> = {}
    const requiredNames = new Set(Array.isArray(value.required) ? value.required.filter((name): name is string => typeof name === 'string') : [])
    for (const [name, child] of Object.entries(table)) {
      const field = convert(child, ctx, `${path}.${name}`, depth + 1)
      properties[name] = requiredNames.has(name) ? { ...field, required: true } : field
    }
    // required 里声明但 properties 缺描述的字段：按 json 兜底（诚实——结构未知）。
    for (const name of requiredNames) {
      if (!(name in properties)) properties[name] = { type: 'json', description: '原 schema 声明必填但未描述结构' }
    }
    return annotate({ type: 'object', properties })
  }
  ctx.warn(path, `type "${type}" 不在 DSL 覆盖内`)
  return annotate({ type: 'json' })
}

/**
 * JSON Schema 节点 → defineTool DSL 节点。
 * 顶层 required 数组 → 字段级 `required: true`；本地 $ref 展开；allOf 浅合并；
 * 可空联合（`anyOf:[T,{type:'null'}]` 与 `type:['X','null']`）→
 * `oneOf:[T,{type:'null'}]`（内核校验按类型接受 null）；anyOf 混合分支、
 * format/min·max 等诚实降级（能落 type 就落，落不了 `{type:'json'}`，
 * 经 ctx.warn 收集注释）。
 */
export function jsonSchemaToDsl(value: unknown, ctx: ConvertContext = NOOP_CTX, path = 'schema'): Record<string, unknown> {
  return convert(value, ctx, path, 0)
}

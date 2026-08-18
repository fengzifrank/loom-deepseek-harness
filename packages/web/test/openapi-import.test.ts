/**
 * `loom import-openapi` 生成器（openapi-import.ts）单测：
 * - jsonSchemaToDsl 纯函数：required 移位 / $ref 展开 / allOf 浅合并 / 可空联合 /
 *   anyOf·开放对象·开放字典·format 约束的诚实降级（json + warn）；
 * - petstore 风格夹具（fixtures/petstore.openapi.json）：生成文本断言——工具名
 *   snake_case 化与缺省名、路径参数字段、policy 建议注释、token 注入、
 *   x-loom-query-json 忠实往返、真 fetch（signal / 非 2xx 抛错）、跳过注释；
 * - --include / --tag 过滤、parseOpenapiSource 校验（YAML 指路 / 形状校验）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  generateImportModule,
  jsonSchemaToDsl,
  parseOpenapiSource,
  snakeCaseOperationName,
  summarizeImportSource,
  type ConvertContext,
  type ImportWarning,
} from '../src/openapi-import.js'

const FIXTURE = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'petstore.openapi.json')

/** 收集警告的测试上下文（$ref 解析指向夹具 doc）。 */
function warnCtx(doc: unknown): { ctx: ConvertContext; warnings: ImportWarning[] } {
  const warnings: ImportWarning[] = []
  return {
    warnings,
    ctx: {
      resolve: (ref: string) => {
        let current: unknown = doc
        for (const raw of ref.replace(/^#\/?/, '').split('/')) {
          if (current === null || typeof current !== 'object') return undefined
          current = (current as Record<string, unknown>)[raw.replace(/~1/g, '/').replace(/~0/g, '~')]
        }
        return current
      },
      warn: (path, message) => { warnings.push({ path, message }) },
    },
  }
}

// ---------------------------------------------------------------------------
// jsonSchemaToDsl（纯函数）
// ---------------------------------------------------------------------------

describe('jsonSchemaToDsl', () => {
  it('顶层 required 数组 → 字段级 required:true', () => {
    expect(jsonSchemaToDsl({
      type: 'object',
      properties: { id: { type: 'integer' }, name: { type: 'string' } },
      required: ['id'],
    })).toEqual({
      type: 'object',
      properties: { id: { type: 'integer', required: true }, name: { type: 'string' } },
    })
  })

  it('本地 $ref 展开（#/components/schemas/...）', () => {
    const doc = { components: { schemas: { Pet: { type: 'object', properties: { name: { type: 'string' } } } } } }
    const { ctx } = warnCtx(doc)
    expect(jsonSchemaToDsl({ $ref: '#/components/schemas/Pet' }, ctx)).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
    })
  })

  it('allOf 浅合并（properties 并集，字段级 required 随字段走）+ 降级警告', () => {
    const { ctx, warnings } = warnCtx({})
    expect(jsonSchemaToDsl({
      allOf: [
        { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        { type: 'object', properties: { kind: { type: 'string' } } },
      ],
    }, ctx)).toEqual({
      type: 'object',
      properties: { name: { type: 'string', required: true }, kind: { type: 'string' } },
    })
    expect(warnings.some(w => w.message.includes('allOf 已按浅合并'))).toBe(true)
  })

  it('type 数组 [x,"null"] → oneOf:[x,{type:"null"}]（内核校验按类型接受 null）', () => {
    expect(jsonSchemaToDsl({ type: ['string', 'null'] })).toEqual({
      oneOf: [{ type: 'string' }, { type: 'null' }],
    })
    // 带 description 的节点：注记原样保留在类型分支上，不再追加"可为 null"字样。
    expect(jsonSchemaToDsl({ type: ['number', 'null'], description: '数量' })).toEqual({
      oneOf: [{ type: 'number', description: '数量' }, { type: 'null' }],
    })
  })

  it('oneOf 分支递归保留；anyOf 可空两分支 → oneOf:[T,{type:"null"}]（不再降级注记）；混合 anyOf 降级 json', () => {
    expect(jsonSchemaToDsl({ oneOf: [{ type: 'string' }, { type: 'number' }] })).toEqual({
      oneOf: [{ type: 'string' }, { type: 'number' }],
    })
    const nullable = warnCtx({})
    expect(jsonSchemaToDsl({ anyOf: [{ type: 'string' }, { type: 'null' }] }, nullable.ctx)).toEqual({
      oneOf: [{ type: 'string' }, { type: 'null' }],
    })
    // 可空联合是忠实转换（非降级）：零警告。
    expect(nullable.warnings).toEqual([])
    // null 分支在前也归一为 [T, null] 形态（确定性）。
    expect(jsonSchemaToDsl({ anyOf: [{ type: 'null' }, { type: 'string' }] })).toEqual({
      oneOf: [{ type: 'string' }, { type: 'null' }],
    })

    const mixed = warnCtx({})
    expect(jsonSchemaToDsl({ anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, mixed.ctx)).toEqual({ type: 'json' })
    expect(mixed.warnings.some(w => w.message.includes('anyOf 多分支联合'))).toBe(true)
  })

  it('诚实降级：开放对象 / 开放字典 / 未知 type / 非 JSON const → json + warn', () => {
    const { ctx, warnings } = warnCtx({})
    expect(jsonSchemaToDsl({ type: 'object' }, ctx)).toEqual({ type: 'json' })
    expect(jsonSchemaToDsl({ type: 'object', additionalProperties: { type: 'integer' } }, ctx)).toEqual({ type: 'json' })
    expect(jsonSchemaToDsl({ type: 'file' }, ctx)).toEqual({ type: 'json' })
    expect(jsonSchemaToDsl({ type: 'string', minimum: 1 }, ctx)).toEqual({ type: 'string' })
    expect(warnings.map(w => w.path)).toEqual(['schema', 'schema', 'schema', 'schema'])
    expect(warnings[3]!.message).toContain('minimum=1')
  })

  it('显式封闭的空对象照常转换（Loom {type:"object"} 的同构物）', () => {
    expect(jsonSchemaToDsl({ type: 'object', properties: {}, additionalProperties: false })).toEqual({
      type: 'object',
      properties: {},
    })
  })

  it('enum / const 原语保留', () => {
    expect(jsonSchemaToDsl({ type: 'string', enum: ['available', 'sold'] })).toEqual({
      type: 'string',
      enum: ['available', 'sold'],
    })
    expect(jsonSchemaToDsl({ type: 'integer', const: 42 })).toEqual({ type: 'number', const: 42 })
  })
})

// ---------------------------------------------------------------------------
// snakeCaseOperationName
// ---------------------------------------------------------------------------

describe('snakeCaseOperationName', () => {
  it('camelCase 拆分、非法字符→下划线、空串兜底', () => {
    expect(snakeCaseOperationName('listPets')).toBe('list_pets')
    expect(snakeCaseOperationName('createPet')).toBe('create_pet')
    expect(snakeCaseOperationName('gis_query_land_types')).toBe('gis_query_land_types')
    expect(snakeCaseOperationName('my tool/v1')).toBe('my_tool_v1')
    expect(snakeCaseOperationName('///')).toBe('op')
  })
})

// ---------------------------------------------------------------------------
// petstore 夹具 → 生成文本
// ---------------------------------------------------------------------------

const petstore = parseOpenapiSource(readFileSync(FIXTURE, 'utf8'), FIXTURE)

describe('generateImportModule：petstore 夹具', () => {
  const source = generateImportModule(petstore)

  it('头部：AUTO-GENERATED + import type + 基址（servers[0].url）+ 覆盖函数', () => {
    expect(source).toContain("AUTO-GENERATED by 'loom import-openapi'")
    expect(source).toContain("import type { App } from '@loom-sdk/web'")
    expect(source).toContain(`let loomImportBase = "https://petstore.example.com/v1"`)
    expect(source).toContain('export function configureImportedClient(opts: { baseUrl: string }): void {')
    expect(source).toContain('export function registerImportedTools(app: App): void {')
  })

  it('工具名：operationId snake_case 化；缺省名由路径+方法拼出（不二次拆 camelCase）', () => {
    expect(source).toContain('.tool("list_pets")')
    expect(source).toContain('.tool("create_pet")')
    expect(source).toContain('.tool("pets_petid_get")')
    expect(source).toContain('.tool("delete_pet")')
    expect(source).toContain('.tool("get_inventory")')
  })

  it('描述 = summary + description + tags + 来源', () => {
    expect(source).toContain('List all pets')
    expect(source).toContain('按条件列出宠物')
    expect(source).toContain('来源标签：pets')
    expect(source).toContain('导入自 OpenAPI 文档：GET /pets')
  })

  it('required 移位 + $ref 展开：NewPet（allOf）的 name 必填、kind 品种注释保留', () => {
    expect(source).toContain('name: { type: "string", description: "宠物名", required: true }')
    expect(source).toContain('kind: { type: "string", description: "品种" }')
  })

  it('Pet（$ref 输出）展开：id/name 必填、enum 保留、int64 约束降级警告、可空昵称 → oneOf', () => {
    expect(source).toContain('id: { type: "integer", required: true }')
    expect(source).toContain('name: { type: "string", required: true }')
    expect(source).toContain('enum: ["available", "sold"]')
    expect(source).toContain('WARN(openapi-import): output→Pet.id——约束 format="int64"')
    // anyOf 可空联合已忠实转换（oneOf:[T,{type:"null"}]）：不再是降级注记形态。
    expect(source).toContain('nickname: { oneOf: [{ type: "string" }, { type: "null" }] }')
    expect(source).not.toContain('anyOf 已降级为可空标量')
    expect(source).not.toContain('可为 null')
  })

  it('query 约束降级警告 + x-loom-query-json 忠实往返', () => {
    expect(source).toContain('WARN(openapi-import): input.limit——约束 format="int32"')
    expect(source).toContain('query.set("filter", JSON.stringify(args["filter"])) // x-loom-query-json')
    expect(source).toContain('query.set("limit", encodeQueryValue(args["limit"]))')
    expect(source).toContain('query.set("tags", encodeQueryValue(args["tags"]))')
    // filter 的开放对象 schema 诚实降级为 json（结构未知）。
    expect(source).toContain('WARN(openapi-import): input.filter——开放对象（未声明 properties）')
  })

  it('路径参数 {petId} → 必填输入字段（description 注明原路径参数）+ execute 路径替换', () => {
    expect(source).toContain('petId: { type: "string", required: true, description: "原路径参数（GET /pets/{petId} 的 {petId}）" }')
    expect(source).toContain('petId: { type: "string", required: true, description: "原路径参数（DELETE /pets/{petId} 的 {petId}）" }')
    expect(source).toContain("const path = `/pets/${encodeURIComponent(String(args[\"petId\"] ?? ''))}`")
  })

  it('缺 200 schema 的输出（204 / 开放字典）降级 json + WARN；结果原样返回注释', () => {
    expect(source).toContain('WARN(openapi-import): output——delete_pet 未声明成功响应')
    expect(source).toContain('WARN(openapi-import): output——additionalProperties 映射（开放字典）不在 Loom DSL 覆盖内')
    expect(source).toContain('// 输出已降级为任意 JSON（见上方 WARN）：结果原样返回')
  })

  it('写操作（POST/DELETE）声明上方给 policy 建议；GET 不给', () => {
    expect(source).toContain('// 建议：app.policy 中为该写操作配置 approve（POST /pets')
    expect(source).toContain('// 建议：app.policy 中为该写操作配置 approve（DELETE /pets/{petId}')
    expect(source).not.toContain('approve（GET ')
  })

  it('securitySchemes：token 注入 + bearer/apiKey 头 + TODO 注释', () => {
    expect(source).toContain('const token = process.env.LOOM_IMPORT_TOKEN')
    expect(source).toContain('// TODO: 按需注入认证头（bearer → Authorization；apiKey 按声明位置）')
    expect(source).toContain('"authorization": `Bearer ${token}`')
    expect(source).toContain('"X-Api-Key": `${token}`')
    expect(source).toContain('headers: { ...(token === undefined ? {} : authHeaders(token)) },')
  })

  it('execute 真 fetch：signal 透传、非 2xx 抛错（状态码 + 响应体前 200 字符）', () => {
    expect(source).toContain('const res = await fetch(url, {')
    expect(source).toContain('signal: exec.signal,')
    expect(source).toContain("const text = await res.text().catch(() => '')")
    expect(source).toContain('text.slice(0, 200)')
    expect(source).toContain('return await res.json()')
  })

  it('POST body：pick 组装 + JSON 序列化 + content-type', () => {
    expect(source).toContain('const payload = pick(args, ["name","tag","kind"])')
    expect(source).toContain("headers: { 'content-type': 'application/json', ...(token === undefined ? {} : authHeaders(token)) },")
    expect(source).toContain('body: JSON.stringify(payload),')
  })

  it('跳过 trace/options/head 并注释', () => {
    expect(source).toContain('// 跳过 HEAD /pets（trace/options/head 暂不支持）')
    expect(source).toContain('（跳过 1 个 trace/options/head operation）')
  })

  it('确定性：两次生成字节相同', () => {
    expect(generateImportModule(petstore)).toBe(source)
  })

  it('--base 覆盖基址并注明', () => {
    const overridden = generateImportModule(petstore, { base: 'http://127.0.0.1:4626/' })
    expect(overridden).toContain('let loomImportBase = "http://127.0.0.1:4626"')
    expect(overridden).toContain('（--base 覆盖）')
  })

  it('--include glob 过滤（复用策略 glob 语义）', () => {
    const only = generateImportModule(petstore, { include: 'delete_*' })
    expect(only).toContain('.tool("delete_pet")')
    expect(only).not.toContain('.tool("list_pets")')
    expect(only).toContain('（过滤 4 个 operation）')
    expect(summarizeImportSource(petstore, { include: 'delete_*' })).toEqual({ tools: 1, skippedMethods: 1, filtered: 4 })
  })

  it('--tag 过滤', () => {
    const store = generateImportModule(petstore, { tag: 'store' })
    expect(store).toContain('.tool("get_inventory")')
    expect(store).not.toContain('.tool("list_pets")')
  })
})

// ---------------------------------------------------------------------------
// parseOpenapiSource（校验与 YAML 指路）
// ---------------------------------------------------------------------------

describe('parseOpenapiSource', () => {
  it('YAML 特征检测 → 明确报错并给转换命令', () => {
    const yamlText = ['openapi: 3.1.0', 'info:', '  title: Petstore', 'paths:', '  /pets:', '    get: {}'].join('\n')
    expect(() => parseOpenapiSource(yamlText, 'petstore.yaml')).toThrow(/疑似 YAML.*python -c.*yaml/s)
  })

  it('非 JSON 非 YAML → 报 JSON 解析错误', () => {
    expect(() => parseOpenapiSource('not json at all', 'x.json')).toThrow(/不是合法 JSON/)
  })

  it('形状校验：缺 openapi / swagger 2.0 / 缺 paths / paths 非对象', () => {
    expect(() => parseOpenapiSource('{"paths": {}}', 'x')).toThrow(/仅支持 3\.x/)
    expect(() => parseOpenapiSource('{"openapi": "2.0"}', 'x')).toThrow(/仅支持 3\.x/)
    expect(() => parseOpenapiSource('{"openapi": "3.1.0"}', 'x')).toThrow(/缺少 "paths"/)
    expect(() => parseOpenapiSource('{"openapi": "3.1.0", "paths": 42}', 'x')).toThrow(/paths" 必须是对象/)
    expect(() => parseOpenapiSource('[1,2]', 'x')).toThrow(/必须是 JSON 对象/)
  })
})

// ---------------------------------------------------------------------------
// QA #6 回归：只读方法声明 requestBody 的坏例（body 并入 query + WARN 固化）
// ---------------------------------------------------------------------------

describe('QA #6：只读方法带 requestBody 的边界行为', () => {
  const doc = {
    openapi: '3.1.0',
    info: { title: 'weird-api', version: '1.0.0' },
    servers: [{ url: 'https://weird.example.com' }],
    paths: {
      // 坏例：GET 声明了 requestBody（OpenAPI 规范不允许，但导入器要诚实容错）
      '/search': {
        get: {
          operationId: 'searchThings',
          requestBody: {
            content: { 'application/json': { schema: { type: 'object', properties: { keyword: { type: 'string' }, limit: { type: 'number' } }, required: ['keyword'] } } },
          },
          responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } } },
        },
      },
    },
  } as unknown as Parameters<typeof generateImportModule>[0]

  it('GET 的 requestBody 字段并入 query 参数 + WARN 提示（不静默丢弃也不读 body）', () => {
    const source = generateImportModule(doc)
    // keyword/limit 变成 query 字段（GET 面孔 query 传输）
    expect(source).toContain('keyword')
    expect(source).toContain('.http("GET")')
    // 诚实告警：只读方法不读 body，字段并入 query
    expect(source).toContain('WARN(openapi-import): input.body——search_things 是只读方法但声明了 requestBody——body 字段已并入 query（Loom 只读方法不读 body）')
    // 生成的 fetch 是 GET：query 上携带，无 body 写出（GET 分支）
    expect(source).toMatch(/method:\s*"GET"/)
  })
})

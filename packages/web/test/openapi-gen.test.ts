/**
 * `loom openapi` 生成器（openapi-gen.ts）单测：
 * - dslToJsonSchema 纯函数：required 移位 / additionalProperties 补齐 / json → {} /
 *   oneOf·const·enum·items 递归；
 * - 合成应用：paths / operationId / tags / query 参数（x-loom-query-json）/
 *   requestBody / 200+500 响应形状 / servers；
 * - gis 集成快照：与已提交的 examples/gis/openapi.json 逐字节一致 + 两次生成相等；
 * - 声明期守门：.http() 自定义 path 含 { → throw；
 * - httpRouteOf：四处调用点共用的路由推导。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { dslToJsonSchema, generateOpenapi, openapiToJson } from '../src/openapi-gen.js'
import { httpRouteOf } from '../src/http-route.js'
import { defineApp } from '../src/index.js'

const GIS_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'examples', 'gis')
/** 集成前置：@loom-sdk/web 编译产物存在（loom.app.ts 经它解析）。 */
const sdkBuilt = existsSync(join(GIS_DIR, 'node_modules', '@loom-sdk', 'web', 'lib', 'index.js'))

// ---------------------------------------------------------------------------
// dslToJsonSchema（纯函数）
// ---------------------------------------------------------------------------

describe('dslToJsonSchema', () => {
  it('字段级 required:true → 顶层 required 数组（object 递归）', () => {
    const schema = dslToJsonSchema({
      type: 'object',
      properties: {
        totalAreaSqm: { type: 'number', required: true },
        note: { type: 'string' },
        items: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            properties: { village: { type: 'string', required: true }, ratioPct: { type: 'number', required: true } },
          },
        },
      },
    })
    expect(schema).toEqual({
      type: 'object',
      properties: {
        totalAreaSqm: { type: 'number' },
        note: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { village: { type: 'string' }, ratioPct: { type: 'number' } },
            required: ['village', 'ratioPct'],
            additionalProperties: false,
          },
        },
      },
      required: ['totalAreaSqm', 'items'],
      additionalProperties: false,
    })
  })

  it('type json → {}（+description）；oneOf / const / enum 递归保留', () => {
    expect(dslToJsonSchema({ type: 'json', description: '任意 JSON' })).toEqual({ description: '任意 JSON' })
    expect(dslToJsonSchema({ oneOf: [{ type: 'string' }, { type: 'number' }] })).toEqual({
      oneOf: [{ type: 'string' }, { type: 'number' }],
    })
    expect(dslToJsonSchema({ type: 'string', const: '连河村' })).toEqual({ type: 'string', const: '连河村' })
    expect(dslToJsonSchema({ type: 'string', enum: ['available', 'sold'] })).toEqual({ type: 'string', enum: ['available', 'sold'] })
    expect(dslToJsonSchema({ type: 'array', items: { type: 'string' } })).toEqual({ type: 'array', items: { type: 'string' } })
  })

  it('显式 additionalProperties 布尔照写（对齐 normalizeDsl）', () => {
    expect(dslToJsonSchema({ type: 'object', properties: {}, additionalProperties: true })).toEqual({
      type: 'object',
      additionalProperties: true,
    })
  })
})

// ---------------------------------------------------------------------------
// httpRouteOf（路由治理：四处调用点共用）
// ---------------------------------------------------------------------------

describe('httpRouteOf', () => {
  it('缺省路由 = apiPrefix/api/<name>；自定义 path 原样；尾斜杠容忍', () => {
    expect(httpRouteOf({ name: 't1', http: { method: 'GET' } }, '/~loom')).toBe('/~loom/api/t1')
    expect(httpRouteOf({ name: 't1', http: { method: 'GET' } }, '/~loom/')).toBe('/~loom/api/t1')
    expect(httpRouteOf({ name: 't1', http: { method: 'GET', path: '/special/x' } }, '/~loom')).toBe('/special/x')
  })
})

// ---------------------------------------------------------------------------
// 合成应用 → 文档
// ---------------------------------------------------------------------------

/** 互通测试用合成应用：GET（数组/json/标量 query）+ POST（object 入参）+ agent tags。 */
function miniApp() {
  const app = defineApp('interop', { port: 4627 })
  app
    .tool('search_items')
    .description('搜索条目')
    .input({
      keyword: { type: 'string', description: '关键词' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签过滤' },
      raw: { type: 'json', description: '任意过滤条件' },
    })
    .output({ type: 'object', properties: { total: { type: 'number', required: true } } })
    .http('GET')
    .execute(async () => ({ total: 0 }))
  app
    .tool('create_item')
    .description('创建条目')
    .input({
      title: { type: 'string', required: true },
      meta: { type: 'object', properties: { lang: { type: 'string' } } },
    })
    .output({ type: 'object', properties: { id: { type: 'string', required: true } } })
    .http('POST')
    .execute(async () => ({ id: 'x' }))
  app.agent('searcher', { persona: 'p', tools: ['search_items'] })
  return app
}

describe('generateOpenapi：合成应用', () => {
  const doc = generateOpenapi(miniApp())

  it('顶层形状：openapi 3.1.0 / info / servers / tags / paths', () => {
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info).toEqual({ title: 'interop', version: '0.1.0' })
    expect(doc.servers).toEqual([{ url: 'http://127.0.0.1:4627' }])
    expect(doc.tags).toEqual([{ name: 'searcher', description: 'agent "searcher" 可见的工具（persona 作用域）' }])
    expect(Object.keys(doc.paths as Record<string, unknown>)).toEqual(['/~loom/api/search_items', '/~loom/api/create_item'])
  })

  it('GET operation：operationId / summary / tags / 逐字段 query 参数', () => {
    const get = (doc.paths as Record<string, any>)['/~loom/api/search_items'].get
    expect(get.operationId).toBe('search_items')
    expect(get.summary).toBe('搜索条目')
    expect(get.tags).toEqual(['searcher'])
    const [keyword, tags, raw] = get.parameters
    expect(keyword).toMatchObject({ name: 'keyword', in: 'query', required: false })
    expect(keyword['x-loom-query-json']).toBeUndefined()
    // 数组/任意 JSON 的 query 值按约定是 JSON 编码字符串 → 扩展标记。
    expect(tags).toMatchObject({ name: 'tags', in: 'query', schema: { type: 'array', items: { type: 'string' } } })
    expect(tags['x-loom-query-json']).toBe(true)
    expect(raw.schema).toEqual({ description: '任意过滤条件' })
    expect(raw['x-loom-query-json']).toBe(true)
  })

  it('POST operation：requestBody（application/json，required 移位到 schema）', () => {
    const post = (doc.paths as Record<string, any>)['/~loom/api/create_item'].post
    expect(post.operationId).toBe('create_item')
    expect(post.tags).toBeUndefined()
    expect(post.requestBody).toEqual({
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              meta: { type: 'object', properties: { lang: { type: 'string' } }, additionalProperties: false },
            },
            required: ['title'],
            additionalProperties: false,
          },
        },
      },
    })
  })

  it('responses：200 = output 转换；500 = {ok:false,error,tool} 形状', () => {
    const get = (doc.paths as Record<string, any>)['/~loom/api/search_items'].get
    expect(get.responses['200'].content['application/json'].schema).toEqual({
      type: 'object',
      properties: { total: { type: 'number' } },
      required: ['total'],
      additionalProperties: false,
    })
    const schema500 = get.responses['500'].content['application/json'].schema
    expect(schema500.required).toEqual(['ok', 'error', 'tool'])
    expect(schema500.properties.ok).toEqual({ type: 'boolean', const: false })
  })

  it('确定性：同一声明两次序列化字节相同', () => {
    expect(openapiToJson(generateOpenapi(miniApp()))).toBe(openapiToJson(doc))
  })
})

// ---------------------------------------------------------------------------
// gis 集成快照
// ---------------------------------------------------------------------------

describe.skipIf(!sdkBuilt)('generateOpenapi：对 gis 应用的快照', () => {
  it('生成物与已提交的 examples/gis/openapi.json 逐字节一致（漂移 = 声明已变）', async () => {
    const app = (await import(join(GIS_DIR, 'loom.app.ts'))).default as ReturnType<typeof defineApp>
    const generated = openapiToJson(generateOpenapi(app))
    const committed = readFileSync(join(GIS_DIR, 'openapi.json'), 'utf8')
    expect(generated).toBe(committed)
  })

  it('确定性：两次生成字节相同（无时间戳）', async () => {
    const app = (await import(join(GIS_DIR, 'loom.app.ts'))).default as ReturnType<typeof defineApp>
    expect(openapiToJson(generateOpenapi(app))).toBe(openapiToJson(generateOpenapi(app)))
  })
})

// ---------------------------------------------------------------------------
// 声明期守门：.http() 路径参数
// ---------------------------------------------------------------------------

describe('声明期守门：.http() 自定义 path 含 { → throw', () => {
  it('报错指路 query/body 输入字段', () => {
    const app = defineApp('gate')
    expect(() => app.tool('t').http('GET', '/items/{id}')).toThrow(/路径参数暂不支持.*query\/body/s)
  })

  it('无路径参数的 path 不受影响', () => {
    const app = defineApp('gate')
    expect(() => app.tool('t2').input({}).output({ type: 'json' }).http('GET', '/items/all').execute(async () => ({}))).not.toThrow()
  })
})

/**
 * OpenAPI 自举往返 e2e（M5；零 key）：导出 → 导入 → 真调，一条链闭合。
 *
 * 1. boot gis 服务（独立端口 4626，与 dev 4620 / 其它 e2e 端口错开）；
 * 2. fetch 运行时活文档 GET /~loom/openapi.json（M5 新端点，与 loom openapi
 *    生成物同源）；
 * 3. generateImportModule 把文档反向生成工具声明模块（写临时文件，tsx 动态
 *    import）；
 * 4. registerImportedTools 注册进一个 mini app；configureImportedClient 把
 *    基址指回本测试实例（文档 servers 记录的是声明端口 4620）；
 * 5. 取出 execute 直调（region='连河村'）——真端点真数据，
 *    断言 totalAreaSqm === 57351531.17（不触模型，零 key）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootLoom, cleanupDir, ensureTsx, GIS_DIR, sdkBuilt, type BootedLoom } from './helpers.js'
import { defineApp, generateImportModule } from '@loom-sdk/web'

const PORT = 4626
const OUT_DIR = resolve(GIS_DIR, '.loom-openapi-e2e')

describe.skipIf(!sdkBuilt())('OpenAPI 自举往返 e2e（导出→导入→真调，零 key）', () => {
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    ensureTsx()
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'loom.app.ts'),
      withApproval: true,
      withSubagent: true,
      port: PORT,
      outDirName: '.loom-openapi-e2e',
    })
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(OUT_DIR)
  })

  it('运行时活文档：GET /~loom/openapi.json 是含 gis_query_land_types 的 OpenAPI 3.1.0', async () => {
    const res = await fetch(`${loom!.base}/openapi.json`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const doc = (await res.json()) as Record<string, any>
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info).toEqual({ title: 'gis-platform', version: '0.1.0' })
    expect(doc.paths['/~loom/api/gis_query_land_types'].get.operationId).toBe('gis_query_land_types')
  })

  it('导入生成 → 注册进 mini app → 直调 execute：region=连河村 → totalAreaSqm === 57351531.17', async () => {
    // ① 拉取活文档（与已提交的 openapi.json 同源——运行时与 CLI 共用 generateOpenapi）。
    const res = await fetch(`${loom!.base}/openapi.json`)
    const doc = (await res.json()) as Parameters<typeof generateImportModule>[0]

    // ② 反向生成工具声明模块（gis 声明全量覆盖 → 无降级警告注释）。
    const source = generateImportModule(doc)
    expect(source).toContain('.tool("gis_query_land_types")')
    expect(source).not.toContain('// WARN(openapi-import):')

    // ③ 写临时文件，tsx 动态 import（与 cli 子进程 --import tsx 等价）。
    mkdirSync(OUT_DIR, { recursive: true })
    const generatedPath = join(OUT_DIR, 'loom.openapi.ts')
    writeFileSync(generatedPath, source, 'utf8')
    const mod = (await import(pathToFileURL(generatedPath).href)) as {
      registerImportedTools: (app: ReturnType<typeof defineApp>) => void
      configureImportedClient: (opts: { baseUrl: string }) => void
    }

    // ④ 基址覆盖：文档 servers 记录声明端口 4620，本实例在 4626。
    mod.configureImportedClient({ baseUrl: `http://127.0.0.1:${PORT}` })

    // ⑤ 一行接入：注册进 mini app 后取 ToolSpec 直调 execute（真 fetch 真端点）。
    const mini = defineApp('roundtrip')
    mod.registerImportedTools(mini)
    const tool = mini.spec.tools.find(t => t.name === 'gis_query_land_types')
    expect(tool).toBeDefined()
    expect(tool!.http).toEqual({ method: 'GET' })
    expect(tool!.parameters).toEqual({
      region: { type: 'string', description: '可选的村庄名过滤词，如"连河村"；省略则返回全部 8 个村庄。' },
    })
    expect(tool!.output).toEqual({
      type: 'object',
      properties: {
        totalAreaSqm: { type: 'number', required: true },
        items: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            properties: {
              village: { type: 'string', required: true },
              landType: { type: 'string', required: true },
              areaSqm: { type: 'number', required: true },
              ratioPct: { type: 'number', required: true },
            },
          },
        },
        queriedAt: { type: 'string', required: true },
      },
    })

    const result = (await tool!.execute({ region: '连河村' }, {})) as {
      totalAreaSqm: number
      items: Array<{ village: string; landType: string }>
      queriedAt: string
    }
    expect(result.totalAreaSqm).toBe(57351531.17)
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items[0]!.village).toContain('连河村')
    expect(result.items[0]!.landType).toBe('耕地')
    expect(typeof result.queriedAt).toBe('string')
  }, 60_000)

  it('往返保真：无过滤参数调用返回全部 8 个村庄', async () => {
    const res = await fetch(`${loom!.base}/openapi.json`)
    const doc = (await res.json()) as Parameters<typeof generateImportModule>[0]
    const mod = (await import(pathToFileURL(join(OUT_DIR, 'loom.openapi.ts')).href)) as {
      registerImportedTools: (app: ReturnType<typeof defineApp>) => void
    }
    const mini = defineApp('roundtrip-all')
    mod.registerImportedTools(mini)
    const tool = mini.spec.tools.find(t => t.name === 'gis_query_land_types')!
    const result = (await tool!.execute({}, {})) as { items: unknown[] }
    expect(result.items.length).toBeGreaterThanOrEqual(8)
  }, 60_000)
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import z from '@deepseek-ai/schemastery'
import {
  inputArrayIssues,
  isSchemastery,
  outputRootIssues,
  schemasteryToDsl,
  schemasteryToOutputDsl,
} from '../src/schema.js'

/** 构造一个 schemastery 形状的实例（z.object 等真实例 + 手搓兜底都覆盖）。 */
function zspy() {
  const warns: string[] = []
  const spy = vi.spyOn(console, 'warn').mockImplementation((line?: unknown) => {
    warns.push(String(line))
  })
  return { warns, restore: () => spy.mockRestore() }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isSchemastery', () => {
  it('识别真实例；DSL 字面量不是', () => {
    expect(isSchemastery(z.object({ a: z.string() }))).toBe(true)
    expect(isSchemastery(z.string())).toBe(true)
    expect(isSchemastery({ type: 'object', properties: { a: { type: 'string', required: true } } })).toBe(false)
    expect(isSchemastery({})).toBe(false)
    expect(isSchemastery(null)).toBe(false)
  })
})

describe('schemasteryToOutputDsl（required 由可选性推导）', () => {
  it('平面对象：默认必填；带 default → 可选', () => {
    const dsl = schemasteryToOutputDsl(z.object({
      total: z.number(),
      note: z.string().default(''),
      when: z.string().required(false),
    }))
    expect(dsl).toEqual({
      type: 'object',
      properties: {
        total: { type: 'number', required: true },
        note: { type: 'string' },
        when: { type: 'string' },
      },
    })
  })

  it('数组与嵌套对象：items/properties 递归转换', () => {
    const dsl = schemasteryToOutputDsl(z.object({
      items: z.array(z.object({ name: z.string(), value: z.number() })),
    }))
    expect(dsl).toEqual({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', required: true },
              value: { type: 'number', required: true },
            },
          },
        },
      },
    })
  })

  it('description 透传到节点；i18n Dict 取首个非空', () => {
    const dsl = schemasteryToOutputDsl(z.object({
      region: z.string().description('村庄名'),
    }))
    expect((dsl as { properties: { region: { description: string } } }).properties.region.description).toBe('村庄名')
  })

  it('number 变体（natural/percent）→ number；date → string', () => {
    const dsl = schemasteryToDsl(z.object({ a: z.natural(), b: z.percent(), c: z.date() }) as never, 'x')
    expect(dsl).toMatchObject({
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
        c: { type: 'string' },
      },
    })
  })

  it('const → 标量 const；union → oneOf', () => {
    const dsl = schemasteryToDsl(z.object({
      kind: z.const('pie'),
      mix: z.union([z.string(), z.number()]),
    }) as never, 'x')
    expect(dsl).toMatchObject({
      properties: {
        kind: { type: 'string', const: 'pie', required: true },
        mix: { oneOf: [{ type: 'string' }, { type: 'number' }], required: true },
      },
    })
  })

  it('根不是 object → throw 指路', () => {
    expect(() => schemasteryToOutputDsl(z.array(z.string()))).toThrow(/z\.object/)
  })

  it('未覆盖类型 → type:json + warn', () => {
    const { warns, restore } = zspy()
    const dsl = schemasteryToDsl(z.any(), 'output.x')
    expect(dsl).toEqual({ type: 'json' })
    expect(warns.join('\n')).toMatch(/json/)
    restore()
  })
})

describe('声明期守门', () => {
  it('output 根 object 无 properties → 指路（M1 的坑）', () => {
    expect(outputRootIssues({ type: 'object' })).toHaveLength(1)
    expect(outputRootIssues({ type: 'object', properties: {} })).toHaveLength(1)
    expect(outputRootIssues({ type: 'object', properties: { a: { type: 'string', required: true } } })).toHaveLength(0)
    expect(outputRootIssues({ type: 'json' })).toHaveLength(0)
    expect(outputRootIssues(undefined)).toHaveLength(0)
  })

  it('input 数组缺 items → 指路；嵌套数组也查', () => {
    const issues = inputArrayIssues({
      tags: { type: 'array', required: true },
      ok: { type: 'array', required: true, items: { type: 'string' } },
      nested: {
        type: 'array',
        items: { type: 'object', properties: { inner: { type: 'array', required: true } } },
      },
    })
    expect(issues).toHaveLength(2)
    expect(issues[0]).toMatch(/input\.tags/)
    expect(issues[1]).toMatch(/input\.nested\[\]\.properties\.inner|inner/)
  })

  it('无问题的 input 不产 issue', () => {
    expect(inputArrayIssues({
      region: { type: 'string', description: 'x' },
      items: { type: 'array', required: true, items: { type: 'object', properties: { name: { type: 'string', required: true } } } },
    })).toEqual([])
  })
})

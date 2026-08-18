/**
 * InferToolArgs / InferToolOutput 的类型级断言：断言写法是"编译期失败即测试失败"——本文件经
 * tsconfig.typecheck.json 进 `pnpm typecheck`（vitest 运行时部分只做冒烟）。
 */
import { describe, expect, it } from 'vitest'
import type { InferToolArgs, InferToolOutput } from '../src/types.js'

/** 两个类型完全相等（相互可赋值）才编译通过。 */
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false
type Expect<T extends true> = T

// —— 标量与可选性 -------------------------------------------------------------
type T1 = InferToolArgs<{ region: { type: 'string'; description: string } }>
type Assert1 = Expect<Equal<T1, { region?: string }>>

type T2 = InferToolArgs<{
  title: { type: 'string'; required: true }
  count: { type: 'number'; required: true }
  flag: { type: 'boolean'; required: true }
}>
type Assert2 = Expect<Equal<T2, { title: string; count: number; flag: boolean }>>

// —— 数组与嵌套对象 -----------------------------------------------------------
type T3 = InferToolArgs<{
  items: {
    type: 'array'
    required: true
    items: { type: 'object'; properties: { name: { type: 'string'; required: true }; value: { type: 'number'; required: true } } }
  }
}>
type Assert3 = Expect<Equal<T3, { items: Array<{ name: string; value: number }> }>>

// —— 嵌套可选字段与未知节点宽松化 ---------------------------------------------
type T4 = InferToolArgs<{
  nested: {
    type: 'object'
    required: true
    properties: {
      keep: { type: 'string'; required: true }
      drop: { type: 'string' }
      mystery: { weird: 'node' }
    }
  }
}>
type Assert4 = Expect<Equal<T4, { nested: { keep: string; drop?: string; mystery?: unknown } }>>

// —— enum / const / 无 items 数组 ----------------------------------------------
type T5 = InferToolArgs<{
  kind: { type: 'string', required: true, enum: ['a', 'b'] }
  tags: { type: 'array', required: true }
}>
type Assert5 = Expect<Equal<T5, { kind: 'a' | 'b'; tags: unknown[] }>>

// —— InferToolOutput：output DSL 根节点 → 返回值类型（与 InferToolArgs 对称） ——
// gis_query_land_types 的真实 output DSL（schemastery 转换产物）。
type O1 = InferToolOutput<{
  type: 'object'
  properties: {
    totalAreaSqm: { type: 'number', required: true }
    items: {
      type: 'array', required: true
      items: { type: 'object', properties: { village: { type: 'string', required: true }, areaSqm: { type: 'number', required: true } } }
    }
    queriedAt: { type: 'string', required: true }
  }
}>
type AssertO1 = Expect<Equal<O1, { totalAreaSqm: number; items: Array<{ village: string; areaSqm: number }>; queriedAt: string }>>

// 未标 required: true → 可选（与内核转换器语义一致：标注才必填）。
type O2 = InferToolOutput<{ type: 'object', properties: { region: { type: 'string', required: true }, reason: { type: 'string' } } }>
type AssertO2 = Expect<Equal<O2, { region: string; reason?: string }>>

// 标量根 / enum / const / json / oneOf。
type O3 = InferToolOutput<{ type: 'string' }>
type AssertO3 = Expect<Equal<O3, string>>
type O4 = InferToolOutput<{ type: 'object', properties: { kind: { type: 'string', required: true, enum: ['a', 'b'] }, mode: { type: 'string', required: true, const: 'fast' }, any: { type: 'json' } } }>
type AssertO4 = Expect<Equal<O4, { kind: 'a' | 'b'; mode: 'fast'; any?: unknown }>>
type O5 = InferToolOutput<{ oneOf: [{ type: 'string' }, { type: 'number' }] }>
type AssertO5 = Expect<Equal<O5, string | number>>

// —— Builder 链路冒烟（execute 拿精确类型；运行时部分） -------------------------
import { defineApp } from '../src/index.js'

describe('InferToolArgs（运行时冒烟：声明收集不受泛型影响）', () => {
  it('类型化 builder 声明 + 收集形态', () => {
    const app = defineApp('type-smoke')
    const returned = app
      .tool('typed_echo')
      .input({
        text: { type: 'string', required: true },
        times: { type: 'number' },
      })
      .output({ type: 'object', properties: { echoed: { type: 'string', required: true } } })
      .execute(async args => {
        // 类型级断言（编译期）：args.text 必为 string、args.times 可选 number。
        const text: string = args.text
        const times: number | undefined = args.times
        return { echoed: text.repeat(times ?? 1) }
      })
    expect(returned).toBe(app)
    const tool = app.spec.tools.find(t => t.name === 'typed_echo')
    expect(tool).toBeDefined()
    expect(tool!.parameters).toEqual({ text: { type: 'string', required: true }, times: { type: 'number' } })
  })

  it('schemastery output 重载：z.object 自动转 DSL', async () => {
    const z = (await import('@deepseek-ai/schemastery')).default
    const app = defineApp('z-smoke')
    app
      .tool('z_out')
      .output(z.object({ total: z.number(), items: z.array(z.object({ name: z.string() })) }))
      .execute(async () => ({ total: 1, items: [] }))
    const tool = app.spec.tools.find(t => t.name === 'z_out')
    expect(tool!.output).toEqual({
      type: 'object',
      properties: {
        total: { type: 'number', required: true },
        items: {
          type: 'array',
          required: true,
          items: { type: 'object', properties: { name: { type: 'string', required: true } } },
        },
      },
    })
  })

  it('声明期守门：agent/subagent 引用未声明工具立即 throw', () => {
    const app = defineApp('gate-smoke')
    expect(() => app.agent('a1', { persona: 'x', tools: ['nope'] })).toThrow(/未声明的工具 "nope"/)
    expect(() => app.subagent('s1', { persona: 'x', tools: ['nope'], visibleTo: ['a0'] })).toThrow(/未声明的工具 "nope"/)
    // 工具先声明、agent 后引用 → 不 throw。
    app.tool('t1').execute(async () => ({}))
    expect(() => app.agent('a2', { persona: 'x', tools: ['t1'] })).not.toThrow()
  })
})

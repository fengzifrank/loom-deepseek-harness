/**
 * 预算治理 e2e（M9，无需 DEEPSEEK_API_KEY——只走 .http() 面的内核管线）：
 *
 * 1. health 汇报 budgets 声明（可观测面）；
 * 2. 前 2 次调用（= max）200 放行，第 3 次 403 fail-closed，error 含预算描述
 *    （current=3 > max=2），x-loom-exec=pipeline 证明走的是 pre-execute 管线；
 * 3. 越限后持续 fail-closed（第 4 次仍 403——被拒的调用也计数，无绕过窗口）；
 * 4. SSE 合成事件 loom/budget-exceeded（隐藏 api 会话无订阅者，事件静默但
 *    行为正确；此处断言行为面）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { bootLoom, cleanupDir, ensureTsx, GIS_DIR, sdkBuilt, type BootedLoom } from './helpers.js'

describe.skipIf(!sdkBuilt())('预算治理 e2e（无 key，.http() 面驱动）', () => {
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    ensureTsx()
    loom = await bootLoom({
      appModulePath: join(GIS_DIR, 'tests', 'budget-app.ts'),
      withApproval: true, // 声明了 policy → 组合需带审批缝（boot 守门）
      port: 4637,
      outDirName: '.loom-budget-e2e',
    })
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(GIS_DIR, '.loom-budget-e2e'))
  })

  const call = () => fetch(`${loom!.base}/api/budget_echo?text=${encodeURIComponent('hi')}`)

  it('health 汇报 budgets 声明', async () => {
    const res = await fetch(`${loom!.base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.app).toBe('budget-demo')
    expect(body.budgets).toEqual([{ kind: 'tool-calls', max: 2, tool: 'budget_echo' }])
  })

  it('前 2 次放行，第 3 次 403（current=3 > max=2），走的是内核管线', async () => {
    expect((await call()).status).toBe(200)
    expect((await call()).status).toBe(200)
    const third = await call()
    expect(third.status).toBe(403)
    expect(third.headers.get('x-loom-exec')).toBe('pipeline')
    const body = (await third.json()) as { error: string }
    expect(body.error).toContain('loom policy budget')
    expect(body.error).toContain('3/2')
  })

  it('越限后持续 fail-closed（被拒的调用也计数，无绕过窗口）', async () => {
    const fourth = await call()
    expect(fourth.status).toBe(403)
    const fifth = await call()
    expect(fifth.status).toBe(403)
  })
})

/**
 * 桥路径 e2e（semantica-demo 主示例）：
 *
 * 无 key 段（需要 venv，不需要 DEEPSEEK key）：
 * 1. boot → python-bridge 握手完成 → health 汇报 pythonTools = 7（7 个 agri_* 工具）；
 * 2. 组合文件含 python-bridge 行与 callTimeoutMs 透传。
 *
 * 带 key 段（真实模型轮次 + 审批闭环）：
 * 3. plant-doctor：查判例 → 按判例记录新决策 → SSE 审批卡 → POST allowed-once →
 *    agri_record_decision 成功返回 decisionId（UUID）→ 因果链工具可追溯该 id；
 * 4. graph.json 真实落盘（diff 证据：文件在 boot 后生成/更新）。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import {
  ANON_HEADERS, bootLoom, cleanupDir, openEventStream, readEnv, sdkBuilt, semanticaReady, SEM_DIR, venvPython, type BootedLoom,
} from './helpers.js'

const env = readEnv(SEM_DIR)
const hasKey = process.env.DEEPSEEK_API_KEY !== undefined || env.DEEPSEEK_API_KEY !== undefined
if (process.env.DEEPSEEK_API_KEY === undefined && env.DEEPSEEK_API_KEY !== undefined) {
  process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY
}

const ready = sdkBuilt() && semanticaReady()

/** 清掉图文件 → 下一次建图重新种子（确定性）。 */
function resetGraph(): void {
  rmSync(join(SEM_DIR, 'graph.json'), { force: true, maxRetries: 5, retryDelay: 200 })
}

/** 直接对桥进程说 loom-py 协议（不经模型）：initialize → tools/list → tools/call。 */
function bridgeProtocolCall(frame: Record<string, unknown>, settleMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveCall, rejectCall) => {
    const child = spawn(venvPython(), [join(SEM_DIR, 'py_tools.py')], {
      env: { ...process.env, SEMANTICA_DISABLE_PROGRESS: '1', PYTHONUNBUFFERED: '1' },
    })
    let stdout = ''
    let stderr = ''
    let sent = false
    const timer = setTimeout(() => {
      child.kill()
      rejectCall(new Error(`桥协议直调超时（120s）；stderr：${stderr.slice(-400)}`))
    }, 120_000)
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      // initialize 响应到达后再发后续帧（时序可控）。
      if (!sent && stdout.includes('"protocol": "loom-py"')) {
        sent = true
        child.stdin.write(`${JSON.stringify(frame)}\n`)
        setTimeout(() => {
          clearTimeout(timer)
          child.stdin.end()
          child.kill()
          resolveCall({ stdout, stderr })
        }, settleMs)
      }
    })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => { clearTimeout(timer); rejectCall(error) })
    child.stdin.write('{"id":1,"method":"initialize","params":{}}\n')
  })
}

describe.skipIf(!ready)('semantica 桥路径 e2e：注册与组合（无 key）', () => {
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    loom = await bootLoom({
      appModulePath: join(SEM_DIR, 'loom.app.ts'),
      withApproval: true, // policy 声明 → 审批缝
      port: 4651,
      outDirName: '.loom-e2e',
    })
  }, 180_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(SEM_DIR, '.loom-e2e'))
  })

  it('health：pythonTools = 7（agri_* 全部注册）', async () => {
    const res = await fetch(`${loom!.base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.app).toBe('semantica-demo')
    expect(body.pythonTools).toBe(7)
    expect(body.budgets).toEqual([{ kind: 'tool-calls', max: 30 }])
  })

  it('组合文件：python-bridge 行 + callTimeoutMs 透传', () => {
    const yml = readFileSync(resolve(SEM_DIR, '.loom-e2e', 'cordis.yml'), 'utf8')
    expect(yml).toContain('- id: python-bridge')
    expect(yml).toContain('dsh-python-tools') // file:/// 入口 URL 指向 workspace 包
    expect(yml).toContain('callTimeoutMs: 180000')
  })
})

describe.skipIf(!ready)('semantica 桥直调 e2e：协议行为（无 key、无模型）', () => {
  // 绕开模型直接对桥说 loom-py 协议——确定性验证 semantica 工具真的能执行：
  // 判例检索命中种子决策 + graph.json 落盘（种子 + save 全链）。
  it('tools/call agri_find_precedents：命中种子判例并落盘 graph.json', async () => {
    resetGraph()
    const { stdout } = await bridgeProtocolCall({
      id: 2,
      method: 'tools/call',
      params: { name: 'agri_find_precedents', args: { scenario: '连河村水稻稻瘟病防治', limit: 3 }, callId: 'py-e2e-1' },
    }, 45_000)
    const callLine = stdout.split('\n').find(line => line.includes('"id": 2'))
    expect(callLine).toBeDefined()
    const parsed = JSON.parse(callLine!) as { result: { value: { count: number; precedents: Array<{ outcome: string }> } } }
    expect(parsed.result.value.count).toBeGreaterThanOrEqual(1)
    expect(String(parsed.result.value.precedents[0]!.outcome)).toContain('春雷霉素')
    expect(existsSync(join(SEM_DIR, 'graph.json'))).toBe(true)
  }, 150_000)
})

describe.skipIf(!ready || !hasKey)('semantica 桥路径 e2e：判例 → 决策入账 → 审批（带 key）', () => {
  let loom: BootedLoom | undefined
  let sessionId = ''

  beforeAll(async () => {
    resetGraph()
    loom = await bootLoom({
      appModulePath: join(SEM_DIR, 'loom.app.ts'),
      withApproval: true,
      port: 4652,
      outDirName: '.loom-e2e-key',
    })
  }, 180_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(SEM_DIR, '.loom-e2e-key'))
  })

  it('查判例并记录决策：审批卡 → 允许 → decisionId 入账 → 因果链可追溯', async () => {
    const created = await fetch(`${loom!.base}/agents/plant-doctor/sessions`, { method: 'POST', headers: ANON_HEADERS })
    expect(created.status).toBe(200)
    sessionId = ((await created.json()) as { sessionId: string }).sessionId
    const sse = await openEventStream(loom!.base, sessionId)
    try {
      const sent = await fetch(`${loom!.base}/agents/plant-doctor/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ANON_HEADERS },
        body: JSON.stringify({
          text: '连河村水稻又要防稻瘟病了。请先用 agri_find_precedents 查判例；然后按判例用 agri_record_decision 记录一条新决策：category 填 plant_protection，scenario 写"连河村水稻稻瘟病抽穗期二次防治"，reasoning 引用判例要点，outcome 自拟（要含具体药剂与农艺措施），confidence 取 0.8，entities 填 ["pest-rice-blast","crop-rice","village-lianhe"]；如果判例结果里带了 decisionId，把 caused_by 填成它（本决策沿用历史判例）。记录完成后把新决策的 decisionId 告诉我。',
        }),
      })
      expect(sent.status).toBe(200)

      // 证据链 1：先查判例（种子决策命中——阈值 0.05 的中文召回）
      const precedents = await sse.wait(e => e.type === 'tool/call' && e.name === 'agri_find_precedents', 120_000, '判例检索')
      expect(String(precedents.args?.scenario)).toContain('稻瘟病')
      const precedentsResult = await sse.wait(e => e.type === 'tool/result' && e.callSeq === precedents.seq, 120_000, '判例结果')
      expect(precedentsResult.isError).toBeFalsy()
      expect(Number(precedentsResult.value?.count ?? 0)).toBeGreaterThanOrEqual(1)

      // 证据链 2：决策入账触发审批卡（policy approve）
      const call = await sse.wait(e => e.type === 'tool/call' && e.name === 'agri_record_decision', 120_000, '决策入账调用')
      expect(call.args).toMatchObject({ category: 'plant_protection', confidence: 0.8 })
      const asked = await sse.wait(e => e.type === 'loom/approval-asked' && e.tool === 'agri_record_decision', 30_000, '审批卡')
      expect(typeof asked.approvalId).toBe('string')
      expect(String(asked.argsPreview)).toContain('plant_protection')

      // 证据链 3：允许 → 工具成功返回 decisionId
      const decision = await fetch(`${loom!.base}/sessions/${sessionId}/approvals/${asked.approvalId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ANON_HEADERS },
        body: JSON.stringify({ decision: 'allowed-once' }),
      })
      expect(decision.status).toBe(200)
      const result = await sse.wait(e => e.type === 'tool/result' && e.callSeq === call.seq, 120_000, '入账结果')
      expect(result.isError).toBeFalsy()
      const decisionId = String(result.value?.decisionId ?? '')
      expect(decisionId).not.toBe('')
      await sse.wait(e => e.type === 'turn/end', 120_000, 'turn/end')

      // 证据链 4：第二轮——因果链追溯该决策（新会话轮次，同 session）
      const second = await fetch(`${loom!.base}/agents/plant-doctor/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ANON_HEADERS },
        body: JSON.stringify({ text: `用 agri_causal_chain 追溯决策 ${decisionId} 的因果链，一句话总结。` }),
      })
      expect(second.status).toBe(200)
      const chainCall = await sse.wait(e => e.type === 'tool/call' && e.name === 'agri_causal_chain', 120_000, '因果链调用')
      expect(String(chainCall.args?.decision_id)).toBe(decisionId)
      const chainResult = await sse.wait(e => e.type === 'tool/result' && e.callSeq === chainCall.seq, 120_000, '因果链结果')
      expect(chainResult.isError).toBeFalsy()
      await sse.wait(e => e.type === 'turn/end', 120_000, 'turn/end(因果链)')
    } finally {
      sse.close()
    }
  }, 420_000)
})

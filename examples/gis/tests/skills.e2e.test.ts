/**
 * 技能文件 e2e（M12，接线 dsh-skill / dsh-skill-filesystem / dsh-tool-skill）：
 *
 * 无 key 段：组合三行 + 隔离模式 customSkillDirs 指向 tests/skills + boot 成功
 * （skill-filesystem 激活即完成发现；tool-skill 激活即注册模型面 skill 工具）。
 *
 * 带 key 段：真实模型轮次——目录消息让模型知道 greeting-guide 存在 → 模型调
 * `skill` 工具加载全文 → 按 SKILL.md 规范回答（文本以"施主"开头、含"祝君安康"）。
 */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import {
  ANON_HEADERS, bootLoom, cleanupDir, ensureTsx, GIS_DIR, openEventStream, readEnv, sdkBuilt, type BootedLoom,
} from './helpers.js'

const env = readEnv(GIS_DIR)
const hasKey = process.env.DEEPSEEK_API_KEY !== undefined || env.DEEPSEEK_API_KEY !== undefined
if (process.env.DEEPSEEK_API_KEY === undefined && env.DEEPSEEK_API_KEY !== undefined) {
  process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY
}

async function boot(): Promise<BootedLoom> {
  ensureTsx()
  return await bootLoom({
    appModulePath: join(GIS_DIR, 'tests', 'skills-app.ts'),
    withApproval: false,
    port: 4644,
    outDirName: '.loom-skills-e2e',
  })
}

describe.skipIf(!sdkBuilt())('技能文件 e2e：组合与注册（无 key）', () => {
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    loom = await boot()
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(GIS_DIR, '.loom-skills-e2e'))
  })

  it('组合文件：三行 + 隔离模式指向 tests/skills', () => {
    const yml = readFileSync(resolve(GIS_DIR, '.loom-skills-e2e', 'cordis.yml'), 'utf8')
    expect(yml).toContain("- id: skill\n  name: '@deepseek-ai/dsh-skill'")
    expect(yml).toContain("- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'")
    expect(yml).toContain('includeDefaultRoots: false')
    expect(yml).toContain('skills"') // customSkillDirs 指向 tests/skills（正斜杠路径）
    expect(yml).toContain("- id: tool-skill\n  name: '@deepseek-ai/dsh-tool-skill'")
  })

  it('boot 成功 = 技能发现 + 模型面 skill 工具注册完成', async () => {
    const res = await fetch(`${loom!.base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.app).toBe('skills-demo')
  })
})

describe.skipIf(!sdkBuilt() || !hasKey)('技能文件 e2e：模型加载并遵循技能（带 key）', () => {
  let loom: BootedLoom | undefined

  beforeAll(async () => {
    loom = await boot()
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(GIS_DIR, '.loom-skills-e2e'))
  })

  it('模型调 skill 工具加载 greeting-guide 并按规范回答', async () => {
    const created = await fetch(`${loom!.base}/agents/receptionist/sessions`, { method: 'POST', headers: ANON_HEADERS })
    const { sessionId } = (await created.json()) as { sessionId: string }
    const sse = await openEventStream(loom!.base, sessionId)
    try {
      const sent = await fetch(`${loom!.base}/agents/receptionist/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ANON_HEADERS },
        body: JSON.stringify({ text: '请使用 greeting-guide 技能和我打个招呼。' }),
      })
      expect(sent.status).toBe(200)
      const call = await sse.wait(e => e.type === 'tool/call' && e.name === 'skill', 60_000, 'skill 工具调用')
      expect(call.args?.name).toBe('greeting-guide')
      const result = await sse.wait(e => e.type === 'tool/result' && e.callSeq === call.seq, 60_000, '技能加载结果')
      expect(result.isError).toBeFalsy()
      // 第一条 assistant/message 可能是"先调工具"的空文本步骤——等包含施主的那条定稿。
      const message = await sse.wait(
        e => e.type === 'assistant/message' && String(e.text ?? '').includes('施主'),
        60_000,
        '包含"施主"的助手回答',
      )
      expect(String(message.text)).toContain('祝君安康')
    } finally {
      sse.close()
    }
  })
})

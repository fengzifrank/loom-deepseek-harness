import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS, PROVIDER_PRESET_NAMES, resolveLlm } from '../src/providers.js'
import { composeCordisYml } from '../src/compose.js'

const baseOpts = {
  runtimeUrl: 'file:///runtime.js',
  appModuleUrl: 'file:///app.ts',
  outDir: '/tmp/.loom',
  port: 4620,
  apiPrefix: '/~loom',
}

describe('resolveLlm：预设解析', () => {
  it('缺省 = deepseek-official（零配置现状，向后兼容）', () => {
    expect(resolveLlm({ model: 'deepseek-v4-flash' })).toEqual({ kind: 'deepseek-official' })
  })

  it('ollama 预设：openai-completions + 本地端点 + models 含默认与 agent 覆盖模型', () => {
    const resolved = resolveLlm({
      model: 'qwen3:32b',
      provider: 'ollama',
      agents: [{ model: 'qwen3:8b' }, {}],
    })
    expect(resolved.kind).toBe('pi-ai')
    if (resolved.kind !== 'pi-ai') return
    expect(resolved.active).toBe('ollama')
    expect(resolved.model).toBe('qwen3:32b')
    expect(resolved.routes).toEqual([{
      route: 'ollama',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:11434/v1',
      headers: { Authorization: 'Bearer loom-anonymous' },
      models: ['qwen3:32b', 'qwen3:8b'],
    }])
  })

  it('openrouter 预设：云端端点 + apiKeyEnv 引用（机密不进声明）', () => {
    const resolved = resolveLlm({ model: 'claude-sonnet-4-5', provider: 'openrouter' })
    expect(resolved).toMatchObject({
      kind: 'pi-ai',
      active: 'openrouter',
      routes: [{ route: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' }],
    })
  })

  it('openai-compatible 预设缺 baseURL → 声明期拒绝', () => {
    expect(() => resolveLlm({ model: 'm1', provider: 'openai-compatible' })).toThrow(/baseURL/)
  })

  it('providers 覆盖预设端点（内网 Ollama 不在本机）', () => {
    const resolved = resolveLlm({
      model: 'qwen3:32b',
      provider: 'ollama',
      providers: { ollama: { baseURL: 'http://10.0.0.5:11434/v1' } },
    })
    expect((resolved.kind === 'pi-ai' ? resolved.routes[0]!.baseURL : undefined)).toBe('http://10.0.0.5:11434/v1')
  })

  it('自定义路由作为活跃 provider（vLLM 自建）', () => {
    const resolved = resolveLlm({
      model: 'deepseek-v4-flash',
      provider: 'my-vllm',
      providers: { 'my-vllm': { baseURL: 'http://10.0.0.8:8000/v1', apiKeyEnv: 'VLLM_KEY', models: ['llama3.3'] } },
    })
    expect(resolved.kind === 'pi-ai' ? resolved.routes[0] : undefined).toMatchObject({
      route: 'my-vllm',
      api: 'openai-completions',
      apiKeyEnv: 'VLLM_KEY',
      models: ['deepseek-v4-flash', 'llama3.3'],
    })
  })

  it('未知 provider / 非法 api / 空自定义 models 目录 / 官方带 providers → 拒绝', () => {
    expect(() => resolveLlm({ model: 'm', provider: 'azure' })).toThrow(/未知 provider/)
    expect(() => resolveLlm({
      model: 'm', provider: 'ollama',
      providers: { ollama: { api: 'grpc' as never } },
    })).toThrow(/api/)
    // 空目录只可能发生在非活跃的额外路由（活跃路由必含应用默认 model）
    expect(() => resolveLlm({
      model: 'm', provider: 'my-vllm',
      providers: { 'my-vllm': { baseURL: 'http://x/v1' }, spare: { baseURL: 'http://y/v1' } },
    })).toThrow(/spare[\s\S]*models/)
    expect(() => resolveLlm({
      model: 'm', provider: 'deepseek-official',
      providers: { ollama: { baseURL: 'http://x/v1' } },
    })).toThrow(/deepseek-official/)
  })
})

describe('composeCordisYml：LLM 组合段', () => {
  it('缺省（未传 llm）：llm-deepseek + DEEPSEEK_API_KEY（现状字节不变路径）', () => {
    const yml = composeCordisYml(baseOpts)
    expect(yml).toContain('- id: llm-deepseek')
    expect(yml).toContain('apiKeyEnv: DEEPSEEK_API_KEY')
    expect(yml).toContain('provider: deepseek-official')
    expect(yml).not.toContain('llm-pi-ai')
  })

  it('pi-ai：网关块 + 路由 + 模型目录 + agent-default-model 指向活跃路由', () => {
    const yml = composeCordisYml({
      ...baseOpts,
      llm: resolveLlm({ model: 'qwen3:32b', provider: 'ollama' }),
    })
    expect(yml).toContain("- id: llm-pi-ai")
    expect(yml).not.toContain('llm-deepseek')
    expect(yml).not.toContain('DEEPSEEK_API_KEY')
    expect(yml).toContain('ollama:')
    expect(yml).toContain('api: openai-completions')
    expect(yml).toContain('baseURL: "http://127.0.0.1:11434/v1"')
    expect(yml).toContain('- id: "qwen3:32b"')
    expect(yml).toContain('provider: ollama')
    expect(yml).toContain('model: "qwen3:32b"')
  })

  it('pi-ai：apiKeyEnv 引用透传（机密不进 yml）', () => {
    const yml = composeCordisYml({
      ...baseOpts,
      llm: resolveLlm({ model: 'm1', provider: 'openrouter' }),
    })
    expect(yml).toContain('apiKeyEnv: OPENROUTER_API_KEY')
    expect(yml).not.toMatch(/sk-[A-Za-z0-9]/)
  })
})

describe('PROVIDER_PRESETS', () => {
  it('预设名单稳定（文档引用）', () => {
    expect(PROVIDER_PRESET_NAMES).toEqual(['deepseek-official', 'ollama', 'openrouter', 'openai-compatible'])
    expect(Object.keys(PROVIDER_PRESETS)).toHaveLength(4)
  })
})

describe('resolveLlm：per-agent provider（M11 stretch，0.1.2 解锁）', () => {
  it('agent.provider 指向已声明路由 → 通过；模型目录自动覆盖该路由', () => {
    const resolved = resolveLlm({
      model: 'm1', provider: 'gw-a',
      providers: {
        'gw-a': { baseURL: 'http://a/v1' },
        'gw-b': { baseURL: 'http://b/v1', models: [] },
      },
      agents: [{ id: 'auditor', provider: 'gw-b', model: 'm2' }],
    })
    expect(resolved.kind === 'pi-ai' ? resolved.routes.map(r => r.route) : []).toEqual(['gw-a', 'gw-b'])
    const routeB = resolved.kind === 'pi-ai' ? resolved.routes[1] : undefined
    expect(routeB?.models).toContain('m2')
  })

  it('agent.provider 指向未声明路由 → 声明期拒绝（pi-ai 分支）', () => {
    expect(() => resolveLlm({
      model: 'm1', provider: 'gw-a',
      providers: { 'gw-a': { baseURL: 'http://a/v1' } },
      agents: [{ id: 'x', provider: 'no-such-route' }],
    })).toThrow(/no-such-route[\s\S]*路由未声明/)
  })

  it('非活跃路由的 agent 模型自动并入目录（与活跃路由同语义）；官方组合下非官方 provider → 拒绝', () => {
    const resolved = resolveLlm({
      model: 'm1', provider: 'gw-a',
      providers: {
        'gw-a': { baseURL: 'http://a/v1' },
        'gw-b': { baseURL: 'http://b/v1', models: [] },
      },
      agents: [{ id: 'x', provider: 'gw-b', model: 'auto-model' }],
    })
    const routeB = resolved.kind === 'pi-ai' ? resolved.routes[1] : undefined
    expect(routeB?.models).toContain('auto-model')
    expect(() => resolveLlm({
      model: 'm1',
      agents: [{ id: 'x', provider: 'ollama' }],
    })).toThrow(/deepseek-official/)
  })
})

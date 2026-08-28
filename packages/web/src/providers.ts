/**
 * 模型提供方预设与路由解析（M11）—— defineApp({ provider, providers }) 的消费端。
 *
 * 组合映射（compose.ts 消费解析结果）：
 * - `deepseek-official`（缺省）：dsh-llm-deepseek + DEEPSEEK_API_KEY（现状零配置）；
 * - 其余预设/自定义路由：dsh-llm-pi-ai 的 providers 配置段（route 键 = agent-default-model
 *   的 provider 名）。非 catalog 路由必须整条声明（api + baseURL + models）——
 * pi-ai 的 Config 契约；models 目录自动包含应用默认 model，外加用户声明的额外 id。
 *
 * 机密纪律：只输出 apiKeyEnv 引用（每请求经 ctx.credentials 解析），机密不进 yml。
 * @module @loom-sdk/web/providers
 */

import type { LlmProviderOptions } from './types.js'

/** 预设名 → 默认路由声明（ollama/openrouter 是 pi-ai 无 catalog 的手写路由）。 */
export const PROVIDER_PRESETS: Readonly<Record<string, LlmProviderOptions>> = {
  'deepseek-official': {},
  ollama: { api: 'openai-completions', baseURL: 'http://127.0.0.1:11434/v1' },
  openrouter: { api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
  'openai-compatible': { api: 'openai-completions' },
}

/** 预设名单（声明期校验用）。 */
export const PROVIDER_PRESET_NAMES: readonly string[] = Object.keys(PROVIDER_PRESETS)

/** 一条解析后的 pi-ai 路由（compose 直接物化为 yml config 段）。 */
export interface ResolvedLlmRoute {
  readonly route: string
  readonly api: string
  readonly baseURL?: string
  readonly apiKeyEnv?: string
  /** 无凭据路由的 Authorization 占位头（pi-ai 的 OpenAI 兼容协议强制要 key 或 Authorization）。 */
  readonly headers?: Record<string, string>
  readonly models: readonly string[]
}

/** 解析结果：deepseek 官方（走现状组合）或 pi-ai 多路由。 */
export type ResolvedLlm =
  | { readonly kind: 'deepseek-official' }
  | { readonly kind: 'pi-ai'; readonly active: string; readonly model: string; readonly routes: readonly ResolvedLlmRoute[] }

const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

/**
 * 解析应用的提供方声明（声明期诚实失败：未知预设 / openai-compatible 缺 baseURL /
 * 自定义路由缺 baseURL / 非法协议）。活跃路由的 models 目录自动包含应用默认 model
 * 与各 agent 的 model 覆盖（pi-ai 非 catalog 路由必须有目录，缺 id 即请求期失败——
 * 声明期收口）。
 */
export function resolveLlm(spec: {
  model: string
  provider?: string
  providers?: Record<string, LlmProviderOptions>
  agents?: ReadonlyArray<{ model?: string }>
}): ResolvedLlm {
  const providerName = spec.provider ?? 'deepseek-official'
  const declared = spec.providers ?? {}
  const preset = PROVIDER_PRESETS[providerName]
  // 活跃 provider 必须是预设名，或 providers 里整条声明的自定义路由名。
  if (preset === undefined && declared[providerName] === undefined) {
    throw new Error(
      `defineApp: 未知 provider "${providerName}"（预设：${PROVIDER_PRESET_NAMES.join(' / ')}；自定义路由请在 providers 里整条声明同名路由）`,
    )
  }
  if (providerName === 'deepseek-official') {
    if (Object.keys(declared).length > 0) {
      throw new Error('defineApp: provider "deepseek-official" 不消费 providers 覆盖（它是 dsh-llm-deepseek 现状组合；请换 openai-compatible + providers.{route}.baseURL）')
    }
    return { kind: 'deepseek-official' }
  }

  // 活跃路由必须覆盖的模型目录：应用默认 model + 各 agent 的 model 覆盖。
  const requiredModels = [spec.model, ...(spec.agents ?? []).map(agent => agent.model).filter((m): m is string => m !== undefined)]

  // 路由集合 = 活跃预设路由 + 用户声明的全部路由（多路由一并物化，v1 全应用共用活跃路由）。
  const routeNames = [...new Set([providerName, ...Object.keys(declared)])]
  const routes: ResolvedLlmRoute[] = routeNames.map(route => {
    const isPreset = route === providerName && PROVIDER_PRESETS[route] !== undefined
    const base: LlmProviderOptions = isPreset ? PROVIDER_PRESETS[route]! : {}
    const override = declared[route] ?? {}
    const api = override.api ?? base.api ?? 'openai-completions'
    if (!PROTOCOLS.includes(api as (typeof PROTOCOLS)[number])) {
      throw new Error(`defineApp: providers.${route}.api 必须是 ${PROTOCOLS.join(' / ')}，收到 ${JSON.stringify(api)}`)
    }
    const baseURL = override.baseURL ?? base.baseURL
    if (baseURL === undefined) {
      throw new Error(`defineApp: providers.${route} 缺 baseURL（${isPreset ? `预设 ${route} 可被 providers.${route}.baseURL 覆盖` : '自定义路由必须整条声明'}）`)
    }
    const apiKeyEnv = override.apiKeyEnv ?? base.apiKeyEnv
    if (apiKeyEnv !== undefined && (typeof apiKeyEnv !== 'string' || apiKeyEnv.trim() === '')) {
      throw new Error(`defineApp: providers.${route}.apiKeyEnv 必须是非空字符串（环境变量名）`)
    }
    // pi-ai 的 OpenAI 兼容协议强制要求 key 或 Authorization 头其一（本地 Ollama 等
    // 免认证端点也过不去）——无凭据路由发匿名占位头，端点忽略即可。
    const headers = apiKeyEnv === undefined ? { Authorization: 'Bearer loom-anonymous' } : undefined
    // models 目录：活跃路由必须含全部被引用的 model；自定义路由无 catalog，
    // 缺目录则不可服务。
    const extra = override.models ?? base.models ?? []
    const models = route === providerName ? [...new Set([...requiredModels, ...extra])] : [...new Set(extra)]
    if (models.length === 0) {
      throw new Error(`defineApp: providers.${route} 缺 models 目录（自定义路由无内置 catalog，至少列一个模型 id）`)
    }
    return {
      route,
      api,
      ...(baseURL === undefined ? {} : { baseURL }),
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
      ...(headers === undefined ? {} : { headers }),
      models,
    }
  })
  return { kind: 'pi-ai', active: providerName, model: spec.model, routes }
}

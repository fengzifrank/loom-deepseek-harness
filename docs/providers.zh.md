# 模型网关（M11）：一行切换 Ollama / vLLM / OpenRouter

> Loom 的模型层不再写死 DeepSeek 官方 API。`defineApp` 的 `provider` 一行声明即可切换
> 到本地 Ollama、自建 vLLM/OpenAI 兼容端点或云端 OpenRouter——组合层自动把
> `dsh-llm-deepseek` 换成 `dsh-llm-pi-ai` 多提供方路由。**不声明 provider 的应用字节
> 级向后兼容（仍是 DeepSeek 官方零配置）。**

## 预设一览

| provider | 端点 | 凭据 | 场景 |
|---|---|---|---|
| `deepseek-official`（缺省） | DeepSeek 官方 API | `DEEPSEEK_API_KEY` | 云端零配置，现状不变 |
| `ollama` | `http://127.0.0.1:11434/v1` | 免认证（自动带匿名头） | 内网/离线部署，农业 FDE 私有化 |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | 一个 key 用遍各家云端模型 |
| `openai-compatible` | 自定（必须给 baseURL） | 可选 | vLLM / LiteLLM / 自建网关 |

## 用法

### Ollama 本地（内网部署）

```ts
import { defineApp } from '@loom-sdk/web'

const app = defineApp('tcm-platform', {
  model: 'qwen3:32b',        // Ollama 里已拉取的模型名
  provider: 'ollama',        // 一行切换
})
```

Ollama 不在本机时覆盖端点：

```ts
const app = defineApp('tcm-platform', {
  model: 'qwen3:32b',
  provider: 'ollama',
  providers: { ollama: { baseURL: 'http://10.0.0.5:11434/v1' } },
})
```

### vLLM / 自建 OpenAI 兼容端点

```ts
const app = defineApp('tcm-platform', {
  model: 'deepseek-v4-flash',
  provider: 'my-vllm',                                // 自定义路由名
  providers: {
    'my-vllm': {
      baseURL: 'http://10.0.0.8:8000/v1',
      apiKeyEnv: 'VLLM_KEY',                          // 可选；缺省免认证
      models: ['llama3.3'],                           // 额外模型目录（默认 model 自动包含）
    },
  },
})
```

### OpenRouter 云端

```ts
const app = defineApp('tcm-platform', {
  model: 'anthropic/claude-sonnet-4-5',
  provider: 'openrouter',     // key 从环境变量 OPENROUTER_API_KEY 每请求解析
})
```

## 语义与边界（如实）

- **凭据纪律**：声明里只出现 `apiKeyEnv` 引用（环境变量名），机密不进
  `loom.app.ts`，也不进生成的 `.loom/cordis.yml`（每请求经 harness 凭据缝解析）。
- **免认证路由的占位头**：pi-ai 的 OpenAI 兼容协议强制要求 key 或 `Authorization`
  头其一；无凭据路由（Ollama 等）会自动附带 `Authorization: Bearer loom-anonymous`
  占位头——端点忽略即可，Loom 无法跳过该协议要求。
- **模型目录**：非 catalog 路由（ollama/openrouter/自定义）没有内置模型清单，Loom
  自动把**应用默认 model 与各 agent 的 `model` 覆盖**写进该路由的 models 目录；再用
  `providers.<route>.models` 追加。目录里没有的模型名会在请求期被 pi-ai 明确拒绝。
- **线协议**：预设路由用 `openai-completions`；可用 `providers.<route>.api` 覆盖为
  `openai-responses` / `anthropic-messages`。
- **声明期收口**：未知 provider 名、`openai-compatible` 缺 baseURL、自定义路由缺
  baseURL 或空模型目录、非法协议名——`loom dev` 启动前直接抛错（诚实失败优于请求期排查）。
- **v1 应用级路由**：provider/model 全应用共用（`agent-default-model` 单选）；
  按 agent 切换 provider 待内核 per-agent provider 支持后开放（`AgentSpec.model`
  字符串覆盖现在就可用，但走同一路由）。
- **应用依赖**：使用非官方 provider 的应用需安装 `@deepseek-ai/dsh-llm-pi-ai`
  （组合按 npm 名解析，与其它 `dsh-*` 插件同机制）。

## 组合层发生了什么

`loom dev` 用 `resolveLlm(app.spec)` 解析声明（`@loom-sdk/web` 导出，可单测）：

- `deepseek-official` → 组合保持 `dsh-llm-deepseek` + `apiKeyEnv: DEEPSEEK_API_KEY`；
- 其余 → 组合写入：

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      ollama:
        api: openai-completions
        baseURL: "http://127.0.0.1:11434/v1"
        headers:
          "Authorization": "Bearer loom-anonymous"
        models:
          - id: "qwen3:32b"

# agent-default-model 从 deepseek-official 换成路由键
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: ollama
    model: "qwen3:32b"
```

## 测试证据

- 单测：`packages/web/test/providers.test.ts`（预设解析 / 覆盖 / 声明期拒绝 / yml 片段）。
- e2e：`examples/gis/tests/gateway.e2e.test.ts`——测试进程内起 mock OpenAI 兼容服务器
  （openai-completions 流式协议），`provider: 'openai-compatible'` 指向 mock，跑通完整
  agent 轮次（SSE assistant/message 到达、mock 收到 `chat/completions` 且 model 正确），
  **全程不需要 DEEPSEEK_API_KEY**——组合/路由/协议适配端到端成立。

## FDE 交付提示（农业内网场景）

1. 客户内网服务器装 Ollama + 拉取目标模型（如 `ollama pull qwen3:32b`）；
2. 应用 `defineApp(..., { model: 'qwen3:32b', provider: 'ollama' })`（或指向内网机器的
   baseURL 覆盖）；
3. `loom dev` 启动即走本地模型，数据不出内网；`loom eval` 的会话夹具照常可用
   （评测重放不依赖线上模型）。

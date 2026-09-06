/**
 * 模型网关 e2e 的 fixture 应用（M11）。
 *
 * provider 'openai-compatible' 指向测试进程内启动的 mock OpenAI 服务器
 * （端点经 LOOM_GW_MOCK_URL 环境变量注入——bootLoom 同进程导入本模块，env 可见）。
 * 全程不需要 DEEPSEEK_API_KEY：证明组合/路由/协议适配端到端成立。
 */
import { defineApp } from '@loom-sdk/web'

const app = defineApp('gateway-demo', {
  model: 'mock-model',
  provider: 'openai-compatible',
  providers: {
    // 双路由：默认路由 + gw-b（均指向测试进程内的 mock，模型 id 区分流量归属）。
    'openai-compatible': { baseURL: process.env.LOOM_GW_MOCK_URL ?? 'http://127.0.0.1:9/v1' },
    'gw-b': { baseURL: process.env.LOOM_GW_MOCK_URL ?? 'http://127.0.0.1:9/v1' },
  },
})

app.agent('talker', {
  persona: '你是网关测试数字员工，用一句话回答。',
})

// per-agent 路由（0.1.2 解锁）：这个 agent 固定走 gw-b 路由的 mock-model-2。
app.agent('talker-b', {
  persona: '你是网关测试数字员工（B 路由），用一句话回答。',
  provider: 'gw-b',
  model: 'mock-model-2',
})

export default app

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
    'openai-compatible': { baseURL: process.env.LOOM_GW_MOCK_URL ?? 'http://127.0.0.1:9/v1' },
  },
})

app.agent('talker', {
  persona: '你是网关测试数字员工，用一句话回答。',
})

export default app

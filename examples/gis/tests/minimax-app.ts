/**
 * MiniMax-M3 真实端点 e2e 的 fixture 应用（M11 网关的第三方实证）。
 *
 * provider 'minimax'（api.minimaxi.com/v1，OpenAI 兼容）——组合走 dsh-llm-pi-ai，
 * key 从环境变量 MINIMAX_API_KEY 每请求解析（.env 已 gitignore，绝不入库）。
 * probe_echo 工具用于验证 MiniMax-M3 的函数调用（finish_reason=tool_calls）。
 */
import { defineApp } from '@loom-sdk/web'

const app = defineApp('minimax-demo', {
  model: 'MiniMax-M3',
  provider: 'minimax',
})

app
  .tool('probe_echo')
  .description('回显 text 参数（连通性探针，无副作用）。')
  .input({ text: { type: 'string', required: true, description: '要回显的文本。' } })
  .output({ type: 'object', properties: { text: { type: 'string', required: true } } })
  .card('generic', { title: '回显' })
  .execute(async (args) => ({ text: `echo: ${String(args.text ?? '')}` }))

app.agent('talker', {
  persona: '你是连通性测试数字员工。用户要求调用工具时立即调用，调用后一句话确认结果。',
  tools: ['probe_echo'],
})

export default app

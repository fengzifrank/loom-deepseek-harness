/**
 * 预算治理 e2e 的 fixture 应用（M9）。
 *
 * 无需 API key：断言只驱动 .http() 第二张面孔（经内核管线 → tools/pre-execute
 * → 预算计量器），全程不发起 LLM 请求。budget_echo 的 tool-calls 预算 max=2
 * ——同一隐藏 api 会话上第 3 次调用应 fail-closed 拒绝。
 */
import { defineApp } from '@loom-sdk/web'

const app = defineApp('budget-demo', { model: 'deepseek-v4-flash' })

app
  .tool('budget_echo')
  .description('回显 text 参数（预算 e2e 专用，无副作用）。')
  .input({ text: { type: 'string', required: true, description: '要回显的文本。' } })
  .output({ type: 'object', properties: { text: { type: 'string', required: true } } })
  .card('generic', { title: '回显' })
  .http('GET')
  .execute(async (args) => ({ text: String(args.text ?? '') }))

app.agent('echo-worker', {
  persona: '回显数字员工：只做回显，别无他事。',
  tools: ['budget_echo'],
})

app.policy({
  default: 'allow',
  rules: [],
  budgets: [{ kind: 'tool-calls', max: 2, tool: 'budget_echo' }],
})

export default app

/**
 * 无 key 冒烟夹具应用：纯本地工具（不触 LLM），验证 boot / health / 404 / .http()。
 */
import { defineApp } from '@loom-sdk/web'

const app = defineApp('smoke', { port: 4621 })

app
  .tool('smoke_echo')
  .description('回显输入（冒烟测试用）')
  .input({ text: { type: 'string', required: true }, times: { type: 'number', description: '重复次数，默认 1' } })
  .output({ type: 'object', properties: { text: { type: 'string', required: true }, n: { type: 'number', required: true } } })
  .http('GET')
  .execute(async args => ({ text: String(args.text ?? '').repeat(Math.max(1, Number(args.times ?? 1))), n: 42 }))

app.agent('smoke-agent', { persona: 'smoke', tools: ['smoke_echo'] })

// M3 冒烟：subagent 声明（组合加入 subagent 服务缝 + spawn provider）与
// webhook 通道（401/400/202 各路径，全部不触 LLM 即可断言）。
app.subagent('smoke-researcher', {
  persona: '冒烟研究员',
  tools: ['smoke_echo'],
  visibleTo: ['smoke-agent'],
})

app.channel.webhook('/hooks/smoke', {
  agent: 'smoke-agent',
  map: payload => {
    if (typeof payload.text !== 'string' || payload.text.trim() === '') {
      throw new Error('payload.text 必须是非空字符串')
    }
    return `【webhook】${payload.text.trim()}`
  },
  secret: 'whsec_smoke',
  sessionKey: payload => (typeof payload.topic === 'string' && payload.topic.trim() !== '' ? payload.topic.trim() : 'default'),
})

app.policy({
  default: 'allow',
  rules: [
    { tool: 'smoke_*', effect: 'allow' },
    { tool: 'smoke_secret_*', effect: 'deny' },
  ],
})

export default app

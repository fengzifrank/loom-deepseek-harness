/**
 * QA 冲刺夹具应用（无 key 可跑全部路径）：auth（CORS 白名单）+ policy
 * （qa_approve_* 走人工审批、approvalTimeoutMs 缩短到 8s 便于测超时清理）+
 * webhook 通道（并发同 sessionKey 竞态）。
 *
 * 关键设计：qa_touch / qa_approve_write 都带 .http() 面孔——HTTP 直调经
 * ctx.tools.execute 走完整 policy 管线，能在**不触 LLM** 的情况下触发审批缝
 * （挂起在隐藏 api 会话上，测试扫描 .loom/sessions 目录拿到其 id 即可订阅）。
 */
import { defineApp } from '@loom-sdk/web'

const app = defineApp('qa-app', { port: 4630 })

app
  .tool('qa_touch')
  .description('无副作用探针（触发 api 隐藏会话创建；allow）')
  .input({ text: { type: 'string', description: '任意文本' } })
  .output({ type: 'object', properties: { ok: { type: 'boolean', required: true }, echo: { type: 'string', required: true } } })
  .http('GET')
  .execute(async args => ({ ok: true, echo: String(args.text ?? '') }))

app
  .tool('qa_approve_write')
  .description('需要人工审批的写操作（approve——经 .http() 直调即可触发审批缝，无需 LLM）')
  .input({ note: { type: 'string', required: true, description: '写入内容' } })
  .output({ type: 'object', properties: { written: { type: 'string', required: true } } })
  .http('POST')
  .execute(async args => ({ written: String(args.note ?? '') }))

app
  .tool('qa_echo')
  .description('普通模型面工具（无 http 面孔）')
  .input({ text: { type: 'string', required: true } })
  .output({ type: 'object', properties: { text: { type: 'string', required: true } } })
  .execute(async args => ({ text: String(args.text ?? '') }))

// auth 开启（POST 需身份）+ CORS 白名单（非白名单 Origin 不回显）+ 记忆面板路由。
app.auth({ corsOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'] })
app.memory()

app.agent('qa-agent', { persona: 'QA 冲刺夹具智能体', tools: ['qa_touch', 'qa_approve_write', 'qa_echo'] })

// webhook 通道：无 secret（本地测试形态）；同 topic 复用会话（并发竞态测试面）。
app.channel.webhook('/hooks/qa', {
  agent: 'qa-agent',
  map: payload => {
    const text = payload.text
    if (typeof text !== 'string' || text.trim() === '') throw new Error('payload.text 必须是非空字符串')
    return `【qa-hook】${text.trim()}`
  },
  sessionKey: payload => (typeof payload.topic === 'string' && payload.topic.trim() !== '' ? payload.topic.trim() : 'default'),
})

// 策略：qa_approve_* 人工审批（8s 超时 fail-closed——测试审批超时清理不用等 5 分钟）。
// 注意规则按声明顺序求值、后声明覆盖先声明——default 已是 allow，无需再写
// qa_* allow（它会覆盖掉 qa_approve_* 的 approve）。
app.policy({
  default: 'allow',
  rules: [
    { tool: 'qa_approve_*', effect: 'approve' },
  ],
  approvalTimeoutMs: 8_000,
})

export default app

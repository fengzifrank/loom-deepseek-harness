/**
 * M7 重启恢复夹具应用：真实进程 boot（dev-worker 子进程）→ 杀进程 → 同一
 * .loom 目录重新 boot → 会话历史完整 + 同 sessionId 续聊（惰性 resume）。
 * 独立目录（tests/fixtures/resume/.loom）避免与开发工作区互踩。
 */
import { defineApp } from '@loom-sdk/web'

const app = defineApp('resume-fixture', { port: 4627 })

app.agent('memory-keeper', {
  persona: '你是重启恢复测试助手：如实记住用户在上一段对话里告诉你的名字与事实，用中文一句话回答。',
  tools: [],
})

export default app

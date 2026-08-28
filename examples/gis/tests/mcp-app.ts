/**
 * MCP 桥接 e2e 的 fixture 应用（M10）。
 *
 * app.mcp 声明本地 stdio echo 服务器（tests/mcp-echo-server.mjs）；failOnStartupError
 * 打开——boot 成功即证明连接 + 工具发现 + 注册全部完成（失败会拒绝激活）。
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineApp } from '@loom-sdk/web'

const testsDir = fileURLToPath(new URL('.', import.meta.url))

const app = defineApp('mcp-demo', { model: 'deepseek-v4-flash' })

app.agent('caller', {
  persona: '你是 MCP 测试数字员工，按用户要求调用工具后一句话确认。',
})

app.mcp('echo', {
  transport: 'stdio',
  command: process.execPath,
  args: [join(testsDir, 'mcp-echo-server.mjs')],
  failOnStartupError: true,
})

export default app

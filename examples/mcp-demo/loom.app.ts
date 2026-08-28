/**
 * MCP 桥接示例（M10）——接入 filesystem MCP 服务器，策略治理其工具。
 *
 *   pnpm install
 *   pnpm loom dev        # http://127.0.0.1:4620/~loom/health
 *
 * 模型会看到 mcp__fs__read_file / mcp__fs__write_file / mcp__fs__list_directory
 * 等工具（Claude Code/Codex 同款命名形）。写操作走人工审批（fail-closed）。
 * 首次运行 npx 会下载 @modelcontextprotocol/server-filesystem（需要网络）。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineApp } from '@loom-sdk/web'

const workspaceDir = join(dirname(fileURLToPath(import.meta.url)), 'workspace')

const app = defineApp('mcp-demo', { model: 'deepseek-v4-flash' })

app.agent('file-assistant', {
  persona: [
    '你是"文件助手数字员工"，通过 MCP filesystem 服务器读写本地 workspace 目录。',
    '规则：列目录用 mcp__fs__list_directory，读文件用 mcp__fs__read_file，',
    '写文件用 mcp__fs__write_file（真实落盘，会触发人工审批，被拒后如实告知）；',
    '只操作 workspace 目录内的路径；回答用中文，引用文件内容时给出行号。',
  ].join('\n'),
})

app.mcp('fs', {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', workspaceDir],
  // 机密示例：MCP_TOKEN 不会进 cordis.yml，只在运行时经环境变量注入。
  // envRef: ['MCP_TOKEN'],
  failOnStartupError: true,
})

// MCP 工具照常走策略/审批门（glob 模式匹配 mcp__fs__* 命名空间）。
app.policy({
  default: 'allow',
  rules: [
    { tool: 'mcp__fs__write_file', effect: 'approve' }, // 真实写盘：人工审批
    { tool: 'mcp__fs__read_*', effect: 'allow' },       // 只读：放行
    { tool: 'mcp__fs__list_*', effect: 'allow' },
  ],
  budgets: [{ kind: 'tool-calls', max: 50 }], // M9 顺手示范：每会话最多 50 次工具调用
})

export default app

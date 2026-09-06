/**
 * Semantica × Loom 的 MCP 变体（零代码路径，M10）。
 *
 * `python -m semantica.mcp_server`（semantica 自带，stdio 手写 JSON-RPC，免网络
 * 免认证）→ 工具以 mcp__semantica__* 注册（record_decision / find_precedents /
 * get_causal_chain / add_entity / run_reasoning / query_graph 等 15 个）。
 *
 * 注意：graph-mcp.json 与桥路径的 graph.json 是**两个独立文件**——两个进程
 * 各自单写（共用一个文件是 last-writer-wins，文档警示见 docs/semantica.zh.md）。
 * 持久化 bug 在 0.6.8 修复（#1394），必须钉版本。
 *
 *   pnpm loom dev loom.mcp-app.ts
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineApp } from '@loom-sdk/web'

const appDir = dirname(fileURLToPath(import.meta.url))
const pyExe = join(appDir, '.venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')
const kgPath = join(appDir, 'graph-mcp.json').split('\\').join('/')

const app = defineApp('semantica-mcp-demo', { model: 'deepseek-v4-flash' })

app.agent('graph-analyst', {
  persona: [
    '你是"知识图谱分析数字员工"，通过 MCP 服务器（mcp__semantica__* 工具）操作一张语义图。',
    '纪律：先 mcp__semantica__get_graph_summary 看图概况；查相似决策用 find_precedents；',
    '记录决策（record_decision）会触发人工审批，被拒后如实告知；改图前先 query_graph 确认现状。',
  ].join('\n'),
})

app.mcp('semantica', {
  transport: 'stdio',
  command: pyExe,
  args: ['-m', 'semantica.mcp_server'],
  env: { SEMANTICA_KG_PATH: kgPath, SEMANTICA_LOG_LEVEL: 'WARNING' },
  failOnStartupError: true, // 连接/发现/注册失败 → boot 直接失败（诚实失败优于静默空集）
})

app.policy({
  default: 'allow',
  rules: [
    { tool: 'mcp__semantica__record_decision', effect: 'approve' },
    { tool: 'mcp__semantica__update_node', effect: 'approve' },
    { tool: 'mcp__semantica__delete_node', effect: 'deny' }, // 软删除也不放开：审计场景禁删
  ],
  budgets: [{ kind: 'tool-calls', max: 20 }],
})

export default app

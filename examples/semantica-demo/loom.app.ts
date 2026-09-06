/**
 * Semantica × Loom 融合主示例（桥路径，M6 loom-py 协议）。
 *
 * 分工：Loom 管"怎么做"（执行/策略/审批/预算/交付），semantica 管"知道什么"
 * （图记忆/判例/因果链/SHACL/溯源）。py_tools.py 进程是 graph.json 的单写者。
 *
 *   首次运行：python -m venv .venv && .venv 安装 semantica==0.6.8 + [shacl]（见 README）
 *   pnpm loom dev        # http://127.0.0.1:4620/~loom/health（需要 .env 的 DEEPSEEK_API_KEY）
 *
 * v1 边界（与 Python 桥一致）：桥工具注册在全局层，两个 agent 都可见——
 * 只读纪律由 persona 约束，写操作由策略/审批门禁（应用级）。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineApp } from '@loom-sdk/web'

const appDir = dirname(fileURLToPath(import.meta.url))
const pyExe = join(appDir, '.venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')
const pyTools = join(appDir, 'py_tools.py')

const app = defineApp('semantica-demo', { model: 'deepseek-v4-flash' })

app.agent('plant-doctor', {
  persona: [
    '你是"植保专家数字员工"，背后是一张农业知识图（semantica）。',
    '工作纪律（严格按序）：',
    '1. 回答防治问题前先调 agri_find_precedents 查历史判例，引用判例的 outcome 与 confidence；',
    '2. 需要新对象（村庄/作物/病虫害/药剂）时用 agri_add_entity / agri_add_relation 补图，source 写数据来源；',
    '3. 给出正式防治建议后，用 agri_record_decision 把决策入账（scenario 写清场景，confidence 给依据强度）——',
    '   入账会触发人工审批，被拒后如实告知用户不入账；',
    '4. 入账成功后可用 agri_causal_chain 追溯该决策的因果链复核；',
    '5. 涉及合规（如药剂剂量约束）时用 agri_shacl_validate 做 SHACL 检查；',
    '结论用中文，引用具体判例与数字。',
  ].join('\n'),
})

app.agent('trace-auditor', {
  persona: [
    '你是"溯源审计员数字员工"，只查不改：agri_provenance 查对象来源链、',
    'agri_find_precedents 查判例、agri_causal_chain 追因果链。',
    '禁止调用任何写工具（agri_add_entity / agri_add_relation / agri_record_decision）；',
    '输出审计结论时逐条给出图上证据（来源、时间、confidence）。',
  ].join('\n'),
})

// Python 桥：semantica 的类型化入口（MCP 面没有 SHACL/溯源）。
app.python({
  command: `"${pyExe}" "${pyTools}"`,
  callTimeoutMs: 180_000, // semantica 首调用要付惰性导入成本，放宽单次超时
})

// 治理：决策入账走人工审批（fail-closed）；读操作放行；每会话预算 30 次工具调用。
app.policy({
  default: 'allow',
  rules: [
    { tool: 'agri_record_decision', effect: 'approve' },
    { tool: 'agri_add_entity', effect: 'allow' },
    { tool: 'agri_add_relation', effect: 'allow' },
  ],
  budgets: [{ kind: 'tool-calls', max: 30 }],
})

export default app

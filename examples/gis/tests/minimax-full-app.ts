/**
 * MiniMax-M3 全接口发布验收 fixture——一个 app 覆盖 Loom 全部对外能力面。
 * provider minimax（真实第三方端点），key 从环境变量 MINIMAX_API_KEY 解析。
 */
import { createHmac } from 'node:crypto'
import { defineApp } from '@loom-sdk/web'

const app = defineApp('minimax-release', {
  model: 'MiniMax-M3',
  provider: 'minimax',
  port: 4677,
})

// 工具（含 .http() 第二面孔）
app
  .tool('rel_query')
  .description('查询村庄地类面积。')
  .input({ region: { type: 'string', description: '村庄名过滤词，可选。' } })
  .output({
    type: 'object',
    properties: {
      items: { type: 'array', required: true, items: { type: 'object', properties: { village: { type: 'string', required: true }, landType: { type: 'string', required: true }, areaSqm: { type: 'number', required: true } } } },
      totalAreaSqm: { type: 'number', required: true },
    },
  })
  .card('generic', { title: '地类查询' })
  .http('GET')
  .execute(async (args) => {
    const all = [
      { village: '连河村', landType: '水浇地', areaSqm: 4520 },
      { village: '连河村', landType: '旱地', areaSqm: 2100 },
      { village: '河边村', landType: '水田', areaSqm: 3800 },
    ]
    const kw = typeof args.region === 'string' ? args.region.trim() : ''
    const items = kw === '' ? all : all.filter(i => i.village.includes(kw))
    return { items, totalAreaSqm: items.reduce((s, i) => s + i.areaSqm, 0) }
  })

// 写工具（策略审批）
app
  .tool('rel_update_note')
  .description('更新村庄备注（真实写操作）。')
  .input({ region: { type: 'string', required: true }, note: { type: 'string', required: true } })
  .output({ type: 'object', properties: { updated: { type: 'number', required: true } } })
  .card('generic', { title: '备注（写）' })
  .http('POST')
  .execute(async (args) => ({ updated: 1 }))

// Agent（含记忆）
app.agent('analyst', {
  persona: '你是国土数据数字员工。回答前必须先调 rel_query 查真实数据，禁止编造数字。用中文简洁作答。',
  tools: ['rel_query', 'rel_update_note'],
  memory: true,
})

// 子智能体（对等委派）
app.agent('writer', {
  persona: '你是专题写作数字员工，只依据查到的材料写结论。',
})

// 群体（mesh 拓扑 + 群体记忆）
app.swarm('research-pod', {
  entry: { id: 'pod-lead', persona: '你是研究组长：拆解任务、委派成员、汇总。', tools: ['rel_query'] },
  topology: 'mesh',
  memory: true,
  members: [
    { id: 'researcher', role: 'worker', persona: '你是研究员：用 rel_query 查数据，发现记入 swarm_note。', tools: ['rel_query'] },
    { id: 'summarizer', persona: '你是写作员：用 swarm_recall 检索群体笔记写结论。' },
  ],
})

// 策略：写操作审批 + 预算
app.policy({
  default: 'allow',
  rules: [
    { tool: 'rel_update_note', effect: 'approve' },
  ],
  budgets: [{ kind: 'tool-calls', max: 10 }],
})

// 通道（webhook）
app.channel.webhook('/hooks/release', {
  agent: 'analyst',
  map: payload => `【发布验收】${String(payload.text ?? '')}`,
  secret: 'whsec_release_test',
})

// 投影
export interface WorkspaceState {
  tasks: Array<{ seq: number; title: string; status: string }>
}
app.projection<WorkspaceState>('workspace', {
  init: { tasks: [] },
  apply(state, event) {
    switch (event.type) {
      case 'tool/call':
        return { ...state, tasks: [...state.tasks, { seq: event.seq, title: String(event.name), status: 'running' }] }
      case 'tool/result':
        return { ...state, tasks: state.tasks.map(t => (t.seq === event.callSeq ? { ...t, status: 'done' } : t)) }
      default:
        return state
    }
  },
})

// 认证
app.auth()

// 记忆
app.memory({ extraction: { maxPerTurn: 3 } })

export default app

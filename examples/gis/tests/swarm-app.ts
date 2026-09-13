/**
 * 群体智能（M15）e2e 的 fixture 应用：mesh 拓扑 + 群体记忆 + 深度 2。
 *
 * pod-lead（入口）→ researcher / writer（成员，互为对等委派对象）。
 * swarm_query 提供确定性农业数据（连河村三作物面积），供 researcher 记群体笔记。
 */
import { defineApp } from '@loom-sdk/web'

const app = defineApp('swarm-demo', { model: 'deepseek-v4-flash' })

app
  .tool('swarm_query')
  .description('查询连河村三大作物的种植面积（亩）。')
  .input({ crop: { type: 'string', description: '可选作物名过滤（水稻/小麦/玉米）。' } })
  .output({
    type: 'object',
    properties: {
      items: { type: 'array', required: true, items: { type: 'object', properties: { crop: { type: 'string', required: true }, acres: { type: 'number', required: true } } } },
    },
  })
  .card('generic', { title: '作物面积' })
  .execute(async (args) => {
    const all = [
      { crop: '水稻', acres: 1200 },
      { crop: '小麦', acres: 800 },
      { crop: '玉米', acres: 450 },
    ]
    const keyword = typeof args.crop === 'string' ? args.crop.trim() : ''
    return { items: keyword === '' ? all : all.filter(item => item.crop.includes(keyword)) }
  })

app.swarm('pod', {
  entry: {
    id: 'pod-lead',
    persona: '你是研究组长：把用户的任务拆解后委派给成员，自己不直接查数据；汇总成员结果用中文简洁作答。',
    tools: ['swarm_query'],
  },
  topology: 'mesh',
  memory: true,
  members: [
    { id: 'researcher', role: 'worker', persona: '你是研究员：用 swarm_query 查真实数据，绝不编造数字。', tools: ['swarm_query'] },
    { id: 'writer', role: 'worker', persona: '你是写作员：只依据查到的材料写结论，不新增事实。', tools: [] },
  ],
})

export default app

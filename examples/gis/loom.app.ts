/**
 * GIS 平台 —— 第一个 Loom 应用（对 harness examples/gis-bridge 的声明式重写，
 * 见 docs/whitepaper.zh.md §7 提炼表）。业务逻辑原样搬自 gis-bridge 插件。
 *
 * DX 冲刺后的写法：.input() 字面量 DSL 推导入参类型（内核已校验，execute 里
 * 直接用）；.output() 直接写 schemastery 的 z.object，required 由可选性推导。
 * 启动：pnpm loom dev（一条命令起智能体服务 + Vite 前端）。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { defineApp } from '@loom-sdk/web'

const DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'data', 'land-types.json')
/** Python 工具脚本（相对本文件定位；解释器取 PATH 上的 python，需 3.10+）。 */
const PY_TOOLS = join(dirname(fileURLToPath(import.meta.url)), 'py_tools.py')

async function loadLandTypes(signal?: AbortSignal) {
  let text
  try {
    text = await readFile(DATA_PATH, 'utf8' /* , signal */)
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new Error(`地类数据文件不存在：${DATA_PATH}`)
    throw error
  }
  const data = JSON.parse(text)
  if (!Array.isArray(data.items)) throw new Error('land-types.json 顶层缺少 items 数组')
  return data as { items: Array<{ village: string; landType: string; areaSqm: number; ratioPct: number; note?: string }> }
}

async function saveLandTypes(data: unknown, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('aborted')
  await writeFile(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

const app = defineApp('gis-platform', { model: 'deepseek-v4-flash' })

// ── 工具：一份声明，模型面孔 + generic 卡片（args 全部类型化） ───────────────

app
  .tool('gis_query_land_types')
  .description('查询村庄地类面积数据（2022 年土地地类图斑按村庄汇总）。返回每个村庄的地类、图斑面积（平方米）与占全镇面积百分比，按面积从大到小排序。可按村庄名（支持部分匹配）过滤。')
  .input({ region: { type: 'string', description: '可选的村庄名过滤词，如"连河村"；省略则返回全部 8 个村庄。' } })
  .output(z.object({
    totalAreaSqm: z.number(),
    items: z.array(z.object({ village: z.string(), landType: z.string(), areaSqm: z.number(), ratioPct: z.number() })),
    queriedAt: z.string(),
  }))
  .card('generic', { title: '地类面积查询' })
  .http('GET') // 第二张面孔：GET /~loom/api/gis_query_land_types?region=连河村
  .execute(async (args, exec) => {
    const data = await loadLandTypes(exec.signal)
    const keyword = (args.region ?? '').trim()
    const items = keyword === '' ? [...data.items] : data.items.filter(item => item.village.includes(keyword))
    items.sort((a, b) => b.areaSqm - a.areaSqm)
    const round2 = (n: number) => Math.round(n * 100) / 100
    return {
      totalAreaSqm: round2(items.reduce((sum, item) => sum + item.areaSqm, 0)),
      items: items.map(item => ({ village: item.village, landType: item.landType, areaSqm: item.areaSqm, ratioPct: item.ratioPct })),
      queriedAt: new Date().toISOString(),
    }
  })

app
  .tool('gis_render_pie_chart')
  .description('把一组占比数据渲染成饼图，展示在平台的图表面板。items 的 name 是扇区名（如村庄名），value 是数值（如面积平方米）。')
  .input({
    title: { type: 'string', required: true, description: '饼图标题，如"各村地类面积占比"。' },
    items: { type: 'array', required: true, description: '扇区数据，至少 1 项。', items: { type: 'object', properties: { name: { type: 'string', required: true }, value: { type: 'number', required: true } } } },
  })
  .output(z.object({ title: z.string(), items: z.array(z.object({ name: z.string(), value: z.number() })) }))
  .card('generic', { title: '饼图' })
  .execute(async (args, exec) => {
    if (exec.signal?.aborted) throw new Error('aborted')
    if (args.items.length === 0) throw new Error('items 必须是非空数组 [{name, value}]')
    return { title: args.title, items: args.items.map(item => ({ name: item.name, value: item.value })) }
  })

app
  .tool('gis_focus_map')
  .description('把平台地图聚焦/飞行到某个村庄并高亮，用于在讲解某村庄数据时引导用户视线。')
  .input({ region: { type: 'string', required: true, description: '目标村庄名，如"连河村"。' }, reason: { type: 'string', description: '聚焦原因（可选），展示在地图图例区。' } })
  .output(z.object({ region: z.string(), reason: z.string().required(false) }))
  .card('generic', { title: '地图聚焦' })
  .execute(async (args, exec) => {
    if (exec.signal?.aborted) throw new Error('aborted')
    return args.reason === undefined ? { region: args.region } : { region: args.region, reason: args.reason }
  })

app
  .tool('gis_write_report')
  .description('把一篇结构化报告落到平台的工作区（报告面板）。sections 按顺序渲染，每节有 heading 与 body。')
  .input({
    title: { type: 'string', required: true, description: '报告标题。' },
    sections: { type: 'array', required: true, description: '报告章节，至少 1 节。', items: { type: 'object', properties: { heading: { type: 'string', required: true }, body: { type: 'string', required: true } } } },
  })
  .output(z.object({ title: z.string(), sections: z.array(z.object({ heading: z.string(), body: z.string() })) }))
  .card('generic', { title: '专题报告' })
  .execute(async (args, exec) => {
    if (exec.signal?.aborted) throw new Error('aborted')
    if (args.sections.length === 0) throw new Error('sections 必须是非空数组 [{heading, body}]')
    return { title: args.title, sections: args.sections.map(section => ({ heading: section.heading, body: section.body })) }
  })

// 写工具：真实落盘（修改 data/land-types.json 的村庄 note 字段）——
// 策略里标 approve，模型调用时前端出现审批卡片（允许/拒绝），fail-closed。
app
  .tool('gis_update_land_note')
  .description('为某个村庄更新备注（note）字段，直接写入地类数据库（data/land-types.json）。region 支持部分匹配（如"连河村"），note 是新备注文本。这是真实的落盘写操作。')
  .input({
    region: { type: 'string', required: true, description: '目标村庄名（支持部分匹配），如"连河村"。' },
    note: { type: 'string', required: true, description: '新备注文本，如"重点耕地保护区"。' },
  })
  .output(z.object({
    updated: z.number(),
    villages: z.array(z.object({ village: z.string(), note: z.string() })),
    updatedAt: z.string(),
  }))
  .card('generic', { title: '村庄备注（写）' })
  .execute(async (args, exec) => {
    const data = await loadLandTypes(exec.signal)
    const updatedAt = new Date().toISOString()
    const villages = data.items
      .filter(item => item.village.includes(args.region))
      .map(item => ({ village: item.village, note: args.note }))
    if (villages.length === 0) throw new Error(`没有找到村庄名包含 "${args.region}" 的图斑记录`)
    for (const item of data.items) {
      if (item.village.includes(args.region)) item.note = args.note
    }
    await saveLandTypes(data, exec.signal)
    return { updated: villages.length, villages, updatedAt }
  })

// ── Python 工具桥（M6）：业务逻辑用 Python 写 ────────────────────────────
// py_tools.py 里 @tool 声明 gis_area_stats / gis_rank_change（statistics 模块
// 算标准差），run() 进入 stdio 协议主循环；这里 spawn 子进程握手后清单注册为
// 模型可见的代理工具（全部 agent 共享）。解释器取 PATH 上的 python（3.10+，
// 可用 LOOM_PYTHON 环境变量覆盖，如 CI 上无 python 别名时设 python3）。
app.python({ command: `${process.env.LOOM_PYTHON ?? 'python'} "${PY_TOOLS}"` })

// ── 认证 + 记忆（M7）：匿名 UUID 自动可用，本地账号注册/登录；数据分析
// 数字员工显式开启记忆（两阶段提取每轮最多 3 条候选，召回 topK 默认 5） ──────
app.auth()
app.memory({ extraction: { maxPerTurn: 3 } })

// ── 智能体：声明即路由（persona 精简自 gis-bridge） ────────────────────────

app.agent('data-analysis', {
  persona: [
    '你是"数据分析数字员工"，服务于一个国土 GIS 平台，通过工具驱动页面上的地图与图表。',
    '规则：回答任何数据问题前，必须先调用 gis_query_land_types 查询真实数据，禁止编造数字；统计类问题（均值、标准差、汇总占比等）优先用 Python 工具 gis_area_stats 直接计算；查某个村庄的占比或排名可用 gis_rank_change；需要展示占比结构时，主动调用 gis_render_pie_chart 画饼图；谈到某个村庄时，主动调用 gis_focus_map 聚焦；用户要求修改村庄备注时，调用 gis_update_land_note（真实落盘，会触发人工审批，被拒后如实告知）；用户提到"研究员"或要求核对/查证数据时，用 subagent 工具把核对任务委派给 researcher 并等它的结论再汇总；用户说明个人偏好或背景（如报告语言、面积单位）时，可调用 memory_write 记住，回答风格类问题先用 memory_search 查证；结论必须带具体数字（面积、百分比），用中文简洁作答。',
  ].join('\n'),
  tools: ['gis_query_land_types', 'gis_render_pie_chart', 'gis_focus_map', 'gis_update_land_note'],
  memory: { paths: true }, // M8：任务型 agent 开路径记忆（窄门控；M7 提取+召回同时保持开启）
})

app.agent('data-governance', {
  persona: [
    '你是"数据治理数字员工"，服务于一个国土 GIS 平台，负责引导用户完成数据上传、数据入库、数据清洗。',
    '规则：当前平台没有接入真实的外部数据源，不要假装已经上传或入库，而是给出可执行的引导与建议清单（坐标系纠偏 CGCS2000、字段名与地类编码标准化、拓扑检查、面积单位统一为平方米、重复图斑去重、属性空值补全）。回答用中文，条理清晰；用户问数据内容时可调用 gis_query_land_types 查询库内样例。',
  ].join('\n'),
  tools: ['gis_query_land_types'],
})

app.agent('report-writing', {
  persona: [
    '你是"专题写作数字员工"，服务于一个国土 GIS 平台，负责撰写结构化的专题分析报告。',
    '规则：写报告前必须先用 gis_query_land_types 查询真实数据，引用真实数字；报告按章节结构组织（背景、数据分析、结论建议等），每节有明确的小标题；成稿后必须调用 gis_write_report 把 {title, sections:[{heading, body}]} 落到平台工作区。',
  ].join('\n'),
  tools: ['gis_query_land_types', 'gis_focus_map', 'gis_write_report'],
})

// ── 子智能体：多智能体协作（M3） ─────────────────────────────────────────
// 只有 visibleTo 里的父 agent 看得到 subagent 委派工具；researcher 在自己的
// 独立会话里干活（父流推 loom/subagent-started，前端并屏直播父/子两条流）。
app.subagent('researcher', {
  persona: '数据核对研究员：只负责查证与核对，给结论配证据',
  tools: ['gis_query_land_types'],
  visibleTo: ['data-analysis'],
})

// ── 通道：webhook 入口（M3） ─────────────────────────────────────────────
// POST /~loom/hooks/demo（HMAC-SHA256 签名，见 .env 的 LOOM_WEBHOOK_SECRET，
// 缺省 whsec_loom_demo）→ map 成任务文本交给 data-analysis；同 topic 复用会话。
app.channel.webhook('/hooks/demo', {
  agent: 'data-analysis',
  map: payload => {
    const text = payload.text
    if (typeof text !== 'string' || text.trim() === '') throw new Error('payload.text 必须是非空字符串')
    return `【webhook】${text.trim()}`
  },
  secret: process.env.LOOM_WEBHOOK_SECRET ?? 'whsec_loom_demo',
  sessionKey: payload => (typeof payload.topic === 'string' && payload.topic.trim() !== '' ? payload.topic.trim() : 'default'),
})

// ── 策略：权力即声明（M2） ────────────────────────────────────────────────
// allow 放行 / deny 拒绝 / approve 走人工审批（SSE 审批卡片 + POST 答复，超时 5 分钟按拒绝——fail-closed）。
// 规则按声明顺序求值，后声明覆盖先声明；无命中取 default。
app.policy({
  default: 'allow',
  rules: [
    { tool: 'gis_update_*', effect: 'approve' }, // 真实落盘写：必须人工审批
    { tool: 'memory_forget', effect: 'approve' }, // M7：删除记忆属于破坏性写——人工审批
    { tool: 'gis_query_*', effect: 'allow' },    // 只读查询：放行
    // { tool: 'gis_*', effect: 'deny' },        // deny 示例（按需启用）
  ],
})

// ── 投影：会话事件 → 应用状态（init/apply 跑在浏览器） ─────────────────────

export interface WorkspaceTask { seq: number; title: string; name: string; status: 'running' | 'done' | 'error' }
export interface WorkspaceState {
  chart: { title: string; items: Array<{ name: string; value: number }> } | null
  focus: { region: string; reason?: string } | null
  report: { title: string; sections: Array<{ heading: string; body: string }> } | null
  tasks: WorkspaceTask[]
}

app.projection<WorkspaceState>('workspace', {
  init: { chart: null, focus: null, report: null, tasks: [] },
  apply(state, event) {
    // 投影事件是宽松载荷（[key: string]: unknown）：pick 做一次受控收窄。
    const fields = event as Record<string, unknown>
    const pick = <T,>(key: string): T | undefined => fields[key] as T | undefined
    switch (event.type) {
      case 'tool/call':
        return {
          ...state,
          tasks: [...state.tasks, { seq: event.seq, title: String(pick<{ title?: string }>('card')?.title ?? event.name), name: String(event.name), status: 'running' }],
        }
      case 'tool/result': {
        const callSeq = pick<number>('callSeq') ?? -1
        return {
          ...state,
          chart: event.name === 'gis_render_pie_chart' ? pick<NonNullable<WorkspaceState['chart']>>('value') ?? state.chart : state.chart,
          focus: event.name === 'gis_focus_map' ? pick<NonNullable<WorkspaceState['focus']>>('value') ?? state.focus : state.focus,
          report: event.name === 'gis_write_report' ? pick<NonNullable<WorkspaceState['report']>>('value') ?? state.report : state.report,
          tasks: state.tasks.map(task => (task.seq === callSeq ? { ...task, status: pick<boolean>('isError') === true ? 'error' : 'done' } : task)),
        }
      }
      default:
        return state
    }
  },
})

export default app

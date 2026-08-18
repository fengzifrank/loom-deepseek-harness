/**
 * GIS 平台前端：组装 @loom-sdk/web/react-ui 的通用组件（ChatStream / DebugPanel /
 * MultiAgentPanel / AuthPanel / SessionList / MemoryPanel）+ 本应用专属面板
 * （echarts 饼图、任务链、地图聚焦、报告），全部由 workspace 投影与会话 hooks
 * 驱动（init/apply 跑在浏览器）。M7：身份（匿名/登录）驱动会话列表与记忆面板。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts'
import { useAgentSession, useLoomAuth, useProjection, useSubagentStreams } from '@loom-sdk/web/react'
import { AuthPanel, ChatStream, DebugPanel, MemoryPanel, MultiAgentPanel, SessionList } from '@loom-sdk/web/react-ui'
import type { WorkspaceState } from '../loom.app'

const AGENTS = [
  { id: 'data-analysis', label: '数据分析' },
  { id: 'data-governance', label: '数据治理' },
  { id: 'report-writing', label: '专题报告' },
]

const SUGGESTIONS = '查询所有村庄的地类面积占比，画出饼图，聚焦最大村'
const APPROVAL_DEMO = '给连河村加备注：重点耕地保护区'
const SUBAGENT_DEMO = '让研究员核对连河村和太平河村的地类数据，然后汇总差异'
const MEMORY_DEMO = '请记住：我偏好中文报告，面积单位用万亩'

function ChartPanel({ chart }: { chart: WorkspaceState['chart'] }) {
  const ref = useRef<HTMLDivElement>(null)
  const echartsRef = useRef<echarts.ECharts | null>(null)
  useEffect(() => {
    if (ref.current !== null && echartsRef.current === null) echartsRef.current = echarts.init(ref.current)
    return () => {
      echartsRef.current?.dispose()
      echartsRef.current = null
    }
  }, [])
  useEffect(() => {
    const instance = echartsRef.current
    if (instance === null) return
    if (chart === null) {
      instance.clear()
      return
    }
    instance.setOption({
      backgroundColor: 'transparent',
      title: { text: chart.title, left: 'center', top: 4, textStyle: { color: '#dce3ec', fontSize: 13 } },
      tooltip: { trigger: 'item', formatter: '{b}: {c} ㎡ ({d}%)' },
      series: [{
        type: 'pie',
        radius: ['32%', '62%'],
        center: ['50%', '58%'],
        itemStyle: { borderColor: '#161b23', borderWidth: 2, borderRadius: 4 },
        label: { color: '#8a96a8', fontSize: 11 },
        data: chart.items,
      }],
    })
  }, [chart])
  return <div id="chart" ref={ref} />
}

export default function App() {
  const [agentId, setAgentId] = useState(AGENTS[0]!.id)
  const [draft, setDraft] = useState('')
  const auth = useLoomAuth()
  const identity = auth.identity
  const { sessionId, messages, status, error, send, decide, reset, attach } = useAgentSession(agentId, { identity })
  const workspace = useProjection<WorkspaceState>(sessionId, 'workspace', { identity })
  const subagentStreams = useSubagentStreams(sessionId, { identity })

  const focusVillage = useMemo(() => workspace?.focus?.region ?? null, [workspace])

  return (
    <div className="app">
      <header className="header">
        <h1>Loom · 国土 GIS 数字员工平台</h1>
        <span className="sub">deepseek-v4-flash · 声明式智能体（loom.app.ts）· 单命令 loom dev · 策略审批 + 回放调试 + webhook 与子智能体 + 多用户与记忆</span>
        <span className={`pill${status === 'idle' ? ' ok' : ''}`}>
          {status === 'busy' ? '思考中…' : status === 'connecting' ? '连接中…' : status === 'error' ? '出错' : '就绪'}
        </span>
        <AuthPanel auth={auth} compact />
      </header>

      <div className="main">
        <section className="panel chat">
          <div className="tabs">
            {AGENTS.map(agent => (
              <button key={agent.id} className={agent.id === agentId ? 'active' : ''} onClick={() => setAgentId(agent.id)}>
                {agent.label}
              </button>
            ))}
          </div>
          <div style={{ padding: '8px 0 2px' }}>
            <SessionList
              agentId={agentId}
              currentSessionId={sessionId}
              identity={identity}
              onSelect={sid => {
                if (sid !== sessionId) attach(sid)
              }}
              onNew={reset}
            />
          </div>
          <ChatStream
            messages={messages}
            decide={decide}
            streamCursor={status === 'busy'}
            placeholder={<>试试：{SUGGESTIONS}<br />审批演示：{APPROVAL_DEMO}（写库触发人工审批卡片）<br />多智能体：{SUBAGENT_DEMO}（右侧面板并屏直播父/子两条流）<br />记忆：{MEMORY_DEMO}（换新会话再问"我的报告偏好是什么"）</>}
          />
          {error !== null && <div className="placeholder" style={{ color: 'var(--err)' }}>{error}</div>}
          <div className="composer">
            <input
              value={draft}
              placeholder={SUGGESTIONS}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && draft.trim() !== '') {
                  send(draft)
                  setDraft('')
                }
              }}
            />
            <button
              disabled={draft.trim() === '' || status === 'busy' || status === 'connecting'}
              onClick={() => {
                send(draft)
                setDraft('')
              }}
            >
              发送
            </button>
          </div>
        </section>

        <div className="side">
          <MultiAgentPanel
            sessionId={sessionId}
            parentBusy={status === 'busy'}
            streams={subagentStreams}
            parentLabel="父 · data-analysis"
            hint={<>试试：「{SUBAGENT_DEMO}」——父会话委派 researcher 后，这里同屏直播两条流</>}
          />

          <section className="panel">
            <h2>任务链</h2>
            {workspace === null || workspace.tasks.length === 0 ? (
              <div className="placeholder">工具调用将按序出现在这里</div>
            ) : (
              <ul className="tasks">
                {workspace.tasks.map(task => (
                  <li key={task.seq} className={task.status}>
                    <span className="dot" />
                    <span>{task.title}</span>
                    <span className="name">{task.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <h2>图表面板</h2>
            <ChartPanel chart={workspace?.chart ?? null} />
          </section>

          <MemoryPanel identity={identity} />

          <DebugPanel
            sessionId={sessionId}
            projectionName="workspace"
            renderSnapshot={state => {
              const s = state as WorkspaceState
              return (
                <>
                  <ul className="tasks">
                    {(s?.tasks ?? []).map(task => (
                      <li key={task.seq} className={task.status}><span className="dot" /><span>{task.title}</span></li>
                    ))}
                    {(s?.tasks ?? []).length === 0 && <li><span className="dot" style={{ background: 'var(--line)' }} /><span className="placeholder">（无任务）</span></li>}
                  </ul>
                  <div className="placeholder" style={{ marginTop: 8 }}>
                    {s?.chart ? `饼图：${s.chart.title}（${s.chart.items.length} 扇区）` : '饼图：无'}
                    {' · '}
                    {s?.focus ? `聚焦：${s.focus.region}` : '聚焦：无'}
                  </div>
                </>
              )
            }}
          />

          <section className="panel" style={{ display: 'flex', flexDirection: 'column' }}>
            <h2>地图聚焦{focusVillage ? ` · ${focusVillage}` : ''}</h2>
            <div className="placeholder" style={{ marginBottom: 8 }}>
              {focusVillage
                ? `已聚焦${focusVillage}${workspace?.focus?.reason ? ` —— ${workspace.focus.reason}` : ''}`
                : '谈到某个村庄时，地图会聚焦并高亮（演示为村庄列表）'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {['连河村', '太平河村', '马河村', '李家村', '王家村', '赵庄村', '刘屯', '陈湾村'].map(village => (
                <span
                  key={village}
                  style={{
                    border: `1px solid ${village === focusVillage ? 'var(--accent)' : 'var(--line)'}`,
                    color: village === focusVillage ? 'var(--accent)' : 'var(--muted)',
                    borderRadius: 6, padding: '2px 10px', fontSize: 12,
                  }}
                >
                  {village}
                </span>
              ))}
            </div>
            {workspace?.report != null && (
              <>
                <h2 style={{ marginTop: 14 }}>报告工作区 · {workspace.report.title}</h2>
                <div className="report">
                  {workspace.report.sections.map(section => (
                    <div key={section.heading}>
                      <h4>{section.heading}</h4>
                      <p>{section.body}</p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

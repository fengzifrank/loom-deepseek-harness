/**
 * 老 ERP 对接助手前端（脚手架风格，极简）：聊天流（含工具卡片 + 审批卡，全部
 * 复用 @loom-sdk/web/react-ui）+ 顶部一行"接入方式"徽章 + 右侧任务链（workspace
 * 投影）与记忆面板。SSE 经 Vite 的 /~loom 同源代理直通 4640。
 */
import { useState } from 'react'
import { useAgentSession, useLoomAuth, useProjection } from '@loom-sdk/web/react'
import { ChatStream, MemoryPanel, SessionList } from '@loom-sdk/web/react-ui'
import type { WorkspaceState } from '../loom.app'

const SUGGEST = '查一下库存低于 10 的商品并给补货建议'
const ORDER_DEMO = '帮 C001 下单买 2 个轴承 D60'
const MOVEMENT_DEMO = '查一下轴承 D60 的库存流水'

const ROUTES = [
  { label: 'OpenAPI 导入 ×5', hint: '路 1：loom import-openapi 一键生成（erp_list/get_products、erp_list/get_customers、erp_orders_create）' },
  { label: '手写包装 ×1', hint: '路 2：库存流水接口没写进文档，手写 erp_stock_movements' },
  { label: '只读直连库 ×1', hint: '路 3：erp_db_stock_audit 用 node:sqlite readonly 打开 erp.db' },
]

export default function App() {
  const [draft, setDraft] = useState('')
  const auth = useLoomAuth()
  const identity = auth.identity
  const { sessionId, messages, status, error, send, decide, reset, attach } = useAgentSession('erp-assistant', { identity })
  const workspace = useProjection<WorkspaceState>(sessionId, 'workspace', { identity })

  const submit = () => {
    if (draft.trim() === '') return
    send(draft)
    setDraft('')
  }

  return (
    <div className="loom-app">
      <header className="loom-header">
        <h1>Loom · 老 ERP 对接助手</h1>
        <span className="loom-pill">{status === 'busy' ? '思考中…' : status === 'connecting' ? '连接中…' : status === 'error' ? '出错' : '就绪'}</span>
        <span className="loom-pill legacy">老系统 :4710</span>
        <span className="loom-auth"><button className="linkish" onClick={() => reset()}>新会话</button></span>
      </header>
      <div className="routes" title="本应用把 2018 年的老 ERP 三路接入 Loom">
        {ROUTES.map(route => <span key={route.label} className="route" title={route.hint}>{route.label}</span>)}
        <span className="route note">写操作（下单）→ 人工审批，全程可回放</span>
      </div>

      <div className="loom-main">
        <section className="chat-col">
          <SessionList
            agentId="erp-assistant"
            currentSessionId={sessionId}
            identity={identity}
            onSelect={sid => { if (sid !== sessionId) attach(sid) }}
            onNew={reset}
          />
          <ChatStream
            messages={messages}
            decide={decide}
            streamCursor={status === 'busy'}
            placeholder={<>试试：{SUGGEST}<br />下单（触发审批卡）：{ORDER_DEMO}<br />查流水（手写包装）：{MOVEMENT_DEMO}</>}
          />
          {error !== null && <div className="loom-error">{error}</div>}
          <div className="loom-composer">
            <input
              value={draft}
              placeholder={SUGGEST}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit() }}
            />
            <button disabled={draft.trim() === '' || status === 'busy' || status === 'connecting'} onClick={submit}>
              发送
            </button>
          </div>
        </section>

        <aside className="side-col">
          <section className="loom-panel">
            <h2>任务链</h2>
            {workspace === null || workspace.tasks.length === 0 ? (
              <div className="placeholder">工具调用将按序出现在这里（含审批结果）</div>
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
          <MemoryPanel identity={identity} />
        </aside>
      </div>
    </div>
  )
}

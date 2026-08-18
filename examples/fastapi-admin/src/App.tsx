/**
 * FastapiAdmin 老系统助手前端（脚手架风格，极简）：聊天流（含工具卡片 + 审批卡，
 * 全部复用 @loom-sdk/web/react-ui）+ 顶部"接入方式"徽章 + 右侧任务链（workspace
 * 投影）与记忆面板。SSE 经 Vite 的 /~loom 同源代理直通 4645。
 */
import { useState } from 'react'
import { useAgentSession, useLoomAuth, useProjection } from '@loom-sdk/web/react'
import { ChatStream, MemoryPanel, SessionList } from '@loom-sdk/web/react-ui'
import type { WorkspaceState } from '../loom.app'

const SUGGEST = '列出系统里的前 5 个用户'
const CREATE_DEMO = '创建用户 zhangsan_demo，昵称张三，角色普通用户，密码 Demo123456'
const ROLE_DEMO = '查一下系统里有哪些角色'

const ROUTES = [
  { label: '真实老系统：FastapiAdmin v3 · :8001', hint: 'FastAPI + SQLAlchemy + Redis 的开源企业后台（1.0k★），SQLite 模式原样运行，Loom 侧零改动' },
  { label: 'OpenAPI 导入 ×15', hint: '路 1：loom import-openapi 从活系统的 /openapi.json 生成（--include *system_user*，用户域 15 个 operation）' },
  { label: '登录桥 + 手写 ×2', hint: '路 2：JWT 认证——boot 时顶层 await 登录换 token；legacy_relogin（热刷新）/ legacy_roles_list（角色域补位）手写' },
]

export default function App() {
  const [draft, setDraft] = useState('')
  const auth = useLoomAuth()
  const identity = auth.identity
  const { sessionId, messages, status, error, send, decide, reset, attach } = useAgentSession('admin-assistant', { identity })
  const workspace = useProjection<WorkspaceState>(sessionId, 'workspace', { identity })

  const submit = () => {
    if (draft.trim() === '') return
    send(draft)
    setDraft('')
  }

  return (
    <div className="loom-app">
      <header className="loom-header">
        <h1>Loom · FastapiAdmin 老系统助手</h1>
        <span className="loom-pill">{status === 'busy' ? '思考中…' : status === 'connecting' ? '连接中…' : status === 'error' ? '出错' : '就绪'}</span>
        <span className="loom-pill legacy">真实老系统 :8001</span>
        <span className="loom-auth"><button className="linkish" onClick={() => reset()}>新会话</button></span>
      </header>
      <div className="routes" title="本应用把真实的 FastapiAdmin v3 老系统两路接入 Loom">
        {ROUTES.map(route => <span key={route.label} className="route" title={route.hint}>{route.label}</span>)}
        <span className="route note">创建/修改/删除用户 → 人工审批，全程可回放</span>
      </div>

      <div className="loom-main">
        <section className="chat-col">
          <SessionList
            agentId="admin-assistant"
            currentSessionId={sessionId}
            identity={identity}
            onSelect={sid => { if (sid !== sessionId) attach(sid) }}
            onNew={reset}
          />
          <ChatStream
            messages={messages}
            decide={decide}
            streamCursor={status === 'busy'}
            placeholder={<>试试：{SUGGEST}<br />建用户（触发审批卡）：{CREATE_DEMO}<br />查角色（手写包装）：{ROLE_DEMO}</>}
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

/**
 * Loom UI 组件库（'@loom-sdk/web/react-ui' 子路径导出）。
 *
 * 从 examples/gis 的 App.tsx 抽出的通用组件，全部 props 驱动（数据来自
 * useAgentSession / useProjection / useSubagentStreams，组件不自取会话状态），
 * 颜色一律走 CSS 变量（--bg/--panel/--panel-2/--line/--text/--muted/--accent/
 * --ok/--err），不写死主题。结构样式内联，app 可用 className 覆盖。
 *
 * - ChatStream：文本+工具卡+审批卡混合流，流式光标，自动滚底。
 * - ToolCard / ApprovalCard：单卡（也被 ChatStream 内部使用）。
 * - DebugPanel：事件列表 + seq 滑块 + 此刻投影快照 + 从此点分叉（回放调试）。
 * - MultiAgentPanel：父/子双活动流（子流由 useSubagentStreams 喂数据）。
 * @module @loom-sdk/web/react-ui
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { LoomApproval, LoomMessage, LoomSubagentStream, LoomToolCard } from '../react.js'

/** 默认 API 前缀（与 react.ts 的 DEFAULT_API_BASE 同值；vite 场景经同源代理）。 */
const DEFAULT_API_BASE = '/~loom'

/** 组件通用 props（className 透传覆盖样式）。 */
export interface LoomUiProps {
  className?: string
}

// ---------------------------------------------------------------------------
// ToolCard / ApprovalCard
// ---------------------------------------------------------------------------

/** 工具卡片：运行中/完成/失败 三态 + 参数/结果预览。 */
export function ToolCard({ card, className }: { card: LoomToolCard } & LoomUiProps): ReactNode {
  const state = card.isError ? 'error' : card.done ? 'done' : 'running'
  const stateText = state === 'running' ? '运行中…' : state === 'done' ? '完成' : '失败'
  const borderColor = state === 'error' ? 'var(--err)' : state === 'done' ? 'var(--ok)' : 'var(--line)'
  return (
    <div
      className={`loom-card${className === undefined ? '' : ` ${className}`}`}
      style={{ border: `1px solid ${borderColor}`, borderRadius: 8, padding: '8px 10px', background: 'var(--panel)', margin: '6px 0' }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
        <span
          style={{ fontSize: 12, color: state === 'error' ? 'var(--err)' : state === 'done' ? 'var(--ok)' : 'var(--accent)', flexShrink: 0 }}
        >
          {stateText}
        </span>
        <span style={{ fontWeight: 600 }}>{card.title}</span>
      </div>
      <pre style={{ margin: 0, fontSize: 12, color: 'var(--muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {card.preview ?? JSON.stringify(card.args ?? {}, null, 2)}
      </pre>
    </div>
  )
}

/** 审批卡片：pending 显示允许/拒绝按钮；终态显示结果。 */
export function ApprovalCard({
  approval,
  decide,
  className,
}: { approval: LoomApproval; decide: (id: string, decision: 'allowed-once' | 'rejected') => void } & LoomUiProps): ReactNode {
  const decided = approval.status !== 'pending'
  const statusText = decided
    ? approval.status === 'allowed-once'
      ? '已允许'
      : approval.status === 'rejected'
        ? '已拒绝'
        : approval.status
    : '等待审批…'
  return (
    <div
      className={`loom-approval${className === undefined ? '' : ` ${className}`}`}
      style={{
        border: `1px solid ${decided ? 'var(--line)' : 'var(--accent)'}`,
        borderRadius: 8,
        padding: '8px 10px',
        background: 'var(--panel-2, var(--panel))',
        margin: '6px 0',
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: decided ? 'var(--muted)' : 'var(--accent)' }}>{statusText}</span>
        <span style={{ fontWeight: 600 }}>人工审批 · {approval.tool}</span>
      </div>
      <pre style={{ margin: 0, fontSize: 12, color: 'var(--muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {approval.argsPreview ?? '(无参数预览)'}
      </pre>
      {!decided && (
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button
            className="loom-approval-allow"
            style={{ border: 'none', borderRadius: 6, padding: '4px 14px', background: 'var(--ok)', color: '#fff', cursor: 'pointer' }}
            onClick={() => decide(approval.approvalId, 'allowed-once')}
          >
            允许
          </button>
          <button
            className="loom-approval-reject"
            style={{ border: 'none', borderRadius: 6, padding: '4px 14px', background: 'var(--err)', color: '#fff', cursor: 'pointer' }}
            onClick={() => decide(approval.approvalId, 'rejected')}
          >
            拒绝
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ChatStream
// ---------------------------------------------------------------------------

/** 单条消息（文本 + 工具卡 + 审批卡）。 */
function MessageItem({ message, decide }: { message: LoomMessage; decide: (id: string, d: 'allowed-once' | 'rejected') => void }): ReactNode {
  const empty = message.role === 'assistant' && message.text === '' && message.toolCards.length === 0 && (message.approvals ?? []).length === 0
  if (empty) return null
  return (
    <>
      {message.text !== '' && (
        <div
          className={`loom-msg ${message.role}`}
          style={{
            alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
            background: message.role === 'user' ? 'var(--panel-2, var(--panel))' : 'transparent',
            border: `1px solid ${message.role === 'user' ? 'var(--line)' : 'transparent'}`,
            borderRadius: 10,
            padding: message.role === 'user' ? '6px 12px' : '2px 0',
            maxWidth: '92%',
            whiteSpace: 'pre-wrap',
          }}
        >
          {message.text}
        </div>
      )}
      {message.toolCards.map(card => (
        <ToolCard key={card.seq} card={card} />
      ))}
      {(message.approvals ?? []).map(approval => (
        <ApprovalCard key={approval.approvalId} approval={approval} decide={decide} />
      ))}
    </>
  )
}

/** ChatStream props。 */
export interface ChatStreamProps extends LoomUiProps {
  /** useAgentSession 的 messages。 */
  messages: LoomMessage[]
  /** useAgentSession 的 decide（审批答复；缺省审批卡只读）。 */
  decide?: (id: string, decision: 'allowed-once' | 'rejected') => void
  /** true 时最后一条 assistant 消息尾部显示流式光标（busy 期间）。 */
  streamCursor?: boolean
  /** 空流占位提示。 */
  placeholder?: ReactNode
  /** 容器高度（默认撑满父级）。 */
  height?: CSSProperties['height']
}

/** 聊天流：文本 + 工具卡 + 审批卡混合渲染，流式光标，自动滚底。 */
export function ChatStream({ messages, decide, streamCursor = false, placeholder, height = '100%', className }: ChatStreamProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [messages, streamCursor])
  const noop = useCallback(() => undefined, [])
  return (
    <div
      ref={ref}
      className={`loom-chat-stream${className === undefined ? '' : ` ${className}`}`}
      style={{ height, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 2px' }}
    >
      {messages.length === 0 && placeholder !== undefined && (
        <div style={{ color: 'var(--muted)', fontSize: 13, padding: '12px 4px' }}>{placeholder}</div>
      )}
      {messages.map((message, index) => (
        <MessageItem key={index} message={message} decide={decide ?? noop} />
      ))}
      {streamCursor && (
        <span className="loom-cursor" style={{ color: 'var(--accent)', fontSize: 13, alignSelf: 'flex-start' }}>
          ▍
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// DebugPanel（回放调试）
// ---------------------------------------------------------------------------

/** DebugPanel 拉到的事件（宽松载荷；seq 是唯一顺序权威）。 */
export interface LoomDebugEvent {
  seq?: number
  type: string
  name?: string
  [key: string]: unknown
}

/** DebugPanel props。 */
export interface DebugPanelProps extends LoomUiProps {
  /** 目标会话（useAgentSession 的 sessionId；分叉后切到子会话）。 */
  sessionId: string | null
  /** 投影名（滑块快照按该投影的 init/apply 折叠，规格经 /projections/:name 下发）。 */
  projectionName: string
  /** 快照渲染（默认渲染 JSON 预览）。 */
  renderSnapshot?: (state: unknown) => ReactNode
  /** API 前缀（默认 /~loom）。 */
  apiBase?: string
  /** 面板标题。 */
  title?: ReactNode
}

/** 有界区间读全量事件（?since&to 的 SSE 服务端读完即收）。 */
async function readEventRange(apiBase: string, sessionId: string, since = -1, to = 1_000_000_000): Promise<LoomDebugEvent[]> {
  const res = await fetch(`${apiBase}/sessions/${encodeURIComponent(sessionId)}/events?since=${since}&to=${to}`)
  if (!res.ok) throw new Error(`读取事件流失败（${res.status}）`)
  const text = await res.text()
  const events: LoomDebugEvent[] = []
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data: ')) continue
      try {
        const payload = JSON.parse(line.slice(6)) as LoomDebugEvent
        if (payload.type !== 'loom/replay-end') events.push(payload)
      } catch {
        /* 心跳/非 JSON 行忽略 */
      }
    }
  }
  return events
}

interface ProjectionSpecDto { init: unknown; apply: string }

/**
 * 回放调试面板：事件列表 + seq 滑块 + 此刻投影快照 + 从此点分叉。
 * 事件与投影规格由面板自取（fetch 有界区间；这是它的本职），会话状态仍由 props 给。
 */
export function DebugPanel({
  sessionId,
  projectionName,
  renderSnapshot,
  apiBase = DEFAULT_API_BASE,
  title = '回放调试',
  className,
}: DebugPanelProps): ReactNode {
  const [viewSessionId, setViewSessionId] = useState<string | null>(sessionId)
  const [events, setEvents] = useState<LoomDebugEvent[]>([])
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [applySrc, setApplySrc] = useState<string | null>(null)
  const [init, setInit] = useState<unknown>(null)

  useEffect(() => { setViewSessionId(sessionId) }, [sessionId])

  const refresh = useCallback(async () => {
    const sid = viewSessionId
    if (sid === null) return
    try {
      const list = await readEventRange(apiBase, sid)
      setEvents(list)
      setCursor(list.reduce((max, e) => Math.max(max, typeof e.seq === 'number' ? e.seq : max), 0))
      setNote(null)
    } catch (error) {
      setNote(String(error))
    }
  }, [viewSessionId, apiBase])

  useEffect(() => {
    if (viewSessionId === null) return
    void refresh()
  }, [refresh, viewSessionId])

  useEffect(() => {
    void fetch(`${apiBase}/projections/${encodeURIComponent(projectionName)}`)
      .then(async res => {
        if (!res.ok) throw new Error(`投影 "${projectionName}" 不可用（${res.status}）`)
        return await res.json() as ProjectionSpecDto
      })
      .then(
        spec => {
          setApplySrc(spec.apply)
          setInit(spec.init)
        },
        error => setNote(String(error)),
      )
  }, [projectionName, apiBase])

  // 滑块选任意 seq → 把 events ≤ seq 折叠进投影（与 useProjection 同一折叠逻辑）。
  const folded = useMemo<unknown>(() => {
    if (applySrc === null || events.length === 0) return null
    const fold = new Function('state', 'event', `return (${applySrc})(state, event)`) as (state: unknown, event: LoomDebugEvent) => unknown
    let state = init
    for (const e of events) {
      if (typeof e.seq === 'number' && e.seq <= cursor) state = fold(state, e)
    }
    return state
  }, [events, cursor, applySrc, init])

  const maxSeq = events.reduce((max, e) => Math.max(max, typeof e.seq === 'number' ? e.seq : max), 0)

  const forkHere = async () => {
    const sid = viewSessionId
    if (sid === null) return
    try {
      const res = await fetch(`${apiBase}/sessions/${encodeURIComponent(sid)}/fork`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ atSeq: cursor }),
      })
      const json = (await res.json().catch(() => ({}))) as { sessionId?: string; error?: string }
      if (!res.ok || json.sessionId === undefined) throw new Error(json.error ?? `${res.status}`)
      setViewSessionId(json.sessionId)
      setNote(`已从 @seq=${cursor} 分叉 → ${json.sessionId}（前缀事件一致；分叉会话为只读回放视图）`)
    } catch (error) {
      setNote(`分叉失败：${String(error)}`)
    }
  }

  return (
    <section className={`loom-panel loom-debug${className === undefined ? '' : ` ${className}`}`} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, background: 'var(--panel)' }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>
        {title}
        {viewSessionId !== null && sessionId !== null && viewSessionId !== sessionId ? ' · 分叉视图' : ''}
      </h2>
      {viewSessionId === null ? (
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>发起一次对话后，这里可以拖动到任意时刻查看投影状态，并从该点分叉</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="range" min={0} max={maxSeq} value={Math.min(cursor, maxSeq)} onChange={e => setCursor(Number(e.target.value))} style={{ flex: 1, minWidth: 120 }} />
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>seq ≤ {Math.min(cursor, maxSeq)} / {maxSeq}</span>
            <button onClick={() => void refresh()} style={{ ...btnStyle, background: 'var(--panel-2, var(--panel))', color: 'var(--text)' }}>刷新</button>
            <button onClick={() => void forkHere()} disabled={maxSeq === 0} style={{ ...btnStyle, background: 'var(--accent)' }}>从此点分叉</button>
          </div>
          {note !== null && <div style={{ color: 'var(--accent)', fontSize: 12, marginTop: 6 }}>{note}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) minmax(140px, 1fr)', gap: 8, marginTop: 8 }}>
            <div style={{ maxHeight: 180, overflowY: 'auto', fontSize: 12 }}>
              {events.filter(e => typeof e.seq === 'number' && e.seq <= cursor).slice(-40).map(e => (
                <div key={e.seq} style={{ display: 'flex', gap: 6, padding: '1px 0', color: e.seq === Math.min(cursor, maxSeq) ? 'var(--accent)' : 'var(--muted)' }}>
                  <span>{e.seq}</span>
                  <span>{e.type}</span>
                  <span>{String(e.name ?? '')}</span>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12 }}>
              <div style={{ color: 'var(--muted)', marginBottom: 4 }}>此刻的 {projectionName} 状态</div>
              {renderSnapshot !== undefined && folded !== null
                ? renderSnapshot(folded)
                : (
                  <pre style={{ margin: 0, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 150, overflowY: 'auto' }}>
                    {folded === null ? '（无事件）' : JSON.stringify(folded, null, 1)}
                  </pre>
                )}
            </div>
          </div>
        </>
      )}
    </section>
  )
}

const btnStyle: CSSProperties = {
  border: 'none',
  borderRadius: 6,
  padding: '4px 12px',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 12,
}

// ---------------------------------------------------------------------------
// MultiAgentPanel（父/子双流）
// ---------------------------------------------------------------------------

/** 单条子活动流（折叠头 + 迷你聊天流）。 */
function SubagentStreamItem({ stream }: { stream: LoomSubagentStream }): ReactNode {
  const [expanded, setExpanded] = useState(true)
  useEffect(() => {
    if (stream.status !== 'running') setExpanded(false)
  }, [stream.status])
  const toolCount = stream.messages.reduce((sum, message) => sum + message.toolCards.length, 0)
  const lastText = [...stream.messages].reverse().find(message => message.role === 'assistant' && message.text !== '')?.text ?? ''
  const stateColor = stream.status === 'running' ? 'var(--accent)' : stream.status === 'done' ? 'var(--ok)' : 'var(--err)'
  return (
    <div
      className={`loom-subagent-stream ${stream.status}`}
      style={{ border: `1px solid ${stateColor}`, borderRadius: 8, padding: 8, background: 'var(--panel)' }}
    >
      <button
        className="loom-subagent-head"
        onClick={() => setExpanded(value => !value)}
        style={{ display: 'flex', gap: 8, alignItems: 'baseline', width: '100%', background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', textAlign: 'left', padding: 0 }}
      >
        <span style={{ fontSize: 12, color: stateColor, flexShrink: 0 }}>
          {stream.status === 'running' ? '工作中…' : stream.status === 'done' ? '完成' : '失败'}
        </span>
        <span style={{ fontWeight: 600 }}>子智能体 · {stream.spec}</span>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>
          {toolCount > 0 ? `${toolCount} 次工具` : ''}{stream.status !== 'running' && lastText !== '' ? ' · 已回报' : ''}
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--muted)' }}>{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 6, maxHeight: 220, overflowY: 'auto' }}>
          {stream.messages.map((message, index) => (
            <MessageItem key={index} message={message} decide={() => undefined} />
          ))}
          {stream.messages.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 12 }}>子会话启动中…</div>}
          {stream.status === 'error' && (
            <div style={{ color: 'var(--err)', fontSize: 12 }}>stopReason: {stream.stopReason ?? 'error'}</div>
          )}
        </div>
      )}
    </div>
  )
}

/** MultiAgentPanel props。 */
export interface MultiAgentPanelProps extends LoomUiProps {
  /** 父会话 id（仅用于显示"父 lane"标识）。 */
  sessionId: string | null
  /** 父 turn 是否进行中。 */
  parentBusy: boolean
  /** useSubagentStreams 的子流数据。 */
  streams: LoomSubagentStream[]
  /** 父 lane 标签（如 "父 · data-analysis"）。 */
  parentLabel?: string
  /** 空态提示。 */
  hint?: ReactNode
  /** 面板标题。 */
  title?: ReactNode
}

/** 多智能体面板：父 lane + 每个子会话一条直播流（完成后回落折叠，可再展开）。 */
export function MultiAgentPanel({
  sessionId,
  parentBusy,
  streams,
  parentLabel = '父会话',
  hint,
  title = '多智能体',
  className,
}: MultiAgentPanelProps): ReactNode {
  const running = streams.some(stream => stream.status === 'running')
  const badge = running ? '子会话直播中…' : parentBusy ? '父会话工作中…' : streams.length > 0 ? `已结束 ${streams.length}` : '空闲'
  const badgeColor = !running && !parentBusy ? 'var(--ok)' : 'var(--muted)'
  return (
    <section className={`loom-panel loom-multiagent${className === undefined ? '' : ` ${className}`}`} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, background: 'var(--panel)' }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
        {title}
        <span className="loom-pill" style={{ border: '1px solid var(--line)', borderRadius: 999, padding: '1px 10px', fontSize: 12, color: badgeColor }}>{badge}</span>
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div
          className="loom-agent-lane"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            border: `1px solid ${parentBusy ? 'var(--accent)' : 'var(--line)'}`,
            borderRadius: 8,
            padding: '6px 10px',
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          <span>{parentLabel}{sessionId === null ? '' : ''}</span>
          <span>{parentBusy ? 'turn 进行中' : '空闲'}</span>
        </div>
        {streams.map(stream => (
          <SubagentStreamItem key={stream.childSessionId} stream={stream} />
        ))}
        {streams.length === 0 && (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>{hint ?? '父会话委派子智能体后，这里同屏直播两条流'}</div>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// AuthPanel（M7 多用户）：登录/注册/当前身份显示
// ---------------------------------------------------------------------------

/** AuthPanel props：useLoomAuth 的结果（数据与动作均由 hook 提供）。 */
export interface AuthPanelProps extends LoomUiProps {
  /** useLoomAuth() 的返回值。 */
  auth: {
    identity: { userId: string; kind: 'anon' | 'local'; username?: string } | null
    login: (username: string, password: string) => Promise<void>
    register: (username: string, password: string) => Promise<void>
    logout: () => void
    error: string | null
    busy: boolean
  }
  /** 紧凑形态（放 header 用：只显示身份 + 弹出表单）。 */
  compact?: boolean
}

/** 认证面板：当前身份徽标 + 登录/注册表单 + 登出。 */
export function AuthPanel({ auth, compact = false, className }: AuthPanelProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const identity = auth.identity
  const submit = (): void => {
    const action = mode === 'login' ? auth.login : auth.register
    void action(username.trim(), password).then(
      () => {
        setOpen(false)
        setPassword('')
      },
      () => undefined, // 错误显示在 auth.error
    )
  }
  return (
    <div className={`loom-auth${className === undefined ? '' : ` ${className}`}`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {identity === null ? (
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>身份加载中…</span>
      ) : (
        <span
          className="loom-auth-badge"
          style={{
            border: `1px solid ${identity.kind === 'local' ? 'var(--ok)' : 'var(--line)'}`,
            borderRadius: 999,
            padding: '2px 10px',
            fontSize: 12,
            color: identity.kind === 'local' ? 'var(--ok)' : 'var(--muted)',
            whiteSpace: 'nowrap',
          }}
          title={identity.userId}
        >
          {identity.kind === 'local' ? `👤 ${identity.username ?? identity.userId}` : `匿名 ${identity.userId.slice(5, 13)}…`}
        </span>
      )}
      {identity?.kind === 'local' ? (
        <button className="loom-auth-logout" style={{ ...btnStyle, background: 'var(--panel-2, var(--panel))', color: 'var(--text)' }} onClick={auth.logout}>
          登出
        </button>
      ) : (
        <button className="loom-auth-toggle" style={{ ...btnStyle, background: 'var(--panel-2, var(--panel))', color: 'var(--text)' }} onClick={() => setOpen(value => !value)}>
          {open ? '取消' : '登录 / 注册'}
        </button>
      )}
      {open && (
        <div
          className="loom-auth-form"
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            flexWrap: 'wrap',
            ...(compact ? {} : { flexDirection: 'column', alignItems: 'stretch' }),
          }}
        >
          <input
            className="loom-auth-username"
            style={inputStyle}
            placeholder="用户名（3-32 字符）"
            value={username}
            onChange={e => setUsername(e.target.value)}
          />
          <input
            className="loom-auth-password"
            style={inputStyle}
            type="password"
            placeholder="密码（≥8 字符）"
            value={password}
            onKeyDown={e => {
              if (e.key === 'Enter') submit()
            }}
            onChange={e => setPassword(e.target.value)}
          />
          <button
            className="loom-auth-submit"
            style={{ ...btnStyle, background: 'var(--accent)' }}
            disabled={auth.busy || username.trim() === '' || password === ''}
            onClick={submit}
          >
            {mode === 'login' ? '登录' : '注册并登录'}
          </button>
          <button
            className="loom-auth-mode"
            style={{ border: 'none', background: 'none', color: 'var(--muted)', fontSize: 12, cursor: 'pointer', padding: '4px 2px' }}
            onClick={() => setMode(value => (value === 'login' ? 'register' : 'login'))}
          >
            {mode === 'login' ? '没有账号？注册' : '已有账号？登录'}
          </button>
        </div>
      )}
      {auth.error !== null && <span className="loom-auth-error" style={{ color: 'var(--err)', fontSize: 12 }}>{auth.error}</span>}
    </div>
  )
}

const inputStyle: CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 6,
  padding: '4px 8px',
  background: 'var(--bg, transparent)',
  color: 'var(--text)',
  fontSize: 12,
  minWidth: 110,
}

// ---------------------------------------------------------------------------
// SessionList（M7 会话持久化）：列表 / 点击继续 / 新建
// ---------------------------------------------------------------------------

/** 会话列表条目（GET /agents/:id/sessions 的返回行）。 */
export interface LoomSessionSummary {
  sessionId: string
  title: string
  createdAt: string
  updatedAt: string
  kind?: string
}

/** SessionList props。 */
export interface SessionListProps extends LoomUiProps {
  /** 目标 agent id。 */
  agentId: string
  /** 当前会话（高亮；null = 尚无）。 */
  currentSessionId: string | null
  /** 点击一条会话继续（app 侧调 useAgentSession 的切换逻辑）。 */
  onSelect: (sessionId: string) => void
  /** 新建会话（调 hook 的 reset）。 */
  onNew: () => void
  /** 身份（useLoomAuth 的 identity；决定列谁的会话）。 */
  identity?: { userId: string; kind: 'anon' | 'local'; username?: string; token?: string } | null
  /** API 前缀（默认 /~loom）。 */
  apiBase?: string
  /** 标题。 */
  title?: ReactNode
}

/** 会话列表：该 agent 在服务端的会话（sidecar 索引），点击继续、按钮新建。 */
export function SessionList({
  agentId,
  currentSessionId,
  onSelect,
  onNew,
  identity,
  apiBase = DEFAULT_API_BASE,
  title = '会话',
  className,
}: SessionListProps): ReactNode {
  const [sessions, setSessions] = useState<LoomSessionSummary[]>([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const userId = identity?.userId ?? null

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const headers: Record<string, string> = {}
      if (identity?.token !== undefined) headers.authorization = `Bearer ${identity.token}`
      else if (identity !== null && identity !== undefined) headers['x-loom-user'] = identity.userId
      const res = await fetch(`${apiBase}/agents/${encodeURIComponent(agentId)}/sessions`, { headers })
      if (!res.ok) throw new Error(`${res.status}`)
      const body = (await res.json()) as { sessions?: LoomSessionSummary[] }
      setSessions(body.sessions ?? [])
      setError(null)
    } catch (err) {
      setError(String(err))
    }
  }, [agentId, apiBase, identity])

  useEffect(() => {
    void refresh()
  }, [refresh, userId])

  return (
    <div className={`loom-session-list${className === undefined ? '' : ` ${className}`}`} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          className="loom-session-toggle"
          onClick={() => {
            setOpen(value => !value)
            if (!open) void refresh()
          }}
          style={{ ...btnStyle, background: 'var(--panel-2, var(--panel))', color: 'var(--text)' }}
        >
          {title}{open ? ' ▴' : ` （${sessions.length}）▾`}
        </button>
        <button className="loom-session-new" style={{ ...btnStyle, background: 'var(--accent)' }} onClick={onNew}>
          新建会话
        </button>
      </div>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
          {error !== null && <span style={{ color: 'var(--err)', fontSize: 12 }}>{error}</span>}
          {sessions.length === 0 && error === null && <span style={{ color: 'var(--muted)', fontSize: 12 }}>还没有会话——发第一条消息即建</span>}
          {sessions.map(session => {
            const active = session.sessionId === currentSessionId
            return (
              <button
                key={session.sessionId}
                className={`loom-session-item${active ? ' active' : ''}`}
                onClick={() => onSelect(session.sessionId)}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                  textAlign: 'left',
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
                  borderRadius: 6,
                  padding: '4px 8px',
                  background: 'var(--panel-2, var(--panel))',
                  color: active ? 'var(--accent)' : 'var(--text)',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {session.kind === 'fork' ? '⑂ ' : ''}{session.title}
                </span>
                <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{new Date(session.updatedAt).toLocaleString()}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// MemoryPanel（M7 loom memory）：搜索 / 列表 / 编辑 / 删除
// ---------------------------------------------------------------------------

/** 记忆条目（GET /~loom/memories 的返回行）。 */
export interface LoomMemoryItem {
  id: string
  kind: string
  content: string
  sourceSession?: string | null
  /** M8：置信度（path 衰减/重验回写会变；其余类别恒 1）。 */
  confidence?: number
  /** M8：最近一次重验时间（path 专用；null = 从未重验/非 path）。 */
  verifiedAt?: string | null
  createdAt: string
  updatedAt: string
}

/** MemoryPanel props。 */
export interface MemoryPanelProps extends LoomUiProps {
  /** 身份（useLoomAuth 的 identity；记忆按用户隔离）。 */
  identity?: { userId: string; kind: 'anon' | 'local'; username?: string; token?: string } | null
  /** API 前缀（默认 /~loom）。 */
  apiBase?: string
  /** 面板标题。 */
  title?: ReactNode
}

/** 记忆面板：搜索框 + 条目列表 + 行内编辑 + 删除（深色风格走 CSS 变量）。 */
export function MemoryPanel({ identity, apiBase = DEFAULT_API_BASE, title = '记忆', className }: MemoryPanelProps): ReactNode {
  const [memories, setMemories] = useState<LoomMemoryItem[]>([])
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const userId = identity?.userId ?? null

  const headers = useCallback((): Record<string, string> => {
    if (identity?.token !== undefined) return { authorization: `Bearer ${identity.token}` }
    if (identity !== null && identity !== undefined) return { 'x-loom-user': identity.userId }
    return {}
  }, [identity])

  const refresh = useCallback(async (searchQuery: string): Promise<void> => {
    try {
      const url = searchQuery.trim() === ''
        ? `${apiBase}/memories`
        : `${apiBase}/memories?query=${encodeURIComponent(searchQuery.trim())}`
      const res = await fetch(url, { headers: headers() })
      if (!res.ok) throw new Error(`${res.status}`)
      const body = (await res.json()) as { memories?: LoomMemoryItem[] }
      setMemories(body.memories ?? [])
      setNote(null)
    } catch (err) {
      setNote(String(err))
    }
  }, [apiBase, headers])

  useEffect(() => {
    void refresh('')
  }, [refresh, userId])

  const save = async (id: string): Promise<void> => {
    try {
      const res = await fetch(`${apiBase}/memories/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...headers() },
        body: JSON.stringify({ content: draft }),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      setEditingId(null)
      await refresh(query)
    } catch (err) {
      setNote(`保存失败：${String(err)}`)
    }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      const res = await fetch(`${apiBase}/memories/${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers() })
      if (!res.ok) throw new Error(`${res.status}`)
      await refresh(query)
    } catch (err) {
      setNote(`删除失败：${String(err)}`)
    }
  }

  return (
    <section className={`loom-panel loom-memory${className === undefined ? '' : ` ${className}`}`} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, background: 'var(--panel)' }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>{title}</h2>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input
          className="loom-memory-query"
          style={{ ...inputStyle, minWidth: 0, flex: 1 }}
          placeholder="搜索记忆（支持中文子串）"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') void refresh(query)
          }}
        />
        <button className="loom-memory-search" style={{ ...btnStyle, background: 'var(--panel-2, var(--panel))', color: 'var(--text)' }} onClick={() => void refresh(query)}>
          搜索
        </button>
      </div>
      {note !== null && <div style={{ color: 'var(--err)', fontSize: 12, marginBottom: 6 }}>{note}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
        {memories.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 12 }}>暂无记忆（开启提取或用 memory_write 工具写入）</div>}
        {memories.map(memory => (
          <div
            key={memory.id}
            className="loom-memory-item"
            style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '6px 8px', background: 'var(--panel-2, var(--panel))' }}
          >
            <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginBottom: 4 }}>
              <span
                className="loom-memory-kind"
                style={{
                  fontSize: 11,
                  borderRadius: 4,
                  padding: '1px 6px',
                  border: '1px solid var(--line)',
                  color: 'var(--muted)',
                  flexShrink: 0,
                }}
              >
                {memory.kind}
              </span>
              {memory.kind === 'path' && memory.confidence !== undefined && (
                <span
                  className="loom-memory-path-meta"
                  style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}
                  title="路径记忆（M8）：置信度随重验衰减/回升；verified_at 是最近一次重验时间"
                >
                  置信度 {memory.confidence.toFixed(2)} · {memory.verifiedAt === null || memory.verifiedAt === undefined ? '未重验' : `重验于 ${memory.verifiedAt.slice(0, 10)}`}
                </span>
              )}
              {editingId === memory.id ? (
                <>
                  <input className="loom-memory-edit" style={{ ...inputStyle, minWidth: 0, flex: 1 }} value={draft} onChange={e => setDraft(e.target.value)} />
                  <button className="loom-memory-save" style={{ ...btnStyle, background: 'var(--ok)' }} onClick={() => void save(memory.id)}>保存</button>
                  <button className="loom-memory-cancel" style={{ ...btnStyle, background: 'var(--panel)', color: 'var(--text)' }} onClick={() => setEditingId(null)}>取消</button>
                </>
              ) : (
                <>
                  <span style={{ fontSize: 12, color: 'var(--text)', flex: 1, wordBreak: 'break-all' }}>{memory.content}</span>
                  <button
                    className="loom-memory-edit-btn"
                    style={{ border: 'none', background: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 12, flexShrink: 0 }}
                    onClick={() => {
                      setEditingId(memory.id)
                      setDraft(memory.content)
                    }}
                  >
                    编辑
                  </button>
                  <button
                    className="loom-memory-delete"
                    style={{ border: 'none', background: 'none', color: 'var(--err)', cursor: 'pointer', fontSize: 12, flexShrink: 0 }}
                    onClick={() => void remove(memory.id)}
                  >
                    删除
                  </button>
                </>
              )}
            </div>
            {memory.sourceSession !== null && memory.sourceSession !== undefined && (
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>来源会话 …{memory.sourceSession.slice(-8)}</div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

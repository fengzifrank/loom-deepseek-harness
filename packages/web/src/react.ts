/**
 * Loom React hooks（'@loom-sdk/web/react' 子路径导出）。
 *
 * - useAgentSession(agentId)：懒建会话、send、messages（文本+工具卡片）、status；
 *   M7 起支持会话持久化（localStorage 键 loom:session:<userId>:<agentId>——
 *   挂载时有存档会话则直接连接并全量重放 foldEvent 重建消息）与身份头。
 * - useLoomAuth()：匿名 UUID 自动生成 / 注册 / 登录 / me（token 存 localStorage）。
 * - useProjection(sessionId, name)：客户端折叠——init/apply 跑在浏览器
 *   （apply 以源码经 GET /projections/:name 下发，new Function 重建；
 *   纯函数约束由投影作者保证）。
 * - useSubagentStreams(sessionId)：父流 loom/subagent-* → 自动并屏父/子两条活动流。
 *
 * 传输：fetch + EventSource（原生重连；这里手动 close→按 since 重连，
 * 避免固定 URL 全量重放）。EventSource 不能带自定义头——SSE 的身份经
 * ?token=/?user= query 参数等价传递（服务端同权解析）。零第三方依赖。
 * @module @loom-sdk/web/react
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectionEvent } from './types.js'

/** 默认 API 前缀（vite 场景经同源代理转发到 loom dev）。 */
export const DEFAULT_API_BASE = '/~loom'

// ---------------------------------------------------------------------------
// 身份（M7）：localStorage 持久化 + 请求头/SSE query 装配
// ---------------------------------------------------------------------------

/** 当前身份（匿名 UUID 或本地账号 token）。 */
export interface LoomAuthState {
  userId: string
  kind: 'anon' | 'local'
  username?: string
  token?: string
}

/** 身份存储键（当前身份 JSON）；匿名底座 UUID 独立存放（登出回落）。 */
const AUTH_STORAGE_KEY = 'loom:auth'
const ANON_STORAGE_KEY = 'loom:anon'

function readStoredJson(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>)
  } catch {
    return null
  }
}

/** 匿名底座 UUID（首次生成后稳定；登出/未登录时用它）。 */
export function anonUserId(): string {
  let existing = localStorage.getItem(ANON_STORAGE_KEY)
  if (existing === null || existing === '' || !/^anon-[0-9a-f-]{8,}$/.test(existing)) {
    existing = `anon-${crypto.randomUUID()}`
    localStorage.setItem(ANON_STORAGE_KEY, existing)
  }
  return existing
}

/** 读取当前身份（无存储时回落匿名底座；不在 React 外触发写入）。 */
export function loadLoomIdentity(): LoomAuthState {
  const stored = readStoredJson(AUTH_STORAGE_KEY)
  if (stored !== null && typeof stored.userId === 'string' && (stored.kind === 'anon' || stored.kind === 'local')) {
    return {
      userId: stored.userId,
      kind: stored.kind,
      ...(typeof stored.username === 'string' ? { username: stored.username } : {}),
      ...(typeof stored.token === 'string' ? { token: stored.token } : {}),
    }
  }
  return { userId: anonUserId(), kind: 'anon' }
}

function storeLoomIdentity(state: LoomAuthState): void {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(state))
}

/** 持久化身份并返回（useLoomAuth 内部与手动切换用）。 */
export function saveLoomIdentity(state: LoomAuthState): LoomAuthState {
  storeLoomIdentity(state)
  return state
}

/** fetch 请求头：本地账号带 Bearer token；匿名带 x-loom-user。 */
export function authHeaders(identity: LoomAuthState | null | undefined): Record<string, string> {
  if (identity === null || identity === undefined) return {}
  return identity.token !== undefined
    ? { authorization: `Bearer ${identity.token}` }
    : { 'x-loom-user': identity.userId }
}

/** SSE URL 的身份 query（EventSource 不能带自定义头）。 */
export function authQuery(identity: LoomAuthState | null | undefined): string {
  if (identity === null || identity === undefined) return ''
  return identity.token !== undefined
    ? `token=${encodeURIComponent(identity.token)}`
    : `user=${encodeURIComponent(identity.userId)}`
}

/** useLoomAuth 返回。 */
export interface UseLoomAuthResult {
  /** 当前身份（挂载前为 null；之后恒有值——匿名或本地账号）。 */
  identity: LoomAuthState | null
  /** 登录（成功后 identity 切到本地账号）。 */
  login: (username: string, password: string) => Promise<void>
  /** 注册（成功即登录）。 */
  register: (username: string, password: string) => Promise<void>
  /** 登出（回落匿名底座 UUID）。 */
  logout: () => void
  /** 最近一次操作错误（中文）。 */
  error: string | null
  busy: boolean
}

/**
 * 多用户身份 hook：匿名 UUID 自动生成（首次即用）；register/login 走
 * POST /~loom/auth/*，token 持久化在 localStorage（'loom:auth'）。
 */
export function useLoomAuth(opts: { apiBase?: string } = {}): UseLoomAuthResult {
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE
  const [identity, setIdentity] = useState<LoomAuthState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const stored = loadLoomIdentity()
    storeLoomIdentity(stored)
    setIdentity(stored)
  }, [])

  const authenticate = useCallback(async (path: 'login' | 'register', username: string, password: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/auth/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const json = (await res.json().catch(() => ({}))) as { token?: string; userId?: string; username?: string; error?: string }
      if (!res.ok || typeof json.token !== 'string' || typeof json.userId !== 'string') {
        throw new Error(json.error ?? `${res.status} ${res.statusText}`)
      }
      const next: LoomAuthState = { userId: json.userId, kind: 'local', username: json.username ?? username, token: json.token }
      storeLoomIdentity(next)
      setIdentity(next)
    } catch (err) {
      setError(String(err instanceof Error ? err.message : String(err)))
      throw err
    } finally {
      setBusy(false)
    }
  }, [apiBase])

  const login = useCallback((username: string, password: string) => authenticate('login', username, password), [authenticate])
  const register = useCallback((username: string, password: string) => authenticate('register', username, password), [authenticate])
  const logout = useCallback((): void => {
    const anon: LoomAuthState = { userId: anonUserId(), kind: 'anon' }
    storeLoomIdentity(anon)
    setIdentity(anon)
    setError(null)
  }, [])

  return { identity, login, register, logout, error, busy }
}

/** 会话持久化键：loom:session:<userId>:<agentId>（无身份时 userId 用 'anon'）。 */
export function sessionStorageKey(userId: string, agentId: string): string {
  return `loom:session:${userId}:${agentId}`
}

/** 工具卡片（tool/call + tool/result 折叠）。 */
export interface LoomToolCard {
  seq: number
  name: string
  title: string
  args?: unknown
  preview?: string
  value?: unknown
  isError?: boolean
  done: boolean
}

/** 审批卡片状态：pending 等待人工答复；其余为终态。 */
export type LoomApprovalStatus = 'pending' | 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 审批卡片（loom/approval-asked + loom/approval-decided 折叠；M2）。 */
export interface LoomApproval {
  approvalId: string
  tool: string
  status: LoomApprovalStatus
  argsPreview?: string
  reason?: string
}

/** 聊天流消息。 */
export interface LoomMessage {
  role: 'user' | 'assistant'
  text: string
  toolCards: LoomToolCard[]
  /** 挂起/已决的审批卡片（策略 approve 触发）。 */
  approvals: LoomApproval[]
}

/** 会话状态机。 */
export type LoomSessionStatus = 'idle' | 'connecting' | 'busy' | 'error'

/** useAgentSession 返回。 */
export interface UseAgentSessionResult {
  sessionId: string | null
  messages: LoomMessage[]
  status: LoomSessionStatus
  error: string | null
  /** 发送一条用户消息（首次调用懒建会话并开 SSE）。 */
  send: (text: string) => void
  /** 答复一条挂起中的审批（POST /sessions/:sid/approvals/:aid）。 */
  decide: (approvalId: string, decision: 'allowed-once' | 'rejected') => void
  /**
   * 新建会话（M7）：丢弃 localStorage 里的存档会话并复位到全新状态
   * （下一条 send 会懒建新会话）。也用于存档会话失效后的手动重置。
   */
  reset: () => void
  /**
   * 切换到一个已知会话（M7：会话列表"继续"用）——直连重放重建消息流，
   * 并写入 localStorage 持久化键。
   */
  attach: (sessionId: string) => void
}

/** useAgentSession 选项。 */
export interface UseAgentSessionOptions {
  apiBase?: string
  /** 身份（useLoomAuth 的 identity；null = 挂载前的空窗，缺省读 localStorage）。 */
  identity?: LoomAuthState | null
  /** false 时禁用会话持久化（默认 true）。 */
  persist?: boolean
}

/** 懒建会话 + 聊天流（M7：会话持久化 + 身份头；挂载时有存档则全量重放重建）。 */
export function useAgentSession(agentId: string, opts: UseAgentSessionOptions = {}): UseAgentSessionResult {
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE
  const identity = opts.identity ?? loadLoomIdentity()
  const persist = opts.persist !== false
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<LoomMessage[]>([])
  const [status, setStatus] = useState<LoomSessionStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const sessionIdRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const lastSeqRef = useRef(-1)
  const closeStreamRef = useRef<(() => void) | null>(null)
  const identityUserId = identity.userId

  const teardown = useCallback((): void => {
    closeStreamRef.current?.()
    closeStreamRef.current = null
    sessionIdRef.current = null
    lastSeqRef.current = -1
    busyRef.current = false
    setSessionId(null)
    setMessages([])
    setError(null)
    setStatus('idle')
  }, [])

  const reset = useCallback((): void => {
    if (persist) localStorage.removeItem(sessionStorageKey(identityUserId, agentId))
    teardown()
  }, [agentId, identityUserId, persist, teardown])

  // 连接一个已知会话（存档恢复）：全量重放（since=-1，覆盖 seq 0 起）+ 实时。
  const attachSession = useCallback((sid: string): void => {
    sessionIdRef.current = sid
    lastSeqRef.current = -1
    setSessionId(sid)
    closeStreamRef.current?.()
    closeStreamRef.current = openEventStream(
      since => {
        const query = authQuery(identity)
        return `${apiBase}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sid)}/events?since=${since}${query === '' ? '' : `&${query}`}`
      },
      event => {
        setMessages(prev => foldEvent(prev, event))
        if (event.type === 'turn/end') {
          busyRef.current = false
          setStatus('idle')
        }
      },
      () => undefined,
    )
  }, [agentId, apiBase, identity])

  // 切换到一个已知会话（会话列表"继续"）：清空消息 → 直连重放 → 持久化键更新。
  const attach = useCallback((sid: string): void => {
    if (sid === '') return
    setMessages([])
    setError(null)
    busyRef.current = false
    attachSession(sid)
    if (persist) localStorage.setItem(sessionStorageKey(identityUserId, agentId), sid)
  }, [agentId, identityUserId, persist, attachSession])

  useEffect(() => {
    // 切换 agent / 切换身份用户：整体复位（换身份 = 换一份存档会话）。
    closeStreamRef.current?.()
    closeStreamRef.current = null
    sessionIdRef.current = null
    lastSeqRef.current = -1
    busyRef.current = false
    setSessionId(null)
    setMessages([])
    setError(null)
    setStatus('idle')

    // M7：挂载时有存档会话 → 验证仍存在（服务端可能换了 outDir）→ 直连重放。
    if (!persist) return
    const stored = localStorage.getItem(sessionStorageKey(identityUserId, agentId))
    if (stored === null || stored === '') return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/agents/${encodeURIComponent(agentId)}/sessions`, { headers: authHeaders(identity) })
        if (!res.ok) throw new Error(`${res.status}`)
        const body = (await res.json()) as { sessions?: Array<{ sessionId?: string }> }
        const known = body.sessions?.some(session => session.sessionId === stored) === true
        if (cancelled) return
        if (known) attachSession(stored)
        else localStorage.removeItem(sessionStorageKey(identityUserId, agentId))
      } catch {
        /* 服务暂不可达：保留存档，等用户主动操作 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [agentId, identityUserId, persist, apiBase, identity, attachSession])

  const send = useCallback(
    (text: string): void => {
      const trimmed = text.trim()
      if (trimmed === '' || busyRef.current) return
      busyRef.current = true
      setStatus('busy')
      setMessages(prev => [...prev, { role: 'user', text: trimmed, toolCards: [], approvals: [] }])
      setError(null)
      const headers = authHeaders(identity)

      const postMessage = (sid: string): Promise<void> =>
        postJson(`${apiBase}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sid)}/messages`, { text: trimmed }, headers)
          .then(() => undefined)
          .catch(err => {
            setError(String(err))
            setStatus('error')
          })

      const ensureSession = async (): Promise<void> => {
        if (sessionIdRef.current !== null) return postMessage(sessionIdRef.current)
        setStatus('connecting')
        const { sessionId: sid } = await postJson(`${apiBase}/agents/${encodeURIComponent(agentId)}/sessions`, {}, headers)
        sessionIdRef.current = String(sid)
        if (persist) localStorage.setItem(sessionStorageKey(identityUserId, agentId), String(sid))
        attachSession(String(sid))
        return postMessage(String(sid))
      }

      void ensureSession().catch(err => {
        setError(String(err))
        setStatus('error')
        busyRef.current = false
      })
    },
    [agentId, apiBase, identity, identityUserId, persist, attachSession],
  )

  const decide = useCallback(
    (approvalId: string, decision: 'allowed-once' | 'rejected'): void => {
      const sid = sessionIdRef.current
      if (sid === null) return
      void postJson(`${apiBase}/sessions/${encodeURIComponent(sid)}/approvals/${encodeURIComponent(approvalId)}`, { decision }, authHeaders(identity))
        .catch(err => setError(String(err)))
    },
    [apiBase, identity],
  )

  // 卸载时关流。
  useEffect(() => () => {
    closeStreamRef.current?.()
  }, [])

  return { sessionId, messages, status, error, send, decide, reset, attach }
}

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Record<string, any>> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(async res => {
    const json = (await res.json().catch(() => ({}))) as Record<string, any>
    if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`)
    return json
  })
}

/** SSE 白名单事件载荷（宽松类型）。 */
type EventPayload = ProjectionEvent & Record<string, any>

/** 把一条事件折叠进消息列表（不可变更新；导出供单测与回放调试复用）。 */
export function foldEvent(messages: LoomMessage[], event: EventPayload): LoomMessage[] {
  switch (event.type) {
    case 'user/message': {
      if (event.text === '') return messages
      return [...messages, { role: 'user', text: String(event.text ?? ''), toolCards: [], approvals: [] }]
    }
    case 'assistant/chunk': {
      if (messages.length === 0 || messages[messages.length - 1]!.role !== 'assistant') {
        return [...messages, { role: 'assistant', text: String(event.delta ?? ''), toolCards: [], approvals: [] }]
      }
      const last = messages[messages.length - 1]!
      return [...messages.slice(0, -1), { ...last, text: last.text + String(event.delta ?? '') }]
    }
    case 'assistant/message': {
      const text = String(event.text ?? '')
      if (messages.length > 0 && messages[messages.length - 1]!.role === 'assistant') {
        const last = messages[messages.length - 1]!
        // 定稿消息优先于流式聚合（避免增量丢失时的空消息）。
        return [...messages.slice(0, -1), { ...last, text: text === '' ? last.text : text }]
      }
      if (text === '') return messages
      return [...messages, { role: 'assistant', text, toolCards: [], approvals: [] }]
    }
    case 'tool/call': {
      const card: LoomToolCard = {
        seq: event.seq,
        name: String(event.name ?? ''),
        title: event.card?.title ?? String(event.name ?? ''),
        ...(event.args === undefined ? {} : { args: event.args }),
        done: false,
      }
      // 挂到最近一条 assistant 消息（没有则新建一条空 assistant）。
      if (messages.length > 0 && messages[messages.length - 1]!.role === 'assistant') {
        const last = messages[messages.length - 1]!
        return [...messages.slice(0, -1), { ...last, toolCards: [...last.toolCards, card] }]
      }
      return [...messages, { role: 'assistant', text: '', toolCards: [card], approvals: [] }]
    }
    case 'loom/approval-asked': {
      const approval: LoomApproval = {
        approvalId: String(event.approvalId ?? ''),
        tool: String(event.tool ?? ''),
        status: 'pending',
        ...(event.argsPreview === undefined ? {} : { argsPreview: String(event.argsPreview) }),
        ...(event.reason === undefined ? {} : { reason: String(event.reason) }),
      }
      if (approval.approvalId === '') return messages
      // 幂等去重：服务端在 SSE 重连时会按原 approvalId 重发未决审批卡——
      // 同一 approvalId 只保留首张（含已决状态，防重连后复活已决卡片）。
      const alreadyPresent = messages.some(
        message => (message.approvals ?? []).some(existing => existing.approvalId === approval.approvalId),
      )
      if (alreadyPresent) return messages
      // 挂到最近一条 assistant 消息（审批发生在该 assistant 的 turn 内）。
      if (messages.length > 0 && messages[messages.length - 1]!.role === 'assistant') {
        const last = messages[messages.length - 1]!
        return [...messages.slice(0, -1), { ...last, approvals: [...(last.approvals ?? []), approval] }]
      }
      return [...messages, { role: 'assistant', text: '', toolCards: [], approvals: [approval] }]
    }
    case 'loom/approval-decided': {
      const approvalId = String(event.approvalId ?? '')
      const decision = String(event.decision ?? '') as LoomApprovalStatus
      const settle = (approval: LoomApproval): LoomApproval =>
        approval.approvalId === approvalId && approval.status === 'pending' ? { ...approval, status: decision } : approval
      return messages.map(message => ({ ...message, approvals: (message.approvals ?? []).map(settle) }))
    }
    case 'tool/result': {
      const callSeq = event.callSeq
      const settle = (card: LoomToolCard): LoomToolCard =>
        card.seq === callSeq
          ? {
              ...card,
              done: true,
              ...(event.isError === undefined ? {} : { isError: Boolean(event.isError) }),
              ...(event.preview === undefined ? {} : { preview: String(event.preview) }),
              ...(event.value === undefined ? {} : { value: event.value }),
            }
          : card
      return messages.map(message => ({ ...message, toolCards: message.toolCards.map(settle) }))
    }
    default:
      return messages
  }
}

/** 打开一条带手动重连的 SSE（EventSource 原生重连的 URL 固定，会全量重放）。 */
function openEventStream(
  url: (since: number) => string,
  onEvent: (event: EventPayload) => void,
  onOpen: () => void,
): () => void {
  let disposed = false
  let es: EventSource | null = null
  let lastSeq = -1
  const connect = (): void => {
    if (disposed) return
    es = new EventSource(url(lastSeq))
    es.onopen = () => onOpen()
    es.onmessage = e => {
      try {
        const payload = JSON.parse(e.data) as EventPayload
        if (typeof payload.seq === 'number' && payload.seq <= lastSeq) return
        if (typeof payload.seq === 'number') lastSeq = payload.seq
        onEvent(payload)
      } catch {
        // 非 JSON 行忽略（心跳注释行不进 onmessage）。
      }
    }
    es.onerror = () => {
      es?.close()
      es = null
      if (!disposed) setTimeout(connect, 3000)
    }
  }
  connect()
  return () => {
    disposed = true
    es?.close()
  }
}

/** 投影状态（折叠跑在浏览器；会话未建/投影缺失时为 null）。 */
export function useProjection<S = unknown>(
  sessionId: string | null,
  projectionName: string,
  opts: { apiBase?: string; identity?: LoomAuthState | null } = {},
): S | null {
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE
  const identity = opts.identity
  const [state, setState] = useState<S | null>(null)

  useEffect(() => {
    if (sessionId === null) {
      setState(null)
      return
    }
    let disposed = false
    let closeStream: (() => void) | null = null
    let lastSeq = -1

    void (async () => {
      const res = await fetch(`${apiBase}/projections/${encodeURIComponent(projectionName)}`, { headers: authHeaders(identity) })
      if (!res.ok) throw new Error(`投影 "${projectionName}" 不可用（${res.status}）`)
      const spec = (await res.json()) as { init: S; apply: string }
      // 重建纯函数：apply 以源码下发（与服务端同一声明，浏览器折叠）。
      const fold = new Function('state', 'event', `return (${spec.apply})(state, event)`) as (state: S, event: EventPayload) => S
      let current = spec.init
      setState(current)
      const query = authQuery(identity)
      closeStream = openEventStream(
        since => `${apiBase}/sessions/${encodeURIComponent(sessionId)}/events?since=${since}${query === '' ? '' : `&${query}`}`,
        event => {
          if (typeof event.seq === 'number' && event.seq <= lastSeq) return
          if (typeof event.seq === 'number') lastSeq = event.seq
          current = fold(current, event)
          setState(current)
        },
        () => undefined,
      )
    })().catch(error => {
      if (!disposed) {
        setState(null)
        console.warn(`[loom] useProjection(${projectionName})：${String(error)}`)
      }
    })

    return () => {
      disposed = true
      closeStream?.()
    }
  }, [sessionId, projectionName, apiBase, identity])

  return state
}

// ---------------------------------------------------------------------------
// 多智能体（M3）：父流里的 loom/subagent-* → 自动并屏父/子两条活动流
// ---------------------------------------------------------------------------

/** 一条子智能体活动流。 */
export interface LoomSubagentStream {
  /** 子规格 id（app.subagent 声明名）。 */
  spec: string
  /** 子会话 id（可独立开 SSE 直播）。 */
  childSessionId: string
  /** running = 子会话进行中；done/error = 已结束（UI 回落折叠，流数据保留可展开）。 */
  status: 'running' | 'done' | 'error'
  /** 终局 stopReason（内核 SubagentResult.stopReason）。 */
  stopReason?: string
  /** 子会话折叠出的迷你聊天流（文本 + 工具卡片）。 */
  messages: LoomMessage[]
}

/**
 * 监听父会话流上的 loom/subagent-started/-finished 合成事件：每出现一个子会话
 * 就自动开第二条 SSE 并折叠其事件流，同屏显示"父/子"两条活动流；子完成后
 * status 落定（回落折叠由 UI 决定，流数据保留可再展开）。
 *
 * 实现上独立开一条父 SSE（since=-1 有重放，不漏事件），不动 useAgentSession。
 */
export function useSubagentStreams(sessionId: string | null, opts: { apiBase?: string; identity?: LoomAuthState | null } = {}): LoomSubagentStream[] {
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE
  const identity = opts.identity
  const [streams, setStreams] = useState<LoomSubagentStream[]>([])

  useEffect(() => {
    setStreams([])
    if (sessionId === null) return
    const closeStreams: Array<() => void> = []
    const upsert = (childSessionId: string, patch: (stream: LoomSubagentStream) => LoomSubagentStream): void => {
      setStreams(prev => {
        const index = prev.findIndex(stream => stream.childSessionId === childSessionId)
        if (index === -1) return prev
        const next = [...prev]
        next[index] = patch(next[index]!)
        return next
      })
    }

    // 父流（独立一条）：看 loom/subagent-* 合成事件。
    const query = authQuery(identity)
    closeStreams.push(openEventStream(
      since => `${apiBase}/sessions/${encodeURIComponent(sessionId)}/events?since=${since}${query === '' ? '' : `&${query}`}`,
      event => {
        if (event.type === 'loom/subagent-started' && typeof event.childSessionId === 'string') {
          const childSessionId = event.childSessionId
          const spec = String(event.spec ?? '')
          setStreams(prev => (prev.some(stream => stream.childSessionId === childSessionId)
            ? prev
            : [...prev, { spec, childSessionId, status: 'running', messages: [] }]))
          // 子流：since=-1 全量重放 + 实时，折叠进迷你聊天流。
          let childSeq = -1
          closeStreams.push(openEventStream(
            since2 => `${apiBase}/sessions/${encodeURIComponent(childSessionId)}/events?since=${since2}${query === '' ? '' : `&${query}`}`,
            childEvent => {
              if (typeof childEvent.seq === 'number' && childEvent.seq <= childSeq) return
              if (typeof childEvent.seq === 'number') childSeq = childEvent.seq
              upsert(childSessionId, stream => ({ ...stream, messages: foldEvent(stream.messages, childEvent) }))
            },
            () => undefined,
          ))
        } else if (event.type === 'loom/subagent-finished' && typeof event.childSessionId === 'string') {
          const childSessionId = event.childSessionId
          const stopReason = String(event.stopReason ?? '')
          upsert(childSessionId, stream => ({ ...stream, status: stopReason === 'completed' ? 'done' : 'error', stopReason }))
        }
      },
      () => undefined,
    ))

    return () => {
      for (const close of closeStreams.splice(0)) close()
    }
  }, [sessionId, apiBase, identity])

  return streams
}

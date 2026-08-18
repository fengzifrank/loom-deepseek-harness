/**
 * SSE 白名单投影的纯函数（自 runtime.ts 抽出，便于单测）。
 *
 * 规则（whitepaper §6 协议 v1）：
 * - 白名单：turn/start、turn/end、user/message（仅人类消息）、assistant/chunk
 *   （仅 text-delta）、assistant/message、tool/call、tool/result（预览截断）；
 * - 永不转发：request/header（含完整系统提示词与工具 schema）、approval/*
 *   （log-only 审计对——审批 UI 走 loom/approval-* 合成事件）等。
 * @module @loom-sdk/web/projection
 */

/** SSE 结果预览截断长度（gis-bridge 同值）。 */
export const PREVIEW_MAX = 1500
/** 小结果全量下发的阈值：render 文本不超过该长度时附 value（解析后的 JSON）。 */
export const VALUE_MAX = 4096

/** 最小事件形状（内核 SessionEvent 的 loose 视图）。 */
export interface SessionEventLike {
  seq: number
  type: string
  data?: any
}

/** 工具名 → 卡片意图。 */
export type CardIndex = Map<string, { kind: 'generic'; title: string }>

/** callId → {seq, name}（tool/result 回填工具名与调用 seq）。 */
export type CallIndex = Map<string, { seq: number; name: string }>

/** 从 content blocks 抽取纯文本。 */
export function textOfBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block && (block as any).type === 'text' && typeof (block as any).text === 'string')
    .map(block => (block as any).text as string)
    .join('')
}

/** 截断预览文本。 */
export function truncate(text: string, max = PREVIEW_MAX): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…(截断，共 ${text.length} 字符)`
}

/** 一条持久会话事件 → SSE 白名单载荷；不在白名单返回 undefined。 */
export function projectEvent(event: SessionEventLike, callIndex: CallIndex, cards: CardIndex): Record<string, unknown> | undefined {
  const d = event.data ?? {}
  switch (event.type) {
    case 'turn/start':
      return { seq: event.seq, type: 'turn/start', turn: d.turn }
    case 'turn/end':
      return { seq: event.seq, type: 'turn/end', turn: d.turn, reason: d.reason }
    case 'user/message':
      // 只投影人类消息；runtime-context 注入（source.kind === 'plugin'）不进前端气泡。
      if (d.source && d.source.kind !== 'user') return undefined
      return { seq: event.seq, type: 'user/message', text: textOfBlocks(d.content) }
    case 'assistant/chunk':
      // 只投影可见文本增量（text-delta）。
      if (d.chunk && d.chunk.type === 'text-delta' && d.chunk.text) {
        return { seq: event.seq, type: 'assistant/chunk', delta: d.chunk.text }
      }
      return undefined
    case 'assistant/message':
      return {
        seq: event.seq,
        type: 'assistant/message',
        text: textOfBlocks(d.message.content),
        ...(d.usage === undefined ? {} : { usage: d.usage }),
      }
    case 'tool/call': {
      let args: unknown
      try {
        args = JSON.parse(d.arguments)
      } catch {
        args = d.arguments
      }
      callIndex.set(d.callId, { seq: event.seq, name: d.name })
      const card = cards.get(d.name)
      return {
        seq: event.seq,
        type: 'tool/call',
        callId: d.callId,
        name: d.name,
        args,
        ...(card === undefined ? {} : { card }),
      }
    }
    case 'tool/result': {
      const block = Array.isArray(d.message.content) ? d.message.content[0] : undefined
      const call = callIndex.get(d.message.source.callId)
      const text = truncate(textOfBlocks(block === undefined ? [] : (block as any).content))
      // 小结果全量下发：render 是 canonical JSON，原文不长时附解析值，投影可直接消费。
      let value: unknown
      if (block !== undefined && !text.includes('…(截断')) {
        try {
          const raw = textOfBlocks((block as any).content)
          if (raw.length <= VALUE_MAX) value = JSON.parse(raw)
        } catch {
          value = undefined
        }
      }
      return {
        seq: event.seq,
        type: 'tool/result',
        callSeq: call === undefined ? undefined : call.seq,
        name: call === undefined ? d.message.source.callId : call.name,
        isError: block !== undefined && (block as any).isError === true,
        preview: text,
        ...(value === undefined ? {} : { value }),
      }
    }
    default:
      // request/header（含完整系统提示词）、step/*、approval/* 等一律不转发。
      return undefined
  }
}

/** 扫描历史事件重建 callId→{seq,name} 索引（fork 子会话回放需要）。 */
export function rebuildCallIndex(session: { events: Iterable<SessionEventLike> }): CallIndex {
  const index: CallIndex = new Map()
  for (const event of session.events) {
    if (event.type === 'tool/call' && event.data?.callId !== undefined) {
      index.set(String(event.data.callId), { seq: event.seq, name: String(event.data.name) })
    }
  }
  return index
}

/**
 * transcript 评测（M4）——对齐内核 snapshot 哲学（白皮书 §10 M4 行）：
 * 真实跑出的会话日志就是评测夹具；无 key 的 CI 里对日志做**纯重放断言**
 * （零网络、零 key——评测读的是 .loom/sessions/*.jsonl 的精简投影）。
 *
 * 三件套：
 * 1. `slimSessionLog()`：夹具提取——从 `.loom/sessions/<id>/session.jsonl` 读原始
 *    日志，**折叠 assistant/chunk 增量**（保留 assistant/message 定稿），其余
 *    事件（turn/step/user/tool/approval/loom-*）原样保留；其余类型（session 头、
 *    request/header 系统提示词、block-* 流式增量等）剔除——纯函数，幂等。
 * 2. `defineEval({ name, fixture, assert })`：评测用例声明。`assert(ev)` 拿到
 *    夹具视图（events / byType / byTool / turns / orderOf / text + expect 断言
 *    辅助：toolCalled / toolFailed / turnEnded / approvalFlow / textIncludes）。
 * 3. `runEval(spec)`：加载夹具文件 → 建视图 → 跑断言 → 结果（ok/error）。
 *    `loom eval` CLI 逐个加载 `*.eval.ts` 并运行，失败 exit 1。
 * @module @loom-sdk/web/eval
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { textOfBlocks } from './projection.js'

// ---------------------------------------------------------------------------
// 夹具提取（slim）
// ---------------------------------------------------------------------------

/** 原样保留的事件类型（assistant/chunk 增量折叠进 assistant/message 定稿）。 */
const KEEP_EXACT = new Set(['assistant/message'])
/** 原样保留的事件类型前缀。 */
const KEEP_PREFIXES = ['turn/', 'step/', 'user/', 'tool/', 'approval/', 'loom/']

/** 一个事件类型是否进精简夹具。 */
function slimKeeps(type: unknown): boolean {
  if (typeof type !== 'string') return false
  return KEEP_EXACT.has(type) || KEEP_PREFIXES.some(prefix => type.startsWith(prefix))
}

/**
 * 原始 session.jsonl 行流 → 精简夹具行（JSONL 字符串数组；确定性输出）。
 * 非法 JSON 行与空行静默跳过；对已是精简形态的输入幂等。
 */
export function slimSessionLog(lines: string | Iterable<string>): string[] {
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!slimKeeps((event as { type?: unknown }).type)) continue
    out.push(JSON.stringify(event))
  }
  return out
}

/** 夹具文件里的一条事件（原始日志形状：type/seq/time/data 宽松保留）。 */
export interface EvalEvent {
  type: string
  seq?: number
  time?: number
  data?: any
  [key: string]: unknown
}

/** 读取 jsonl 文件为事件数组（跳过空行/非法行）。 */
export function readEventsFile(path: string): EvalEvent[] {
  const events: EvalEvent[] = []
  for (const line of slimSessionLog(readFileSync(path, 'utf8').split(/\r?\n/))) {
    events.push(JSON.parse(line) as EvalEvent)
  }
  return events
}

// ---------------------------------------------------------------------------
// 夹具视图（assert(ev) 的 ev）
// ---------------------------------------------------------------------------

/** 一次工具调用（tool/call + 对应 tool/result 的折叠视图）。 */
export interface EvalToolCall {
  /** 工具名。 */
  name: string
  /** tool/call 的 seq。 */
  seq: number
  /** 已解析的入参（原始日志里是 JSON 字符串；解析失败保留原文）。 */
  args?: unknown
  /** 结果是否已回（false = 只有调用没有结果，如被中断）。 */
  done: boolean
  /** tool/result 的 seq。 */
  resultSeq?: number
  /** 结果是否为错误（isError）。 */
  isError?: boolean
  /** 结果预览文本（render 的 canonical JSON 文本）。 */
  preview?: string
  /** 小结果的解析值（preview 是合法 JSON 且不长时）。 */
  value?: unknown
}

/** turn/end 的归一视图。 */
export interface EvalTurnEnd {
  turn: number
  seq: number
  /** 归一后的 reason（原始可能是 { kind: 'completed' } 对象或字符串）。 */
  reason: string
}

/** 断言辅助（全部以 throw Error 表达失败；消息中文，直接可读）。 */
export interface EvalExpect {
  /** 断言某工具至少被调用一次。 */
  toolCalled(name: string): void
  /** 断言某工具至少一次以错误收场（tool/result isError）。 */
  toolFailed(name: string): void
  /** 断言最后一个 turn 以指定 reason 收场（如 'completed'）。 */
  turnEnded(kind: string): void
  /** 断言 approval/asked → approval/decided 顺序成立；返回这一对事件。 */
  approvalFlow(): { asked: EvalEvent; decided: EvalEvent; outcome: string }
  /** 断言助手文本聚合包含子串。 */
  textIncludes(needle: string): void
}

/** assert(ev) 收到的夹具视图。 */
export interface EvalContext {
  /** 精简夹具的全部事件（seq 升序）。 */
  readonly events: readonly EvalEvent[]
  /** 按类型过滤（如 'tool/call'、'approval/asked'）。 */
  byType(type: string): EvalEvent[]
  /** 按工具名折叠的调用记录（调用序）。 */
  byTool(name: string): EvalToolCall[]
  /** 全部工具调用（不区分名字，调用序）。 */
  toolCalls(): EvalToolCall[]
  /** 全部 turn/end（归一 reason）。 */
  turns(): EvalTurnEnd[]
  /** 各类型首现事件的 seq（自定义顺序断言用；未出现为 undefined）。 */
  orderOf(...types: string[]): Array<number | undefined>
  /** 助手文本聚合（assistant/message 定稿文本按序拼接）。 */
  text(): string
  /** 断言辅助。 */
  readonly expect: EvalExpect
  /**
   * 记一条非阻断告警（M12，oci-agent 的 blocker/warner 区分）：断言全部通过但
   * 存在告警 → 判定 pass-with-caveats（满意但有保留）。空消息直接抛错（fail-closed）。
   */
  caveat(message: string): void
  /** 已记录的告警（活视图；runEval 在断言结束后读取）。 */
  readonly caveats: readonly string[]
}

/** turn/end 的 reason 归一（内核是 { kind } 对象；旧日志可能是字符串）。 */
function reasonKind(reason: unknown): string {
  if (reason !== null && typeof reason === 'object' && 'kind' in (reason as Record<string, unknown>)) {
    return String((reason as { kind: unknown }).kind)
  }
  return String(reason ?? '')
}

/** 从 tool/result 事件提取结果信息。 */
function resultInfo(event: EvalEvent): { isError: boolean; preview: string; value?: unknown } {
  const block = Array.isArray(event.data?.message?.content) ? event.data.message.content[0] : undefined
  const preview = textOfBlocks(block === undefined ? [] : block.content)
  let value: unknown
  if (block !== undefined && !preview.includes('…(截断')) {
    try {
      if (preview.length <= 8192) value = JSON.parse(preview)
    } catch {
      value = undefined
    }
  }
  return { isError: block !== undefined && block.isError === true, preview, ...(value === undefined ? {} : { value }) }
}

/** 事件数组 → 夹具视图（纯函数；defineEval/runEval 内部使用，单测可直接调）。 */
export function buildEvalContext(events: readonly EvalEvent[]): EvalContext {
  const calls: EvalToolCall[] = []
  const callsByCallId = new Map<string, EvalToolCall>()
  for (const event of events) {
    if (event.type === 'tool/call') {
      let args: unknown = event.data?.arguments
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          /* 保留原文 */
        }
      }
      const record: EvalToolCall = { name: String(event.data?.name ?? ''), seq: event.seq ?? -1, args, done: false }
      calls.push(record)
      if (typeof event.data?.callId === 'string') callsByCallId.set(event.data.callId, record)
    } else if (event.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId
      const record = typeof callId === 'string' ? callsByCallId.get(callId) : undefined
      if (record === undefined) continue
      const info = resultInfo(event)
      record.done = true
      record.resultSeq = event.seq
      record.isError = info.isError
      record.preview = info.preview
      if (info.value !== undefined) record.value = info.value
    }
  }

  const text = () =>
    events
      .filter(event => event.type === 'assistant/message')
      .map(event => textOfBlocks(event.data?.message?.content))
      .join('')

  // M12：非阻断告警收集（断言全过 + 有告警 = pass-with-caveats）。
  const caveats: string[] = []
  const caveat = (message: string): void => {
    if (typeof message !== 'string' || message.trim() === '') {
      throw new Error('caveat() 需要非空告警消息（fail-closed：告警本身写错按失败处理）')
    }
    caveats.push(message)
  }

  const fail = (message: string): never => {
    throw new Error(message)
  }

  const expect: EvalExpect = {
    toolCalled(name) {
      if (!calls.some(call => call.name === name)) {
        fail(`断言失败：期望工具 "${name}" 被调用，实际调用序列：[${calls.map(call => call.name).join(' → ')}]`)
      }
    },
    toolFailed(name) {
      const failed = calls.find(call => call.name === name && call.done && call.isError === true)
      if (failed === undefined) {
        const seen = calls.filter(call => call.name === name)
        fail(
          seen.length === 0
            ? `断言失败：期望工具 "${name}" 以错误收场，但它从未被调用`
            : `断言失败：期望工具 "${name}" 以错误收场，实际 ${seen.length} 次调用全部成功`,
        )
      }
    },
    turnEnded(kind) {
      const ends = events.filter(event => event.type === 'turn/end')
      if (ends.length === 0) fail('断言失败：夹具中没有任何 turn/end 事件')
      const last = ends[ends.length - 1]!
      const actual = reasonKind(last.data?.reason)
      if (actual !== kind) {
        fail(`断言失败：期望最后一个 turn 以 "${kind}" 收场，实际 "${actual}"（turn=${String(last.data?.turn)}）`)
      }
    },
    approvalFlow() {
      const asked = events.find(event => event.type === 'approval/asked')
      if (asked === undefined) fail('断言失败：夹具中没有 approval/asked 事件')
      const askedSeq = asked!.seq ?? -1
      const decided = events.find(event => event.type === 'approval/decided' && (event.seq ?? -1) > askedSeq)
      if (decided === undefined) fail('断言失败：approval/asked 之后没有 approval/decided（顺序也不成立）')
      return { asked: asked!, decided: decided!, outcome: String(decided!.data?.outcome ?? '') }
    },
    textIncludes(needle) {
      const aggregate = text()
      if (!aggregate.includes(needle)) {
        const head = aggregate.length > 160 ? `${aggregate.slice(0, 160)}…` : aggregate
        fail(`断言失败：助手文本不包含 ${JSON.stringify(needle)}；文本开头：${JSON.stringify(head)}`)
      }
    },
  }

  return {
    events,
    byType: (type: string) => events.filter(event => event.type === type),
    byTool: (name: string) => calls.filter(call => call.name === name),
    toolCalls: () => [...calls],
    turns: () =>
      events
        .filter(event => event.type === 'turn/end')
        .map(event => ({ turn: Number(event.data?.turn ?? -1), seq: event.seq ?? -1, reason: reasonKind(event.data?.reason) })),
    orderOf: (...types: string[]) => types.map(type => events.find(event => event.type === type)?.seq),
    text,
    expect,
    caveat,
    caveats,
  }
}

// ---------------------------------------------------------------------------
// 用例声明与运行
// ---------------------------------------------------------------------------

/** 一个评测用例。 */
export interface EvalSpec {
  /** 用例名（结果表里展示；建议与夹具语义一致，如 'approval-allowed'）。 */
  readonly name: string
  /** 夹具 jsonl 路径（相对 .eval.ts 所在目录，或绝对路径）。 */
  readonly fixture: string
  /** 断言（抛错即失败；同步或异步）。 */
  assert(ev: EvalContext): void | Promise<void>
}

/** 声明一个评测用例（在 *.eval.ts 里 default 导出其返回值）。 */
export function defineEval(def: EvalSpec): EvalSpec {
  if (typeof def.name !== 'string' || def.name.trim() === '') throw new Error('defineEval：name 必须是非空字符串')
  if (typeof def.fixture !== 'string' || def.fixture.trim() === '') throw new Error(`defineEval("${def.name}")：fixture 必须是非空字符串`)
  if (typeof def.assert !== 'function') throw new Error(`defineEval("${def.name}")：assert 必须是函数`)
  return def
}

/** 单个用例的运行结果。 */
export interface EvalResult {
  name: string
  /** 兼容字段 = verdict !== 'fail'。 */
  ok: boolean
  /**
   * 三级判定（M12，oci-agent 的 fully_satisfactory/satisfactory_with_caveats/
   * not_satisfactory 移植）：pass 全过无告警 / pass-with-caveats 全过有告警 /
   * fail 断言抛错或夹具不可读（fail-closed）。
   */
  verdict: 'pass' | 'pass-with-caveats' | 'fail'
  /** 已记录的非阻断告警（verdict=pass-with-caveats 时非空）。 */
  caveats: string[]
  /** 夹具事件数（成功时展示；失败也有）。 */
  eventCount: number
  /** 失败原因（verdict=fail 时）。 */
  error?: string
  durationMs: number
}

/** 运行一个用例：加载夹具 → 建视图 → 跑断言（捕获一切错误为失败；断言抛错即
 * fail——即使之前已记告警（阻断优先于保留，oci-agent 的 blocker 语义）。 */
export async function runEval(spec: EvalSpec, opts: { fixtureDir?: string } = {}): Promise<EvalResult> {
  const started = Date.now()
  const fixturePath = isAbsolute(spec.fixture) ? spec.fixture : resolve(opts.fixtureDir ?? process.cwd(), spec.fixture)
  let events: EvalEvent[]
  try {
    events = readEventsFile(fixturePath)
  } catch (error) {
    return { name: spec.name, ok: false, verdict: 'fail', caveats: [], eventCount: 0, error: `夹具读取失败（${fixturePath}）：${String(error)}`, durationMs: Date.now() - started }
  }
  if (events.length === 0) {
    return { name: spec.name, ok: false, verdict: 'fail', caveats: [], eventCount: 0, error: `夹具为空或没有可保留事件（${fixturePath}）`, durationMs: Date.now() - started }
  }
  try {
    const context = buildEvalContext(events)
    await spec.assert(context)
    const caveats = [...context.caveats]
    return caveats.length === 0
      ? { name: spec.name, ok: true, verdict: 'pass', caveats, eventCount: events.length, durationMs: Date.now() - started }
      : { name: spec.name, ok: true, verdict: 'pass-with-caveats', caveats, eventCount: events.length, durationMs: Date.now() - started }
  } catch (error) {
    return { name: spec.name, ok: false, verdict: 'fail', caveats: [], eventCount: events.length, error: String(error instanceof Error ? error.message : error), durationMs: Date.now() - started }
  }
}

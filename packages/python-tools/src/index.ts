/**
 * dsh-python-tools —— Python 工具桥插件（loom-py 协议）：内核保持 TS，Python
 * 成为一等工具作者语言。自 @loom-sdk/web 的 python-bridge.ts 抽出（M8 插件化，
 * Loom 成为插件生产者）；API 形状保持：named exports name/inject/apply/Config。
 *
 * 形态：cordis 插件（组合里一行挂载）。职责：
 * 1. 解析 config（command 字符串按空格拆 argv，支持含引号路径）；
 * 2. spawn Python 子进程，stdio 上跑 **loom-py v1 协议**（JSON Lines：双方
 *    逐行读写、每行一个 JSON 对象——比 Content-Length 分帧简单，双方一致即可）：
 *    - 请求：`{"id":N,"method":"initialize|tools/list|tools/call","params":{...}}`
 *    - 通知（无 id，不回复）：`{"method":"tools/cancel","params":{"callId":"..."}}`
 *    - 响应：`{"id":N,"result":{...}}` 或 `{"id":N,"error":{"code"?:N,"message":str}}`
 * 3. 握手（initialize → {protocol:'loom-py', version:1} → tools/list）后校验
 *    清单（name 合法 / 必填字段 / 重复拒绝，中文报错）；
 * 4. 清单项 → defineTool 注册代理工具（模型可见）：parameters 经
 *    `jsonSchemaToDsl`（./convert.js 的诚实降级转换器）取 object 根的
 *    属性表；output 走同一转换器（root required[] → 字段级 required:true，
 *    object 节点补 additionalProperties:false）；
 * 5. 调用转发：递增 id → 请求写 stdin → 等响应（默认 120s 超时可配）→
 *    `{value}` 返回；`{error:{message}}` → throw（内核转 isError 工具结果）；
 *    exec.signal abort → 发 tools/cancel 通知并不再等待（结果作废）；
 * 6. 进程退出：pending 全部拒绝 + 清晰错误；自动重启（间隔 1s，上限
 *    restartLimit 默认 3，超出后 unavailable——后续调用清晰报错并 fail-loud 日志）。
 *
 * 帧编解码 / 清单校验 / jsonSchema→DSL 映射全部是导出的纯函数（单测友好）；
 * PythonBridge 类不依赖 cordis（假子进程集成测试直接实例化）。
 * v1 边界：Python 工具仅模型面孔（无 HTTP 面孔/客户端生成）；取消尽力而为。
 * @module dsh-python-tools
 */

import { type ChildProcess, spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { jsonSchemaToDsl, type ConvertContext } from './convert.js'

/** defineTool 的 parameters DSL 对象（属性表形态）。 */
export type ToolInputDSL = Record<string, unknown>
/** defineTool 的 output.schema DSL 对象（根节点形态）。 */
export type ToolOutputDSL = Record<string, unknown>

// ---------------------------------------------------------------------------
// 协议常量（与 packages/loom-py/loom_py/__init__.py 的文档注释互为镜像）
// ---------------------------------------------------------------------------

/** 协议名（initialize 握手互验）。 */
export const PROTOCOL_NAME = 'loom-py'
/** 协议版本（握手互验）。 */
export const PROTOCOL_VERSION = 1
/** 握手（spawn → initialize + tools/list）总超时。 */
export const HANDSHAKE_TIMEOUT_MS = 30_000
/** 进程退出后的自动重启间隔。 */
export const RESTART_INTERVAL_MS = 1_000
/** 默认自动重启上限。 */
export const DEFAULT_RESTART_LIMIT = 3
/** 默认单次调用超时。 */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000
/** bridge 对外提供的 cordis 服务名（宿主 runtime health / CLI 横幅读计数用）。 */
export const LOOM_PYTHON_SERVICE = 'loomPython'

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 纯 JSON 对象判定（帧/清单校验共用）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 截断长文本（错误信息友好）。 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

// ---------------------------------------------------------------------------
// 纯函数：命令解析 / 帧编解码 / 握手与清单校验（单测直测）
// ---------------------------------------------------------------------------

/**
 * command 字符串 → argv：按空格拆分，双引号/单引号内的空格保留
 * （`"C:\Program Files\Python313\python.exe" -u py_tools.py` → 三段 argv）。
 * 至少要有一段（解释器）；空/空白 → throw。
 */
export function parsePythonCommand(command: string): string[] {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error(`loom-python-bridge: command 必须是非空字符串，收到 ${JSON.stringify(command)}`)
  }
  const argv: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of command.matchAll(pattern)) {
    const token = match[1] ?? match[2] ?? match[3]
    if (token !== undefined && token !== '') argv.push(token)
  }
  if (argv.length === 0) {
    throw new Error(`loom-python-bridge: command 解析不出任何参数：${JSON.stringify(command)}`)
  }
  return argv
}

/** 一个协议对象 → 一行帧文本（JSON + 换行）。 */
export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

/**
 * 按行 JSON 解码器（有状态闭包）：喂入任意切割的 chunk 流，吐出已完整收到的
 * 协议对象。容忍 `\r\n`；空行跳过；非法 JSON → throw（调用方记日志，不致命）。
 */
export function createLineDecoder(): (chunk: string) => Array<Record<string, unknown>> {
  let buffer = ''
  return (chunk: string): Array<Record<string, unknown>> => {
    buffer += chunk
    const frames: Array<Record<string, unknown>> = []
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line.trim() === '') continue
      try {
        frames.push(JSON.parse(line) as Record<string, unknown>)
      } catch (error) {
        throw new Error(`协议行不是合法 JSON：${String(error)}（行内容：${truncate(line, 120)}）`)
      }
    }
    return frames
  }
}

/** initialize 结果校验：必须是 {protocol:'loom-py', version:1}（中文报错）。 */
export function validateInitializeResult(result: unknown): void {
  if (!isPlainObject(result)) {
    throw new Error(`loom-python-bridge: 握手失败——initialize 结果必须是对象，收到 ${result === null ? 'null' : typeof result}`)
  }
  if (result.protocol !== PROTOCOL_NAME) {
    throw new Error(
      `loom-python-bridge: 握手失败——对端 protocol 应为 "${PROTOCOL_NAME}"，收到 ${JSON.stringify(result.protocol)}`
      + '（command 启动的不是 loom-py 协议进程？）',
    )
  }
  if (result.version !== PROTOCOL_VERSION) {
    throw new Error(
      `loom-python-bridge: 握手失败——协议版本不兼容（本桥 v${PROTOCOL_VERSION}，对端 ${JSON.stringify(result.version)}）`,
    )
  }
}

/** 清单里的一项（校验后的形态）。 */
export interface PythonToolEntry {
  readonly name: string
  readonly description: string
  /** 输入 JSON Schema（object 根；缺省 {} = 无参数）。 */
  readonly parameters: Record<string, unknown>
  /** 输出 JSON Schema；未声明时 undefined（DSL 侧按任意 JSON 处理）。 */
  readonly output: Record<string, unknown> | undefined
}

/**
 * tools/list 结果校验：必须是数组；每项 name 合法（`[A-Za-z_][A-Za-z0-9_]*`）、
 * description 非空、parameters/output（可缺省）为对象；重复工具名拒绝；
 * 空清单拒绝（几乎必然是忘了 @tool）。全部中文报错。
 */
export function validatePythonManifest(tools: unknown): PythonToolEntry[] {
  if (!Array.isArray(tools)) {
    throw new Error(`loom-python-bridge: tools/list 结果必须是数组，收到 ${tools === null ? 'null' : typeof tools}`)
  }
  if (tools.length === 0) {
    throw new Error('loom-python-bridge: Python 清单为空——脚本里至少要有一个 @tool 装饰的函数并调用 run()')
  }
  const seen = new Set<string>()
  const entries: PythonToolEntry[] = []
  for (let index = 0; index < tools.length; index++) {
    const raw = tools[index]
    if (!isPlainObject(raw)) {
      throw new Error(`loom-python-bridge: 清单第 ${index} 项不是 JSON 对象，收到 ${raw === null ? 'null' : typeof raw}`)
    }
    const name = raw.name
    if (typeof name !== 'string' || name === '') {
      throw new Error(`loom-python-bridge: 清单第 ${index} 项缺少非空字符串 name`)
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`loom-python-bridge: 清单第 ${index} 项的工具名 "${name}" 不合法——须匹配 [A-Za-z_][A-Za-z0-9_]*`)
    }
    if (seen.has(name)) {
      throw new Error(`loom-python-bridge: 清单里工具名 "${name}" 重复——每个 @tool 的函数名必须唯一`)
    }
    seen.add(name)
    const description = raw.description
    if (typeof description !== 'string' || description.trim() === '') {
      throw new Error(`loom-python-bridge: 工具 "${name}" 缺少非空 description（@tool 的第一个参数）`)
    }
    if (raw.parameters !== undefined && !isPlainObject(raw.parameters)) {
      throw new Error(`loom-python-bridge: 工具 "${name}" 的 parameters 必须是 JSON Schema 对象`)
    }
    if (raw.output !== undefined && !isPlainObject(raw.output)) {
      throw new Error(`loom-python-bridge: 工具 "${name}" 的 output 必须是 JSON Schema 对象`)
    }
    entries.push({
      name,
      description,
      parameters: isPlainObject(raw.parameters) ? raw.parameters : {},
      output: isPlainObject(raw.output) ? raw.output : undefined,
    })
  }
  return entries
}

// ---------------------------------------------------------------------------
// 纯函数：清单项 → 代理工具定义（jsonSchema → DSL）
// ---------------------------------------------------------------------------

/** 一个 Python 工具映射后的代理定义（注册 defineTool 用）。 */
export interface ProxyToolDefinition {
  readonly name: string
  readonly description: string
  /** defineTool parameters DSL（属性表形态）。 */
  readonly parameters: ToolInputDSL
  /** defineTool output.schema DSL（根节点形态，required 已下沉到字段级）。 */
  readonly output: ToolOutputDSL
  /** 转换期间的诚实降级警告（注册时逐条记日志）。 */
  readonly warnings: readonly string[]
}

/**
 * 清单项 → 代理工具定义。
 * - parameters：JSON Schema object 根经 `jsonSchemaToDsl` 转 DSL 后**取属性表**
 *   （defineTool 的 parameters 是属性表形态）；根不是 object 时整体收进单字段
 *   `input`（诚实注明）；
 * - output：同一转换器直转根节点（root `required:[...]` → 字段级
 *   `required:true`）；未声明 → `{type:'json'}`（任意 canonical JSON——
 *   Python 函数返回值不预设形状）；
 * - 转换器不覆盖的 JSON Schema 子集诚实降级（{type:'json'}），警告收集在
 *   `warnings` 里由调用方透出——宁可少承诺，不可静默错 schema。
 */
export function pythonEntryToToolDef(entry: PythonToolEntry): ProxyToolDefinition {
  const warnings: string[] = []
  const ctx: ConvertContext = {
    resolve: () => undefined, // Python 清单是内联 schema，无 $ref 可解析
    warn: (path, message) => { warnings.push(`${path}——${message}`) },
  }

  let parameters: ToolInputDSL
  const hasParameters = entry.parameters !== undefined && Object.keys(entry.parameters).length > 0
  if (!hasParameters) {
    parameters = {}
  } else {
    const dsl = jsonSchemaToDsl(entry.parameters, ctx, `parameters(${entry.name})`)
    if (dsl.type === 'object' && isPlainObject(dsl.properties)) {
      parameters = dsl.properties as ToolInputDSL
    } else {
      // 非 object 根（或转换降级）：整体收进单字段 input（保持可调用）。
      parameters = {
        input: {
          ...dsl,
          required: true,
          description: '原 parameters 根不是 object，已整体收进单字段 input（任意 JSON）',
        },
      }
    }
  }

  const output: ToolOutputDSL = entry.output === undefined
    ? { type: 'json' }
    : (jsonSchemaToDsl(entry.output, ctx, `output(${entry.name})`) as ToolOutputDSL)

  return { name: entry.name, description: entry.description, parameters, output, warnings }
}

/**
 * DSL 规格化：每个 type:'object' 节点补 `additionalProperties:false`（封闭对象，
 * 内核 schema 转换器要求）。深拷贝语义。
 */
export function normalizePythonDsl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePythonDsl)
  if (value === null || typeof value !== 'object') return value
  const node: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    node[key] = normalizePythonDsl(entry)
  }
  if (node.type === 'object' && typeof node.additionalProperties !== 'boolean') {
    node.additionalProperties = false
  }
  return node
}

/** defineTool 的宽松签名边界（Loom DSL 与内核泛型 DSL 之间的互转层）。 */
const defineToolLoose = defineTool as unknown as (options: Record<string, unknown>) => unknown

/** 代理工具的 execute 转发函数形态。 */
export type PythonToolForwarder = (args: Record<string, unknown>, signal: AbortSignal | undefined) => Promise<unknown>

/** 代理定义 + 转发器 → defineTool 参数（render 输出 canonical JSON 文本投影）。 */
export function proxyToolArgs(def: ProxyToolDefinition, forward: PythonToolForwarder): Record<string, unknown> {
  const render = (_args: unknown, value: unknown): Array<Record<string, unknown>> => [
    { type: 'text', text: JSON.stringify(value, null, 2) },
  ]
  return defineToolLoose({
    name: def.name,
    description: `${def.description}（Python 工具，经 loom-python-bridge 转发）`,
    parameters: normalizePythonDsl(def.parameters),
    output: { schema: normalizePythonDsl(def.output), render },
    async execute(args: Record<string, unknown>, exec: { signal?: AbortSignal }): Promise<unknown> {
      return await forward(args, exec?.signal)
    },
  }) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// PythonBridge：子进程生命周期 + 请求/响应转发（不依赖 cordis，单测直测）
// ---------------------------------------------------------------------------

/** 最小日志接口（cordis ctx.logger / console 均满足）。 */
export interface BridgeLogger {
  info(line: string): void
  warn(line: string): void
}

/** 桥接构造选项。 */
export interface PythonBridgeOptions {
  /** argv（parsePythonCommand 的产物）。 */
  readonly command: readonly string[]
  readonly cwd?: string
  /** 附加环境变量（合并进 process.env）。 */
  readonly env?: Record<string, string>
  readonly restartLimit?: number
  readonly callTimeoutMs?: number
  readonly logger?: BridgeLogger
}

/** 桥运行状态。 */
export type PythonBridgeStatus = 'starting' | 'ready' | 'restarting' | 'dead'

interface PendingCall {
  readonly callId: string
  readonly label: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  onAbort?: () => void
  readonly signal?: AbortSignal
  settled: boolean
}

const consoleLogger: BridgeLogger = {
  info: line => console.log(line),
  warn: line => console.warn(line),
}

/**
 * 一个 Python 子进程桥：spawn → 握手 → 清单；调用转发；崩溃自动重启
 * （上限 fail-loud）；取消尽力而为。状态机：
 * starting → ready →（退出）restarting → ready / … → dead（超上限）。
 */
export class PythonBridge {
  private readonly command: readonly string[]
  private readonly cwd: string | undefined
  private readonly env: Record<string, string> | undefined
  private readonly restartLimit: number
  private readonly callTimeoutMs: number
  private readonly logger: BridgeLogger

  private child: ChildProcess | undefined
  private decode: (chunk: string) => Array<Record<string, unknown>> = createLineDecoder()
  private nextId = 1
  private readonly pending = new Map<number, PendingCall>()
  private restarts = 0
  private restartTimer: NodeJS.Timeout | undefined
  private disposed = false
  private status: PythonBridgeStatus = 'starting'
  private manifestValue: readonly PythonToolEntry[] = []
  /** 非 ready 期间新调用的等待门（重启成功兑现 / 死亡拒绝）。 */
  private gate: { promise: Promise<void>; settle(error?: Error): void } | undefined

  constructor(opts: PythonBridgeOptions) {
    this.command = opts.command
    this.cwd = opts.cwd
    this.env = opts.env
    this.restartLimit = opts.restartLimit ?? DEFAULT_RESTART_LIMIT
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    this.logger = opts.logger ?? consoleLogger
  }

  /** 当前状态（测试/诊断用）。 */
  get statusOf(): PythonBridgeStatus {
    return this.status
  }

  /** 是否就绪（方法调用不被 TS 收窄——await 后仍需复查）。 */
  private isReady(): boolean {
    return this.status === 'ready'
  }

  /** 握手后的清单（start 之后可用）。 */
  get manifest(): readonly PythonToolEntry[] {
    return this.manifestValue
  }

  /** 子进程 pid（诊断/测试用；未运行 undefined）。 */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /** 在途请求数（诊断/测试用——正常路径收到响应即出队，应归零）。 */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * 启动：spawn → initialize → tools/list → 校验。失败 throw（cordis boot
   * fail-loud）。成功后状态 ready，清单可用。
   */
  async start(): Promise<readonly PythonToolEntry[]> {
    if (this.status !== 'starting') throw new Error('loom-python-bridge: start() 只能调用一次')
    const entries = await this.spawnAndHandshake()
    this.manifestValue = entries
    this.status = 'ready'
    this.settleGate(undefined)
    return entries
  }

  /** 调用一个 Python 工具（代理工具的 execute 转发到这里）。 */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed || this.status === 'dead') {
      throw new Error(
        `loom-python-bridge: Python 桥不可用——工具 "${name}" 无法调用`
        + `（状态 ${this.disposed ? 'disposed' : 'dead'}：${this.disposed ? '已随应用关闭' : `重启 ${this.restarts} 次超上限 ${this.restartLimit}，进程不再拉起`})`,
      )
    }
    if (!this.isReady()) {
      if (this.gate !== undefined) await this.gate.promise
      if (!this.isReady()) {
        throw new Error(`loom-python-bridge: Python 桥未就绪（状态 ${this.status}）——工具 "${name}" 无法调用`)
      }
    }
    if (signal?.aborted) {
      throw new Error(`loom-python-bridge: 工具 "${name}" 调用在发出前已被取消（abort）`)
    }
    const id = this.nextId
    const result = await this.request(
      'tools/call',
      { name, args: args ?? {}, callId: `py-${id}` },
      this.callTimeoutMs,
      `工具 "${name}"`,
      signal,
    )
    if (isPlainObject(result) && 'value' in result) return result.value
    return undefined
  }

  /** 关闭：杀子进程、拒绝全部 pending、停止重启计时。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer)
    this.killChild('dispose')
    this.rejectAllPending(new Error('loom-python-bridge: 桥已随应用关闭，未完成的调用全部作废'))
    this.status = 'dead'
    this.settleGate(new Error('loom-python-bridge: 桥已关闭'))
  }

  // ---- 内部：spawn / 握手 / 帧处理 ----------------------------------------

  /** spawn 一个新子进程并完成握手；成功返回清单。失败会清理半开的子进程。 */
  private async spawnAndHandshake(): Promise<readonly PythonToolEntry[]> {
    const [file, ...rest] = this.command
    const child = spawn(file!, rest, {
      ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
      env: this.env === undefined ? { ...process.env } : { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.decode = createLineDecoder()
    this.wireChild(child)
    try {
      const init = await this.request('initialize', {}, HANDSHAKE_TIMEOUT_MS, 'initialize 握手')
      validateInitializeResult(init)
      const listed = await this.request('tools/list', {}, HANDSHAKE_TIMEOUT_MS, 'tools/list 握手')
      const entries = validatePythonManifest(isPlainObject(listed) ? listed.tools : listed)
      return entries
    } catch (error) {
      // 握手失败：清掉半开的子进程（boot fail-loud 由调用方呈现）。
      this.killChild('handshake-failed')
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  private wireChild(child: ChildProcess): void {
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      let frames: Array<Record<string, unknown>>
      try {
        frames = this.decode(chunk)
      } catch (error) {
        this.logger.warn(`loom-python-bridge: ${String(error)}`)
        return
      }
      for (const frame of frames) this.handleFrame(frame)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      const text = chunk.trimEnd()
      if (text !== '') this.logger.warn(`[loom-py stderr] ${text}`)
    })
    child.on('error', error => {
      this.handleDown(`子进程无法启动：${error.message}`)
    })
    child.on('exit', (code, signal) => {
      this.handleDown(`Python 子进程退出（code=${code}${signal === null ? '' : ` signal=${signal}`}）`)
    })
  }

  private handleFrame(frame: Record<string, unknown>): void {
    if (!isPlainObject(frame)) return
    const id = frame.id
    if (typeof id !== 'number') return // v1：Python 侧不发通知，未知行忽略
    const pending = this.pending.get(id)
    if (pending === undefined || pending.settled) return
    this.pending.delete(id) // 收到响应即出队（超时/abort 已各自删除；防积累）
    if (isPlainObject(frame.error)) {
      const message = typeof frame.error.message === 'string' && frame.error.message !== ''
        ? frame.error.message
        : JSON.stringify(frame.error)
      const detail = typeof frame.error.detail === 'string' ? `（${frame.error.detail}）` : ''
      const code = typeof frame.error.code === 'number' ? ` [code ${frame.error.code}]` : ''
      this.settlePending(pending, new Error(`loom-python-bridge: ${pending.label} 失败${code}：${message}${detail}`))
      return
    }
    this.settlePending(pending, undefined, frame.result)
  }

  /** 发一个带 id 的请求并等响应（超时/abort/进程退出三路拒绝）。 */
  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    label: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const child = this.child
    const stdin = child?.stdin ?? undefined
    if (child === undefined || stdin === undefined || child.exitCode !== null || child.signalCode !== null) {
      return Promise.reject(new Error(`loom-python-bridge: Python 子进程不在运行，${label} 无法发出`))
    }
    const id = this.nextId++
    const callId = `py-${id}`
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingCall = {
        callId,
        label,
        resolve,
        reject,
        timer: undefined as unknown as NodeJS.Timeout,
        signal,
        settled: false,
      }
      const start = (): void => {
        this.pending.set(id, pending)
        pending.timer = setTimeout(() => {
          // 超时：通知对端作废（尽力而为）并拒绝。
          this.notifyCancel(callId)
          this.pending.delete(id)
          this.settlePending(pending, new Error(`loom-python-bridge: ${label} 超时（${timeoutMs}ms 无响应）`))
        }, timeoutMs)
        if (signal !== undefined) {
          pending.onAbort = () => {
            // abort：发取消通知并不再等待（结果作废）。
            this.notifyCancel(callId)
            this.pending.delete(id)
            this.settlePending(pending, new Error(`loom-python-bridge: ${label} 已取消（abort，callId=${callId}）——结果作废`))
          }
          signal.addEventListener('abort', pending.onAbort, { once: true })
        }
        try {
          stdin.write(encodeFrame({ id, method, params }))
        } catch (error) {
          this.pending.delete(id)
          this.settlePending(pending, new Error(`loom-python-bridge: ${label} 请求写入 stdin 失败：${String(error)}`))
        }
      }
      start()
    })
  }

  /** 发一个无 id 的通知（不等待响应）。 */
  private notifyCancel(callId: string): void {
    const child = this.child
    const stdin = child?.stdin ?? undefined
    if (child === undefined || stdin === undefined || child.exitCode !== null) return
    try {
      stdin.write(encodeFrame({ method: 'tools/cancel', params: { callId } }))
    } catch {
      // 子进程已亡——退出事件负责拒绝 pending，这里静默。
    }
  }

  private settlePending(pending: PendingCall, error: Error | undefined, value?: unknown): void {
    if (pending.settled) return
    pending.settled = true
    clearTimeout(pending.timer)
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    if (error !== undefined) pending.reject(error)
    else pending.resolve(value)
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      this.settlePending(pending, error)
    }
    this.pending.clear()
  }

  // ---- 内部：退出 / 重启状态机 ---------------------------------------------

  /** 子进程退出或 spawn 失败的统一入口（幂等：只处理当前子进程）。 */
  private handleDown(reason: string): void {
    const child = this.child
    if (child !== undefined) {
      child.stdout?.removeAllListeners('data')
      child.stderr?.removeAllListeners('data')
      child.removeAllListeners('error')
      child.removeAllListeners('exit')
    }
    this.child = undefined
    this.rejectAllPending(new Error(`loom-python-bridge: ${reason}——未完成的调用全部失败`))
    if (this.disposed) return
    if (this.status === 'dead') return
    if (this.restarts >= this.restartLimit) {
      this.status = 'dead'
      this.logger.warn(
        `loom-python-bridge: ${reason}，且自动重启已达上限（${this.restartLimit} 次）——Python 工具标记为不可用，后续调用将清晰报错（fail-loud）`,
      )
      this.settleGate(new Error(`loom-python-bridge: Python 子进程退出且重启超上限（${reason}）`))
      return
    }
    this.restarts += 1
    this.status = 'restarting'
    this.openGate()
    this.logger.warn(
      `loom-python-bridge: ${reason}，${RESTART_INTERVAL_MS}ms 后自动重启（第 ${this.restarts}/${this.restartLimit} 次）`,
    )
    this.restartTimer = setTimeout(() => {
      void this.spawnAndHandshake().then(
        entries => {
          this.manifestValue = entries
          this.status = 'ready'
          this.settleGate(undefined)
          this.logger.info(`loom-python-bridge: Python 子进程重启成功（pid=${this.child?.pid ?? '?'}，清单 ${entries.length} 个工具）`)
        },
        error => {
          this.logger.warn(`loom-python-bridge: 重启握手失败：${String(error)}`)
          this.handleDown(`重启握手失败：${String(error)}`)
        },
      )
    }, RESTART_INTERVAL_MS)
  }

  private killChild(reason: string): void {
    const child = this.child
    this.child = undefined
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
    child.removeAllListeners('error')
    child.removeAllListeners('exit')
    child.kill()
    this.logger.info(`loom-python-bridge: 子进程已终止（${reason}）`)
  }

  // ---- 内部：ready 门 -------------------------------------------------------

  private openGate(): void {
    if (this.gate !== undefined) return
    let settleGate!: (error?: Error) => void
    const promise = new Promise<void>((resolve, reject) => {
      settleGate = (error?: Error): void => {
        if (error === undefined) {
          resolve()
        } else {
          reject(error)
        }
      }
    })
    this.gate = { promise, settle: settleGate }
    // 吞未观察拒绝（等待方已由 call 的 await 感知；无等待方时不许 unhandledRejection）。
    void promise.catch(() => undefined)
  }

  private settleGate(error: Error | undefined): void {
    if (this.gate === undefined) return
    const gate = this.gate
    this.gate = undefined
    gate.settle(error)
  }
}

// ---------------------------------------------------------------------------
// cordis 插件
// ---------------------------------------------------------------------------

/** Cordis 插件名（loom-py 协议桥的运行时身份；包名是发行身份 dsh-python-tools）。 */
export const name = 'loom-python-bridge'

/** 挂载前提：工具注册表（代理工具注册进全局层，全部 agent 可见——v1 边界）。 */
export const inject = ['tools']

/** 插件配置 schema（env 用 z.any 透传——形状由宿主声明侧校验）。 */
export const Config = z.object({
  command: z.string().required().description('Python 启动命令（按空格拆 argv，支持引号路径），如 "python py_tools.py"'),
  cwd: z.string().description('子进程工作目录（缺省继承当前进程）'),
  env: z.any().description('附加环境变量（合并进 process.env 后传给子进程）'),
  restartLimit: z.number().default(DEFAULT_RESTART_LIMIT).description('进程退出后的自动重启上限（超出后 unavailable，fail-loud）'),
  callTimeoutMs: z.number().default(DEFAULT_CALL_TIMEOUT_MS).description('单次工具调用的超时毫秒数'),
})

/** 插件配置形态。 */
export interface PythonBridgeConfig {
  command: string
  cwd?: string
  env?: Record<string, string>
  restartLimit?: number
  callTimeoutMs?: number
}

/** bridge 提供给宿主 runtime（health 计数）/ CLI（就绪横幅）的服务形状。 */
export interface LoomPythonService {
  /** 已注册的 Python 工具名（握手清单序）。 */
  readonly toolNames: readonly string[]
  /** 直调入口（诊断/测试用；模型调用走代理工具）。 */
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}

/** bridge apply 需要的最小 ctx 形状（loose 视图）。 */
interface BridgeCtx {
  tools: { register(tool: unknown): void }
  logger: BridgeLogger
  reflect: { provide(serviceName: string, value: unknown): () => void }
  effect(register: () => () => void): unknown
}

/**
 * 挂载 Python 桥：spawn → 握手 → 校验清单 → 注册代理工具（模型可见）→
 * 提供 loomPython 服务（计数/直调）。握手失败 throw（boot fail-loud）。
 * @param ctx - 携带 tools/logger 的 cordis 上下文。
 * @param config - command/cwd/env/restartLimit/callTimeoutMs。
 */
export async function apply(ctx: Context, config: PythonBridgeConfig): Promise<void> {
  const c = ctx as unknown as BridgeCtx
  const bridge = new PythonBridge({
    command: parsePythonCommand(config.command),
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    ...(config.env === undefined ? {} : { env: config.env }),
    ...(config.restartLimit === undefined ? {} : { restartLimit: config.restartLimit }),
    ...(config.callTimeoutMs === undefined ? {} : { callTimeoutMs: config.callTimeoutMs }),
    logger: c.logger,
  })
  const manifest = await bridge.start()

  for (const entry of manifest) {
    const def = pythonEntryToToolDef(entry)
    for (const warning of def.warnings) {
      c.logger.warn(`loom-python-bridge: 工具 "${def.name}" 的 ${warning}`)
    }
    c.tools.register(proxyToolArgs(def, (args, signal) => bridge.call(def.name, args, signal)))
  }
  const service: LoomPythonService = {
    toolNames: manifest.map(entry => entry.name),
    call: (toolName, args, signal) => bridge.call(toolName, args, signal),
  }
  const unprovide = c.reflect.provide(LOOM_PYTHON_SERVICE, service)
  c.effect(() => () => {
    unprovide()
    bridge.dispose()
  })
  c.logger.info(
    `loom-python-bridge: Python 工具 ${manifest.length} 个已注册（${manifest.map(e => e.name).join(', ')}）`
    + `——command "${config.command}"，pid=${bridge.pid ?? '?'}`,
  )
}

// ---- 转换器再导出（宿主/测试直接用；loom 的 openapi-import 亦反向复用） ------
export { jsonSchemaToDsl } from './convert.js'
export type { ConvertContext } from './convert.js'

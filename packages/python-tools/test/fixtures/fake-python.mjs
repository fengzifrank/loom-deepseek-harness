/**
 * 假 loom-py 子进程（node 模拟 python stdio 协议）——python-bridge 集成测试的
 * 夹具：不依赖真 Python，永远可跑。
 *
 * 实现 loom-py v1 协议（JSON Lines over stdio，见 src/python-bridge.ts 头注释）：
 * - initialize → {protocol:'loom-py', version:1}（FAKE_PY_HANDSHAKE_FAIL=1 时
 *   故意返回错误协议——测握手校验 fail-loud）
 * - tools/list → echo / boom / die / slow 四个工具
 * - tools/call → 分发；echo 回显参数；boom 回结构化错误；die 直接退出进程
 *   （模拟崩溃——pending 由桥的 exit 事件拒绝）；slow 睡眠后回显（测超时）
 * - tools/cancel → 忽略（尽力而为语义）
 */
import process from 'node:process'

const PROTOCOL_OK = process.env.FAKE_PY_HANDSHAKE_FAIL !== '1'

const TOOLS = [
  {
    name: 'echo',
    description: '回显参数（集成测试用）',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '要回显的文本' },
        times: { type: 'integer', description: '重复次数（默认 1）' },
      },
      required: ['message'],
    },
    output: {
      type: 'object',
      properties: { message: { type: 'string' }, times: { type: 'integer' } },
      required: ['message', 'times'],
    },
  },
  {
    name: 'boom',
    description: '必然失败（错误映射测试用）',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'die',
    description: '让子进程立即退出（故障注入测试用）',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'slow',
    description: '睡眠 ms 毫秒后回显（超时/取消测试用）',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string' }, ms: { type: 'integer' } },
      required: ['message'],
    },
  },
]

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`)
}

function replyError(id, error) {
  process.stdout.write(`${JSON.stringify({ id, error })}\n`)
}

async function callTool(name, args) {
  if (name === 'echo') {
    const times = Number(args.times ?? 1)
    return { value: { message: String(args.message ?? ''), times } }
  }
  if (name === 'boom') {
    return { __error: { code: 0, message: '演示错误：boom 工具必然失败', type: 'FakeError', detail: 'fake-python.mjs:1 in boom' } }
  }
  if (name === 'die') {
    process.exit(1) // 模拟崩溃：不回复（pending 由桥的 exit 事件拒绝）
  }
  if (name === 'slow') {
    await new Promise(resolve => setTimeout(resolve, Number(args.ms ?? 8000)))
    return { value: { message: String(args.message ?? ''), slept: true } }
  }
  return { __error: { code: -32602, message: `未知工具：${name}` } }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line === '') continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      replyError(null, { code: -32700, message: `请求行不是合法 JSON：${line.slice(0, 60)}` })
      continue
    }
    if (message.id === undefined) continue // 通知（tools/cancel 等）：忽略
    if (message.method === 'initialize') {
      if (PROTOCOL_OK) reply(message.id, { protocol: 'loom-py', version: 1 })
      else reply(message.id, { protocol: 'not-loom-py', version: 99 })
      continue
    }
    if (message.method === 'tools/list') {
      reply(message.id, { tools: TOOLS })
      continue
    }
    if (message.method === 'tools/call') {
      void callTool(message.params?.name, message.params?.args ?? {}).then(
        result => {
          if (result && typeof result === 'object' && '__error' in result) replyError(message.id, result.__error)
          else reply(message.id, result)
        },
        error => replyError(message.id, { code: 0, message: String(error) }),
      )
      continue
    }
    replyError(message.id, { code: -32601, message: `未知 method：${String(message.method)}` })
  }
})

process.stderr.write('[fake-python] ready\n')

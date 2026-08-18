/**
 * dsh-python-tools 测试（自 @loom-sdk/web 迁入，M8 插件化）（**不依赖真 Python，永远可跑**）：
 *
 * 1. 纯函数：命令解析 / 帧编解码 / 握手校验 / 清单校验（含非法清单拒绝）/
 *    jsonSchema→DSL 映射 / DSL 规格化；
 * 2. 假子进程集成：node 脚本模拟 loom-py 协议（fixtures/fake-python.mjs）→
 *    起桥 → 清单 → 调用往返 → 错误映射 → 超时 → abort 取消；
 * 3. 故障注入：杀子进程 → pending 清晰失败 → 自动重启（新 pid）→ 超上限后
 *    unavailable（全部在单测内完成，不靠真服务）；
 * 4. 握手 fail-loud：对端协议不匹配 → start() 拒绝。
 */
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_RESTART_LIMIT,
  PythonBridge,
  createLineDecoder,
  encodeFrame,
  parsePythonCommand,
  pythonEntryToToolDef,
  proxyToolArgs,
  validateInitializeResult,
  validatePythonManifest,
  normalizePythonDsl,
  type PythonBridgeOptions,
} from '../src/index.js'

const FAKE_PYTHON = fileURLToPath(new URL('./fixtures/fake-python.mjs', import.meta.url))

/** 静默 logger（测试输出干净；故障注入断言靠状态而非日志）。 */
const silentLogger = { info: () => undefined, warn: () => undefined }

function fakeBridgeOpts(extra: Partial<PythonBridgeOptions> = {}): PythonBridgeOptions {
  return {
    command: [process.execPath, FAKE_PYTHON],
    logger: silentLogger,
    ...extra,
  }
}

/** 轮询等待条件成立（重启时序异步；超时抛错）。 */
async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`等待 ${label} 超时（${timeoutMs}ms）`)
    await new Promise(resolve => setTimeout(resolve, 60))
  }
}

// ---------------------------------------------------------------------------
// 1. 纯函数
// ---------------------------------------------------------------------------

describe('parsePythonCommand（argv 解析）', () => {
  it('按空格拆分', () => {
    expect(parsePythonCommand('python py_tools.py')).toEqual(['python', 'py_tools.py'])
  })
  it('双引号路径含空格保持一段', () => {
    expect(parsePythonCommand('"C:\\Program Files\\Python313\\python.exe" -u py_tools.py')).toEqual([
      'C:\\Program Files\\Python313\\python.exe',
      '-u',
      'py_tools.py',
    ])
  })
  it('单引号同样支持；多余空白容忍', () => {
    expect(parsePythonCommand(`  'D:/my tools/python.exe'   run.py  `)).toEqual(['D:/my tools/python.exe', 'run.py'])
  })
  it('空/非字符串 → 中文报错', () => {
    expect(() => parsePythonCommand('')).toThrow('command 必须是非空字符串')
    expect(() => parsePythonCommand('   ')).toThrow()
  })
})

describe('帧编解码（JSON Lines）', () => {
  it('encodeFrame：JSON + 换行', () => {
    expect(encodeFrame({ id: 1, method: 'initialize', params: {} })).toBe('{"id":1,"method":"initialize","params":{}}\n')
  })
  it('解码：整行、多行一包、跨包切半、\\r\\n、空行', () => {
    const decode = createLineDecoder()
    expect(decode('{"id":1,"result":{"value":42}}\n')).toEqual([{ id: 1, result: { value: 42 } }])
    expect(decode('{"id":2,"result":1}\r\n{"id":3,"result":2}\n\n')).toEqual([
      { id: 2, result: 1 },
      { id: 3, result: 2 },
    ])
    expect(decode('{"id":4,"res')).toEqual([])
    expect(decode('ult":null}\n')).toEqual([{ id: 4, result: null }])
  })
  it('非法 JSON → throw（行内容定位）', () => {
    const decode = createLineDecoder()
    expect(() => decode('not-json\n')).toThrow('协议行不是合法 JSON')
  })
})

describe('validateInitializeResult（握手校验）', () => {
  it('接受 {protocol:"loom-py", version:1}', () => {
    expect(() => validateInitializeResult({ protocol: 'loom-py', version: 1 })).not.toThrow()
  })
  it('协议名/版本不匹配 → 中文报错', () => {
    expect(() => validateInitializeResult({ protocol: 'not-loom-py', version: 1 })).toThrow('对端 protocol 应为 "loom-py"')
    expect(() => validateInitializeResult({ protocol: 'loom-py', version: 99 })).toThrow('协议版本不兼容')
    expect(() => validateInitializeResult('x')).toThrow('initialize 结果必须是对象')
  })
})

describe('validatePythonManifest（清单校验）', () => {
  const validEntry = {
    name: 'gis_area_stats',
    description: '统计',
    parameters: { type: 'object', properties: { precision: { type: 'integer' } } },
    output: { type: 'object', properties: { villages: { type: 'integer' } }, required: ['villages'] },
  }

  it('合法清单通过（output 可缺省）', () => {
    const entries = validatePythonManifest([validEntry, { name: 'plain', description: '无参数无输出' }])
    expect(entries.map(e => e.name)).toEqual(['gis_area_stats', 'plain'])
    expect(entries[1]!.parameters).toEqual({})
    expect(entries[1]!.output).toBeUndefined()
  })
  it('非数组 / 空清单 / 非对象项 → 拒绝', () => {
    expect(() => validatePythonManifest('x')).toThrow('tools/list 结果必须是数组')
    expect(() => validatePythonManifest([])).toThrow('清单为空')
    expect(() => validatePythonManifest([42])).toThrow('第 0 项不是 JSON 对象')
  })
  it('name 缺失/非法/重复 → 中文报错', () => {
    expect(() => validatePythonManifest([{ description: 'x' }])).toThrow('缺少非空字符串 name')
    expect(() => validatePythonManifest([{ name: 'bad-name!', description: 'x' }])).toThrow('不合法')
    expect(() => validatePythonManifest([{ name: 'a', description: 'x' }, { name: 'a', description: 'y' }])).toThrow('重复')
  })
  it('description/parameters/output 形状 → 拒绝', () => {
    expect(() => validatePythonManifest([{ name: 'a', description: '' }])).toThrow('缺少非空 description')
    expect(() => validatePythonManifest([{ name: 'a', description: 'x', parameters: 'nope' }])).toThrow('parameters 必须是 JSON Schema 对象')
    expect(() => validatePythonManifest([{ name: 'a', description: 'x', output: [] }])).toThrow('output 必须是 JSON Schema 对象')
  })
})

describe('pythonEntryToToolDef（jsonSchema → Loom DSL）', () => {
  it('parameters：object 根 → 属性表（root required 下沉到字段级）', () => {
    const def = pythonEntryToToolDef({
      name: 'echo',
      description: '回显',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '文本' },
          times: { type: 'integer' },
        },
        required: ['message'],
      },
      output: undefined,
    })
    expect(def.parameters).toEqual({
      message: { type: 'string', description: '文本', required: true },
      times: { type: 'integer' },
    })
    expect(def.output).toEqual({ type: 'json' }) // 未声明输出 → 任意 JSON
    expect(def.warnings).toEqual([])
  })

  it('output：required 数组 → 字段级 required:true（与 normalizeDsl 对齐）', () => {
    const def = pythonEntryToToolDef({
      name: 'stats',
      description: '统计',
      parameters: { type: 'object', properties: {} },
      output: {
        type: 'object',
        properties: {
          meanRatioPct: { type: 'number' },
          stdRatioPct: { type: 'number' },
        },
        required: ['meanRatioPct', 'stdRatioPct'],
      },
    })
    expect(def.output).toEqual({
      type: 'object',
      properties: {
        meanRatioPct: { type: 'number', required: true },
        stdRatioPct: { type: 'number', required: true },
      },
    })
  })

  it('parameters 非 object 根 → 整体收进单字段 input 并注明', () => {
    const def = pythonEntryToToolDef({
      name: 'odd',
      description: '根不是 object',
      parameters: { type: 'string' },
      output: undefined,
    })
    expect(def.parameters.input).toMatchObject({ type: 'string', required: true })
    expect(String(def.parameters.input!.description)).toContain('已整体收进单字段 input')
  })

  it('诚实降级：开放对象属性 → json + 警告收集', () => {
    const def = pythonEntryToToolDef({
      name: 'degraded',
      description: '降级演示',
      parameters: {
        type: 'object',
        properties: {
          meta: { type: 'object' }, // 无 properties 的开放 object → json
        },
      },
      output: { type: 'string', format: 'date-time' }, // format 约束丢弃
    })
    expect(def.parameters.meta).toEqual({ type: 'json' })
    expect(def.output).toEqual({ type: 'string' })
    expect(def.warnings.some(w => w.includes('开放对象'))).toBe(true)
    expect(def.warnings.some(w => w.includes('format'))).toBe(true)
  })

  it('嵌套 array items / 嵌套 object required 都正确下沉', () => {
    const def = pythonEntryToToolDef({
      name: 'nested',
      description: '嵌套',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, value: { type: 'number' } },
              required: ['name'],
            },
          },
        },
        required: ['items'],
      },
      output: undefined,
    })
    expect(def.parameters.items).toEqual({
      type: 'array',
      required: true,
      items: {
        type: 'object',
        properties: { name: { type: 'string', required: true }, value: { type: 'number' } },
      },
    })
  })
})

describe('normalizePythonDsl + proxyToolArgs（注册形态）', () => {
  it('object 节点递归补 additionalProperties:false（标量不动）', () => {
    expect(normalizePythonDsl({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'object' } } })).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'object', additionalProperties: false } },
      additionalProperties: false,
    })
    expect(normalizePythonDsl({ type: 'string' })).toEqual({ type: 'string' })
  })
  it('proxyToolArgs 产出 defineTool 形状且 execute 走转发函数', async () => {
    const def = pythonEntryToToolDef({
      name: 'echo',
      description: '回显',
      parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      output: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    })
    const args = proxyToolArgs(def, async (callArgs) => ({ message: String(callArgs.message).toUpperCase() }))
    expect(args.name).toBe('echo')
    expect(String(args.description)).toContain('Python 工具')
    // defineTool 把属性表 DSL 编译成 JSON Schema（required 上浮回数组）——
    // 断言编译产物等于内核语义（字段级 required:true 被正确理解）。
    expect(args.parameters).toEqual({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    })
    const output = args.output as { schema: Record<string, unknown>; render: (a: unknown, v: unknown) => Array<Record<string, unknown>> }
    expect(output.schema.additionalProperties).toBe(false)
    const value = await (args.execute as (a: Record<string, unknown>, e: { signal?: AbortSignal }) => Promise<unknown>)({ message: 'hi' }, {})
    expect(value).toEqual({ message: 'HI' })
    expect(output.render(undefined, { message: 'HI' })).toEqual([{ type: 'text', text: '{\n  "message": "HI"\n}' }])
  })
})

// ---------------------------------------------------------------------------
// 2. 假子进程集成（永远可跑，不依赖真 Python）
// ---------------------------------------------------------------------------

describe('假子进程集成（fake-python.mjs 全链路）', () => {
  it('start()：握手 → 清单 → ready', async () => {
    const bridge = new PythonBridge(fakeBridgeOpts())
    const manifest = await bridge.start()
    try {
      expect(manifest.map(e => e.name)).toEqual(['echo', 'boom', 'die', 'slow'])
      expect(manifest[0]!.parameters).toMatchObject({ type: 'object' })
      expect(bridge.statusOf).toBe('ready')
      expect(typeof bridge.pid).toBe('number')
    } finally {
      bridge.dispose()
    }
  })

  it('call 往返：echo 回显参数；缺省参数由 Python 侧默认值补齐', async () => {
    const bridge = new PythonBridge(fakeBridgeOpts())
    await bridge.start()
    try {
      await expect(bridge.call('echo', { message: '你好，桥', times: 3 })).resolves.toEqual({ message: '你好，桥', times: 3 })
      await expect(bridge.call('echo', { message: 'x' })).resolves.toEqual({ message: 'x', times: 1 })
      // 响应出队纪律：连续调用后 pending 必须归零（防缓慢积累）。
      for (let index = 0; index < 30; index++) await bridge.call('echo', { message: `m${index}` })
      expect(bridge.pendingCount).toBe(0)
      expect(bridge.call('boom', {})).rejects.toThrow('演示错误')
      await bridge.call('boom', {}).catch(() => undefined) // 错误响应同样出队
      expect(bridge.pendingCount).toBe(0)
    } finally {
      bridge.dispose()
    }
  })

  it('错误映射：{error:{message}} → throw（消息/类型/定位透传）', async () => {
    const bridge = new PythonBridge(fakeBridgeOpts())
    await bridge.start()
    try {
      await expect(bridge.call('boom', {})).rejects.toThrow('演示错误：boom 工具必然失败')
      await expect(bridge.call('nope', {})).rejects.toThrow('未知工具')
    } finally {
      bridge.dispose()
    }
  })

  it('调用超时：callTimeoutMs 到点拒绝并放弃等待', async () => {
    const bridge = new PythonBridge(fakeBridgeOpts({ callTimeoutMs: 350 }))
    await bridge.start()
    try {
      await expect(bridge.call('slow', { message: '太慢', ms: 8000 })).rejects.toThrow('超时（350ms 无响应）')
    } finally {
      bridge.dispose()
    }
  })

  it('abort 取消：exec.signal abort → 发取消通知并不再等待（结果作废）', async () => {
    const bridge = new PythonBridge(fakeBridgeOpts({ callTimeoutMs: 20_000 }))
    await bridge.start()
    const controller = new AbortController()
    try {
      const pending = bridge.call('slow', { message: '慢慢算', ms: 8000 }, controller.signal)
      setTimeout(() => controller.abort(), 200)
      await expect(pending).rejects.toThrow('已取消（abort')
      // 桥仍可用（取消不杀伤进程）
      await expect(bridge.call('echo', { message: 'still-alive' })).resolves.toMatchObject({ message: 'still-alive' })
    } finally {
      bridge.dispose()
    }
  })

  it('dispose：后续调用清晰报错', async () => {
    const bridge = new PythonBridge(fakeBridgeOpts())
    await bridge.start()
    bridge.dispose()
    expect(bridge.statusOf).toBe('dead')
    await expect(bridge.call('echo', { message: 'x' })).rejects.toThrow('不可用')
  })
})

// ---------------------------------------------------------------------------
// 3. 故障注入（单测内完成：杀进程 → 重启 → 超上限 unavailable）
// ---------------------------------------------------------------------------

describe('故障注入（崩溃 → 自动重启 → 超上限 unavailable）', () => {
  it('die → pending 拒绝 → 1s 后自动重启（新 pid）→ 再 die → 超上限 dead', async () => {
    const bridge = new PythonBridge(fakeBridgeOpts({ restartLimit: 1 }))
    await bridge.start()
    const firstPid = bridge.pid
    try {
      // ① 正常调用
      await expect(bridge.call('echo', { message: 'before-crash' })).resolves.toMatchObject({ message: 'before-crash' })

      // ② 崩溃：die 工具让子进程退出；在途调用被清晰拒绝
      await expect(bridge.call('die', {})).rejects.toThrow('Python 子进程退出')
      expect(bridge.statusOf).toBe('restarting')

      // ③ 自动重启（间隔 1s）：状态回 ready，pid 换新
      await waitUntil(() => bridge.statusOf === 'ready', 8000, '自动重启完成')
      expect(bridge.pid).not.toBe(firstPid)
      await expect(bridge.call('echo', { message: 'revived' })).resolves.toMatchObject({ message: 'revived' })

      // ④ 第二次崩溃：restartLimit=1 已用尽 → dead，后续调用清晰报错
      await expect(bridge.call('die', {})).rejects.toThrow('Python 子进程退出')
      await waitUntil(() => bridge.statusOf === 'dead', 4000, '超上限转 dead')
      await expect(bridge.call('echo', { message: 'never' })).rejects.toThrow('不可用')
    } finally {
      bridge.dispose()
    }
  }, 30_000)

  it('重启窗口内的调用等待门：ready 后兑现', async () => {
    const bridge = new PythonBridge(fakeBridgeOpts({ restartLimit: 3 }))
    await bridge.start()
    try {
      const dying = bridge.call('die', {})
      await expect(dying).rejects.toThrow('Python 子进程退出')
      // 重启进行中发出调用 → 等待门 → 重启完成后兑现
      const queued = bridge.call('echo', { message: 'queued-during-restart' })
      await expect(queued).resolves.toMatchObject({ message: 'queued-during-restart' })
    } finally {
      bridge.dispose()
    }
  }, 30_000)
})

// ---------------------------------------------------------------------------
// 4. 握手 fail-loud
// ---------------------------------------------------------------------------

describe('握手 fail-loud', () => {
  it('对端协议不匹配 → start() 拒绝（boot 会 fail-loud）', async () => {
    const bridge = new PythonBridge(fakeBridgeOpts({
      env: { FAKE_PY_HANDSHAKE_FAIL: '1' },
    }))
    await expect(bridge.start()).rejects.toThrow('对端 protocol 应为 "loom-py"')
    expect(bridge.statusOf !== 'ready').toBe(true)
    bridge.dispose()
  })

  it('不存在的命令 → start() 拒绝且不悬挂', async () => {
    const bridge = new PythonBridge({
      command: ['definitely-not-a-real-command-xyz', FAKE_PYTHON],
      logger: silentLogger,
    })
    await expect(bridge.start()).rejects.toThrow()
    bridge.dispose()
  }, 20_000)
})

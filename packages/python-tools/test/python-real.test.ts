/**
 * dsh-python-tools 真 Python 链测试（自 @loom-sdk/web 迁入，M8 插件化）（**skipIf 无 python 解释器**——探测见 test/python-env.ts）：
 *
 * 1. spawn 真解释器跑 packages/python-tools/test/fixtures/py_demo_tools.py（loom-py 包的
 *    demo server）→ 清单（schema 推断断言：必填/缺省/无注解）→ 注册 → 调用 →
 *    UTF-8 中文往返 → 错误形状透传；
 * 2. selftest：`python -m loom_py.selftest` 子进程 exit 0 且打印
 *    "loom-py selftest OK"（cwd/PYTHONPATH 指向 packages/loom-py）。
 */
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { PythonBridge } from '../src/index.js'
import { detectPython, loomPyDir } from './python-env.js'

const PYTHON = detectPython()
const DEMO = fileURLToPath(new URL('./fixtures/py_demo_tools.py', import.meta.url))
const silentLogger = { info: () => undefined, warn: () => undefined }

describe.skipIf(PYTHON === undefined)('真 Python 链（loom_py 包 + 真解释器）', () => {
  it('spawn 真解释器：清单 schema 推断 + 调用往返 + 错误形状', async () => {
    const bridge = new PythonBridge({ command: [PYTHON!, DEMO], logger: silentLogger })
    const manifest = await bridge.start()
    try {
      // 清单：四个工具按注册序；schema 推断断言
      expect(manifest.map(entry => entry.name)).toEqual(['add', 'greet', 'plain', 'fail_always'])
      const add = manifest[0]!
      expect(add.parameters).toEqual({
        type: 'object',
        properties: { a: { type: 'integer' }, b: { type: 'integer' } },
        required: ['a'], // b 有默认值 → 非必填
      })
      const greet = manifest[1]!
      expect(greet.parameters.required).toEqual(['name']) // prefix 可空 → 非必填
      expect(greet.parameters.properties).toMatchObject({ prefix: { type: 'string' } }) // Optional[str] 落 string
      const plain = manifest[2]!
      expect(plain.parameters.properties).toMatchObject({
        x: { type: 'string', description: expect.stringContaining('无类型注解') },
      })

      // 调用往返（真管道、真 UTF-8）
      await expect(bridge.call('add', { a: 2, b: 3 })).resolves.toEqual({ total: 5 })
      await expect(bridge.call('add', { a: 7 })).resolves.toEqual({ total: 17 }) // 缺省参数
      const greeting = await bridge.call('greet', { name: '桥' }) as { greeting: string }
      expect(greeting.greeting).toBe('你好，桥！')
      await expect(bridge.call('plain', { x: 42 })).resolves.toEqual({ x: '42' })

      // 错误形状：异常类型 + 消息 + traceback 最内帧定位
      await expect(bridge.call('fail_always', {})).rejects.toThrow('RuntimeError: boom：演示错误形状')
      await expect(bridge.call('fail_always', {})).rejects.toThrow('py_demo_tools.py')
      // 未知工具：协议错误
      await expect(bridge.call('nope', {})).rejects.toThrow('未知工具')
    } finally {
      bridge.dispose()
    }
  }, 30_000)

  it('selftest：python -m loom_py.selftest → exit 0 + "loom-py selftest OK"', () => {
    const pyDir = loomPyDir()
    const result = spawnSync(PYTHON!, ['-m', 'loom_py.selftest'], {
      encoding: 'utf8',
      timeout: 30_000,
      cwd: pyDir,
      env: { ...process.env, PYTHONPATH: pyDir },
    })
    expect(result.status).toBe(0)
    expect(String(result.stdout)).toContain('loom-py selftest OK')
  }, 45_000)
})

// 无 python 环境：如实断言跳过语义（不红——探测不到不是失败）。
describe.skipIf(PYTHON !== undefined)('真 Python 链（无 python 解释器 → 跳过）', () => {
  it.skip('探测不到解释器，跳过真链测试', () => undefined)
})

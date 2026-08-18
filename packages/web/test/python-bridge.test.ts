/**
 * defineApp().python() 声明校验（M6 守门；桥本体已抽至 dsh-python-tools，见
 * packages/python-tools/test——web 侧 src/python-bridge.ts 是薄 re-export，
 * 本文件的 DEFAULT_RESTART_LIMIT 导入顺带验证 re-export 链路）。
 */
import { describe, expect, it } from 'vitest'
import { defineApp } from '../src/index.js'
import { DEFAULT_RESTART_LIMIT } from '../src/python-bridge.js'

describe('defineApp().python()（声明校验）', () => {
  it('合法声明进 spec.python（kind 标记）', () => {
    const app = defineApp('py-app')
    app.python({ command: 'python py_tools.py', restartLimit: 2, callTimeoutMs: 5000, env: { A: '1' } })
    expect(app.spec.python).toMatchObject({ kind: 'python', command: 'python py_tools.py', restartLimit: 2, callTimeoutMs: 5000, env: { A: '1' } })
  })
  it('缺省值不写入 spec（透传 undefined 语义）', () => {
    const app = defineApp('py-app2')
    app.python({ command: 'python x.py' })
    expect(app.spec.python!.restartLimit).toBeUndefined()
    expect(app.spec.python!.cwd).toBeUndefined()
  })
  it('非法 command/cwd/env/restartLimit/callTimeoutMs → 中文报错', () => {
    const app = defineApp('py-app3')
    expect(() => app.python({ command: '' })).toThrow('command 必须是非空字符串')
    expect(() => app.python({ command: 'python x.py', cwd: ' ' })).toThrow('cwd 必须是非空字符串')
    expect(() => app.python({ command: 'python x.py', env: { A: 1 as unknown as string } })).toThrow('env["A"] 必须是字符串')
    expect(() => app.python({ command: 'python x.py', restartLimit: -1 })).toThrow('restartLimit 必须是非负整数')
    expect(() => app.python({ command: 'python x.py', callTimeoutMs: 0 })).toThrow('callTimeoutMs 必须是正数')
  })
  it('重复声明拒绝（v1 单桥）', () => {
    const app = defineApp('py-app4')
    app.python({ command: 'python a.py' })
    expect(() => app.python({ command: 'python b.py' })).toThrow('重复的 app.python')
  })
  it('缺省 restartLimit 的默认值由桥层提供（DEFAULT_RESTART_LIMIT=3）', () => {
    expect(DEFAULT_RESTART_LIMIT).toBe(3)
  })
})

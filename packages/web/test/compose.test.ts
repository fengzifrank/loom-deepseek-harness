import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { composeCordisYml } from '../src/compose.js'

/** 与 compose.pluginEntryUrl 同法解析 workspace 插件包入口（B2：python-tools / web-approval-answerer）。 */
const pluginUrl = (name: string): string => pathToFileURL(createRequire(import.meta.url).resolve(name)).href

const baseOpts = {
  runtimeUrl: 'file:///F:/loom/packages/web/lib/runtime.js',
  appModuleUrl: 'file:///F:/loom/examples/gis/loom.app.ts',
  outDir: 'F:\\loom\\examples\\gis\\.loom',
  port: 4620,
  apiPrefix: '/~loom',
}

describe('composeCordisYml（policy 行差异）', () => {
  const withoutPolicy = composeCordisYml(baseOpts)
  const withPolicy = composeCordisYml({ ...baseOpts, withApproval: true })

  it('基线组合的关键行（lean 清单 + webserver + loom-runtime）', () => {
    expect(withoutPolicy).toContain("- id: logger\n  name: '@deepseek-ai/cordis-plugin-logger-console'")
    expect(withoutPolicy).toContain("- id: llm\n  name: '@deepseek-ai/dsh-llm'")
    expect(withoutPolicy).toContain("apiKeyEnv: DEEPSEEK_API_KEY")
    expect(withoutPolicy).toContain("- id: session-persistence-jsonl\n  name: '@deepseek-ai/dsh-session-persistence-jsonl'")
    expect(withoutPolicy).toContain("- id: tools\n  name: '@deepseek-ai/dsh-tools'")
    expect(withoutPolicy).toContain("- id: webserver\n  name: '@deepseek-ai/dsh-host-webserver'")
    expect(withoutPolicy).toContain(`port: ${baseOpts.port}`)
    expect(withoutPolicy).toContain(`apiPrefix: "${baseOpts.apiPrefix}"`)
    expect(withoutPolicy).toContain('file:///F:/loom/examples/gis/loom.app.ts')
    // Windows 路径转正斜杠后进 sessions root
    expect(withoutPolicy).toContain('F:/loom/examples/gis/.loom/sessions')
    // B1 消费侧：会话历史查询两行（SQLite FTS5 后端 + 模型面工具），索引落 .loom
    expect(withoutPolicy).toContain("- id: session-query-sqlite\n  name: '@deepseek-ai/dsh-session-query-sqlite'")
    expect(withoutPolicy).toContain("- id: tool-session-query\n  name: '@deepseek-ai/dsh-tool-session-query'")
    expect(withoutPolicy).toContain('F:/loom/examples/gis/.loom/session-query.db')
  })

  it('未声明 policy 时不包含 user-approval 行', () => {
    expect(withoutPolicy).not.toContain('dsh-user-approval')
    expect(withoutPolicy).not.toContain('- id: user-approval')
  })

  it('声明 policy 时新增 user-approval + web-approval-answerer 行（B2 answerer 为独立包入口）', () => {
    expect(withPolicy).toContain("- id: user-approval\n  name: '@deepseek-ai/dsh-user-approval'")
    expect(withPolicy).toContain("- id: web-approval-answerer\n  name: " + JSON.stringify(pluginUrl('dsh-web-approval-answerer')))
    // 除该块外不应引入其他差异行
    const diffLines = withPolicy.split('\n').filter(line => !withoutPolicy.split('\n').includes(line))
    const meaningful = diffLines.filter(line => !/^\s*(#|$)/.test(line))
    expect(meaningful).toEqual([
      '- id: user-approval',
      "  name: '@deepseek-ai/dsh-user-approval'",
      '- id: web-approval-answerer',
      `  name: ${JSON.stringify(pluginUrl('dsh-web-approval-answerer'))}`,
    ])
  })

  it('两份组合其余行保持一致（policy 块之外零漂移）', () => {
    const strip = (text: string): string => text
      .split('\n')
      .filter(line => !/^\s*#/.test(line) && line.trim() !== '')
      .filter(line => !line.includes('user-approval') && !line.includes('web-approval-answerer'))
      .join('\n')
    expect(strip(withPolicy)).toBe(strip(withoutPolicy))
  })
})

describe('composeCordisYml（python-bridge 行差异，M6）', () => {
  const withoutPy = composeCordisYml(baseOpts)
  const withPy = composeCordisYml({
    ...baseOpts,
    withPython: true,
    pythonConfig: { command: 'python "py_tools.py"', restartLimit: 2, env: { PYTHONPATH: 'F:/x' } },
  })

  it('未声明 app.python 时不包含 python-bridge 行', () => {
    expect(withoutPy).not.toContain('- id: python-bridge')
    expect(withoutPy).not.toContain('python-bridge.js')
  })

  it('声明时新增 python-bridge 行（B2：dsh-python-tools 独立包入口；config 原样透传）', () => {
    expect(withPy).toContain('- id: python-bridge\n  name: ' + JSON.stringify(pluginUrl('dsh-python-tools')))
    expect(withPy).toContain('    command: "python \\"py_tools.py\\""')
    expect(withPy).toContain('    restartLimit: 2')
    expect(withPy).toContain('    env:')
    expect(withPy).toContain('      "PYTHONPATH": "F:/x"')
  })

  it('除 python 块外与基线零漂移（差异行为 python-bridge 声明 + 透传 config）', () => {
    const diffLines = withPy.split('\n').filter(line => !withoutPy.split('\n').includes(line))
    const meaningful = diffLines.filter(line => !/^\s*(#|$)/.test(line))
    expect(meaningful).toEqual([
      '- id: python-bridge',
      `  name: ${JSON.stringify(pluginUrl('dsh-python-tools'))}`,
      '    command: "python \\"py_tools.py\\""',
      '    env:',
      '      "PYTHONPATH": "F:/x"',
      '    restartLimit: 2',
    ])
  })

  it('与 approval/subagent 块可共存', () => {
    const all = composeCordisYml({ ...baseOpts, withApproval: true, withSubagent: true, withPython: true, pythonConfig: { command: 'python x.py' } })
    expect(all).toContain("name: '@deepseek-ai/dsh-user-approval'")
    expect(all).toContain("name: '@deepseek-ai/dsh-subagent-spawn-in-process'")
    expect(all).toContain('- id: python-bridge')
  })
})

describe('composeCordisYml（subagent 行差异，M3）', () => {
  const withoutSub = composeCordisYml(baseOpts)
  const withSub = composeCordisYml({ ...baseOpts, withSubagent: true })
  const withBoth = composeCordisYml({ ...baseOpts, withApproval: true, withSubagent: true })

  it('未声明 subagent 时不包含 dsh-subagent 行', () => {
    expect(withoutSub).not.toContain('dsh-subagent')
    expect(withoutSub).not.toContain('- id: subagent')
  })

  it('声明 subagent 时新增服务缝 + spawn provider 两行（providerName=loom-spawn）', () => {
    expect(withSub).toContain("- id: subagent\n  name: '@deepseek-ai/dsh-subagent'")
    expect(withSub).toContain("- id: subagent-spawn-in-process\n  name: '@deepseek-ai/dsh-subagent-spawn-in-process'")
    expect(withSub).toContain('providerName: loom-spawn')
    // 不加载 dsh-tool-subagent 的全局工具行（委派工具由 runtime 按父作用域注册）。
    expect(withSub).not.toContain("- id: tool-subagent\n")
    expect(withSub).not.toContain("name: '@deepseek-ai/dsh-tool-subagent'")
  })

  it('与 approval 块可同时存在且互不干扰', () => {
    expect(withBoth).toContain("name: '@deepseek-ai/dsh-user-approval'")
    expect(withBoth).toContain("name: '@deepseek-ai/dsh-subagent'")
    expect(withBoth).toContain("name: '@deepseek-ai/dsh-subagent-spawn-in-process'")
  })

  it('除 subagent 块外与基线零漂移（差异行恰为服务缝 + spawn 两行）', () => {
    const diffLines = withSub.split('\n').filter(line => !withoutSub.split('\n').includes(line))
    const meaningful = diffLines.filter(line => !/^\s*(#|$)/.test(line))
    expect(meaningful).toEqual([
      '- id: subagent',
      "  name: '@deepseek-ai/dsh-subagent'",
      '- id: subagent-spawn-in-process',
      "  name: '@deepseek-ai/dsh-subagent-spawn-in-process'",
      '    providerName: loom-spawn',
    ])
  })
})

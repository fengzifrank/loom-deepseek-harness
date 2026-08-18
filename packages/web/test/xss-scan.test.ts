/**
 * QA #9 回归：前端渲染面静态扫描——react-ui 与示例前端不得出现原生 HTML 注入
 * （dangerouslySetInnerHTML / innerHTML / insertAdjacentHTML / document.write）。
 * React JSX 文本节点默认转义，工具参数/结果预览与消息文本全部走文本渲染；
 * 该扫描守住"未来不引入直写"的边界。DebugPanel 的 `new Function` 是投影 apply
 * 源码受信重建（服务端下发、作者声明），非用户数据注入面，不在本扫描范围。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'lib') continue
      listSourceFiles(full, out)
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const SINKS = [/dangerouslySetInnerHTML/, /\.innerHTML\b/, /insertAdjacentHTML/, /document\.write/]

describe('QA #9：前端 XSS 静态扫描', () => {
  it('react-ui 与 examples 前端源码无 HTML 注入 sink（React 默认转义生效）', () => {
    const targets = [
      ...listSourceFiles(join(ROOT, 'packages', 'web', 'src', 'react-ui')),
      ...listSourceFiles(join(ROOT, 'examples', 'gis', 'src')),
      join(ROOT, 'examples', 'gis', 'index.html'),
    ]
    expect(targets.length).toBeGreaterThan(3) // 扫描集非空（react-ui + gis 前端）
    const offenders: string[] = []
    for (const file of targets) {
      const text = readFileSync(file, 'utf8')
      for (const sink of SINKS) {
        if (sink.test(text)) offenders.push(`${file}: ${sink.source}`)
      }
    }
    expect(offenders, `发现 HTML 注入 sink：\n${offenders.join('\n')}`).toEqual([])
  })
})

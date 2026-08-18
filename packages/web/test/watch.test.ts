import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectWatchFiles, extractImportSpecifiers, isLocalSpecifier, resolveLocalImport, type WatchIo } from '../src/watch.js'

/** 内存文件系统：路径 → 内容；existsFile 以内容表为准。路径统一走 resolve（Windows 盘符一致）。 */
function memIo(files: Record<string, string>): WatchIo {
  return {
    readFile: path => {
      if (!(path in files)) throw new Error(`ENOENT ${path}`)
      return files[path]!
    },
    existsFile: path => path in files,
  }
}

const p = (...parts: string[]): string => resolve(...parts)

describe('extractImportSpecifiers', () => {
  it('静态/副作用/动态 import 与 export…from 都抽到', () => {
    const source = [
      `import { a } from './a.ts'`,
      `import './side-effect.js'`,
      `import type { T } from '../types/x'`,
      `export { b } from './b'`,
      `const mod = await import('./lazy.ts')`,
      `import fs from 'node:fs'`,
      `import z from '@deepseek-ai/schemastery'`,
    ].join('\n')
    expect([...new Set(extractImportSpecifiers(source))].sort()).toEqual([
      '../types/x', './a.ts', './b', './lazy.ts', './side-effect.js', '@deepseek-ai/schemastery', 'node:fs',
    ].sort())
  })

  it('isLocalSpecifier：只有 ./ 与 ../ 开头算本地', () => {
    expect(isLocalSpecifier('./a')).toBe(true)
    expect(isLocalSpecifier('../a')).toBe(true)
    expect(isLocalSpecifier('node:fs')).toBe(false)
    expect(isLocalSpecifier('@loom-sdk/web')).toBe(false)
    expect(isLocalSpecifier('/abs/path')).toBe(false)
  })
})

describe('resolveLocalImport', () => {
  const src = p('/loom-test/app/src')
  const io = memIo({
    [p('/loom-test/app/src/util.ts')]: '',
    [p('/loom-test/app/src/comp.tsx')]: '',
    [p('/loom-test/app/src/mod/index.ts')]: '',
    [p('/loom-test/app/src/x.js')]: '',
  })

  it('按后缀候选解析（原样 → .ts → .tsx → …）', () => {
    expect(resolveLocalImport(src, './util', io)).toBe(p('/loom-test/app/src/util.ts'))
    expect(resolveLocalImport(src, './util.ts', io)).toBe(p('/loom-test/app/src/util.ts'))
    expect(resolveLocalImport(src, './comp', io)).toBe(p('/loom-test/app/src/comp.tsx'))
  })

  it('目录索引与不存在的说明符', () => {
    expect(resolveLocalImport(src, './mod', io)).toBe(p('/loom-test/app/src/mod/index.ts'))
    expect(resolveLocalImport(src, './missing', io)).toBeUndefined()
  })
})

describe('collectWatchFiles', () => {
  it('入口 + 递归相对 import；外部包/绝对导入跳过；循环不死', () => {
    const io = memIo({
      [p('/loom-test/app/loom.app.ts')]: `import { helper } from './src/helper'\nimport z from '@deepseek-ai/schemastery'\nimport { ext } from './src/ext/index.js'`,
      [p('/loom-test/app/src/helper.ts')]: `import { deep } from './deep'\nimport { readFileSync } from 'node:fs'`,
      [p('/loom-test/app/src/deep.ts')]: `import { helper } from './helper'`, // 循环回边
      [p('/loom-test/app/src/ext/index.js')]: `export const ext = 1`,
    })
    const set = [...collectWatchFiles(p('/loom-test/app/loom.app.ts'), io)].sort()
    expect(set).toEqual([
      p('/loom-test/app/loom.app.ts'),
      p('/loom-test/app/src/deep.ts'),
      p('/loom-test/app/src/ext/index.js'),
      p('/loom-test/app/src/helper.ts'),
    ])
  })

  it('读不出的文件静默跳过（watch 是尽力而为的超集）', () => {
    const io = memIo({ [p('/loom-test/app/loom.app.ts')]: `import './gone'` })
    const set = [...collectWatchFiles(p('/loom-test/app/loom.app.ts'), io)]
    expect(set).toEqual([p('/loom-test/app/loom.app.ts')])
  })
})

/**
 * dev 热重载的 watch 集合解析（纯函数）：
 * 从入口文件出发，解析其相对 import 的本地 .ts/.tsx/.js 文件
 * （解析 import 语句即可，不必完美——外部包/别名/绝对导入一律跳过），
 * 返回应被监听的绝对路径集合（含入口自身）。
 * @module @loom-sdk/web/watch
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 文件 IO（默认真文件系统；单测注入内存实现）。 */
export interface WatchIo {
  readFile(path: string): string
  existsFile(path: string): boolean
}

const realIo: WatchIo = {
  readFile: path => readFileSync(path, 'utf8'),
  existsFile(path: string): boolean {
    try {
      readFileSync(path)
      return true
    } catch {
      return false
    }
  },
}

/** 说明符的解析候选后缀（按顺序尝试：原样 → 补后缀 → 目录索引）。 */
const EXT_CANDIDATES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const INDEX_NAMES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs']

/**
 * 抽取一段源码里的全部模块说明符：静态 import/export…from 'x'、副作用 import 'x'
 * 与动态 import('x')。正则解析，够用即可（dev watch 场景，误报只多 watch 一个文件）。
 */
export function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const fromRe = /(?:^|[^\w$.])(?:import|export)\s+(?:type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/g
  const sideEffectRe = /(?:^|[^\w$.])import\s*['"]([^'"]+)['"]/g
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const re of [fromRe, sideEffectRe, dynamicRe]) {
    for (const match of source.matchAll(re)) {
      const spec = match[1]
      if (spec !== undefined) specifiers.push(spec)
    }
  }
  return specifiers
}

/** 判断一个说明符是否是应跟随的本地相对导入。 */
export function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

/** 相对说明符 → 本地文件绝对路径（后缀/索引候选逐一尝试；全不中返回 undefined）。 */
export function resolveLocalImport(fromDir: string, specifier: string, io: WatchIo = realIo): string | undefined {
  const base = resolve(fromDir, specifier)
  for (const ext of EXT_CANDIDATES) {
    const candidate = `${base}${ext}`
    if (io.existsFile(candidate)) return candidate
  }
  for (const name of INDEX_NAMES) {
    const candidate = join(base, name)
    if (io.existsFile(candidate)) return candidate
  }
  return undefined
}

/**
 * 解析 watch 集合：入口 + 递归跟随的相对导入本地文件。
 * 解析失败（缺文件/外部包）静默跳过——watch 集合是尽力而为的超集；
 * 循环 import 由 visited 集合防死循环。
 * @param entryPath 入口文件绝对路径。
 * @param io 文件 IO（默认真文件系统；单测注入内存实现）。
 * @returns 应监听的绝对路径集合（含入口）。
 */
export function collectWatchFiles(entryPath: string, io: WatchIo = realIo): Set<string> {
  const visited = new Set<string>()
  const queue = [resolve(entryPath)]
  while (queue.length > 0) {
    const current = queue.pop()!
    if (visited.has(current)) continue
    visited.add(current)
    let source: string
    try {
      source = io.readFile(current)
    } catch {
      continue // 读不出的文件不跟随（入口缺文件由调用方报错）
    }
    for (const specifier of extractImportSpecifiers(source)) {
      if (!isLocalSpecifier(specifier)) continue
      const resolved = resolveLocalImport(dirname(current), specifier, io)
      if (resolved !== undefined && !visited.has(resolved)) queue.push(resolved)
    }
  }
  return visited
}

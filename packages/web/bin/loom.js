#!/usr/bin/env node
/**
 * loom bin 包装：pnpm/node 直接启动本文件时，先以 `node --import <tsx>`
 * 重新拉起自身（子进程内 TS 加载钩子全程生效，cli 才能动态导入 .ts 入口），
 * 再执行编译产物 lib/cli.js。tsx 经 import.meta.resolve 从本包解析；
 * main 用绝对路径而非 file:/// URL（tsx 的 resolve 钩子不认 URL 形态的
 * 主入口）。均与调用方 cwd 无关。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.env.LOOM_CLI_CHILD === '1') {
  await import('../lib/cli.js')
} else {
  const tsxRegister = import.meta.resolve('tsx')
  const cliPath = fileURLToPath(new URL('../lib/cli.js', import.meta.url))
  const result = spawnSync(
    process.execPath,
    ['--import', tsxRegister, cliPath, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, LOOM_CLI_CHILD: '1' } },
  )
  if (result.error !== undefined) throw result.error
  process.exit(result.status ?? 1)
}

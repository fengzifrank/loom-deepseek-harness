/**
 * Python 探测 helper（M6）：供 python 相关测试决定跑还是 skipIf。
 * 优先级：LOOM_TEST_PYTHON 环境变量 → python → python3 → py（取第一个
 * `--version` 成功的）。无 python 返回 undefined（调用方 skipIf）。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function detectPython(): string | undefined {
  const candidates = process.env.LOOM_TEST_PYTHON !== undefined && process.env.LOOM_TEST_PYTHON !== ''
    ? [process.env.LOOM_TEST_PYTHON]
    : ['python', 'python3', 'py']
  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 })
      if (result.status === 0) return candidate
    } catch {
      // 该候选不可用——试下一个
    }
  }
  return undefined
}

/** loom-py 包根目录（packages/loom-py；从本文件位置上溯到 packages/ 再进 loom-py）。 */
export function loomPyDir(): string {
  return fileURLToPath(new URL('../../loom-py/', import.meta.url))
}

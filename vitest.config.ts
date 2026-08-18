import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'examples/gis/tests/**/*.test.ts',
      'examples/legacy-erp/tests/**/*.test.ts',
      'examples/fastapi-admin/tests/**/*.test.ts',
    ],
    // 集成文件各自 boot 完整 cordis 应用（不同端口），文件间串行避免资源竞争。
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})

/**
 * 密钥映射：LEGACY_API_KEY → 生成物约定的 LOOM_IMPORT_TOKEN 注入位。
 *
 * loom.openapi.ts（import-openapi 生成物，零手改）在模块体顶层读取
 * `const token = process.env.LOOM_IMPORT_TOKEN`——本文件必须在它之前导入
 * （loom.app.ts 的第一条 import），把 .env 里统一配置的 LEGACY_API_KEY 映射
 * 过去。`loom dev` 的 dev-worker 会在导入应用前加载同目录 .env，所以两种
 * 启动路径（loom dev / 测试 boot）都能命中。
 */
if (process.env.LOOM_IMPORT_TOKEN === undefined && process.env.LEGACY_API_KEY !== undefined) {
  process.env.LOOM_IMPORT_TOKEN = process.env.LEGACY_API_KEY
}

export {}

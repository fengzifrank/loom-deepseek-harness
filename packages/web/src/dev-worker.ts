/**
 * loom dev 的 worker 进程（cli.ts 主进程的子进程）：
 * - serve 模式：加载 .env → 导入入口 → compose 写 .loom/cordis.yml → boot（智能体服务）。
 * - check 模式：只做模块级导入（不 boot）——热重载换新前的"新代码能过吗"预检。
 * - start 模式：生产模式 = serve + dist/ 前端静态服务（同端口 SPA fallback）。
 *
 * 本文件在 bin/loom.js 拉起的 `node --import tsx … lib/cli.js` 子进程树里运行
 * （cli.ts 经 fork 再拉起本文件，tsx 加载钩子经 execArgv 继承），可直接动态
 * 导入 .ts 的应用入口。IPC：boot 成功发 {type:'ready'}；失败发
 * {type:'boot-failed', error} 后以非零码退出；收到 {type:'shutdown'} 优雅退出。
 * @module @loom-sdk/web/dev-worker
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { boot, installFailLoud } from '@deepseek-ai/dsh-app-boot'
import type { App } from './types.js'
import { composeCordisYml } from './compose.js'
import { resolveLlm } from './providers.js'

const NAME = 'loom'

/**
 * 简易 .env 解析：只认 KEY=VALUE 行（# 注释、单双引号剥离）；
 * 已存在的环境变量不覆盖。缺文件静默（依赖宿主环境）。
 */
export function loadDotEnv(dir: string): void {
  let text: string
  try {
    text = readFileSync(resolve(dir, '.env'), 'utf8')
  } catch {
    return
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

/** 解析入口参数为绝对路径（默认 ./loom.app.ts）。 */
export function resolveEntry(entryArg: string | undefined, cwd = process.cwd()): string {
  return entryArg === undefined || !isAbsolute(entryArg) ? resolve(cwd, entryArg ?? './loom.app.ts') : entryArg
}

/** worker 模式。 */
export type WorkerMode = 'serve' | 'check' | 'start'

/** 导入应用入口并校验 default 导出形态。 */
export async function importApp(entryPath: string): Promise<App> {
  const mod = (await import(pathToFileURL(entryPath).href)) as { default?: App }
  const app = mod.default
  if (app === undefined || typeof app.tool !== 'function') {
    throw new Error(`${entryPath} 缺少 defineApp 产物的 default 导出`)
  }
  return app
}

/** 组合并启动一个 Loom 应用（serve/start 共用；start 附加 distDir 静态服务）。 */
export async function bootApp(entryPath: string, opts: { production?: boolean } = {}): Promise<void> {
  installFailLoud(NAME)
  const appDir = dirname(entryPath)
  loadDotEnv(appDir)
  const app = await importApp(entryPath)

  // .loom/ 工作区：cordis.yml + sessions/
  const loomDir = resolve(appDir, '.loom')
  mkdirSync(resolve(loomDir, 'sessions'), { recursive: true })
  const runtimeUrl = new URL('./runtime.js', import.meta.url).href
  const distDir = opts.production === true ? resolve(appDir, 'dist') : undefined
  const yml = composeCordisYml({
    runtimeUrl,
    appModuleUrl: pathToFileURL(entryPath).href,
    outDir: loomDir,
    port: app.spec.port,
    apiPrefix: app.spec.apiPrefix,
    withApproval: app.spec.policy !== undefined,
    withSubagent: app.spec.subagents.length > 0,
    withPython: app.spec.python !== undefined,
    ...(app.spec.python === undefined ? {} : { pythonConfig: app.spec.python }),
    ...(distDir === undefined ? {} : { distDir }),
    // M11：官方缺省走 dsh-llm-deepseek（向后兼容）；声明 provider 时解析为 pi-ai 路由
    //（声明期诚实失败：未知预设/缺 baseURL 直接 boot 前抛错）。
    llm: resolveLlm(app.spec),
  })
  const configPath = resolve(loomDir, 'cordis.yml')
  writeFileSync(configPath, yml, 'utf8')
  process.stderr.write(`loom: 组合已写入 ${configPath}\n`)

  const ctx = await boot(NAME, configPath)
  // M6：就绪横幅读 python-bridge 服务计数（boot 已等待 bridge 握手完成——
  // 服务缺失即组合缺 python-bridge 行，fail-loud 提示重新生成）。
  const pythonService = app.spec.python === undefined
    ? undefined
    : (ctx as unknown as { get?(service: 'loomPython'): { toolNames: readonly string[] } | undefined }).get?.('loomPython')
  process.stderr.write(
    [
      `loom: 应用 "${app.name}" 已就绪`,
      `  API    http://127.0.0.1:${app.spec.port}${app.spec.apiPrefix}/health`,
      `  agents ${app.spec.agents.map(agent => agent.id).join(' | ') || '(无)'}`,
      ...(app.spec.subagents.length === 0 ? [] : [`  subs   ${app.spec.subagents.map(sub => `${sub.id} → ${sub.visibleTo.join('/')}`).join(' | ')}`]),
      ...(app.spec.channels.length === 0 ? [] : [`  hooks  ${app.spec.channels.map(channel => `POST ${app.spec.apiPrefix}${channel.path} → ${channel.agent}`).join(' | ')}`]),
      ...(app.spec.python === undefined ? [] : pythonService === undefined
        ? [`  python ⚠ 桥服务未注册（组合缺 python-bridge 行——请重新运行 loom dev 生成组合）`]
        : [`  python ${pythonService.toolNames.length} 个工具（${pythonService.toolNames.join(', ')}）`]),
      ...(distDir === undefined ? [] : [`  web    http://127.0.0.1:${app.spec.port}/ （dist/ 静态服务，同端口 SPA fallback）`]),
      `  停止    Ctrl+C`,
      '',
    ].join('\n'),
  )
  process.send?.({ type: 'ready', port: app.spec.port })

  const shutdown = (signal: string): void => {
    process.stderr.write(`loom: 收到 ${signal}，正在关闭……\n`)
    void ctx.fiber.dispose().then(
      () => process.exit(0),
      error => {
        process.stderr.write(`loom: 关闭出错：${String(error)}\n`)
        process.exit(1)
      },
    )
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('message', message => {
    if ((message as { type?: string })?.type === 'shutdown') shutdown('shutdown')
  })
}

/** worker 入口：serve（dev）/ start（生产）/ check（热重载预检）。 */
export async function runWorker(entryArg: string | undefined, mode: WorkerMode): Promise<void> {
  const entryPath = resolveEntry(entryArg)
  if (mode === 'check') {
    try {
      loadDotEnv(dirname(entryPath))
      const app = await importApp(entryPath)
      process.stderr.write(`loom: check ok —— ${app.name}（${app.spec.tools.length} 工具 / ${app.spec.agents.length} 智能体）\n`)
    } catch (error) {
      process.stderr.write(`loom: check 失败：${String(error)}\n`)
      process.exitCode = 1
    }
    return
  }
  try {
    await bootApp(entryPath, { production: mode === 'start' })
  } catch (error) {
    process.stderr.write(`loom: 启动失败：${String(error)}\n`)
    process.send?.({ type: 'boot-failed', error: String(error) })
    process.exit(1)
  }
}

// 直接作为主模块运行时自执行（被 cli.ts import 时不触发）。
if (process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('dev-worker.js')) {
  await runWorker(process.argv[2], (process.argv[3] as WorkerMode | undefined) ?? 'serve')
}

/**
 * 由 AppSpec 生成 .loom/cordis.yml —— Loom 应用的 DeepSeek Harness 组合。
 *
 * 镜像 examples/jsonrpc-agent 的 lean 清单（去掉 bash/pty/fs/subagent/todo），
 * 加 host-webserver 与 loom-runtime 两行；凭据行镜像 minimal.cordis.yml 的
 * apiKeyEnv 做法；agent-default-model 镜像 dsh-base 的 63-67 行。
 * @module @loom-sdk/web/compose
 */

import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * 解析 workspace 插件包的入口 file:/// URL（B2 生产侧：python-tools /
 * web-approval-answerer 已抽为独立包）。从本包（@loom-sdk/web）的依赖关系解析，
 * 应用侧无需直接声明依赖。
 */
function pluginEntryUrl(packageName: string): string {
  return pathToFileURL(createRequire(import.meta.url).resolve(packageName)).href
}

/** compose 输入。 */
export interface ComposeOptions {
  /** loom-runtime 插件的 file:/// URL（@loom-sdk/web 的 lib/runtime.js）。 */
  runtimeUrl: string
  /** 应用入口（loom.app.ts）的 file:/// URL。 */
  appModuleUrl: string
  /** .loom 输出目录（绝对路径）。 */
  outDir: string
  /** webserver 端口。 */
  port: number
  /** API 前缀。 */
  apiPrefix: string
  /** 声明了 app.policy 时为 true：组合加入 user-approval 审批缝。 */
  withApproval?: boolean
  /** 声明了任一 app.subagent 时为 true：组合加入 subagent 服务缝 + spawn provider。 */
  withSubagent?: boolean
  /** 声明了 app.python 时为 true：组合加入 python-bridge 行（config 原样透传）。 */
  withPython?: boolean
  /** app.python 的配置（command/cwd/env/restartLimit/callTimeoutMs；原样透传给桥插件）。 */
  pythonConfig?: {
    command: string
    cwd?: string
    env?: Record<string, string>
    restartLimit?: number
    callTimeoutMs?: number
  }
  /** 生产模式（loom start）：dist 目录绝对路径——compose 加 frontend-static 行占用 webserver 的 SPA fallback 单席。 */
  distDir?: string
  /** B2：dsh-python-tools 入口 URL 覆盖（测试用；缺省从 @loom-sdk/web 依赖解析）。 */
  pythonBridgeUrl?: string
  /** B2：dsh-web-approval-answerer 入口 URL 覆盖（测试用；缺省从 @loom-sdk/web 依赖解析）。 */
  approvalAnswererUrl?: string
}

/** Windows 反斜杠转正斜杠（YAML/URL 安全）。 */
function toPosix(p: string): string {
  return p.split('\\').join('/')
}

/** JSON 字符串即合法 YAML 双引号标量。 */
function y(s: string): string {
  return JSON.stringify(s)
}

/**
 * 生成 cordis.yml 文本。行序无加载语义（激活由服务可用性驱动）。
 * @returns yml 文本（调用方负责写入 `<outDir>/cordis.yml`）。
 */
export function composeCordisYml(opts: ComposeOptions): string {
  const sessionsDir = toPosix(join(opts.outDir, 'sessions'))
  const approvalBlock = opts.withApproval === true
    ? `

# 策略审批缝（app.policy 声明时加入）：tools/pre-execute 的 ask 裁决经
# ctx.approval.request 路由；无 answerer fail-closed，且自动落
# approval/asked + approval/decided 审计对（packages/interaction/user-approval）。
- id: user-approval
  name: '@deepseek-ai/dsh-user-approval'

# SSE 审批 answerer（B2 生产侧抽出的独立包 dsh-web-approval-answerer）：
# approval/request → 宿主 SSE 审批卡 + 待审批留档重发 + 答复裁决（并发 409）
# + 超时 fail-closed。loom-runtime 提供 webApprovalHost 桥并消费其服务。
- id: web-approval-answerer
  name: ${y(opts.approvalAnswererUrl ?? pluginEntryUrl('dsh-web-approval-answerer'))}
`
    : ''
  const subagentBlock = opts.withSubagent === true
    ? `

# 多智能体协作缝（任一 app.subagent 声明时加入）：ctx.subagents 服务 + 进程内
# spawn provider（fresh child：独立会话、继承父 provider/model、per-child
# persona 与 toolFilter 能力齐备，见 packages/subagent/subagent-spawn-in-process）。
# 模型面的 subagent 委派工具由 loom-runtime 按 visibleTo 父 agent 作用域注册
# （精确作用域 + 只能 spawn 声明过的子规格），故不加载 dsh-tool-subagent 的
# 全局工具实例（它会把委派工具暴露给所有 agent）。
- id: subagent
  name: '@deepseek-ai/dsh-subagent'

- id: subagent-spawn-in-process
  name: '@deepseek-ai/dsh-subagent-spawn-in-process'
  config:
    providerName: loom-spawn
`
    : ''
  const pythonBlock = opts.withPython === true
    ? (() => {
        const cfg = opts.pythonConfig
        const lines = [
          '',
          '# Python 工具桥（app.python 声明时加入；B2 生产侧抽出的独立包 dsh-python-tools）：',
          '# spawn Python 子进程按 loom-py 协议（stdio JSON Lines）握手，@tool 清单注册为',
          '# 代理工具（模型可见，全部 agent 共享；进程退出自动重启，超上限 fail-loud）。',
          '# 配置原样透传自 app.python(...)。',
          '- id: python-bridge',
          `  name: ${y(opts.pythonBridgeUrl ?? pluginEntryUrl('dsh-python-tools'))}`,
          '  config:',
          `    command: ${y(cfg?.command ?? 'python')}`,
        ]
        if (cfg?.cwd !== undefined) lines.push(`    cwd: ${y(cfg.cwd)}`)
        if (cfg?.env !== undefined && Object.keys(cfg.env).length > 0) {
          lines.push('    env:')
          for (const [key, value] of Object.entries(cfg.env)) lines.push(`      ${y(key)}: ${y(value)}`)
        }
        if (cfg?.restartLimit !== undefined) lines.push(`    restartLimit: ${cfg.restartLimit}`)
        if (cfg?.callTimeoutMs !== undefined) lines.push(`    callTimeoutMs: ${cfg.callTimeoutMs}`)
        return `\n${lines.join('\n')}`
      })()
    : ''
  const distBlock = opts.distDir === undefined
    ? ''
    : `

# 生产静态服务（loom start，B1 消费侧）：frontend-static 占用 webserver 的
# SPA fallback 单席（穿越 403 / 未命中回落 index.html 200 / 非 GET|HEAD 405 /
# 未知扩展 octet-stream；index 响应过 webserver 的 index taps）。
# distIndex 保留平台原生分隔符（Windows 反斜杠经 JSON 引号转义后仍是合法
# YAML 双引号标量）——该包的穿越校验拿 resolve() 输出与 distRoot 做前缀
# 比较，POSIX 化正斜杠路径在 Windows 上会被误判为穿越（403）。
- id: frontend-static
  name: '@deepseek-ai/dsh-host-frontend-static'
  config:
    distIndex: ${y(join(opts.distDir, 'index.html'))}
`
  // M7：outDir 传给 loom-runtime——sidecar 文件（sessions-index.json / accounts.json
  // / auth-secret / memory.db）与应用同目录（.loom/）。
  const outDirBlock = `
    outDir: ${y(toPosix(opts.outDir))}`
  return `# 由 loom dev 生成 —— 请勿手改；重新运行 loom dev 会覆盖。
# 组合：lean jsonrpc-agent 清单 - bash/pty/fs/subagent/todo + host-webserver + loom-runtime
- id: logger
  name: '@deepseek-ai/cordis-plugin-logger-console'

- id: llm
  name: '@deepseek-ai/dsh-llm'

# 凭据行镜像 examples/jsonrpc-agent/minimal.cordis.yml 的 apiKeyEnv 做法；
# key 从环境变量 DEEPSEEK_API_KEY 每请求解析（CLI 已加载 entry 同目录 .env）。
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY

- id: session
  name: '@deepseek-ai/dsh-session'

# 持久化：jsonl 后端，落在应用的 .loom/sessions。
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: ${y(sessionsDir)}
    compression: 'none'

# 会话历史查询（B1 消费侧）：session-query-sqlite 挂载 ctx.sessionQuery
# （SQLite FTS5 后端，索引落 .loom/session-query.db），tool-session-query
# 注册模型面工具 session_search/session_event_search/session_trace/
# session_event_trace/session_event_read（workspace 授权：caller cwd 精确相等）。
- id: session-query-sqlite
  name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: ${y(toPosix(join(opts.outDir, 'session-query.db')))}

- id: tool-session-query
  name: '@deepseek-ai/dsh-tool-session-query'

- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    persona: ''

- id: tools
  name: '@deepseek-ai/dsh-tools'
${approvalBlock}${subagentBlock}${pythonBlock}
- id: agent
  name: '@deepseek-ai/dsh-agent'

# 镜像 dsh-base（packages/bundle/base/cordis.patch.yml 63-67 行）。
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official
    model: deepseek-v4-flash

- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  config:
    agents: []

- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: '127.0.0.1'
    port: ${opts.port}
${distBlock}
# Loom 运行时（file:/// 绝对 URL 不经基址解析，是 overlay 的唯一可靠写法）。
- id: loom-runtime
  name: ${y(opts.runtimeUrl)}
  config:
    appModule: ${y(opts.appModuleUrl)}
    apiPrefix: ${y(opts.apiPrefix)}${outDirBlock}
`
}

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
import type { ResolvedLlm } from './providers.js'
import type { McpServerSpec } from './types.js'

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
  /**
   * M11：模型提供方解析结果（resolveLlm(app.spec)；缺省/官方 = dsh-llm-deepseek
   * 现状组合，其余 = dsh-llm-pi-ai 多路由段）。缺省 deepseek-official 向后兼容。
   */
  llm?: ResolvedLlm
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
  /** MCP 服务器声明（M10；每个服务器一块 dsh-mcp-client 行）。 */
  mcpServers?: readonly McpServerSpec[]
  /**
   * 技能根目录（M12；绝对路径，dev-worker/cli 按 loom.app.ts 所在目录解析相对
   * 声明）。生成 dsh-skill + dsh-skill-filesystem（隔离模式：只扫这些目录）+
   * dsh-tool-skill（模型面 skill 工具 + 会话目录热刷新）三行。
   */
  skillDirs?: readonly string[]
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
  // M11：LLM 组合段——官方走 dsh-llm-deepseek（零配置现状），其余走 dsh-llm-pi-ai
  // 多路由（route 键 = agent-default-model 的 provider 名；机密只经 apiKeyEnv 引用）。
  const llm = opts.llm ?? { kind: 'deepseek-official' } as const
  const llmBlock = llm.kind === 'deepseek-official'
    ? `
# 凭据行镜像 examples/jsonrpc-agent/minimal.cordis.yml 的 apiKeyEnv 做法；
# key 从环境变量 DEEPSEEK_API_KEY 每请求解析（CLI 已加载 entry 同目录 .env）。
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
`
    : `\n# M11 模型网关：dsh-llm-pi-ai 多提供方路由（app.provider = "${llm.active}"）。
# 路由键即 provider 名；机密只经 apiKeyEnv 引用（每请求解析），不进本文件。
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
${llm.routes.map(route => [
  `      ${route.route}:`,
  `        api: ${route.api}`,
  ...(route.baseURL === undefined ? [] : [`        baseURL: ${y(route.baseURL)}`]),
  ...(route.apiKeyEnv === undefined ? [] : [`        apiKeyEnv: ${route.apiKeyEnv}`]),
  ...(route.headers === undefined ? [] : [
    '        headers:',
    ...Object.entries(route.headers).map(([name, value]) => `          ${y(name)}: ${y(value)}`),
  ]),
  '        models:',
  ...route.models.map(model => `          - id: ${y(model)}`),
].join('\n')).join('\n')}
`
  const agentDefaultModelBlock = llm.kind === 'deepseek-official'
    ? `    provider: deepseek-official
    model: deepseek-v4-flash`
    : `    provider: ${llm.active}
    model: ${y(llm.model)}`
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
  // M10：每个 MCP 服务器一块 dsh-mcp-client 行——工具以 mcp__<serverName>__<rawName>
  // 注册（全局层），策略/审批照常生效。机密只经 envRef/headerRefs 生成 !!js
  // process.env 引用（cordis 加载器求值），明文 env/headers 原样写入。
  const mcpBlock = (opts.mcpServers ?? []).map(server => {
    const lines = [
      '',
      `# MCP 服务器 "${server.serverName}"（app.mcp 声明）：工具以 mcp__${server.serverName}__<rawName>`,
      '# 注册到全局工具层（断线指数退避重连 + 世代回滚；HMR 热替换）。',
      `- id: mcp-${server.serverName}`,
      "  name: '@deepseek-ai/dsh-mcp-client'",
      '  config:',
      `    serverName: ${y(server.serverName)}`,
      `    transport: ${server.transport}`,
    ]
    if (server.transport === 'stdio') {
      lines.push(`    command: ${y(server.command!)}`)
      if (server.args !== undefined && server.args.length > 0) {
        lines.push('    args:')
        for (const arg of server.args) lines.push(`      - ${y(arg)}`)
      } else {
        lines.push('    args: []')
      }
      const envEntries: Array<readonly [string, string]> = [
        ...Object.entries(server.env ?? {}).map(([key, value]) => [key, y(value)] as const),
        ...(server.envRef ?? []).map(ref => [ref, `!!js process.env.${ref}`] as const),
      ]
      if (envEntries.length > 0) {
        lines.push('    env:')
        for (const [key, value] of envEntries) lines.push(`      ${y(key)}: ${value}`)
      }
      if (server.cwd !== undefined) lines.push(`    cwd: ${y(server.cwd)}`)
    } else {
      lines.push(`    url: ${y(server.url!)}`)
      const headerEntries: Array<readonly [string, string]> = [
        ...Object.entries(server.headers ?? {}).map(([name, value]) => [name, y(value)] as const),
        ...Object.entries(server.headerRefs ?? {}).map(([name, ref]) => [name, `!!js \`Bearer \${process.env.${ref}}\``] as const),
      ]
      if (headerEntries.length > 0) {
        lines.push('    headers:')
        for (const [key, value] of headerEntries) lines.push(`      ${y(key)}: ${value}`)
      }
    }
    if (server.toolCallTimeoutMs !== undefined) lines.push(`    toolCallTimeoutMs: ${server.toolCallTimeoutMs}`)
    if (server.failOnStartupError !== undefined) lines.push(`    failOnStartupError: ${server.failOnStartupError}`)
    return `\n${lines.join('\n')}`
  }).join('')
  // M12：技能文件三行——注册表 + 文件系统提供方（隔离模式：只扫应用声明的目录，
  // 不吃项目/.dsh/用户根，部署态自包含）+ 模型面 skill 工具（会话目录 + 按需加载）。
  const skillsBlock = opts.skillDirs === undefined || opts.skillDirs.length === 0
    ? ''
    : `\n# 技能文件（app.skills 声明）：SKILL.md 目录 → 模型面 skill 工具 + 会话目录
# （dsh-tool-skill：目录热刷新 digest；dsh-skill-filesystem：隔离模式只扫下面目录）。
- id: skill
  name: '@deepseek-ai/dsh-skill'

- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    includeDefaultRoots: false
    customSkillDirs:
${opts.skillDirs.map(dir => `      - ${y(dir)}`).join('\n')}

- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
`
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
${llmBlock}
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

# 会话投影缓存缝（0.1.2 起 dsh-agent / dsh-tool-session-query 的强制 peer 服务）。
- id: session-projection
  name: '@deepseek-ai/dsh-session-projection'

- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    persona: ''

- id: tools
  name: '@deepseek-ai/dsh-tools'
${approvalBlock}${subagentBlock}${pythonBlock}${mcpBlock}${skillsBlock}
- id: agent
  name: '@deepseek-ai/dsh-agent'

# 镜像 dsh-base（packages/bundle/base/cordis.patch.yml 63-67 行）；
# M11 起 provider/model 由 resolveLlm(app.spec) 决定（官方缺省 / pi-ai 路由键）。
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
${agentDefaultModelBlock}

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

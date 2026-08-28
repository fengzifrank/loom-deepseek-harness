# MCP 桥接（M10）：三行声明接入 Model Context Protocol 生态

> `app.mcp(serverName, {...})` 连接任意 MCP 服务器（stdio 子进程 / streamable-http
> 远程端点），其工具以 `mcp__<serverName>__<rawName>` 注册——与 Claude Code、Codex
> 相同的服务器限定命名形。MCP 工具在 Loom 里**就是普通工具**：策略、审批门、预算
> 照常生效。底层是内核插件 `@deepseek-ai/dsh-mcp-client`（断线指数退避重连、
> 工具列表变更重同步、注册冲突世代回滚、HMR 热替换）。

## 声明

```ts
import { defineApp } from '@loom-sdk/web'

const app = defineApp('my-app', { model: 'deepseek-v4-flash' })

// stdio 子进程（npx / uvx / python -m …）
app.mcp('github', {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  envRef: ['GITHUB_TOKEN'],              // 机密只写环境变量名
})

// 远程端点
app.mcp('docs', {
  transport: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  headerRefs: { Authorization: 'MCP_TOKEN' },
})
```

## 字段速查

| 字段 | 传输 | 说明 |
|---|---|---|
| `serverName` | 两者 | 命名空间（工具名前缀）；`[A-Za-z0-9_-]{1,32}`，存活实例内唯一 |
| `transport` | 两者 | `'stdio'` / `'streamable-http'` |
| `command` / `args` / `cwd` | stdio | spawn 配置 |
| `env` | stdio | 明文环境变量（非机密） |
| `envRef` | stdio | 机密引用（环境变量名）——生成 `!!js process.env.<name>`，机密不进 yml |
| `url` | http | MCP 端点 |
| `headers` | http | 明文请求头（非机密） |
| `headerRefs` | http | 头名 → 环境变量名——生成 `Bearer ${process.env.<name>}` 模板 |
| `toolCallTimeoutMs` | 两者 | 单次调用超时（默认 60000） |
| `failOnStartupError` | 两者 | true：连接/发现/注册失败拒绝启动（诚实失败）；默认 false 只记日志 |

## 命名与治理

工具公开名 `mcp__<serverName>__<rawName>`（规范化到 DeepSeek 函数名约定；重名折叠
会追加确定性 hash 后缀，绝不同名冲突）。两个服务器发布同名 `search` 工具时在各自
命名空间下共存。

**策略/审批/预算零成本组合**——MCP 工具流经同一 `tools/pre-execute` 管线：

```ts
app.policy({
  default: 'allow',
  rules: [
    { tool: 'mcp__github__create_issue', effect: 'approve' }, // 写操作：人工审批
    { tool: 'mcp__fs__read_*', effect: 'allow' },             // 只读：放行
  ],
  budgets: [{ kind: 'tool-calls', max: 50 }],                 // M9：每会话调用上限
})
```

## 生命周期语义（来自 dsh-mcp-client）

- 连接时等待 `listTools()` 并在组合开始首个轮次前注册全部工具；
- `notifications/tools/list_changed` → 重同步；获取失败保留上一世代；
- 断线/崩溃 → 指数退避重启原配置（初始 500ms，上限 30s，连续 10 次失败放弃并注销）；
- 连接存活超上限时长会重置重试预算（偶尔崩溃的服务器可无限恢复，崩溃循环的不会）；
- HMR：编辑 `loom.app.ts` 里的 mcp 声明 → 断开重连；serverName 不变则工具名稳定。

## v1 边界（如实）

- **全局工具层**：MCP 工具对全部 agent 可见（与 Python 桥 M6 同一边界）。按 agent
  收敛需要内核 `tools.restrict` 的 glob 语义确认，作为后续里程碑开放 `agents` 字段。
- **无 allowlist**：dsh-mcp-client 注册服务器的全部工具（Omnigent 的 per-server
  工具白名单在插件层暂无对应字段）；要收紧就用 policy 的 glob deny。
- **应用依赖**：使用 app.mcp 的应用需安装 `@deepseek-ai/dsh-mcp-client`
  （组合按 npm 名从应用 node_modules 解析，与其它 dsh-* 插件同机制）。

## 测试证据

- 单测：`packages/web/test/compose-mcp.test.ts`（声明器校验 + 两种传输的 yml 物化 +
  机密引用不落值）。
- e2e：`examples/gis/tests/mcp.e2e.test.ts`——本地 stdio echo 服务器
  （`@modelcontextprotocol/sdk` 编写）：无 key 段（boot 成功即证明连接/发现/注册，
  `failOnStartupError` 门）+ 带 key 段（真实模型轮次调用 `mcp__echo__say`，SSE 证据
  `tool/call` 参数与 `tool/result` 的 `echo: 你好`）。
- 人用示例：`examples/mcp-demo`（filesystem 服务器 + 写操作审批 + 预算）。

## 与 Omnigent 的对照（设计出处）

| Omnigent 治理层 | Loom M10 落点 |
|---|---|
| `MCPServerConfig`（stdio/http、headers、超时） | `app.mcp()` 声明（同形字段） |
| `{server}__{tool}` 命名空间 | `mcp__{server}__{tool}`（内核既有约定，兼容 Claude Code 形） |
| 策略 ASK 与 MCP elicitation 汇入同一审批管线 | MCP 工具天然过 `tools/pre-execute`（approve 规则即审批卡） |
| 断路器 + 重连退避 | dsh-mcp-client 原生（世代回滚语义更严） |
| per-server 工具 allowlist | v1 未做（插件无对应字段），policy glob deny 替代 |

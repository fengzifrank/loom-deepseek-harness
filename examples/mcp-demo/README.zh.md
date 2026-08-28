# mcp-demo：三行声明接入 MCP 生态

Loom M10 MCP 桥接的最小示例。`app.mcp('fs', {...})` 连接
[@modelcontextprotocol/server-filesystem](https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem)，
其工具以 `mcp__fs__read_file` / `mcp__fs__write_file` 等名字注册（Claude Code /
Codex 同款命名形），并且**照常走 Loom 的策略与审批门**——写文件需人工批准，读放行。

## 运行

```bash
pnpm install
echo 'DEEPSEEK_API_KEY=sk-...' > .env   # 模型 key（本地 .env，已被 .gitignore）
mkdir workspace                          # filesystem 服务器的根目录
pnpm loom dev                            # http://127.0.0.1:4620/~loom/health
```

首次启动 npx 会下载 server-filesystem（需要网络）。boot 成功即完成连接 +
工具发现 + 注册（`failOnStartupError: true` 把失败变成启动错误而不是静默空集）。

## 试一下

对 `file-assistant` 说：

- "列一下 workspace 目录" → 模型调 `mcp__fs__list_directory`（策略放行）
- "把'会议纪要：周三评审'写进 notes.md" → `mcp__fs__write_file` 弹审批卡（approve → 落盘）

## 换一个 MCP 服务器

stdio 子进程（npx/uvx/python）或 streamable-http 远程端点都支持：

```ts
app.mcp('github', {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  envRef: ['GITHUB_TOKEN'],           // 机密只写环境变量名——不进 cordis.yml
})

app.mcp('remote', {
  transport: 'streamable-http',
  url: 'http://mcp.internal:3000/mcp',
  headerRefs: { Authorization: 'MCP_TOKEN' }, // 生成 !!js `Bearer ${process.env.MCP_TOKEN}`
})
```

## v1 边界（如实）

- MCP 工具注册在**全局工具层**：全部 agent 可见（与 Python 桥一致）。按 agent 收敛
  是后续里程碑（内核 restrict 语义确认后开放 `agents` 字段）。
- 策略/审批/预算对 MCP 工具完整生效（它们就是普通工具）。
- 详见 [docs/mcp.zh.md](../../docs/mcp.zh.md)。

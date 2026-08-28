/**
 * MCP e2e 用的本地 stdio echo 服务器（M10）。
 *
 * 一个工具 say { text } → "echo: {text}"。stdout 是协议通道（SDK 独占），
 * 绝不 console.log。由 dsh-mcp-client 以 command/args spawn。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'echo', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'say',
      description: '回显文本（e2e 专用）',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async request => ({
  content: [{ type: 'text', text: `echo: ${String(request.params.arguments?.text ?? '')}` }],
}))

await server.connect(new StdioServerTransport())

import { describe, expect, it } from 'vitest'
import { composeCordisYml } from '../src/compose.js'
import { defineApp } from '../src/index.js'

const baseOpts = {
  runtimeUrl: 'file:///runtime.js',
  appModuleUrl: 'file:///app.ts',
  outDir: '/tmp/.loom',
  port: 4620,
  apiPrefix: '/~loom',
}

describe('app.mcp 声明器校验', () => {
  it('stdio 声明收集进 spec.mcps', () => {
    const app = defineApp('x')
    app.mcp('github', { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], envRef: ['GITHUB_TOKEN'] })
    expect(app.spec.mcps).toEqual([{
      serverName: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      envRef: ['GITHUB_TOKEN'],
    }])
  })

  it('serverName 命名约束 / 重复拒绝 / 传输互斥字段拒绝', () => {
    const app = defineApp('x')
    expect(() => app.mcp('bad name!', { transport: 'stdio', command: 'node' })).toThrow(/serverName/)
    app.mcp('a', { transport: 'stdio', command: 'node' })
    expect(() => app.mcp('a', { transport: 'stdio', command: 'node' })).toThrow(/重复/)
    expect(() => (app as any).mcp('b', { transport: 'stdio' })).toThrow(/command/)
    expect(() => app.mcp('b', { transport: 'stdio', command: 'node', url: 'http://x' })).toThrow(/url/)
    expect(() => (app as any).mcp('b', { transport: 'streamable-http' })).toThrow(/url/)
    expect(() => app.mcp('b', { transport: 'streamable-http', url: 'http://x/mcp', command: 'node' })).toThrow(/command/)
    expect(() => app.mcp('b', { transport: 'grpc', command: 'node' })).toThrow(/transport/)
    expect(() => app.mcp('b', { transport: 'stdio', command: 'node', envRef: ['1BAD'] })).toThrow(/envRef/)
    expect(() => app.mcp('b', { transport: 'streamable-http', url: 'http://x', headerRefs: { Authorization: 'a-b' } })).toThrow(/headerRefs/)
  })
})

describe('composeCordisYml：MCP 块', () => {
  it('无声明时无 mcp 行（字节级向后兼容）', () => {
    expect(composeCordisYml(baseOpts)).not.toContain('dsh-mcp-client')
  })

  it('stdio：serverName/transport/command/args/env 明文与 envRef 机密引用', () => {
    const yml = composeCordisYml({
      ...baseOpts,
      mcpServers: [{
        serverName: 'github',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { DEBUG: 'mcp' },
        envRef: ['GITHUB_TOKEN'],
        failOnStartupError: true,
      }],
    })
    expect(yml).toContain('- id: mcp-github')
    expect(yml).toContain("name: '@deepseek-ai/dsh-mcp-client'")
    expect(yml).toContain('serverName: "github"')
    expect(yml).toContain('transport: stdio')
    expect(yml).toContain('command: "npx"')
    expect(yml).toContain('- "-y"')
    expect(yml).toContain('"DEBUG": "mcp"')
    expect(yml).toContain('"GITHUB_TOKEN": !!js process.env.GITHUB_TOKEN')
    expect(yml).toContain('failOnStartupError: true')
    // 机密引用是环境变量名展开，不是值
    expect(yml).not.toMatch(/ghp_[A-Za-z0-9]/)
  })

  it('streamable-http：url + headers 明文与 headerRefs Bearer 模板', () => {
    const yml = composeCordisYml({
      ...baseOpts,
      mcpServers: [{
        serverName: 'web',
        transport: 'streamable-http',
        url: 'http://localhost:3000/mcp',
        headers: { 'X-Team': 'loom' },
        headerRefs: { Authorization: 'MCP_TOKEN' },
        toolCallTimeoutMs: 30000,
      }],
    })
    expect(yml).toContain('- id: mcp-web')
    expect(yml).toContain('transport: streamable-http')
    expect(yml).toContain('url: "http://localhost:3000/mcp"')
    expect(yml).toContain('"X-Team": "loom"')
    expect(yml).toContain('"Authorization": !!js `Bearer ${process.env.MCP_TOKEN}`')
    expect(yml).toContain('toolCallTimeoutMs: 30000')
  })
})

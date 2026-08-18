import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SCAFFOLD_FILES, scaffoldApp, sdkSpecFor } from '../src/scaffold.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempParent(): string {
  const dir = mkdtempSync(join(tmpdir(), 'loom-scaffold-'))
  tempDirs.push(dir)
  return dir
}

describe('scaffoldApp（临时目录真文件系统）', () => {
  it('生成文件清单齐全且关键内容正确', () => {
    const parent = tempParent()
    const appDir = scaffoldApp({ name: 'demo', parentDir: parent, sdkSpec: 'workspace:*' })
    for (const file of SCAFFOLD_FILES) {
      expect(existsSync(join(appDir, file)), `缺文件 ${file}`).toBe(true)
    }

    const loomApp = readFileSync(join(appDir, 'loom.app.ts'), 'utf8')
    expect(loomApp).toContain(`defineApp('demo'`)
    expect(loomApp).toContain(`.tool('now')`)
    expect(loomApp).toContain(`app.agent('assistant'`)
    expect(loomApp).toContain('export default app')
    expect(loomApp.split('\n').length).toBeLessThan(20) // ~15 行 hello world

    const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(pkg.scripts.dev).toBe('loom dev')
    expect(pkg.scripts.build).toBe('vite build')
    expect(pkg.scripts.start).toBe('loom start')
    expect(pkg.dependencies['@loom-sdk/web']).toBe('workspace:*')
    expect(pkg.dependencies.react).toBeDefined()
    expect(pkg.dependencies['@deepseek-ai/dsh-host-webserver']).toBeDefined() // lean 组合所需
    expect(pkg.devDependencies.vite).toBeDefined()

    const appTsx = readFileSync(join(appDir, 'src/App.tsx'), 'utf8')
    expect(appTsx).toContain(`useAgentSession('assistant')`)
    expect(appTsx).toContain(`@loom-sdk/web/react-ui`)

    const envExample = readFileSync(join(appDir, '.env.example'), 'utf8')
    expect(envExample).toContain('DEEPSEEK_API_KEY')

    const viteConfig = readFileSync(join(appDir, 'vite.config.ts'), 'utf8')
    expect(viteConfig).toContain(`'/~loom'`)
  })

  it('应用名必须是 kebab-case；已存在的应用不覆盖', () => {
    const parent = tempParent()
    expect(() => scaffoldApp({ name: 'MyApp', parentDir: parent, sdkSpec: 'workspace:*' })).toThrow(/kebab-case/)
    scaffoldApp({ name: 'demo', parentDir: parent, sdkSpec: 'workspace:*' })
    expect(() => scaffoldApp({ name: 'demo', parentDir: parent, sdkSpec: 'workspace:*' })).toThrow(/不覆盖/)
  })

  it('注入 write/mkdir 的纯内存模式也能产出同一清单', () => {
    const written = new Map<string, string>()
    const dirs: string[] = []
    const parent = resolve('/virtual')
    scaffoldApp({
      name: 'mem-demo',
      parentDir: parent,
      sdkSpec: 'file:../../packages/web',
      write: (path, content) => written.set(path.replaceAll('\\', '/'), content),
      mkdir: dir => dirs.push(dir.replaceAll('\\', '/')),
    })
    expect(written.size).toBe(SCAFFOLD_FILES.length)
    expect(written.get(join(parent, 'mem-demo', 'package.json').replaceAll('\\', '/'))).toContain('"file:../../packages/web"')
    expect(dirs.length).toBeGreaterThan(0)
  })
})

describe('sdkSpecFor', () => {
  it('workspace 内（找到含 packages/web 的 pnpm-workspace.yaml）→ workspace:*', () => {
    // 本单测运行于 loom workspace 内（packages/web/test）
    expect(sdkSpecFor(process.cwd())).toBe('workspace:*')
  })

  it('临时目录（无 workspace 祖先）→ file: 相对路径指回', () => {
    const parent = tempParent()
    const spec = sdkSpecFor(parent)
    expect(spec.startsWith('file:')).toBe(true)
  })
})

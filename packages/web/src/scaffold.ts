/**
 * `loom new <name>` 脚手架：在目标目录生成一个可直接 `pnpm i && pnpm loom dev`
 * 跑起来的最小 Loom 应用（1 个 now 工具 + 1 个 assistant 智能体 + 极简前端）。
 * 纯函数（文件内容全部内联），单测在临时目录断言文件清单与关键内容。
 * @module @loom-sdk/web/scaffold
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 脚手架生成的文件清单（相对应用目录）。 */
export const SCAFFOLD_FILES = [
  'loom.app.ts',
  'package.json',
  'index.html',
  'vite.config.ts',
  'tsconfig.json',
  '.env.example',
  'README.md',
  'src/main.tsx',
  'src/App.tsx',
  'src/style.css',
] as const

/** 内核组合（compose 生成的 lean 清单）所需的运行时依赖（与 gis 示例同一组已验证版本）。 */
const RUNTIME_DEPS: Record<string, string> = {
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/cordis-plugin-logger-console': '1.0.1',
  '@deepseek-ai/dsh-agent': '0.1.0-rc.6',
  '@deepseek-ai/dsh-agent-default-model': '0.1.0-rc.6',
  '@deepseek-ai/dsh-agent-loop': '0.1.0-rc.6',
  '@deepseek-ai/dsh-app-boot': '0.1.0-rc.6',
  '@deepseek-ai/dsh-home-paths': '0.1.0-rc.6',
  '@deepseek-ai/dsh-host-webserver': '0.1.0-rc.6',
  '@deepseek-ai/dsh-invariants': '0.1.0-rc.6',
  '@deepseek-ai/dsh-launch-environment': '0.1.0-rc.6',
  '@deepseek-ai/dsh-llm': '0.1.0-rc.6',
  '@deepseek-ai/dsh-llm-deepseek': '0.1.0-rc.6',
  '@deepseek-ai/dsh-scope': '0.1.0-rc.6',
  '@deepseek-ai/dsh-session': '0.1.0-rc.6',
  '@deepseek-ai/dsh-session-persistence': '0.1.0-rc.6',
  '@deepseek-ai/dsh-session-persistence-jsonl': '0.1.0-rc.6',
  '@deepseek-ai/dsh-settings': '0.1.0-rc.6',
  '@deepseek-ai/dsh-system-prompt': '0.1.0-rc.6',
  '@deepseek-ai/dsh-tools': '0.1.0-rc.6',
  '@deepseek-ai/schemastery': '3.18.1',
  'react': '19.2.8',
  'react-dom': '19.2.8',
}

const DEV_DEPS: Record<string, string> = {
  '@types/node': '24.13.3',
  '@types/react': '19.2.18',
  '@types/react-dom': '19.2.4',
  '@vitejs/plugin-react': '6.0.5',
  'tsx': '4.23.12',
  'typescript': '5.9.3',
  'vite': '8.2.1',
}

/** scaffold 输入。 */
export interface ScaffoldOptions {
  /** 应用名（目录名与 defineApp 名）。 */
  name: string
  /** 目标父目录（生成 <parent>/<name>/）。默认 process.cwd()。 */
  parentDir?: string
  /** @loom-sdk/web 的依赖写法（workspace 内 workspace:*，否则 file: 指回）。 */
  sdkSpec: string
  /** 写文件函数（默认真文件系统；单测注入）。 */
  write?: (path: string, content: string) => void
  /** 建目录函数（默认真文件系统）。 */
  mkdir?: (path: string) => void
}

/** 单文件内容表（name 注入标题/包名）。 */
export function scaffoldFiles(name: string, sdkSpec: string): Record<string, string> {
  const loomApp = `import z from '@deepseek-ai/schemastery'
import { defineApp } from '@loom-sdk/web'

const app = defineApp('${name}', { model: 'deepseek-v4-flash' })

app
  .tool('now')
  .description('获取服务器当前时间（ISO 8601）')
  .output(z.object({ iso: z.string(), text: z.string() }))
  .execute(async () => ({ iso: new Date().toISOString(), text: new Date().toLocaleString('zh-CN') }))

app.agent('assistant', {
  persona: '你是贴心的中文助手。涉及"现在几点/今天日期"时先调用 now 工具，不要编造时间；其余问题直接简洁作答。',
  tools: ['now'],
})

export default app
`
  const pkg = {
    name,
    private: true,
    version: '0.1.0',
    type: 'module',
    scripts: {
      dev: 'loom dev',
      build: 'vite build',
      start: 'loom start',
    },
    dependencies: {
      '@loom-sdk/web': sdkSpec,
      ...RUNTIME_DEPS,
    },
    devDependencies: DEV_DEPS,
  }
  const indexHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${name} · Loom</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
`
  const viteConfig = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// /~loom 同源代理到 loom dev 的智能体服务（4620，SSE 流式直通）。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/~loom': { target: 'http://127.0.0.1:4620', changeOrigin: false },
    },
  },
})
`
  const tsconfig = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts", "loom.app.ts"]
}
`
  const envExample = `# DeepSeek API Key（写入本目录 .env；没有 key 也能 loom dev 起 health，只是不能对话）
DEEPSEEK_API_KEY=sk-你的key
`
  const readme = `# ${name}

由 \`loom new\` 生成的 Loom 应用。

\`\`\`bash
pnpm i
pnpm loom dev        # 一条命令：智能体服务(4620) + 前端(5173)
\`\`\`

- 浏览器打开 http://localhost:5173 与 assistant 聊天；工具声明在 \`loom.app.ts\`。
- 无 key：health 仍可访问（curl http://127.0.0.1:4620/~loom/health），对话需要 \`.env\` 里的 DEEPSEEK_API_KEY。
- 生产：\`pnpm loom build && pnpm loom start\` → 同端口 4620 出 dist 页面。
`
  const mainTsx = `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './style.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`
  const appTsx = `import { useRef, useState } from 'react'
import { useAgentSession } from '@loom-sdk/web/react'
import { ChatStream } from '@loom-sdk/web/react-ui'

export default function App() {
  const [draft, setDraft] = useState('')
  const { messages, status, error, send } = useAgentSession('assistant')
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = () => {
    if (draft.trim() === '') return
    send(draft)
    setDraft('')
    inputRef.current?.focus()
  }

  return (
    <div className="loom-app">
      <header className="loom-header">
        <h1>${name}</h1>
        <span className="loom-pill">{status === 'busy' ? '思考中…' : status === 'connecting' ? '连接中…' : status === 'error' ? '出错' : '就绪'}</span>
      </header>
      <ChatStream messages={messages} streamCursor={status === 'busy'} placeholder="问点什么，例如：现在几点了？" />
      {error !== null && <div className="loom-error">{error}</div>}
      <div className="loom-composer">
        <input
          ref={inputRef}
          value={draft}
          placeholder="问点什么，例如：现在几点了？"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit() }}
        />
        <button disabled={draft.trim() === '' || status === 'busy' || status === 'connecting'} onClick={submit}>
          发送
        </button>
      </div>
    </div>
  )
}
`
  const styleCss = `:root {
  color-scheme: dark;
  --bg: #0e1116;
  --panel: #161b23;
  --panel-2: #1c232e;
  --line: #263041;
  --text: #dce3ec;
  --muted: #8a96a8;
  --accent: #4f8cff;
  --ok: #3fbf7f;
  --err: #e5615c;
}

* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font: 14px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
}

.loom-app { max-width: 760px; margin: 0 auto; padding: 20px; display: flex; flex-direction: column; height: 100%; gap: 12px; }
.loom-header { display: flex; align-items: baseline; gap: 12px; }
.loom-header h1 { font-size: 20px; margin: 0; }
.loom-pill { border: 1px solid var(--line); border-radius: 999px; padding: 1px 10px; font-size: 12px; color: var(--muted); }
.loom-composer { display: flex; gap: 8px; }
.loom-composer input { flex: 1; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; color: var(--text); outline: none; }
.loom-composer input:focus { border-color: var(--accent); }
.loom-composer button { background: var(--accent); border: none; border-radius: 8px; padding: 8px 18px; color: #fff; cursor: pointer; }
.loom-composer button:disabled { opacity: 0.4; cursor: default; }
.loom-error { color: var(--err); font-size: 13px; padding: 4px 8px; }
`
  return {
    'loom.app.ts': loomApp,
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
    'index.html': indexHtml,
    'vite.config.ts': viteConfig,
    'tsconfig.json': tsconfig,
    '.env.example': envExample,
    'README.md': readme,
    'src/main.tsx': mainTsx,
    'src/App.tsx': appTsx,
    'src/style.css': styleCss,
  }
}

/**
 * 生成应用目录。目标目录已存在 loom.app.ts 时抛错（不覆盖作者文件）。
 * @returns 应用目录绝对路径。
 */
export function scaffoldApp(opts: ScaffoldOptions): string {
  const name = opts.name
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`应用名必须是 kebab-case（小写字母开头，可含数字与连字符），收到 "${name}"`)
  }
  const appDir = resolve(opts.parentDir ?? process.cwd(), name)
  const write = opts.write ?? ((path, content) => writeFileSync(path, content, 'utf8'))
  const mkdir = opts.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true }))

  const files = scaffoldFiles(name, opts.sdkSpec)
  mkdir(appDir)
  if (opts.write === undefined && existsSync(join(appDir, 'loom.app.ts'))) {
    throw new Error(`目标目录已存在应用：${join(appDir, 'loom.app.ts')}（loom new 不覆盖已有应用）`)
  }
  for (const [relPath, content] of Object.entries(files)) {
    const target = join(appDir, relPath)
    mkdir(dirname(target))
    write(target, content)
  }
  return appDir
}

/**
 * 推断 @loom-sdk/web 的依赖写法：目标在 pnpm workspace 内（向上找到含
 * packages/web 的 pnpm-workspace.yaml）→ workspace:*；否则 file: 相对路径
 * 指回本包（离线可装，指向 monorepo 检出）。
 */
export function sdkSpecFor(parentDir: string): string {
  const libDir = dirname(fileURLToPath(import.meta.url)) // …/packages/web/lib
  let dir = resolve(parentDir)
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'packages', 'web', 'package.json'))) {
      return 'workspace:*'
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const rel = relative(resolve(parentDir), dirname(libDir)).replaceAll('\\', '/')
  return `file:${rel.startsWith('..') ? rel : `./${rel}`}`
}

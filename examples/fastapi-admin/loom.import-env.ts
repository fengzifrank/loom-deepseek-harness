/**
 * 登录桥（路 2）：把 FastapiAdmin 的 JWT 认证接进 Loom——boot 时登录换 token。
 *
 * 实测事实（2026-08-19，以生成物与老系统为准）：
 * 1. 老系统 securitySchemes 是 `CustomOAuth2PasswordBearer`（type: oauth2，password
 *    flow）。`loom import-openapi` 生成器只覆盖 http/bearer 与 apiKey(header)，对
 *    oauth2 只留 TODO 注释——生成物 authHeaders() 返回空对象，**完全不带
 *    Authorization 头**。若没有本桥，导入的 15 个工具每个请求都 401。
 * 2. 生成物的 token 是模块顶层 `const token = process.env.LOOM_IMPORT_TOKEN`
 *    （每次 execute 不重读 env）——运行时改 env 对它无效。好在这条 const 对本
 *    文档是死代码（无头可注入），真正注头的是本文件包装的 fetch。
 *
 * 方案（生成物零手改、核心零改动）：本文件做三件事——
 * a) 顶层 await 登录（POST x-www-form-urlencoded）→ token 写入
 *    process.env.LOOM_IMPORT_TOKEN。loom.app.ts 把本文件放第一条 import：顶层
 *    await 会挂起"依赖它的模块"（loom.app.ts 的模块体——defineApp/工具注册），
 *    登录成功后才继续；失败则整个应用带着下面的中文报错退出，绝不静默起服务。
 *    （实测注意：顶层 await 不阻塞无依赖边的兄弟模块——生成物在登录完成前
 *    求值也无妨，它的 token const 对本文档是死代码。）
 * b) 包装 globalThis.fetch：仅对指向老系统、未自带 Authorization 的请求注入
 *    `Authorization: Bearer <当前 token>`——**每次调用实时读 env**，这正是
 *    legacy_relogin 热刷新生效的原因（绕开生成物顶层 const 的限制，token 过期
 *    无需重启 loom dev）。其它域名（如 LLM API）原样放行。
 * c) 导出 reloginLegacy() 供 legacy_relogin 工具调用。
 *
 * `.loom dev` 的 dev-worker 会在导入应用前加载同目录 .env（LEGACY_BASE_URL /
 * LEGACY_ADMIN_USER / LEGACY_ADMIN_PASS / DEEPSEEK_API_KEY）。
 */

/** 老系统基址（.env 可覆盖；缺省本机 8001）。 */
const LEGACY_BASE = (process.env.LEGACY_BASE_URL ?? 'http://127.0.0.1:8001').replace(/\/+$/, '')
/** 老系统管理员账号（.env 统一配置）。 */
const LEGACY_USER = process.env.LEGACY_ADMIN_USER ?? 'admin'
const LEGACY_PASS = process.env.LEGACY_ADMIN_PASS ?? '123456'

/** 老系统 REST 前缀（openapi servers[0].url = /api/v1，生成物基址已含）。 */
export const LEGACY_API_BASE = `${LEGACY_BASE}/api/v1`

/** 登录成功响应里我们关心的字段（Task 2 实测：{code:0, data:{access_token, expires_in}}）。 */
interface LoginOk { access_token: string, expires_in: number }

/** 连不上老系统时的重启指引（演示与测试都靠它定位环境问题）。 */
const START_HINT = [
  '请先启动 FastapiAdmin 老系统（并确认 Redis 6379 在跑），再启动本 demo：',
  '  cd <FastapiAdmin 仓库>/backend',
  '  uv run main.py run --env=dev   # 监听 http://127.0.0.1:8001',
  '  curl http://127.0.0.1:8001/openapi.json   # 探活应 200',
  '然后重新运行 pnpm dev:fa。（老系统的获取与启动详见 README.zh.md）',
].join('\n')

/** 登录老系统换 JWT（登录端点本身无需认证；错误凭据返回 HTTP 500 + code=-1）。 */
async function loginLegacy(): Promise<LoginOk> {
  let res: Response
  try {
    res = await fetch(`${LEGACY_API_BASE}/system/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: LEGACY_USER, password: LEGACY_PASS }),
    })
  } catch (error) {
    const cause = (error as Error & { cause?: { code?: string } }).cause?.code
    throw new Error(`老系统登录失败：无法连接 ${LEGACY_BASE}（${cause ?? String(error)}）。\n${START_HINT}`)
  }
  const body = (await res.json().catch(() => null)) as
    | null
    | { code?: number, msg?: string, data?: { access_token?: unknown, expires_in?: unknown } }
  if (!res.ok || body?.code !== 0 || typeof body.data?.access_token !== 'string') {
    throw new Error(
      `老系统登录失败：HTTP ${res.status}${body?.msg !== undefined && body.msg !== '' ? `——${body.msg}` : ''}`
      + `（账号 ${LEGACY_USER}；核对 examples/fastapi-admin/.env 的 LEGACY_ADMIN_USER/LEGACY_ADMIN_PASS 后重试）`,
    )
  }
  return { access_token: body.data.access_token, expires_in: typeof body.data.expires_in === 'number' ? body.data.expires_in : 43200 }
}

/** 过期时间的展示口径（expires_in=43200s → '12h'）。 */
function hoursHint(seconds: number): string {
  return `${Math.round(seconds / 3600)}h`
}

/**
 * fetch 包装（安装一次，模块尾部调用）：老系统请求缺 Authorization 时按当前
 * env 注入 Bearer。生成物 loom.openapi.ts 的 execute 用的是裸 fetch（解析到
 * globalThis.fetch），因此无需手改生成物即可带上认证。
 */
function installAuthFetch(): void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // 只处理 string/URL 入参（生成物与手写工具都是这种形态）；Request 实例原样放行。
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const token = process.env.LOOM_IMPORT_TOKEN
    if (token !== undefined && url.startsWith(LEGACY_BASE) && !url.includes('/system/auth/login')) {
      const headers = new Headers(init?.headers)
      if (!headers.has('authorization')) headers.set('authorization', `Bearer ${token}`)
      return originalFetch(input, { ...init, headers })
    }
    return originalFetch(input, init)
  }) as typeof globalThis.fetch
}

/** 重登录（legacy_relogin 工具调用）：刷新 LOOM_IMPORT_TOKEN，下一次请求即生效（无需重启）。 */
export async function reloginLegacy(): Promise<{ ok: true, user: string, expiresHint: string, refreshedAt: string }> {
  const fresh = await loginLegacy()
  process.env.LOOM_IMPORT_TOKEN = fresh.access_token
  return { ok: true, user: LEGACY_USER, expiresHint: hoursHint(fresh.expires_in), refreshedAt: new Date().toISOString() }
}

// ── boot：顶层 await 登录（loom.app.ts 的第一条 import；见文件头注释 a/b/c） ──
const first = await loginLegacy()
process.env.LOOM_IMPORT_TOKEN = first.access_token
installAuthFetch()

/** boot 登录的结果（loom.app.ts 给 legacy_relogin 的描述与日志用）。 */
export const bootLogin = { user: LEGACY_USER, expiresHint: hoursHint(first.expires_in), at: new Date().toISOString() }

/**
 * 真实老系统对接 e2e（examples/fastapi-admin）：需要【外部现成的】老系统
 * （8001）+ Redis（6379）+ .env 里的 DEEPSEEK_API_KEY——任一不满足整体自跳
 * （CI 无老系统时不红，本地全跑；老系统/Redis 由 demo 环境常驻，测试不自起
 * 也不杀）。loom 侧用 bootLoom 起在 4646（避让开发实例 4645）。
 *
 * 四条证据链：
 * 1. 查询：'列出系统里的角色' → SSE：手写工具 legacy_roles_list 被真实调用 →
 *    回答含真实角色名（超级管理员/普通用户）→ completed。
 * 2. 创建·允许：zhangsan_e2e_<时间戳> → 审批卡（args 含 role_ids:[3]）→ POST
 *    allowed-once → **老系统侧直查**（flat username 过滤，不经 loom）断言用户
 *    存在且 status=0 → completed。
 * 3. 创建·拒绝：另一用户名 → rejected → 工具 isError + 老系统侧断言不存在。
 * 4. 401 自愈：注入坏 LOOM_IMPORT_TOKEN（boot 是 in-process，与应用共享 env）→
 *    导入的查询工具 401（isError）→ 模型调 legacy_relogin（fetch 包装按次读
 *    env，热生效）→ 重试成功 → completed。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import {
  ANON_HEADERS, APP_DIR, assertUserNeverAppears, bootLoom, cleanupDir, ensureTsx, legacyBackendUp, legacyLogin,
  openEventStream, readEnv, redisUp, sdkBuilt, waitForUserAppear,
  type BootedLoom, type SseCollector,
} from './helpers.js'

const LOOM_PORT = 4646

// ── 前置探活（skipIf 判据；失败不红，整体跳过） ─────────────────────────────
const env = readEnv(APP_DIR)
const hasKey = process.env.DEEPSEEK_API_KEY !== undefined || env.DEEPSEEK_API_KEY !== undefined
// boot 是 in-process：先把 .env 的凭据放进 process.env（loom.import-env 的
// 顶层登录与 fetch 包装都从这里读）。
if (process.env.DEEPSEEK_API_KEY === undefined && env.DEEPSEEK_API_KEY !== undefined) {
  process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY
}
if (env.LEGACY_ADMIN_USER !== undefined && process.env.LEGACY_ADMIN_USER === undefined) {
  process.env.LEGACY_ADMIN_USER = env.LEGACY_ADMIN_USER
}
if (env.LEGACY_ADMIN_PASS !== undefined && process.env.LEGACY_ADMIN_PASS === undefined) {
  process.env.LEGACY_ADMIN_PASS = env.LEGACY_ADMIN_PASS
}
const backendUp = await legacyBackendUp()
const redisAlive = await redisUp()

const USER_LIST_TOOL = 'get_user_list_controller_system_user_list_get'
const USER_CREATE_TOOL = 'create_user_controller_system_user_create_post'

describe.skipIf(!hasKey || !sdkBuilt() || !backendUp || !redisAlive)('真实老系统对接 e2e（FastapiAdmin 8001 + Redis 6379 + key）', () => {
  let loom: BootedLoom | undefined
  let legacyToken = ''
  /** 老系统侧直查登录账号（.env 与 demo 同源）。 */
  const adminUser = process.env.LEGACY_ADMIN_USER ?? 'admin'
  const adminPass = process.env.LEGACY_ADMIN_PASS ?? '123456'
  /** 时间戳用户名（避开演示数据 zhangsan_demo；两个写用例各一个）。 */
  const stamp = Date.now()
  const allowUser = `zhangsan_e2e_${stamp}a`
  const rejectUser = `zhangsan_e2e_${stamp}b`

  beforeAll(async () => {
    ensureTsx()
    loom = await bootLoom({
      appModulePath: join(APP_DIR, 'loom.app.ts'),
      withApproval: true,
      port: LOOM_PORT,
      outDirName: '.loom-e2e',
    })
    legacyToken = await legacyLogin(adminUser, adminPass)
  }, 120_000)

  afterAll(async () => {
    await loom?.dispose()
    cleanupDir(resolve(APP_DIR, '.loom-e2e'))
    // 老系统（8001）与 Redis（6379）是 demo 常驻进程：不杀、不动。
  })

  async function newSession(): Promise<string> {
    const res = await fetch(`${loom!.base}/agents/admin-assistant/sessions`, { method: 'POST', headers: ANON_HEADERS })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessionId: string }
    expect(body.sessionId).toMatch(/^session-fastapi-admin-/)
    return body.sessionId
  }

  async function sendMessage(sid: string, text: string): Promise<void> {
    const res = await fetch(`${loom!.base}/agents/admin-assistant/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...ANON_HEADERS }, body: JSON.stringify({ text }),
    })
    expect(res.status).toBe(200)
  }

  function assistantText(sse: SseCollector): string {
    return sse.events.filter(e => e.type === 'assistant/message').map(e => String(e.text ?? '')).join(' ')
  }

  it('查询链：手写工具 legacy_roles_list 真实调用，回答带真实角色名', async () => {
    const sid = await newSession()
    const sse = await openEventStream(loom!.base, sid)
    try {
      await sendMessage(sid, '列出系统里的角色')

      // 证据 1：模型调了手写的角色列表工具（路 2）
      const call = await sse.wait(e => e.type === 'tool/call' && e.name === 'legacy_roles_list', 180_000, 'tool/call(legacy_roles_list)')
      expect(call.seq).toBeGreaterThan(0)

      // 证据 2：turn 完成
      await sse.wait(e => e.type === 'turn/end' && String(e.reason?.kind ?? e.reason) === 'completed', 180_000, 'turn/end completed')

      // 证据 3：回答里是老系统的真实角色名（种子数据：超级管理员/管理员/普通用户）
      const answer = assistantText(sse)
      expect(answer).toContain('超级管理员')
      expect(answer).toContain('普通用户')
    } finally {
      sse.close()
    }
  }, 420_000)

  it('允许链：创建用户 → 审批允许 → 老系统 sqlite 真实落库（侧直查）', async () => {
    const sid = await newSession()
    const sse = await openEventStream(loom!.base, sid)
    try {
      await sendMessage(sid, `创建一个新用户：直接调用 ${USER_CREATE_TOOL}（username="${allowUser}"，name="张三E2E"，password="fa-e2e-${stamp}"，role_ids=[3]，status=0），不要先向我确认，审批通过后一句话汇报结果。`)

      // 证据 1：模型调了导入的写工具，参数带 role_ids:[3]（普通用户）
      const call = await sse.wait(e => e.type === 'tool/call' && e.name === USER_CREATE_TOOL, 180_000, `tool/call(${USER_CREATE_TOOL})`)
      expect(call.args).toMatchObject({ username: allowUser, role_ids: [3] })

      // 证据 2：审批卡（真实写操作 → approve）
      const asked = await sse.wait(e => e.type === 'loom/approval-asked' && e.tool === USER_CREATE_TOOL, 30_000, 'loom/approval-asked')
      expect(typeof asked.approvalId).toBe('string')

      // 证据 3：POST 允许 → 工具真实执行成功
      const decision = await fetch(`${loom!.base}/sessions/${sid}/approvals/${asked.approvalId}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...ANON_HEADERS }, body: JSON.stringify({ decision: 'allowed-once' }),
      })
      expect(decision.status).toBe(200)
      const result = await sse.wait(e => e.type === 'tool/result' && e.callSeq === call.seq, 60_000, 'tool/result(允许后)')
      expect(result.isError).toBe(false)

      await sse.wait(e => e.type === 'turn/end' && String(e.reason?.kind ?? e.reason) === 'completed', 180_000, 'turn/end completed')

      // 证据 4（老系统侧，不经 loom）：用户真实存在、启用、挂普通用户角色。
      // 老系统 create 的落库对后续读有 ~6s 可见延迟（实测，SQLite 模式异步提交
      // ——老系统行为），轮询等待出现。
      const row = await waitForUserAppear(legacyToken, allowUser)
      expect(row, `老系统侧应存在用户 ${allowUser}`).toBeDefined()
      expect(row!.username).toBe(allowUser)
      expect(row!.status).toBe(0)
      expect(row!.role_ids).toContain(3)
    } finally {
      sse.close()
    }
  }, 420_000)

  it('拒绝链：创建用户 → 审批拒绝 → 工具 isError + 老系统侧不存在（fail-closed）', async () => {
    const sid = await newSession()
    const sse = await openEventStream(loom!.base, sid)
    try {
      await sendMessage(sid, `再创建一个用户：直接调用 ${USER_CREATE_TOOL}（username="${rejectUser}"，name="李四E2E"，password="fa-e2e-${stamp}"，role_ids=[3]，status=0），不要先向我确认，审批通过后一句话汇报结果。`)

      const call = await sse.wait(e => e.type === 'tool/call' && e.name === USER_CREATE_TOOL, 180_000, 'tool/call(拒绝路径)')
      const asked = await sse.wait(e => e.type === 'loom/approval-asked' && e.tool === USER_CREATE_TOOL, 30_000, 'loom/approval-asked(拒绝路径)')

      const decision = await fetch(`${loom!.base}/sessions/${sid}/approvals/${asked.approvalId}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...ANON_HEADERS }, body: JSON.stringify({ decision: 'rejected' }),
      })
      expect(decision.status).toBe(200)

      const result = await sse.wait(e => e.type === 'tool/result' && e.callSeq === call.seq, 60_000, 'tool/result(拒绝后)')
      expect(result.isError).toBe(true)
      expect(String(result.preview)).toContain('rejected')

      await sse.wait(e => e.type === 'turn/end', 180_000, 'turn/end(拒绝路径)')

      // fail-closed（老系统侧直查）：拒绝的写一个字没落库——覆盖可见性窗口
      // （~6s 实测延迟 + 余量）内持续缺席才算数。
      const neverAppeared = await assertUserNeverAppears(legacyToken, rejectUser)
      expect(neverAppeared, `老系统侧不应存在用户 ${rejectUser}`).toBe(true)
    } finally {
      sse.close()
    }
  }, 420_000)

  it('401 自愈链：坏 token → 导入工具 401 → legacy_relogin 热刷新 → 重试成功', async () => {
    // boot 是 in-process：直接污染共享 env——fetch 包装按次读取，下一次请求即带坏 token。
    const realToken = process.env.LOOM_IMPORT_TOKEN
    process.env.LOOM_IMPORT_TOKEN = 'invalid-fa-e2e-token'
    const sid = await newSession()
    const sse = await openEventStream(loom!.base, sid)
    try {
      await sendMessage(sid, `查询老系统的用户列表：直接调用 ${USER_LIST_TOOL}（search 传 {}，page_no=1，page_size=20）。`)

      // 证据 1：导入的查询工具被调，但带着坏 token → 401（isError）
      const call = await sse.wait(e => e.type === 'tool/call' && e.name === USER_LIST_TOOL, 180_000, 'tool/call(坏 token 首调)')
      const failed = await sse.wait(e => e.type === 'tool/result' && e.callSeq === call.seq && e.isError === true, 120_000, 'tool/result(401)')
      expect(String(failed.preview)).toContain('401')

      // 证据 2：persona 的自愈路径——模型调 legacy_relogin（fetch 包装按次读 env → 新 token 即时生效）
      const relogin = await sse.wait(e => e.type === 'tool/call' && e.name === 'legacy_relogin', 120_000, 'tool/call(legacy_relogin)')
      expect(relogin.seq).toBeGreaterThan(call.seq)

      // 证据 3：重试同一工具成功（新 token 已注入，无需重启）
      const retry = await sse.wait(e => e.type === 'tool/call' && e.name === USER_LIST_TOOL && e.seq > relogin.seq, 120_000, 'tool/call(重试)')
      const retried = await sse.wait(e => e.type === 'tool/result' && e.callSeq === retry.seq && e.isError === false, 120_000, 'tool/result(重试成功)')

      await sse.wait(e => e.type === 'turn/end' && String(e.reason?.kind ?? e.reason) === 'completed', 180_000, 'turn/end completed')

      // 环境已由 relogin 自愈（LOOM_IMPORT_TOKEN 已是新值）；兜底还原防泄漏到后续文件。
      expect(process.env.LOOM_IMPORT_TOKEN).not.toBe('invalid-fa-e2e-token')
      if (process.env.LOOM_IMPORT_TOKEN === undefined && realToken !== undefined) {
        process.env.LOOM_IMPORT_TOKEN = realToken
      }
      expect(retried.seq).toBeGreaterThan(0)
    } finally {
      sse.close()
    }
  }, 420_000)
})

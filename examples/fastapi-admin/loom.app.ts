/**
 * 真实老系统对接（examples/fastapi-admin）：把一台**真实在跑的**开源企业后台
 * [FastapiAdmin v3]（FastAPI + SQLAlchemy + Redis，SQLite 模式，端口 8001）接进
 * Loom——agent 直接查/写老系统，写操作走人工审批，全程可回放。与 legacy-erp
 * （离线模拟案例）互补，本例是旗舰"活系统"案例。
 *
 * ── 两路接入 + 登录桥（详见 README.zh.md 决策表，Task 5） ──────────────────
 *
 * 路 1【有 OpenAPI 文档 → 一键导入】活系统自带 GET /openapi.json（195 路径/
 * 198 operation）。195 个全导入不现实，`--include '*system_user*'` 聚焦用户域：
 *
 *   pnpm exec loom import-openapi http://127.0.0.1:8001/openapi.json \
 *     --base http://127.0.0.1:8001/api/v1 -o loom.openapi.ts --include '*system_user*'
 *
 * 生成 15 个工具（include 是单 glob：`*`/`?`，不支持 | 或 {}，角色域含不进来
 * ——正好由路 2 手写补位，故事更完整）。--base 必须带 /api/v1：openapi 的
 * servers[0].url 是相对前缀 "/api/v1"，生成器 --base 是整体替换不是拼接。
 * 生成日志：15 工具 / 过滤 183 / 降级警告 493 条（真实老 schema 的 pattern/
 * format/min·max 约束被诚实降级，见生成物 WARN 注释——展示点；FastAPI 的
 * Optional[X]（anyOf:[T,null]）已由生成器忠实转为 oneOf:[T,{type:'null'}]，
 * 不再降级——内核校验按类型接受 null）。
 *
 * 登录桥【JWT 这个真实痛点】老系统 securitySchemes 是 oauth2（password flow），
 * 生成器对 oauth2 只留 TODO、不带 Authorization 头；且生成物 token 是模块顶层
 * const（运行时改 env 无效）。loom.import-env.ts（本文件第一条 import）三层解：
 * 顶层 await 登录写 LOOM_IMPORT_TOKEN + 包装 globalThis.fetch 按次注入 Bearer +
 * 导出 reloginLegacy()。因为 fetch 包装每次调用实时读 env，token 过期后调
 * legacy_relogin 即热刷新——无需重启 loom dev（绕开顶层 const 限制）。
 *
 * 路 2【文档外的口子 → 手写包装】
 *   - legacy_roles_list：角色列表（include glob 覆盖不到的角色域，手写补位）；
 *   - legacy_relogin：重登录刷新 token（401 自愈路径，persona 已写明）。
 *
 * 治理与体验：用户域一切写操作（创建/修改/删除/改密/注册/批量启停/导入）走
 * approve——它们真实写老系统 sqlite；查询放行；memory 开启；全程落会话日志。
 * 已知限制（如实记录）：DELETE /system/user/delete 的 body 是 JSON int 数组，
 * 生成器把 DELETE 归为只读方法（body 并入 query），导入的 delete 工具对该端点
 * 会 422——演示删除语义时以审批卡+模型如实报错为准，README 有说明。
 * 启动：先起老系统（8001）与 Redis（6379），再 pnpm dev:fa（4645 + Vite 5175）。
 */
import z from '@deepseek-ai/schemastery'
import { defineApp } from '@loom-sdk/web'
import './loom.import-env' // 第一条 import：顶层 await 登录 + fetch 包装，先于一切工具执行
import { configureImportedClient, registerImportedTools } from './loom.openapi'
import { LEGACY_API_BASE, bootLogin, reloginLegacy } from './loom.import-env'

// 测试/演示指到别的实例时同步生成物基址（--base 已含 /api/v1，这里保持一致）。
if (process.env.LEGACY_BASE_URL !== undefined) {
  configureImportedClient({ baseUrl: `${process.env.LEGACY_BASE_URL.replace(/\/+$/, '')}/api/v1` })
}

const app = defineApp('fastapi-admin', { model: 'deepseek-v4-flash', port: 4645 })

// ── 路 1：一键导入（loom.openapi.ts 是 import-openapi 的生成物，零手改） ───
// 此刻模型/HTTP 已可见用户域 15 个工具（get_user_list / create_user / update_user /
// delete_user / 改密三件套 / 导入导出……）。认证经 loom.import-env 的 fetch 包装
// 注入（oauth2 不在生成器头注入范围，见文件头"登录桥"）。FastAPI Optional[X] 的
// anyOf 可空联合由生成器忠实转为 oneOf:[T,{type:'null'}]（内核校验按类型接受
// null）——早期的"可空放宽桥"（注册后深走 DSL 补 oneOf 的兼容层）已随该框架
// 修复拆除，无需任何生成物后处理。
registerImportedTools(app)

// ── 路 2：手写包装（include glob 覆盖不到、以及文档外行为的口子） ──────────
// 角色列表：GET /system/role/list（认证同理由 fetch 包装统一注入，按次读新 token）。
app
  .tool('legacy_roles_list')
  .description(`查询老系统角色列表（GET /system/role/list，分页）。角色域没进 OpenAPI 导入的 include glob（单 glob 不支持 user|role 二选一）——本工具是手写包装补位。创建用户时角色 id 对照：1=超级管理员、2=管理员、3=普通用户[USER]（以本工具返回的实时数据为准）。boot 时已用账号 ${bootLogin.user} 登录（token 有效期约 ${bootLogin.expiresHint}）。`)
  .input({
    page_no: { type: 'number', description: '页码，从 1 起；缺省 1。' },
    page_size: { type: 'number', description: '每页条数（≤100）；缺省 20。' },
  })
  .output(z.object({
    total: z.number().description('角色总数'),
    has_next: z.boolean().description('是否还有下一页'),
    items: z.array(z.object({
      id: z.number().description('角色 id（创建用户 role_ids 用）'),
      name: z.string().description('角色名，如 超级管理员'),
      code: z.string().description('角色编码，如 SUPER_ADMIN / USER'),
      status: z.number().description('0=启用 1=停用'),
      order: z.number().description('排序号'),
      description: z.string().description('角色说明'),
    })),
  }))
  .card('generic', { title: '老系统角色列表（手写包装）' })
  .http('GET')
  .execute(async (args, exec) => {
    const params = new URLSearchParams()
    params.set('page_no', String(args.page_no ?? 1))
    params.set('page_size', String(args.page_size ?? 20))
    const res = await fetch(`${LEGACY_API_BASE}/system/role/list?${params.toString()}`, { signal: exec.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`legacy_roles_list 调用失败：HTTP ${res.status}——${text.slice(0, 200)}`)
    }
    const body = (await res.json()) as {
      code: number
      msg: string
      data: null | { total: number, has_next: boolean, items: Array<{ id: number, name: string, code: string, status: number, order: number, description: string | null }> }
    }
    if (body.code !== 0 || body.data === null) {
      throw new Error(`legacy_roles_list 老系统返回异常：code=${body.code}——${body.msg}`)
    }
    return {
      total: body.data.total,
      has_next: body.data.has_next,
      items: body.data.items.map(item => ({
        id: item.id, name: item.name, code: item.code, status: item.status, order: item.order,
        description: item.description ?? '',
      })),
    }
  })

// 重登录：无参 → 换新 token 写回 LOOM_IMPORT_TOKEN（fetch 包装按次读取，即时生效）。
app
  .tool('legacy_relogin')
  .description('重新登录老系统刷新 JWT（无参数）。遇 401（token 过期/老系统重启）先调本工具再重试原操作；刷新即时生效，无需重启服务。boot 时已自动登录一次（admin，token 约 12h 有效）。')
  .input({})
  .output(z.object({
    ok: z.boolean().description('恒为 true——失败会以工具错误抛出（isError），不会返回 ok:false'),
    user: z.string().description('登录账号'),
    expiresHint: z.string().description('新 token 有效期提示，如 "12h"'),
    refreshedAt: z.string().description('刷新时刻（ISO 8601）'),
  }))
  .card('generic', { title: '老系统重登录（token 热刷新）' })
  .execute(async () => reloginLegacy())

// ── 认证 + 记忆（老系统对接也要多用户与长期记忆） ──────────────────────────
app.auth()
app.memory({ extraction: { maxPerTurn: 3 } })

// ── 智能体：一个懂这台老后台的中文助手 ──────────────────────────────────────
app.agent('admin-assistant', {
  persona: [
    '企业后台管理助手，操作真实的 FastapiAdmin 老系统（FastAPI+SQLAlchemy）。规则：',
    '查用户用 get_user_list_controller_system_user_list_get（分页默认 page_size=20；search 是必填对象，无条件就传 {}），查用户详情用 get_user_detail…，查角色用 legacy_roles_list——先调工具拿真实数据，禁止编造；',
    '创建用户用 create_user_controller_system_user_create_post：role_ids 用 3（普通用户[USER]），status 用 0（启用），password 至少 6 位；修改用户用 update_user…（带路径 id）；',
    '创建/修改/删除用户是真实写操作，会触发人工审批卡——用户要求时直接调用，不要先反问确认（审批卡本身就是确认环节）；审批被拒后如实告知"未执行成功"，绝不能编造成功；',
    '遇到 401（token 过期）先调 legacy_relogin 刷新再重试原操作；回答用中文，结论带具体数字与用户名。',
  ].join('\n'),
  tools: [
    'get_user_list_controller_system_user_list_get',    // 路 1：导入（读）
    'get_user_detail_controller_system_user_detail_id_get', // 路 1：导入（读）
    'create_user_controller_system_user_create_post',   // 路 1：导入（写，approve）
    'update_user_controller_system_user_update_id_put', // 路 1：导入（写，approve）
    'delete_user_controller_system_user_delete_delete', // 路 1：导入（写，approve；DELETE 带 body 的已知限制见文件头）
    'legacy_roles_list',                                // 路 2：手写（角色域补位）
    'legacy_relogin',                                   // 路 2：手写（401 自愈）
  ],
  memory: true, // 提取 + 召回（提取花 token，按 agent 显式开启）
})

// ── 策略：老系统的一切用户域写操作必须人批，读放行 ──────────────────────────
// 规则按声明顺序求值、后声明覆盖先声明；glob 对照实际生成的工具名（operationId
// 的 snake_case 化，见上方 tools 列表）。写规则覆盖全部 15 个导入工具里的写口：
//   *user*create*   → create_user_controller_system_user_create_post
//   *user*update*   → update_user_… 与 update_current_user_info_…（两者都含 user…update）
//   *user*delete*   → delete_user_controller_system_user_delete_delete
//   *password*      → reset/change/forget_password 三个改密工具
//   *user*register* → register_controller_system_user_register_post
//   *user*status*   → batch_set_available_user_controller_system_user_status_batch_patch
//   *user*import_data* → import_user_list…import_data_post（用户批量导入）
// 放行的写形态仅剩两个 POST-但-只读：export_user_list（导出查询）与
// export_user_import_template（下载导入模板）——它们不落库，按读对待。
app.policy({
  default: 'allow',
  rules: [
    { tool: 'legacy_relogin', effect: 'allow' },          // 401 自愈路径：放行
    { tool: '*password*', effect: 'approve' },            // 改密/重置/忘记密码：高危写
    { tool: '*user*register*', effect: 'approve' },       // 自助注册建用户：真实写
    { tool: '*user*create*', effect: 'approve' },         // 创建用户（导入）：真实写老库
    { tool: '*user*update*', effect: 'approve' },         // 修改用户/改自己资料（导入）：真实写
    { tool: '*user*delete*', effect: 'approve' },         // 删除用户（导入）：真实删
    { tool: '*user*status*', effect: 'approve' },         // 批量启停用户（导入）：真实写
    { tool: '*user*import_data*', effect: 'approve' },    // 批量导入用户（导入）：真实写
    { tool: 'memory_forget', effect: 'approve' },         // 删除记忆：破坏性写，审批
  ],
})

// ── 投影：任务链（聊天流旁的工具调用清单，回放时同样可折叠） ────────────────
export interface WorkspaceState {
  tasks: Array<{ seq: number; title: string; name: string; status: 'running' | 'done' | 'error' }>
}

app.projection<WorkspaceState>('workspace', {
  init: { tasks: [] },
  apply(state, event) {
    const fields = event as Record<string, unknown>
    const pick = <T,>(key: string): T | undefined => fields[key] as T | undefined
    switch (event.type) {
      case 'tool/call':
        return {
          ...state,
          tasks: [...state.tasks, { seq: event.seq, title: String(pick<{ title?: string }>('card')?.title ?? event.name), name: String(event.name), status: 'running' }],
        }
      case 'tool/result': {
        const callSeq = pick<number>('callSeq') ?? -1
        return {
          ...state,
          tasks: state.tasks.map(task => (task.seq === callSeq ? { ...task, status: pick<boolean>('isError') === true ? 'error' : 'done' } : task)),
        }
      }
      default:
        return state
    }
  },
})

export default app

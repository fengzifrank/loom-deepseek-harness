/**
 * 公共 API 面快照（M16.5）——内核升级后的对外兼容性锁定。
 *
 * 锁定 @loom-sdk/web 的**全部具名导出**：任何导出被意外移除/改名（最典型的
 * 内核升级回归）都会在这里 fail-loud，而不是在使用者的构建里炸。
 * 新增导出不锁（向后兼容）；删除/重命名必须在此处显式更新快照并写明理由。
 */
import { describe, expect, it } from 'vitest'
import * as sdk from '../src/index.js'

/** M16（0.1.7-rc.2 迁移后）的公共导出面快照。 */
const EXPECTED_EXPORTS = new Set([
  // 核心声明器与常量
  'defineApp', 'DEFAULT_MODEL', 'DEFAULT_PORT', 'DEFAULT_API_PREFIX',
  // 策略与预算
  'compilePolicy', 'globToRegExp', 'assertPolicySpec', 'POLICY_EFFECTS',
  'BUDGET_KINDS', 'BUDGET_EFFECTS', 'BudgetMeter', 'describeBudget',
  // 子智能体与群体
  'compileSubagents', 'denyListForAgent',
  'compileSwarm', 'DELEGATION_TOOL_NAME', 'SWARM_MEMORY_TOOL_NAMES', 'SWARM_MAX_DEPTH', 'RESERVED_SUB_TOOLS',
  // 模型网关
  'resolveLlm', 'PROVIDER_PRESETS', 'PROVIDER_PRESET_NAMES',
  // 组合
  'composeCordisYml',
  // 客户端/OpenAPI 生成
  'generateClient', 'pascalAlias', 'generateOpenapi', 'dslToJsonSchema', 'openapiToJson', 'OPENAPI_DOC_VERSION',
  'httpRouteOf', 'generateImportModule', 'jsonSchemaToDsl', 'validateOpenapiDocument', 'parseOpenapiSource', 'snakeCaseOperationName',
  // 评测
  'slimSessionLog', 'readEventsFile', 'buildEvalContext', 'defineEval', 'runEval',
  // 记忆
  'MemoryStore', 'MEMORY_KINDS', 'MEMORY_SCHEMA_VERSION', 'ftsNormalize', 'ftsMatchExpr',
  'PATH_VERIFY_INCREMENT', 'PATH_FAIL_DECAY', 'PATH_SOFT_DELETE_BELOW',
  'applyDecisions', 'extractionSystemPrompt', 'extractionUserPrompt',
  'decisionSystemPrompt', 'decisionUserPrompt', 'renderRecallContext', 'renderPathRecallContext',
  'buildPathRecallMessage', 'shortSessionId',
  // Python 桥
  'PROTOCOL_NAME', 'PROTOCOL_VERSION', 'HANDSHAKE_TIMEOUT_MS', 'RESTART_INTERVAL_MS',
  'DEFAULT_RESTART_LIMIT', 'DEFAULT_CALL_TIMEOUT_MS', 'LOOM_PYTHON_SERVICE',
  'parsePythonCommand', 'encodeFrame', 'createLineDecoder', 'validateInitializeResult',
  'validatePythonManifest', 'pythonEntryToToolDef', 'normalizePythonDsl', 'PythonBridge',
  // 认证
  'TOKEN_TTL_MS', 'ANON_ID_PATTERN', 'USERNAME_PATTERN', 'PASSWORD_MIN',
  'atomicWriteJson', 'signToken', 'verifyToken', 'hashPassword', 'safeEqualHex',
  'AccountStore', 'resolveIdentity', 'newAnonUserId',
  // 会话
  'SessionSidecarIndex', 'titleOf', 'TITLE_MAX',
  // Webhook
  'verifyWebhookSignature', 'applyWebhookMap', 'applyWebhookSessionKey', 'webhookSessionId',
  // Schema
  'isSchemastery', 'schemasteryToDsl', 'schemasteryToOutputDsl', 'normalizeContent',
])

describe('公共 API 面快照（内核 0.1.7-rc.2 迁移后）', () => {
  it('全部快照导出仍存在（值非 undefined）', () => {
    const missing: string[] = []
    for (const name of EXPECTED_EXPORTS) {
      if (!(name in sdk) || (sdk as Record<string, unknown>)[name] === undefined) {
        missing.push(name)
      }
    }
    expect(missing, `以下公共导出被移除/重命名——这是对外破坏性变更：${missing.join(', ')}`).toEqual([])
  })

  it('无意外消失：实际导出 ⊇ 快照（新增导出允许）', () => {
    const actual = new Set(Object.keys(sdk))
    const disappeared = [...EXPECTED_EXPORTS].filter(name => !actual.has(name))
    expect(disappeared).toEqual([])
  })

  it('核心声明器可调用（签名冒烟）', () => {
    expect(typeof sdk.defineApp).toBe('function')
    expect(typeof sdk.composeCordisYml).toBe('function')
    expect(typeof sdk.resolveLlm).toBe('function')
    expect(typeof sdk.compileSwarm).toBe('function')
    expect(typeof sdk.generateClient).toBe('function')
    expect(typeof sdk.runEval).toBe('function')
  })

  it('类型重导出（编译期契约——运行时仅验证常量成员存在）', () => {
    // 类型本身在运行时不可验证；其关联常量/类在（上方快照已锁），编译期由
    // typecheck + 下游 TS 消费者保证。此测试锚定"类型常量对"防止静默漂移。
    expect(sdk.POLICY_EFFECTS).toContain('allow')
    expect(sdk.BUDGET_KINDS).toContain('tool-calls')
    expect(sdk.MEMORY_KINDS).toContain('path')
    expect(sdk.PROVIDER_PRESET_NAMES).toContain('minimax')
  })
})

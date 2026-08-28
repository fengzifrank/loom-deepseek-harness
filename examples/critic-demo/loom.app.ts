/**
 * 演员-评论家模式示例（M12，oci-agent 的 actor-critic 循环移植到 Loom 惯用法）：
 *
 *   草拟（prescriber 调 draft_prescription）
 *     → 委派复核（subagent 工具把草稿交给 critic）
 *     → 结构化判定（critic 只输出一个 JSON 代码块：三级 satisfaction + issues + suggestions）
 *     → 修订循环（not_satisfactory = 阻断：修订一次再复核；caveats = 保留：如实转述）
 *     → 落笔（finalize_prescription 走人工审批——fail-closed）
 *
 * oci-agent 的核心纪律在这里的对应：LLM 只写**判定**，代码做**门禁**
 * （worker persona 规定 not_satisfactory 必须修订；finalize 在审批门后面）。
 *
 *   pnpm install && pnpm loom dev    # 需要 .env 里的 DEEPSEEK_API_KEY
 */
import { defineApp } from '@loom-sdk/web'

const app = defineApp('critic-demo', { model: 'deepseek-v4-flash' })

app
  .tool('draft_prescription')
  .description('登记一张处方草稿（不落笔）。herbs 为药材与克数列表。')
  .input({
    patient: { type: 'string', required: true, description: '患者姓名。' },
    diagnosis: { type: 'string', required: true, description: '中医诊断，如"风寒束表"。' },
    herbs: {
      type: 'array', required: true,
      description: '药材列表，每味 { name, grams }。',
      items: { type: 'object', properties: { name: { type: 'string', required: true }, grams: { type: 'number', required: true } } },
    },
  })
  .output({
    type: 'object',
    properties: {
      draftId: { type: 'string', required: true },
      patient: { type: 'string', required: true },
      diagnosis: { type: 'string', required: true },
      herbs: { type: 'array', required: true, items: { type: 'object', properties: { name: { type: 'string', required: true }, grams: { type: 'number', required: true } } } },
    },
  })
  .card('generic', { title: '处方草稿' })
  .execute(async (args) => ({
    draftId: `draft-${Date.now().toString(36)}`,
    patient: String(args.patient ?? ''),
    diagnosis: String(args.diagnosis ?? ''),
    herbs: Array.isArray(args.herbs) ? args.herbs : [],
  }))

app
  .tool('finalize_prescription')
  .description('把复核通过的处方草稿落笔归档（真实写操作，触发人工审批）。')
  .input({ draftId: { type: 'string', required: true, description: 'draft_prescription 返回的草稿 id。' }, verdict: { type: 'string', required: true, description: 'critic 的最终判定（fully_satisfactory / satisfactory_with_caveats）。' } })
  .output({ type: 'object', properties: { archived: { type: 'boolean', required: true }, draftId: { type: 'string', required: true }, verdict: { type: 'string', required: true } } })
  .card('generic', { title: '处方归档（写）' })
  .execute(async (args) => ({ archived: true, draftId: String(args.draftId ?? ''), verdict: String(args.verdict ?? '') }))

app.agent('prescriber', {
  persona: [
    '你是"坐堂医数字员工"，为中医馆草拟处方。工作流（严格按序）：',
    '1. 用 draft_prescription 登记处方草稿；',
    '2. 用 subagent 工具把草稿全文委派给 critic 复核（task 里附患者、诊断、药材克数）；',
    '3. critic 返回 JSON 判定：satisfaction 为 not_satisfactory 时**必须**按 suggestions 修订草稿并再委派复核一次（最多修订一次，两次不过就如实告知用户不建议抓药）；',
    '4. 判定为 fully_satisfactory 或 satisfactory_with_caveats 才可调 finalize_prescription 归档（verdict 参数传 satisfaction 值；caveats 要在回答里如实转述）；',
    '5. 单味药剂量默认不超过 30g，超出必须写明理由（critic 会查这条）。',
  ].join('\n'),
  tools: ['draft_prescription', 'finalize_prescription'],
})

// 评论家：纯推理审查（无工具），只输出结构化判定——LLM 写判定，代码做门禁。
app.subagent('critic', {
  persona: [
    '你是处方复核员。只审查，不改方。审查三条：配伍禁忌（十八反/十九畏）、',
    '剂量（单味 >30g 且无理由 = not_satisfactory）、诊断与用药一致性。',
    '输出**只有一个 JSON 代码块**，别无其他文字：',
    '```json',
    '{"satisfaction":"fully_satisfactory|satisfactory_with_caveats|not_satisfactory","issues":["..."],"suggestions":["..."]}',
    '```',
    'issues 是发现的问题（没有则空数组）；suggestions 是可执行的改法（not_satisfactory 时必填）。',
  ].join('\n'),
  tools: [],
  visibleTo: ['prescriber'],
})

app.policy({
  default: 'allow',
  rules: [
    { tool: 'finalize_prescription', effect: 'approve' }, // 落笔必须人工审批（fail-closed）
  ],
  budgets: [{ kind: 'tool-calls', max: 20 }], // M9：一轮问诊最多 20 次工具调用
})

export default app

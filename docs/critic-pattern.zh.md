# 演员-评论家模式（M12）：从 Netflix oci-agent 到 Loom

> oci-agent（Netflix Skunkworks，Apache-2.0）用 LLM 智能体做观察性因果推断，
> 其核心循环 **plan → actor.draft → 运行 → critic.evaluate → actor.revise** 比无脚手架
> 直答好约 48 倍（ACIC 2016 基准：scaffolded 平均误差 0.054 vs prompt-only 2.572）。
> 这页把该模式的**可移植部分**映射到 Loom 的原语上——不是照搬计量经济学。

## 模式的三个可移植骨架

### 1. LLM 写判定，代码做门禁

oci-agent 的 actor 只产出 YAML spec，`propose()` 用纯代码校验后才交给确定性执行器
——LLM 永远不直接执行。移植到 Loom：

| oci-agent | Loom |
|---|---|
| actor 产 YAML spec | worker 调工具登记**结构化草稿**（output schema 是契约） |
| propose() 代码校验 | 声明期 schema 校验 + critic 判定 + 策略/审批/预算门禁 |
| 确定性 notebook 执行 | 工具 `execute`（普通代码，可测可回放） |

### 2. 三级判定 + 阻断/保留二分

critic 的判定是三级：`fully_satisfactory / satisfactory_with_caveats /
not_satisfactory`，并且每条检查明确分成**阻断**（blocker：必须修）与**保留**
（warner：如实转述后可放行）。Loom 里有两个孪生落点：

- **在线**：critic 子智能体只输出一个 JSON 代码块（三级 satisfaction + issues +
  suggestions）；worker persona 规定 not_satisfactory 必须修订再复核（最多一次，
  防两个 LLM 互相拉扯烧预算）。见 `examples/critic-demo`。
- **离线**：`loom eval` 的三级判定（M12）——断言全过无告警 = `pass`；全过但有
  `ev.caveat('…')` 告警 = `pass-with-caveats`（满意但有保留）；断言抛错 = `fail`
  （阻断优先：即使先记了告警也按失败）。CLI 用 ✓/⚠/✗ 呈现，只有 fail 退出码 1。

### 3. 迭代留档与上限

oci-agent 每轮迭代落一个 `iter_NN` 目录（spec、结果、执行过的 notebook、critique、
报告），人可以随时接手 `revise`。Loom 的会话日志天然就是这份档案：每次委派、每个
判定 JSON、每次修订全在 session log 里（模型可见 ⟺ 落日志），回放/eval/审计共用
同一事实源——不需要额外的迭代目录约定。

## 在 Loom 里声明一个评论家

```ts
app.subagent('critic', {
  persona: [
    '你是复核员。只审查，不改稿。',
    '输出只有一个 JSON 代码块：',
    '{"satisfaction":"fully_satisfactory|satisfactory_with_caveats|not_satisfactory","issues":[],"suggestions":[]}',
  ].join('\n'),
  tools: [],                    // 纯推理审查：无工具 = 天然只读
  visibleTo: ['prescriber'],    // 只有 worker 看得到委派工具
})
```

worker 的 persona 承载循环纪律：

```ts
app.agent('prescriber', {
  persona: '… not_satisfactory 必须按 suggestions 修订并再复核一次（最多一次）；'
         + '两次不过就如实告知；caveats 要在回答里如实转述；落笔走 finalize（审批门）。',
  tools: ['draft_prescription', 'finalize_prescription'],
})
```

`finalize_*` 在 `app.policy` 里挂 `approve` —— 判定是建议，审批才是门禁。

## 为什么不直接依赖 oci-agent

它是"官方不维护"的研究参考实现（Python、Anthropic 单家 API、三个固定 notebook）。
可移植的是**模式**（上表三骨架）；计量经济学部分（EconML/DML/ATE 估计）留在原项目。
Loom 侧的等价实验位：`loom eval` 夹具 + Python 桥（`@tool` 包一层 econml 即可成为
工具，走同一策略/审批管线）。

## 证据与用例

- 示例：`examples/critic-demo`（处方草拟 → 复核判定 → 修订 → 审批归档）。
- 离线判定测试：`packages/web/test/eval.test.ts`（三级判定 + 阻断优先 + 空告警
  fail-closed）。
- oci-agent 基准数字出处：其 README 与 `evals/baseline_vs_scaffolded/`（五臂消融，
  泄漏控制与单次重试的实验卫生值得借鉴）。

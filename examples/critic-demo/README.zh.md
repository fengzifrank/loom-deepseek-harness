# critic-demo：演员-评论家模式（oci-agent 移植）

Netflix oci-agent 用"演员草拟 → 评论家判定 → 修订"的循环做因果推断分析，比无脚手架
直答好 ~48 倍。这个示例把同一模式搬到 Loom 惯用法：**worker 子智能体 + 结构化判定
+ 修订循环 + 审批门落笔**。

## 运行

```bash
pnpm install
echo 'DEEPSEEK_API_KEY=sk-...' > .env
pnpm loom dev
```

对 `prescriber` 说：

- "患者王女士，风寒束表，开麻黄 35 克、桂枝 10 克、杏仁 10 克、甘草 6 克"
  → 35g 超量无理由 → critic 判 `not_satisfactory` → 修订（或补理由）→ 复核 →
  归档时弹审批卡。
- 把剂量改成 10 克 → `fully_satisfactory` → 直接进入归档审批。

## 模式要点（为什么这样设计）

| oci-agent 原文 | 本示例的 Loom 表达 |
|---|---|
| actor.draft → YAML spec | `draft_prescription` 工具登记草稿（结构化输出契约） |
| critic.evaluate 三级判定 | critic 子智能体只输出一个 JSON 代码块（三级 satisfaction） |
| not_satisfactory → actor.revise | worker persona 规定"必须修订并再复核一次"（LLM 写判定，门禁在流程） |
| 迭代上限（--iterations） | "最多修订一次，两次不过如实告知"（防无限循环） |
| 每迭代全量留档（iter_NN） | 会话日志本身就是全量审计（session log 单一事实源） |
| blocker vs warner | `not_satisfactory` = 阻断（不给归档）；`caveats` = 保留（如实转述后放行） |
| 结果落盘 | `finalize_prescription` 走人工审批（fail-closed）——处方合规的映射 |

## 关键纪律

1. **LLM 只写判定，代码做门禁**——critic 的 JSON 是"建议"，真正的门禁是
   worker 的流程约束 + finalize 的审批策略 + 预算上限。判定错了顶多多改一轮，
   门禁错了才会放走坏处方。
2. **评论家无工具**（`tools: []`）——纯推理审查，不碰数据，天然只读。
3. **修订有上限**——防两个 LLM 互相拉扯烧预算；上限内的每一轮都在会话日志里。

详见 [docs/critic-pattern.zh.md](../../docs/critic-pattern.zh.md)。

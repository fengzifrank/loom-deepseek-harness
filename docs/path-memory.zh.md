# 路径记忆（M8 设计）

> 状态：**已实施**（2026-08 交付；e2e 证据见 `examples/gis/tests/path-memory.e2e.test.ts`
> ——无 key 确定性段 + 带 key 闭环段，store 单测 17/17）。M7 交付了记忆基座
> （SQLite FTS5 store + kind 闭合枚举 + 召回注入管道）；M8 在其上补"任务路径"
> 这一种记忆——让智能体记住"怎么做成过一件事"，失败时能检索出成功的路径
> 重新验证后复用。

## 动机

同一个 GIS 平台，用户每周都要"导出某个村的耕地专题报告"。第一次智能体
摸索了 6 步（查数据 → 修正坐标系 → 排序 → 渲染 → 写报告 → 落盘）；第二次
同类请求又从零摸索。事实类记忆（M7 的 fact/preference/skill）记不住这种
**带验证的执行序列**——它不是"用户偏好"，而是一条可重放、可验证、会过期的
**路径**。

## 记录形态

一次任务到达终态（turn/end completed 且产出被用户/下游接受）时，从会话
日志提炼一条 `kind: 'path'` 记忆（复用 M7 的 `memories` 表，零新表）：

```jsonc
{
  "id": "…",
  "user_id": "user-alice",
  "kind": "path",
  "content": "导出村庄耕地专题报告：gis_query_land_types(region) →
              gis_area_stats(items.areaSqm) → gis_write_report(title, sections)；
              注意 land-types.json 的 note 字段可能缺失，缺则跳过引用",
  "source_session": "session-gis-platform-…",   // slim 转录引用（见下）
  "source_seq": 42,
  "confidence": 1.0,
  "verified_at": "2026-08-18T02:00:00.000Z"     // 新增列：最近一次重验时间
}
```

三个来源，全部从既有机制复用：

1. **slim 转录引用**（复用 M4 `loom eval --slim` 的精简管线）：content 不是
   全量转录，而是"目标 + 工具调用序列 + 关键参数 + 结局"的 slim 视图；
   `source_session` + `source_seq` 指回原会话，需要细节时按需展开（M4 的
   readEventsFile + 有界 SSE 区间读取）；
2. **工具图签名**：把路径里的工具调用序列做成稳定签名（工具名 + 参数形状
   的哈希，不含参数值）——用于检索时的快速匹配与去重（同签名路径只保留
   verified_at 最新的一条）；
3. **结局**：completed/blocked/被拒——被拒路径也记（content 标注"此路不通
   与原因"），下次检索时降权而非盲选。

## 检索注入（失败时）

写路径（两阶段提取）在 M7 已跑通；M8 增加"失败触发检索"：

- **失败信号**：turn/end `reason: 'error'` / 连续 `blocked` / 用户明确说
  "不对，重来"（最后者由提取阶段一判定）；
- **检索**：以当前任务 slim 目标为查询，FTS 命中同 userId 的 `kind:'path'`
  记忆 top-K（M7 store 的 search 已支持按 kind 收窄）；
- **注入**：复用 M7 召回管道——`createUserMessage` + source
  `{kind:'plugin', plugin:'loom-memory', form:'recall'}` + 防注入框，框内
  明示"以下是历史成功路径，重验后才可复用"；
- **重验（衰减机制的核心）**：注入的路径不直接执行——prompt 要求智能体先
  重跑路径中的**只读步骤**（查询类工具）确认数据仍在/口径未变，再走写
  步骤。重验成功 → `verified_at` 刷新、confidence 上升；重验失败（数据
  没了/工具报错）→ confidence 衰减，连续 N 次失败 → 软删（active=0）。

## 衰减与重验

```
verified_at 距今 > 30 天        → 检索降权（rank 惩罚，非隐藏）
重验成功                         → verified_at = now，confidence +0.1（≤1.0）
重验失败                         → confidence ×0.5
confidence < 0.3                 → 软删（保留行，active=0，FTS 摘除）
```

时间衰减在 SQL 里做（`ORDER BY rank * exp(-days/30)` 的表达式列或读出后
排序）；不做后台定时任务——衰减在"被检索到的那一刻"计算，惰性求值。

## 与 M7 的接缝

| M7 已有 | M8 复用方式 |
| --- | --- |
| `memories` 表 + kind 闭合枚举 | 新增 `kind: 'path'` 分支（枚举已预留）+ `verified_at` 列（`PRAGMA user_version` 升 2，fail-loud） |
| FTS5 检索（kind 收窄） | path 检索直接用 `search(userId, query, k, 'path')` |
| 两阶段提取队列（turn/end 钩子） | 增加失败钩子（error/blocked）触发检索注入 |
| 召回注入管道（防注入框 + inject） | 同一条管道，框文案区分"背景事实"与"待重验路径" |
| `loom eval --slim`（M4） | 路径 content 的 slim 转录来源 |
| MemoryPanel | kind 徽标已透传（`[path]`），补 verified_at 显示 |

## 实施切分（建议）

1. `memories` 加 `verified_at` 列 + user_version 2 迁移门禁（store 单测先行）；
2. 提取阶段一的 prompt 扩 path 候选（任务型 agent 显式声明
   `app.agent(id, {memory: {paths: true}})` 之类的窄开关，防止闲聊也记路径）；
3. 失败钩子 → path 检索 → 注入（prompt 含重验要求）；
4. 重验回写（工具结果流里识别"路径重放成功/失败"，更新 confidence）；
5. e2e：任务 A 成功 → DB 出现 path 记忆 → 新会话同任务 → 注入 path →
   重验（只读步骤真实执行）→ 复用完成，SSE 全链证据。

## 与 skill 体系的划界

M7 的 `kind` 枚举里已有 `skill`（能力记忆："用户需要面积一律用公顷"、
"写报告先跑查询"），M8 又加了 `path`——两者都是"怎么做"类知识，边界如下：

| | `skill`（M7） | `path`（M8） |
| --- | --- | --- |
| 形态 | 一句话能力/惯例（陈述性） | 目标 + 工具序列 + 参数形状策略 + 结局（程序性，可重放） |
| 写入时机 | 提取阶段随手记（无门控，闲聊也能提炼偏好/能力） | 窄门控 `app.agent(id, { memory: { paths: true } })`，只有任务型 agent 记 |
| 去重 | 按 content 相似（决策阶段自由判断） | 按工具图签名（`toolSequenceSignature`：工具名 + 参数形状哈希，同签名只留最新） |
| 可信度 | 不衰减（记下就是真的，除非显式 forget） | confidence 随重验波动（成功 +0.1 / 失败 ×0.5 / <0.3 软删），verified_at 随时间降权 |
| 触发注入 | 话题相关时随召回管道注入（背景） | **失败触发**（turn/end error/blocked 才注入，框文案明示"待重验路径"） |
| 复用方式 | 直接按建议行事 | 必须先重跑只读步骤验证数据仍在，再走写步骤 |

一句话：skill 回答"做事的一般惯例"，path 回答"这类任务上次成功走通的
具体步骤是什么、现在还灵不灵"。惯例不需要重验，步骤会过期——这就是 path
需要 verified_at/confidence 而 skill 不需要的原因。

## 风险

- **路径过拟合**：参数写死导致换村就错——content 存参数形状与取值策略
  （"region 取用户指定村"），不存具体值；
- **重验成本**：每次复用都重跑只读步骤，多 1-2 次工具调用——换正确性的
  代价，且只读步骤廉价；
- **隐私**：path 记忆同样按 userId 隔离（M7 store 已保证），跨用户不复用。

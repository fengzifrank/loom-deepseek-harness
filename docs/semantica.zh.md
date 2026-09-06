# Semantica × Loom 融合（M13）：Loom 管怎么做，semantica 管知道什么

> [semantica](https://github.com/semantica-agi/semantica)（MIT，Python，v0.6.8）是
> "图原生的上下文与可问责 AI 基础设施"：知识图、决策判例、因果链、SHACL 校验、
> 溯源，全部确定性运行。Loom 是 agent 运行时：执行、策略、审批、预算、交付。
> 两者分工线干净、能力几乎零重叠——本页是融合设计与实证。

## 分工图

```mermaid
flowchart LR
  subgraph Loom["Loom（运行时：手脚与规矩）"]
    A[tools / agents 声明] --> B[策略/审批门/预算]
    B --> C[会话日志 · 单一事实源]
    C --> D[eval · 回放 · 审计]
  end
  subgraph Semantica["semantica（知识层：记忆与推理）"]
    E[ContextGraph 知识图] --> F[决策判例 / 因果链]
    E --> G[SHACL 校验]
    E --> H[溯源 provenance]
  end
  B -- "agri_* 工具调用（M6 桥）" --> E
  C -.-"双审计：行为（模型看到/做了什么）↔ 语义（知识从哪来/决策为什么）".- H
```

**双审计是这次融合最有价值的产出**：Loom 会话日志回答监管"模型当时看到什么、谁批的"；
semantica 决策记录 + 溯源回答"这个结论的数据从哪来、因果链是什么"。农产品溯源、
处方合规这类高监管场景，两边合起来才是完整答案。

## 双路径接入（镜像 OpenAPI 双轨哲学）

| | 桥路径（M6，主路径） | MCP 路径（M10，零代码） |
|---|---|---|
| 声明 | `app.python({ command: '"…python.exe" "py_tools.py"' })` | `app.mcp('semantica', { command, args: ['-m','semantica.mcp_server'] })` |
| 工具 | 类型化 `agri_*`（7 个，含 SHACL/溯源） | 泛化 `mcp__semantica__*`（15 个，无 SHACL/溯源） |
| 治理 | 策略/审批/预算照常 | 照常（`mcp__semantica__record_decision` → approve） |
| 持久化 | 桥进程单写 `graph.json` | `SEMANTICA_KG_PATH`（**≥0.6.8**，低版 MCP 持久化是坏的 #1394） |
| 适合 | 生产/交付（类型化 + 深能力） | 快速评估/原型 |

**单写者纪律**：两条路径不要共用同一个 KG 文件——两个进程各自 load/save，
last-writer-wins 会丢数据。示例里桥用 `graph.json`、MCP 变体用 `graph-mcp.json`。

## 农业本体平台映射（公司的业务落点）

| 本体概念 | Loom 声明 | semantica 落点 |
|---|---|---|
| 对象（地块/作物/病虫害/药剂） | `agri_add_entity` | 图节点（type + label + metadata） |
| 链接（种植/危害/防治） | `agri_add_relation` | 图边（GROWS/INFECTS/TREATS） |
| 动作（开处方/农事决策） | `agri_record_decision` + policy **approve** | 决策一等节点（供判例与因果） |
| 判例（老经验） | `agri_find_precedents` | 相似度检索（precedents） |
| 因果（为什么这么做） | `agri_causal_chain`（`caused_by` 自动补边） | CAUSED 边 + 逐跳遍历 |
| 合规（剂量/用药约束） | `agri_shacl_validate` | SHACL shapes 语义校验 |
| 溯源（食品安全） | `agri_provenance` | 来源链（PROV 对齐 dict） |
| 行为审计 | 会话日志（Loom 自带） | —（互补而非重叠） |

## 实施中踩到的坑（诚实记录，钉版本纪律）

1. **API 命名漂移是真的**：README 说 `add_entity`，实际 `ContextGraph` 是
   `add_node(node_id, node_type, **props)` / `add_edge(source_id, target_id, edge_type)`；
   README 的 `trace_decision_chain` 实际是 `get_causal_chain(decision_id, direction, max_depth)`
   / `trace_decision_causality`。**`py_tools.py --selftest` 校验我们用到的每个方法名**，
   e2e 的 `semanticaReady()` 守卫先跑它——漂移 = fail-loud，不是运行期玄学。
2. **中文相似度阈值要重调**：`find_precedents_by_scenario` 默认 `similarity_threshold=0.5`，
   词面 Jaccard 对中文长句普遍打 0.1~0.2——默认值下**全灭**。桥里放 0.05（召回优先，
   判读交给模型），实测同义查询 ~0.18 命中。
3. **semantica 初始化不能放次线程**：实测主线程阻塞 stdin 读时，后台线程的
   semantica/OpenMP 初始化会卡死（预热线程方案放弃）。桥改惰性初始化：首个工具
   调用付 ~10s 导入成本，在 `app.python` 的 `callTimeoutMs: 180000` 内绰绰有余。
4. **record_decision 回传 id**（签名 `-> str` 实测有效）——判例命中结构是嵌套的
   `{decision: {...}, similarity}`，桥里做了扁平化方便模型消费。
5. **重量级安装**：`pip install semantica` 拉 torch/transformers/faiss/opencv/librosa
   （GB 级，Python 3.13/win64 可装）。专用 venv（gitignored）+ 测试 `semanticaReady()`
   守卫——未装环境全自跳过，CI 不破。

## 边界与风险（如实）

- v0.6.x 周更、pre-1.0：**钉 `semantica==0.6.8`**，升级 = 重跑 selftest + e2e；
- MCP 面没有 SHACL/溯源/冲突检测——这些只在桥路径；
- 无 SKOS、无 PROV-O RDF 序列化（模型对齐但只出 dict）——要 RDF 自带 rdflib；
- Windows 是二线平台（我们 core-only + 不用 ml 提取，实测可用）；
- 冲突检测（ConflictDetector）本示例未接——检测须在合并前跑，接到 ingestion 管线
  是下一步。

## 测试证据（examples/semantica-demo/tests/）

- `bridge.e2e.test.ts` 无 key：loom boot → health `pythonTools: 7` + 组合行；**直调协议**
  （initialize → tools/call agri_find_precedents）命中种子判例 + graph.json 落盘；
- `bridge.e2e.test.ts` 带 key（真实模型四证据链）：查判例（count≥1）→
  `agri_record_decision` 触发审批卡 → POST allowed-once → decisionId 返回 →
  第二轮 `agri_causal_chain` 用该 id 追溯成功；
- `mcp.e2e.test.ts` 无 key：`loom.mcp-app.ts` boot 成功（failOnStartupError 门 =
  连接/发现/注册证据）+ 组合含 `mcp-semantica` 行 + 独立 KG 路径。

## Roadmap（下一轮）

1. **loom memory provider seam**：M7 的 FTS 扁平记忆换/并 semantica ContextGraph
   （图记忆 + 双时间轴），按 userId 隔离不变；
2. **决策自动入账**：session log 的 turn/end → `record_decision` 桥接（行为日志
   自动沉淀为语义决策记录，双审计闭环）；
3. 冲突检测接入 ingestion（多源数据合并前跑 ConflictDetector）。

# 群体智能（M15）：声明式拓扑 Swarm + 会话树群体记忆

> 一个声明，拉起一个协作群体：入口智能体 + 成员子智能体按拓扑协作，可选
> **群体记忆**让成员共享发现，mesh 拓扑下成员可**对等委派**（内核深度帽防失控）。
> 设计出处：拓扑图与命名空间共享记忆两个模式移植自 ruflo 的**概念层**（零代码
> 引入）；共识算法/守护进程/选举等明确不移植——见文末诚实对照。

## 声明

```ts
import { defineApp } from '@loom-sdk/web'

const app = defineApp('swarm-demo', { model: 'deepseek-v4-flash' })

app.swarm('research-pod', {
  entry: {
    id: 'pod-lead',
    persona: '你是研究组长：拆解任务、委派成员、汇总结果。',
    tools: ['swarm_query'],           // 可选；缺省 = 应用全部工具
  },
  topology: 'mesh',                   // 'hierarchical'（入口→成员单层） | 'mesh'
  memory: true,                       // swarm_note / swarm_recall（会话树命名空间）
  members: [
    { id: 'researcher', role: 'worker', persona: '研究员：只查真实数据。', tools: ['swarm_query'] },
    { id: 'writer', persona: '写作员：只依据材料写结论。', tools: [] },
  ],
})
```

**声明期展开**（`compileSwarm` 纯函数，`packages/web/src/swarm.ts`）：entry 注册为
普通 agent（HTTP 寻址 `/agents/pod-lead/sessions`）；members 注册为 subagents，
**visibleTo 按拓扑计算**——hierarchical → `[entry]`；mesh → `[entry, ...同伴]`。
compose/dev-worker 零改动（展开为既有原语）。

## 两种拓扑

| | hierarchical | mesh |
|---|---|---|
| 委派边 | 入口 → 成员（单层） | 入口 → 成员 + **成员 ↔ 成员** |
| 深度帽 | 1 | 默认 2（可配，封顶 3；内核单调深度硬终止防环） |
| 成员工具注入 | 群体记忆工具（memory 时） | + 委派工具 `subagent` |
| persona 注入 | 委派指引 + 记忆纪律 | + 对等委派纪律（写明同伴 id） |

## 群体记忆（会话树命名空间）

- **作用域 = 会话树根**：`swarm:{rootSessionId}` 合成 userId——子会话沿
  parentSessionId（内存 + sidecar 持久化，跨重启成立）上溯到入口会话。
  零 schema 变更复用 MemoryStore 全部 FTS/软删/隔离（userId 是唯一分区）。
- 两个模型工具（全局注册，非群体参与方被 deny 摘除）：
  - `swarm_note(content, tag?)`——把发现记入群体笔记（谁记的、来自哪个会话都有出处）；
  - `swarm_recall(query, limit?)`——FTS 检索群体笔记。
- 纪律由编译期注入 persona（可单测）：值得共享的发现立即记、行动前先查。
- app.memory 未声明时为群体单独建库（同文件，提取链不启用）。
- **生命周期 = 随库留存**（不自动清理——群体记忆是任务资产，删除走
  memory.db 管理；如实边界）。

## 对等委派（mesh 深度 2）

- 委派工具 `subagent` 全局注册、**调用者感知**：执行期从调用会话解析身份
  （子会话 → childSpec；普通会话 → sidecar agentId），可见规格 = 该调用者的
  visibleTo 命中集；无委派权的 agent 经 deny 摘除。
- 深度帽按群体元数据传给内核（`maxDepth`），内核单调深度保证 A→B→A 这类
  环在帽处硬终止。
- 每级拉起都有 `loom/subagent-started` SSE（挂在**父**会话流上——第二级
  事件的证据要订阅子会话实时流，合成事件不落日志）。

## 测试证据

- 单测 `packages/web/test/swarm.test.ts`（19 例）：拓扑展开/校验/persona 注入/
  工具清单合成/mesh 可见性穿过 compileSubagents。
- e2e `examples/gis/tests/swarm.e2e.test.ts`（3 段）：
  - 无 key：health 汇报 swarms 元数据 + mesh 可见性；
  - **带 key A（兄弟记忆传递）**：researcher 查数据 → `swarm_note` 记 1200 亩 →
    writer `swarm_recall` 检索**命中同一条笔记**（跨成员传递的子会话事件流证据）；
  - **带 key B（mesh 深度 2）**：lead 只拉 researcher，researcher **自己**委派
    writer——第二级 `loom/subagent-started`（parent = researcher 子会话），
    lead 流无直接 writer 拉起，全链 completed。

## 从 ruflo 吸收什么 / 拒绝什么（诚实对照）

| 吸收（概念移植，全部原生实现） | 拒绝 |
|---|---|
| 拓扑图：visibleTo 按拓扑计算的委派边 | Raft/Paxos/拜占庭共识（给写代码的子智能体上分布式共识是表演） |
| 命名空间群体记忆（ns: 前缀 → 会话树合成 userId） | 守护进程/常驻 hooks（cordis 生命周期已覆盖） |
| 深度帽防环失控 | 300+ 工具面板、选举/重平衡（拓扑+记忆+内核深度帽足够且可审计） |
| STATUS 式自审（本文档的边界小节） | 任何 ruflo 代码/依赖（零引入） |

## 边界（如实）

- depth 封顶 3；群体记忆不做自动清理；委派工具描述改为全局一份（执行期
  校验调用者实际可见集，报错列出其可用清单——描述里的全集只是导览）。
- 既有 `app.subagent()` API 不变（swarm 是其上的声明糖，二者可混用）。

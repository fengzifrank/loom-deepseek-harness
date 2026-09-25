# Harness 0.1.7-rc.2 迁移实录（M16，2026-09-25 完成）

> **状态：已完成迁移并全量验证**——Loom 现运行在 `@deepseek-ai/*@0.1.7-rc.2 +
> cordis 4.0.4 + schemastery 3.18.4` 上，全量 411 测试绿（含全部真实模型链路），
> `loom dev` 冷启动就绪。本文面向两类读者：想了解官方五个 minor 线变更的开发者，
> 以及基于 Loom 开发、担心 harness 升级会破坏自己应用的用户——**对后者：升级
> 影响为零，框架层吸收了全部破坏**（app.tool/agent/policy/swarm 等声明式 API
> 未变，会话格式迁移自动进行且原文件保留）。

## 官方版本走廊（0.1.2-rc.1 → 0.1.7-rc.2，13 版本/3 周）

无 0.1.3-final、无 0.1.4——走廊是 `0.1.3-alpha → 0.1.5-rc（官方自述"自 0.1.2-rc.1
的汇总"）→ 0.1.6-alpha（最重）→ 0.1.7-rc.2`。npm `next` 指向 0.1.7-rc.2（`latest`
还在 0.1.5-rc.3）。

## Loom 逐点适配实录（全部实测驱动，非清单推导）

### 1. 依赖闭包
- 全部 dsh-* → 0.1.7-rc.2（272 包），**特例**：`dsh-agent-presets` 上游停在
  0.1.5-rc.3（目录式 preset 已废弃、新包未发）→ 钉其最高版；`dsh-code-runtime`
  已改名 `ptc-runtime` 家族 → 从直接依赖移除
- cordis 4.0.2→4.0.4、schemastery 3.18.2→3.18.4；连 lockfile 全清重装（M14
  反混合安装教训）

### 2. 组合层（compose.ts）
- **llm-deepseek 行换包**：0.1.7 起 `dsh-llm-deepseek` 是纯库（无 apply），
  挂载移至 host 插件 **`dsh-llm-deepseek-api-key`**；前置必备行
  `dsh-deepseek-llm-api-extensions`（对照官方 sdk-minimal 组合）
- **默认模型 id 更替**：`deepseek-v4-flash` 已从 0.1.7 catalog 移除
  （DeepSeek-V41-Flash = `deepseek-flash`）——DEFAULT_MODEL 与组合行同步更替
- MCP 块前置 `dsh-mcp-resources` 行（0.1.7 dsh-mcp-client 的必备 peer）
- pi-ai 块、user-approval、session-projection 等行零改动

### 3. 运行时硬点（fail-loud 逐个攻克）
- **持久化 API 重构**：`sessionPersistence.prepare(id)→{session}` 已移除，
  改 `open(id,'read')→SessionHandle` + `handle.read()→{events}`——fork/child
  只读回放改造为轻量视图（sessionEventsOf 收口天然兼容）
- **消息 source 词表**：0.1.7 移除 catch-all `'plugin'` kind（merge-extensible，
  各生产者自有 kind）。loom-memory 的 recall/extraction 注入改用官方
  **`runtime-context`** kind（与内核 loop 的动态上下文同款）——曾试过模块增广
  注册自定义 kind，类型层通过但**落盘编码拒绝**（会话目录空壳、日志不物化），
  实测后回退到官方 kind
- **fork 语义放宽**：turn 中间分叉不再 400 OPEN_TURN——`buildForkSeed` 用合成
  forked 收尾器关闭开放尾（`interruptedTurnClosers` 家族）；e2e 断言更新为
  "200 + 子会话含前缀与合成收尾"
- **tool/result 双形状**：0.1.7（格式 v4）message.content 直接是内容块数组
  （text 块平铺）且 isError 升到 message 层；旧 v2 是外层块内嵌 content——
  projection/eval 双兼容
- ContentBlock 转型、嵌套对象显式 additionalProperties（swarm 工具已满足）
- **注入后主动 flush（CI 专项）**：0.1.7 jsonl 持久化按批写入——recall/路径注入
  splice 在无 key 快速失败路径下滞留批队列（Linux 批处理窗口实测 20s 不落盘；
  Windows win32 write-through 立即发布，故本地过而 CI 红）。修法：运行时在
  agent.inject 后调 sessionPersistence.flush() 再返回 200——注入是「模型可见⟺
  落日志」不变式的一部分，不该被调度窗口扣住

### 4. 会话格式 v2→v4（两代，自动迁移）
- 新日志 `session.v4.jsonl`；事件信封新增 `surfaceOp`/`sourceEventSeqs`；
  `assistant/message` 内嵌 stream + usage；新事件 `agent/inbox/spliced`
 （inbox 持久化投影）、`request/header|context`、`system/message`
- **存量 v2 日志**：恢复时相邻代迁移自动进行、原文件逐字节保留——resume e2e
  实证（SIGKILL 重启后 v2→v4 迁移 + 历史完整重放 + 同会话续聊）
- 外部读者（loom eval 的 slim 投影）对所关注字段天然兼容（已验证）

## 测试证据

| 阶梯 | 结果 |
|---|---|
| 单测全量 | 270 绿 |
| 全量 pnpm test（含真实模型链：审批/委派/webhook/记忆/路径/swarm 三段/semantica 四证据链/minimax 真端点） | **411 绿**（0.1.2 基线同为 411，零回归） |
| resume（SIGKILL 重启 + v2→v4 迁移） | 绿 |
| loom dev 冷启动 | health 200 + 就绪横幅 |

## 对 Loom 应用开发者的影响声明

- **声明式 API 零变化**：`app.tool/agent/subagent/swarm/policy/memory/skills/mcp/python`
  签名与语义不变；组合生成自动跟上（重新 `loom dev` 即重写 cordis.yml）
- **默认模型更替**：未显式声明 model 的应用从 v4-flash 变为 `deepseek-flash`
 （V41）；显式声明者不受影响（显式优先是官方语义）
- **会话日志**：老会话自动迁移，原文件保留；直接读 jsonl 的自定义工具需注意
  v4 信封（surfaceOp/内嵌 stream）——用 `loom eval --slim` 或 /events 端点则无感

## 0.1.7 新能力（未启用，记入 roadmap）

MCP resources（`ctx.mcpResources`）、PTC runtime（run_code，out-of-process）、
后台任务、SSH 远程工作区、Agent Teams（spawn_teammate）、send_message 双向、
插件兼容性检查、`--dump-config-schema`。深度委派（maxDepth）与 per-agent
provider 已分别被 M15/M14 抢先用上。

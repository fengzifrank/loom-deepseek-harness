# Harness 0.1.2 迁移调研笔记（2026-09-06，未完成迁移）

> 官方已发布 0.1.2-rc.1（npm `next`，2026-09-03）与 0.1.3-alpha.1（GitHub 预发布，
> 2026-09-04）。本文记录升级尝试的全部发现——**结论：0.1.2 是一次真正的迁移工程，
> 不是钉版本**；Loom 暂留 0.1.1-rc.1（全量 391 测试绿），下轮专攻。

## 官方版本态势

| 版本 | 日期 | 状态 | 备注 |
|---|---|---|---|
| 0.1.1-rc.1（当前钉） | 08-21 | 稳定 | Loom 全绿基线 |
| 0.1.1-rc.2 | 08-21 | 补丁 | 同日 +6h，低风险 |
| **0.1.2-rc.1** | 09-03 | npm next | 启动机制变更 + peer 纪律 |
| 0.1.3-alpha.1 | 09-04 | 预发布 | **破坏性**：Session persistence → SessionHandle、`agentLoop.create()` 异步、session 锁、格式 v2；官方自认性能回退 |

## 0.1.2 值得迁移的收益（对我们）

- **子智能体支持调用方指定 provider/model/reasoning/max output**——正是 M11 留的
  per-agent provider stretch 项的解锁钥匙；
- 子智能体 `send_message` 双向消息取代单向 `report`（critic 模式的修订循环更强）；
- Node 24.0–24.11.1 启动/HMR 修复；peer deps 解析成本优化；
- pi-ai 模型支持更新 + vLLM 思考（M11 网关直接受益）；
- DeepSeek 适配器上报插件版本（可关）/可选 session 日志上传（默认关）——**交付时
  注意关闭日志上传**（客户数据边界）。

## 已完成的迁移步骤（下轮直接复用）

1. **Peer 依赖闭包**（最大坑）：0.1.2 把 attachment/jobs/sandbox 等从 dependencies
   改成 **peerDependencies**——应用必须显式声明。不动点收集脚本已验证：从直接依赖
   出发迭代收集 peer 并集，需补 23 个包（dsh-attachment / dsh-jobs / dsh-sandbox /
   dsh-code-runtime / dsh-credentials / dsh-authorization / dsh-brand / dsh-fs /
   dsh-subprocess / dsh-util-time / dsh-typert-protocol / dsh-deepseek-llm-api-extensions /
   dsh-session-projection{,-cache} / dsh-client-connection / dsh-anonymous-user-id /
   dsh-atomic-write / dsh-timeout / dsh-agent-presets / dsh-subagent-in-process-driver …
   全部钉 `0.1.2-rc.1`）。
2. **版本线特例**：`@deepseek-ai/cordis-plugin-timer` 有独立版本线（1.1.4），
   不能跟 0.1.2 钉；cordis → 4.0.2。
3. **pnpm-workspace 豁免**：`minimumReleaseAgeExclude` 需加 0.1.2-rc.1 系条目
   （发布仅 3 天）；YAML 里 `@` 开头条目**必须加引号**（保留指示符）。
4. **schemastery 类型标注**：peer 优化后解析到 3.18.2，`Config` 裸推断报 TS2742；
   官方插件模式是 `export const Config: z<RuntimeConfig> = z.object({...})`
   （`z<Config>` 泛型标注，见 dsh-tools 0.1.2 的 d.ts）。已验证可编译。
   注意 3.18.1（当前）的默认导出类型形态不同（`Schemastery.Static`），标注要双向验证。

## 未解决的核心阻塞（下轮主攻）

- **启动机制变更**："应用统一通过 dsh Profile 启动"——app-boot 0.1.2 改用
  `cordis-plugin-include` + loader 加载我们的 cordis.yml 条目，出现
  `loader entries failed to apply` → `failed to import loader entry session-query-sqlite:
  The requested module '@deepseek-ai/dsh-llm' does not provide an export named 'assertNever'`
  ——dsh-llm@0.1.2-rc.1 的导出清单确实没有 assertNever（它自己从 dsh-util-values 导），
  疑似官方 rc 内部不一致或 loader 的解析根变了（从应用目录挪到 boot 调用方）。
- 连锁症状：boot 中止时并行 apply 里的 `c.on(...)` 报
  `cannot create effect on inactive context`（cordis 4.0.2 Fiber.assertActive）——
  是级联不是根因。
- 修复后全量回归仍是 20 文件失败 → 该链路修通前不升级。

## 下轮迁移清单（建议顺序）

1. 修 loader 解析根问题（读 0.1.2 源码 `dsh-app-boot/lib/index.js` 的 Include._apply
   与官方 examples/jsonrpc-agent 的 0.1.2 组合写法——我们本地快照
   `F:\deepseek\deepseek-harness-master` 是 0.1.0-rc.5，需拉新源码对照）；
2. 应用 peer 闭包 + 版本特例 + 豁免表（本文步骤 1-3）；
3. `z<RuntimeConfig>` 标注 + 双版本编译验证；
4. 解锁收益项：AgentSpec.provider per-agent 路由（M11 stretch）、send_message 双向
   委派（critic 模式增强）；
5. 全量 391+ 测试回归 + 真实模型 e2e；
6. 0.1.3 的 SessionHandle 破坏性变更**暂不追**（alpha + 已知性能回退）。

## 隐私注意（交付相关）

0.1.2 起 DeepSeek 官方适配器默认随请求上报已启用插件的包名与版本（可配置关闭），
并有可选的 session 日志增量上传（默认关）——**客户私有化交付（农业内网 Ollama 路径
不受影响，走 pi-ai）要在配置里显式确认这两项**。

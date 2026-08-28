# 技能文件（M12）：SKILL.md 让知识随应用走

> `app.skills()` 一行声明后，`skills/` 目录里的 `<name>/SKILL.md`（或平铺
> `<name>.md`）成为模型可加载的技能：会话开始时模型收到**技能目录**（名称+描述
> 摘要，热刷新），需要时调 `skill` 工具加载全文。FDE 交付姿势：知识文件（植保
> 指南、SOP、合规清单）随应用走，**改知识不改代码**。底层是内核三插件：
> `dsh-skill`（注册表）+ `dsh-skill-filesystem`（文件发现，Chokidar 热监视）+
> `dsh-tool-skill`（模型面 `skill` 工具 + 目录 digest 热刷新）。

## 声明

```ts
import { defineApp } from '@loom-sdk/web'

const app = defineApp('tcm-platform', { model: 'deepseek-v4-flash' })

app.skills()                        // 缺省目录：'skills'（相对 loom.app.ts）
app.skills({ dirs: ['knowledge', 'sop'] })  // 多目录（相对或绝对）
```

## 技能文件格式

```markdown
---
name: greeting-guide          # 必填，kebab-case
description: 中医馆问候规范。当用户要求打招呼或自我介绍时使用。   # 必填（目录摘要）
---

# 问候规范
1. 称呼必须以"施主"开头。
2. 语气平和，不使用网络用语。
```

- 目录只扫**一层**：`<dir>/<name>/SKILL.md` 或平铺 `<dir>/<name>.md`；
- frontmatter 可选字段：`whenToUse`、`metadata`、`disable-model-invocation`、
  `user-invocable`；
- **目录与正文生命周期分离**：发现只解析 frontmatter 做摘要；每次加载都重读全文
  ——改正文即时生效，改 frontmatter 触发目录热刷新（digest 变化 → 下一步前重发目录）。

## 隔离模式（诚实边界）

Loom 生成的组合用 `includeDefaultRoots: false`——**只扫应用声明的目录**，不吃
项目的 `.dsh/skills`、`.agents/skills` 或用户 `~/.dsh/skills`。理由：部署态应用
应当自包含；开发者的个人技能混进客户交付物是事故而不是能力。需要项目/用户根的
场景请直接在 yml 层加 `dsh-skill-filesystem` 实例（那是 harness 原生能力）。

## 模型体验

1. 会话首个请求前收到 `<available_skills>` 目录（仅摘要，省 token）；
2. 任务匹配或用户点名 → 模型调 `skill` 工具加载全文；
3. 同一会话不重复加载；目录变更热刷新（新增/删除/改名都会重发）。

## 与 oci-agent skills 的对照（设计出处）

oci-agent 的 `skills/*.md`（Claude Code 同款格式）验证了"小而固定的技能集内联、
零检索"的做法；Loom 走得更远——目录消息 + 按需加载由内核插件管理（digest 热刷新、
压缩遮蔽恢复），应用只声明目录。

## 测试证据

- 单测：`packages/web/test/compose-skills.test.ts`（声明器校验 + 三行组合物化）。
- e2e：`examples/gis/tests/skills.e2e.test.ts`——无 key 段（组合三行 + 隔离目录 +
  boot）；带 key 段（真实模型调 `skill` 工具加载 `greeting-guide` 并按规范回答
  "施主…祝君安康"）。

## 应用依赖

使用 `app.skills()` 的应用需安装 `@deepseek-ai/dsh-skill` +
`@deepseek-ai/dsh-skill-filesystem` + `@deepseek-ai/dsh-tool-skill`
（组合按 npm 名从应用 node_modules 解析）。

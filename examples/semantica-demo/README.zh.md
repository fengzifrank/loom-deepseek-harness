# semantica-demo：Loom × semantica 融合示例

Loom 管"怎么做"（执行/策略/审批/预算），semantica 管"知道什么"（知识图/判例/
因果链/SHACL/溯源）。设计文档见 [docs/semantica.zh.md](../../docs/semantica.zh.md)。

## 安装（首次，约 10-30 分钟 + GB 级磁盘）

```bash
python -m venv .venv
# Windows（Git Bash）：
.venv/Scripts/python.exe -m pip install "semantica==0.6.8" "semantica[shacl]==0.6.8"
echo 'DEEPSEEK_API_KEY=sk-...' > .env
```

> 钉死 0.6.8：该版本才修复 MCP 持久化（#1394），且 README 与实际 API 存在命名
> 漂移——`py_tools.py --selftest` 会校验我们用到的每个方法名（升级先跑它）。

## 运行

```bash
pnpm install
pnpm loom dev                # 桥路径主示例（http://127.0.0.1:4620/~loom/health）
pnpm loom dev loom.mcp-app.ts  # MCP 零代码变体（独立 graph-mcp.json）
```

首次对话时桥惰性导入 semantica（~10 秒），空图自动种入演示数据：连河村/河边村、
水稻/小麦、稻瘟病/蚜虫，加一条历史防治决策（春雷霉素判例）。

## 试一下（对 plant-doctor 说）

- "连河村水稻要防稻瘟病，先查判例再给方案，并把决策入账" →
  查判例 → 给方案 → `agri_record_decision` 弹**审批卡** → 允许后入账返回决策 id；
- "追溯刚才那条决策的因果链" → `agri_causal_chain`；
- 对 `trace-auditor` 说 "查 village-lianhe 的数据来源" → `agri_provenance`。

## 两个 agent

| agent | 职责 | 纪律 |
|---|---|---|
| `plant-doctor` | 植保专家：查判例 → 补图 → 决策入账（审批）→ 因果复核 | 先判例后结论 |
| `trace-auditor` | 溯源审计：来源链/判例/因果链 | 只查不改（persona 约束） |

> v1 边界：Python 桥工具在全局层，两个 agent 都可见——只读纪律靠 persona，
> 写门禁靠策略（`agri_record_decision` → approve；预算 30 次/会话）。

## 测试

```bash
pnpm vitest run examples/semantica-demo/tests/
```

无 key 段（boot/组合/协议直调）永远可跑；带 key 段需要 `.env`。未装 venv 的
机器全部自跳过（`semanticaReady()` 守卫先跑 `--selftest`）。

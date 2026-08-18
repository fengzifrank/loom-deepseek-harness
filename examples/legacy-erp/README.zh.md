# Loom 老系统对接示例（legacy-erp）

**一个故事讲完：把一台"2018 年上线的进销存 ERP"三路接进 Loom——agent 直接查/改老系统数据，写操作有审批，全程可回放。**

- 模拟老系统：`legacy-server/`（零依赖 node:http，端口 **4710**，内存态 + JSON 落盘 + sqlite 库存冗余副本）
- Loom 应用：`loom.app.ts`（智能体服务 **4640** + Vite 前端 **5174**）
- 演示话术：查库存（导入工具）→ 查流水（手写包装）→ 直连库对账（readonly sqlite）→ 下单（审批卡，真实扣库存）

## 三路接入决策表：什么形态的老系统走哪路

| 你的存量系统长什么样 | 走哪路 | 本例对应 | 一句话理由 |
| --- | --- | --- | --- |
| 有 OpenAPI/Swagger 文档（FastAPI、新版网关、代码生成器产物） | **路 1 · 一键导入** | `loom.openapi.ts`（生成物）+ `registerImportedTools(app)` | `loom import-openapi` 一条命令：每个 operation 变成 Loom 工具（真 fetch execute），模型面孔 + HTTP 面孔 + 策略/审批白得；文档覆盖不了的 schema 部分**诚实降级**并留 `WARN(openapi-import)` 注释 |
| 接口在跑但没有文档（老运维口头交接、文档年久失修） | **路 2 · 手写包装** | `erp_stock_movements`（loom.app.ts） | 十几行工具声明：fetch + 注入认证 + 如实声明 output schema——治理与回放照常生效 |
| 连 HTTP API 都没有，只剩一个数据库 | **路 3 · 只读直连库** | `erp_db_stock_audit`（loom.app.ts） | `node:sqlite` 以 `readOnly: true` 打开老库做对账审计——sqlite 层拒绝写入，Loom 侧绝无写坏老库的可能（框架 engines ≥22.13，node:sqlite 免 flag） |

选路原则：**能走路 1 就走路 1**（文档即真理，源头变更重新生成即可）；路 2 补文档的盲区；路 3 只做读、永远只读。三路可以（且经常应该）混用——本例一台老系统三路全用上。

## 老系统（legacy-server）的"老"

- 认证是 2018 年流行的 `X-Api-Key` 头（所有 `/api/*` 都要，缺头 401）；`GET /openapi.json` 不设防。
- 手写 OpenAPI 3.0 文档**故意不完整**：只文档化了 products/customers/orders 的查询与粗糙的创建订单；`POST /api/orders` 的 requestBody 没有字段描述、带着 `minLength`/`minItems` 约束——导入时生成器如实降级（3 条 `WARN` 注释：2 条约束丢弃 + 1 条响应缺 schema 按任意 JSON 处理）；库存流水 `GET /api/stock-movements` 压根没写进文档（路 2 的存在理由）。
- 下单即扣库存（库存不足 409 `INSUFFICIENT_STOCK`，订单不落账）；JSON 账本（`data/erp-state.json`）与 sqlite 冗余副本（`data/erp.db`）双写。

## 启动步骤

```bash
# 0) 仓库根目录：pnpm install && pnpm build:sdk（首次）；.env 已含密钥则跳过第 3 步说明
# 1) 起老系统（独立小服务器，供演示与测试）
pnpm legacy:server                 # = node examples/legacy-erp/legacy-server/server.mjs → http://127.0.0.1:4710
#    重置回种子数据：node examples/legacy-erp/legacy-server/server.mjs --reset

# 2) 起 Loom demo（另一终端）
pnpm dev:legacy                    # 智能体服务 4640 + Vite 前端 5174
#    浏览器打开 http://localhost:5174

# 3) 密钥（examples/legacy-erp/.env）：
#    DEEPSEEK_API_KEY=sk-...        # 对话需要
#    LEGACY_API_KEY=legacy-key-2018 # 老系统的 X-Api-Key（loom.import-env 会映射给
#                                   # 生成物约定的 LOOM_IMPORT_TOKEN 注入位）
```

自检（不开 UI）：

```bash
curl http://127.0.0.1:4640/~loom/health          # 三路工具 + 策略（3 条规则）
curl "http://127.0.0.1:4640/~loom/api/erp_db_stock_audit?below=10"   # 直连库审计（无需对话）
curl http://127.0.0.1:4710/api/products           # 401（老系统要 key）
curl -H "X-Api-Key: legacy-key-2018" http://127.0.0.1:4710/api/products
```

## 演示话术（照着输就行）

1. **路 1 查询（导入工具）**：`查一下库存低于 10 的商品并给补货建议`
   → 模型调 `erp_list_products`（导入生成）→ 回答"轴承 D60 剩 4、液压油 L46 剩 7"+补货建议。
2. **路 2 查流水（手写包装）**：`查一下轴承 D60 的库存流水`
   → 模型调 `erp_stock_movements`（手写包装的未文档化接口）→ 入库/出库历史带原因。
3. **路 3 直连库对账**：`不放心 API，直连数据库审计一下低库存`
   → 模型调 `erp_db_stock_audit`（readonly sqlite）→ 与路 1 结果互相印证。
4. **写操作 + 审批（允许）**：`帮 C001 下单买 2 个轴承 D60`
   → 聊天流出现**审批卡**（工具/参数预览）→ 点"允许" → 工具成功返回订单号 → 老系统
   `erp-state.json` 的 P101 库存 4→2，sqlite 副本同步为 2（真实副作用）。
5. **写操作 + 审批（拒绝）**：再下一单 → 点"拒绝" → 工具以 `rejected` 失败 →
   模型如实告知"订单未创建"，库存一字不动（fail-closed）。
6. **回放**：任一会话 `GET /~loom/sessions/<id>/events?since=-1&to=<seq>` 有界重读；
   `POST /~loom/sessions/<id>/fork` 在 turn 边界分叉——三路调用、审批问答全程可回放。

## 重新生成导入物（源头文档变更后）

```bash
pnpm legacy:server &   # 老系统在跑（或任何 OpenAPI 3.x 源）
cd examples/legacy-erp
pnpm exec loom import-openapi http://127.0.0.1:4710/openapi.json --base http://127.0.0.1:4710 -o loom.openapi.ts
# 生成日志含"降级警告 N 条"——诚实降级的展示点；loom.openapi.ts 零手改
```

## 测试

```bash
# 仓库根目录
pnpm test            # 全量（含本示例；gis 零回归）
./node_modules/.bin/vitest run examples/legacy-erp/tests/smoke.test.ts     # 无 key 冒烟（老系统 401/409/文档可达 + 三路 .http() 直调）
./node_modules/.bin/vitest run examples/legacy-erp/tests/erp-e2e.test.ts   # 带 key 三路证据链（查询/审批允许+库存实减/审批拒绝+库存不变）
```

测试自行起老系统（冒烟 4711 / e2e 4712，经 `LEGACY_ERP_BASE` 指向）与 loom（4641/4642），不与演示端口冲突；结束后把 `erp-state.json` 还原为测试前快照。

## 目录

```
examples/legacy-erp/
├── loom.app.ts            # 三路接入声明（每路注释讲清适用场景）+ agent + policy + memory + 投影
├── loom.import-env.ts     # LEGACY_API_KEY → LOOM_IMPORT_TOKEN（先于生成物模块体执行）
├── loom.openapi.ts        # AUTO-GENERATED（loom import-openapi；3 条 WARN 诚实降级注释）
├── legacy-server/
│   ├── server.mjs         # 模拟 2018 ERP：REST + X-Api-Key + openapi.json + sqlite 冗余
│   └── data/erp-state.json # 老系统账本（erp.db 由 server 生成维护）
├── src/                   # 极简前端（react-ui 复用 + 接入方式徽章 + 任务链）
└── tests/                 # helpers + 无 key 冒烟 + 带 key e2e
```

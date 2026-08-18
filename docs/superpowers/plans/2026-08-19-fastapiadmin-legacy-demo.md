# FastapiAdmin 真实老系统对接 Demo 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用真实开源老项目 [FastapiAdmin](https://github.com/fastapiadmin/FastapiAdmin)（1.0k★ 的 FastAPI 企业后台）做一次完整的企业存量系统对接案例——Loom agent 通过 OpenAPI 导入直接操作老系统，写操作走人工审批，全程可回放。

**Architecture:** 老系统原样跑起来（SQLite 模式 + Windows 版 Redis），Loom 侧零改动老系统代码，只用 `loom import-openapi` 生成工具 + 一个手写登录包装处理 JWT；demo 应用挂在 loom workspace 的 `examples/fastapi-admin/`。

**Tech Stack:** FastapiAdmin v3（FastAPI+SQLAlchemy+Redis，uv 启动，默认账号 admin/123456，端口 8001）· Loom（import-openapi/policy/approval/react-ui）· tporadowski/redis Windows 移植版 5.0.14 · 本机 Python 3.13（uv 自动装 3.12）。

**已核实的关键事实（2026-08-19）：**
- 老项目 `backend/env/.env.example` 支持 `DATABASE_TYPE = sqlite`（官方注释列出 mysql/postgres/sqlite 三选项）→ 无需 MySQL
- Redis 字段必填（token/缓存硬依赖）→ 本机无 Redis/Docker/uv，需装；本机已有便携 MySQL 5.7 作升级备胎
- 快速启动：`cd backend && uv sync && uv run main.py run --env=dev`（首次自动建表+初始数据）
- FastAPI 天然暴露 `GET /openapi.json` —— `loom import-openapi` 的完美输入
- 本机并行任务：examples/legacy-erp（离线模拟 demo）正在另一 agent 施工，与本计划文件无交集，互不干扰；两者最终定位：legacy-erp=CI 离线案例，本例=旗舰真实案例

**端口分配（避开运行中的 gis 4620/5173 与 legacy-erp 的 4640/4710/5174 及其测试占用 4641/4642/4711/4712）：** Redis 6379 · 老系统 8001 · Loom 4645 · 前端 5175

---

### Task 1: 基础设施准备（uv + Windows Redis）

**Files:**
- Create: `<workspace>\tools\redis\`（解压即用，不装服务）

- [x] **Step 1: 安装 uv（Python 包管理器，老项目钦定）**

```bash
export PATH="<node 与 pnpm 所在目录>:$PATH"
python -m pip install uv
uv --version
```
Expected: 输出 `uv 0.x.y`

- [x] **Step 2: 下载 Windows 版 Redis（tporadowski 移植版）**

```bash
mkdir -p <workspace>/tools && cd <workspace>/tools
curl -L -o redis.zip https://github.com/tporadowski/redis/releases/download/v5.0.14.1/Redis-x64-5.0.14.1.zip
powershell.exe -NoProfile -Command "Expand-Archive -Path redis.zip -DestinationPath redis -Force"
./redis/redis-server.exe --version
```
Expected: `Redis server v=5.0.14`

- [x] **Step 3: 启动 Redis 并验证（后台、无密码）**

```bash
<workspace>/tools/redis/redis-server.exe --port 6379 --daemonize no &
sleep 2 && <workspace>/tools/redis/redis-cli.exe -p 6379 ping
```
Expected: `PONG`（记录 redis PID 供收尾杀）

### Task 2: 克隆并启动老系统（SQLite 模式）

**Files:**
- Create: `<workspace>\FastapiAdmin\`（独立仓库，与 loom 无关）
- Create: `backend/env/.env.dev`（从模板复制修改）

- [x] **Step 1: 克隆仓库**

```bash
cd <workspace> && git clone --depth 1 https://github.com/fastapiadmin/FastapiAdmin.git
```

- [x] **Step 2: 写 .env.dev（sqlite + 本机 redis + 关掉它的 AI）**

```bash
cd /f/deepseek/FastapiAdmin/backend
cp env/.env.example env/.env.dev
# 逐项确认后修改（模板若键名不同以实际为准，记录偏差）：
#   DATABASE_TYPE = sqlite
#   REDIS_HOST = localhost / REDIS_PORT = 6379 / REDIS_PASSWORD =（置空）
#   OPENAI_API_KEY =（占位不用）
```
注：sqlite 模式下 `DATABASE_HOST/PORT/USER/PASSWORD` 大概率被忽略，保留原值即可。

- [x] **Step 3: uv sync + 启动**

```bash
export PATH="<node 与 pnpm 所在目录>:$PATH"
uv sync          # 自动按 .python-version 装 3.12 解释器并建 .venv
uv run main.py run --env=dev &
```
Expected: 首启日志出现建表/初始化数据，最后监听 `localhost:8001`。若 pydantic/SQLAlchemy 在 3.12 有版本报错 → `uv python install 3.12` 显式固定后重试（记录所用 Python 版本）。

- [x] **Step 4: 验证 openapi.json 与登录端点（一切对接的起点）**

```bash
curl -s http://127.0.0.1:8001/openapi.json -o /tmp/fa-openapi.json
node -e "const d=require('/tmp/fa-openapi.json');console.log('title:',d.info.title);console.log(Object.entries(d.paths).slice(0,20).map(([p,ms])=>Object.keys(ms).join(',').toUpperCase()+' '+p).join('\n'))"
```
Expected: 打印路径清单。**从中找出并记录**：登录端点（形如 /api/auth/login 或 /api/login）、用户列表/创建、角色列表/创建的真实路径与参数——后续 Task 3/4 全部以此为准，不猜测。

- [x] **Step 5: 手工验证登录拿 token（写进 demo 文档的"真实老系统第一步"）**

```bash
curl -s -X POST http://127.0.0.1:8001/<登录路径> -H "content-type: application/json" \
  -d '{"username":"admin","password":"123456"}'   # 字段名以 Step4 查到的 schema 为准
```
Expected: 返回含 access_token 的 JSON（记录确切字段名）。**报告禁止打印 token 值本身**。

### Task 3: Loom demo 应用 `examples/fastapi-admin/`

**Files:**
- Create: `examples/fastapi-admin/package.json`、`loom.app.ts`、`vite.config.ts`、`index.html`、`src/main.tsx`、`src/App.tsx`、`.env`（DEEPSEEK_API_KEY 从 gis 拷贝 + LEGACY_BASE_URL/LEGACY_ADMIN_USER/LEGACY_ADMIN_PASS）
- Create: `examples/fastapi-admin/loom.openapi.ts`（生成物，提交）
- Modify: 根 `package.json`（加 `dev:fa` script）、根 `vitest.config.ts`（include 扩到 `examples/fastapi-admin/tests/**`）

- [x] **Step 1: 应用骨架（照抄 legacy-erp/gis 的 package.json 模式）**

```json
{
  "name": "fa-example",
  "private": true,
  "type": "module",
  "scripts": { "dev": "loom dev", "build": "vite build", "loom": "loom" },
  "dependencies": { "@loom-sdk/web": "workspace:*", "react": "19.2.8", "react-dom": "19.2.8" },
  "devDependencies": { "vite": "8.2.1", "@vitejs/plugin-react": "6.0.5", "typescript": "5.9.3" }
}
```
`defineApp('fastapi-admin', { port: 4645 })`；vite 5175 + proxy `/~loom → 4645`；前端用 react-ui 组件组装（ChatStream/ApprovalCard/任务列表，顶部"真实老系统对接"徽章）。

- [x] **Step 2: OpenAPI 导入（路 1）**

```bash
cd /f/deepseek/loom/examples/fastapi-admin
pnpm exec loom import-openapi http://127.0.0.1:8001/openapi.json \
  --base http://127.0.0.1:8001 -o loom.openapi.ts --include '<按 Step4 查到的用户/角色/登录相关路径写 glob，如 api_*user* api_*role* api_auth*>'
```
Expected: 生成 `loom.openapi.ts`，汇总打印工具数与 WARN 降级行（真实老 schema 必有降级——展示点，记录 2-3 条原文）。**读生成物确认 token 注入方式**（`LOOM_IMPORT_TOKEN` env 何时读取：函数内每次读则可用运行时刷新；模块级 const 则需要 boot 时先登录再 import——按实际写 Task 3 Step 3，记录结论）。

- [x] **Step 3: 登录桥（路 2：JWT 过期这个真实痛点）**

```typescript
// loom.app.ts 内
async function loginLegacy(): Promise<string> {
  const res = await fetch(`${process.env.LEGACY_BASE_URL ?? 'http://127.0.0.1:8001'}/<登录路径>`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.LEGACY_ADMIN_USER, password: process.env.LEGACY_ADMIN_PASS }),
  })
  if (!res.ok) throw new Error(`老系统登录失败：HTTP ${res.status}`)
  return (await res.json()).<token字段>      // Step4 查到的字段名
}
```
boot 时登录一次写入 `process.env.LOOM_IMPORT_TOKEN`；另注册手写工具 `legacy_relogin`（无参，重登录刷新 token，返回 `{ok:true, expiresHint}`）——persona 写明"遇 401 先调 legacy_relogin 再重试"。

- [x] **Step 4: agent + policy**

```typescript
registerImportedTools(app)                      // 导入的路 1 工具
app.tool('legacy_relogin')/* ... output 如实声明 ... */
app.agent('admin-assistant', {
  persona: '企业后台管理助手，操作的是真实的 FastapiAdmin 老系统：查询用户/角色先调工具拿真实数据；创建/修改用户是真实写操作会触发人工审批，被拒不编造成功；遇 401 调 legacy_relogin 后重试；回答用中文。',
  memory: true,
})
app.policy({ default: 'allow',
  rules: [{ tool: '<按生成物中 创建/更新/删除用户与角色的实际工具名写 glob>', effect: 'approve' }] })
```

### Task 4: e2e 测试 `examples/fastapi-admin/tests/fa.e2e.test.ts`

**Files:**
- Create: `examples/fastapi-admin/tests/fa.e2e.test.ts`、`tests/helpers.ts`（进程编排：redis→backend→loom，Windows taskkill 收尾）

- [x] **Step 1: helpers 编排（spawn 三进程、ready 探活、afterAll 全杀报告 PID）**
  探活条件：6379 PONG → 8001 /openapi.json 200 → 4641 /~loom/health 200。backend 启动命令用 `uv run main.py run --env=dev`（cwd=backend，PATH 带 uv）。

- [x] **Step 2: e2e-查询（带 key）**："列出系统里的角色" → SSE 证据：导入生成的列表工具被调用 + 回答含真实角色名。

- [x] **Step 3: e2e-写+审批允许（带 key）**："创建用户 zhangsan_n，昵称张三，角色普通用户"（字段按 Step4 schema）→ 审批卡 → POST allowed-once → **再次查询该用户存在**（老系统 sqlite 真实写入的证据）→ turn/end completed。

- [x] **Step 4: e2e-审批拒绝**：同请求 → rejected → 工具 isError + 再查询用户不存在。

- [x] **Step 5: 全量回归**

```bash
cd /f/deepseek/loom && pnpm build:sdk && pnpm typecheck && pnpm test
```
Expected: 326 基线 + 新增全绿；gis/legacy-erp 零回归；openapi/client 新鲜度零漂移。

### Task 5: 一键启动、文档与收尾

**Files:**
- Create: `examples/fastapi-admin/start-all.mjs`（redis→backend→loom dev 三进程编排，Ctrl+C 级联）
- Create: `examples/fastapi-admin/README.zh.md`；Modify: 根 `README.md`/`README.zh.md`（Examples 表加一行 + "真实老系统对接"3 句话小节）、`docs/learn.html`（FAQ 加"有真实老系统对接案例吗？"，§十一末尾加一句指向；改后跑结构校验脚本）

- [x] **Step 1: start-all.mjs + 手测三端口**（4710 无关；本例 6379/8001/4641/5175 全起、页面可登录老系统账号演示）
- [x] **Step 2: README 写"一天对接真实老系统"叙事**（决策表：有文档→import-openapi / 无文档→手写 / 只有库→直连；本例展示前两路 + 登录桥）
- [x] **Step 3: learn.html FAQ + 结构校验**（section 开闭/无重复 id/导航锚点）
- [x] **Step 4: 收尾**：杀掉本计划启动的所有进程（redis/backend/loom/vite，报告 PID）；`<workspace>\FastapiAdmin` 保留（独立仓库，demo 依赖它）

---

## 风险与预案

| 风险 | 预案 |
|---|---|
| uv 在国内网络拉 Python 3.12/依赖慢或失败 | 设 `UV_PYTHON_INSTALL_MIRROR`（清字号镜像）；重试；极端时用本机 3.13 直接 venv+pip（记录依赖兼容性结论） |
| Redis Windows 移植版被老项目特性拒绝（RESP3 等） | 5.0.14 走 RESP2，FastAPI redis 库（redis-py）默认兼容；若报错→换 Memurai dev 或评估内存假 redis（如实报告） |
| sqlite 模式有隐藏坑（迁移/字符集） | 备胎：本机便携 MySQL 5.7（新 datadir + 3307 端口，不动原数据）；仍不行则记录为老系统环境限制 |
| JWT 短过期打断演示 | legacy_relogin 工具 + persona 401 重试（已设计） |
| 老系统 openapi 的 auth 字段命名与假设不符 | 一切以 Task 2 Step 4 实测为准，计划中的 `<登录路径>`/`<token字段>` 占位即彼时落定——**这正是"从 openapi.json 认识老系统"的方法论本身** |

## Self-Review 结论

- 覆盖：真实老系统启动/三路接入中的两路+登录桥/审批写路径 e2e 允许与拒绝/一键启动/双语文档——用户诉求"完整 demo 开发案例"全覆盖；第三路（直连库）由并行的 legacy-erp 案例承担，README 决策表互相引用
- 占位符：`<登录路径>`/`<token字段>`/glob 为"以实测为准"的显式留白（附方法论说明），非偷懒占位
- 一致性：端口/路径/包名前后一致（4641/5175/8001/6379；fa-example；loom.openapi.ts）

## 执行结果摘要（2026-08-19 收尾）

- 五任务全部交付：老系统（SQLite 模式 + Windows Redis）原样运行零改动；OpenAPI 导入 15 工具（过滤 183、诚实降级 WARN 493 条）；登录桥三层结构（顶层 await 登录 + fetch 按次读 env 注 Bearer + legacy_relogin 热刷新）解 oauth2 生成器缺口；e2e 四链全绿（查询 / 审批允许+老系统侧直查落库 / 审批拒绝 fail-closed / 401 自愈）；`start-all.mjs` 一键编排三进程（探活串联、复用识别、级联退出）。
- 对接反哺框架：FastAPI `Optional[X]` 的 `anyOf:[T,null]` 可空联合由降级改为忠实转 `oneOf:[T,{type:'null'}]`，导入 WARN 858→493；最终回归 **338 passed + 1 skipped 全绿零漂移**，gis openapi/client 生成物 md5 不变。
- 文档齐备：examples/fastapi-admin/README.zh.md（一天对接叙事 + 三路决策表 + 演示话术 + 已知限制三条）、根 README 双语 Examples 表与"老系统对接"旗舰案例小节、docs/learn.html FAQ"有真实老系统的对接案例吗？"与 §十一 双案例指向（结构校验 14 section/14 id/16 锚点/h2 序号连续全通过）。


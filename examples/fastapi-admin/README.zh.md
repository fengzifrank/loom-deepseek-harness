# Loom 真实老系统对接示例（fastapi-admin）

**一个故事讲完：一天之内，把一台真实在跑的开源企业后台 [FastapiAdmin v3](https://github.com/fastapiadmin/FastapiAdmin)（1k★，FastAPI + SQLAlchemy + Redis）接进 Loom——agent 直接查/写老系统，写操作走人工审批，全程可回放。** 与 `examples/legacy-erp`（离线模拟案例）互补，本例是旗舰"活系统"实录：老系统一行代码不改，Loom 侧只有两份手写文件（`loom.app.ts` + `loom.import-env.ts` 登录桥）。

- 老系统：克隆 FastapiAdmin 到本机任意目录（如 `<workspace>/FastapiAdmin`），`backend` 以 SQLite 模式 + Redis 运行，端口 **8001**，默认账号 admin/123456（详见下方"启动老系统"）
- Loom 应用：`loom.app.ts`（智能体服务 **4645** + Vite 前端 **5175**）
- 演示话术：查用户（导入工具）→ 查角色（手写补位）→ 创建用户过审批卡 → 401 自愈（token 热刷新）

## 三路接入决策表：什么形态的老系统走哪路

| 你的存量系统长什么样 | 走哪路 | 本例对应 | 一句话理由 |
| --- | --- | --- | --- |
| 有 OpenAPI/Swagger 文档（FastAPI、新版网关、代码生成器产物） | **路 1 · 一键导入** | `loom.openapi.ts`（生成物）+ `registerImportedTools(app)` | `loom import-openapi` 一条命令：每个 operation 变成 Loom 工具（真 fetch execute），模型面孔 + HTTP 面孔 + 策略/审批白得；文档覆盖不了的 schema 部分**诚实降级**并留 `WARN(openapi-import)` 注释 |
| 接口在跑但有文档管不到的口子（认证流程、没进 include 的域） | **路 2 · 手写包装** | 登录桥 `loom.import-env.ts` + `legacy_roles_list` / `legacy_relogin` | 十几行工具声明或一个 fetch 包装：注入认证 + 如实声明 output schema——治理与回放照常生效 |
| 连 HTTP API 都没有，只剩一个数据库 | **路 3 · 只读直连库** | 见 [`examples/legacy-erp`](../legacy-erp/README.zh.md) | `node:sqlite` 以 `readOnly: true` 打开老库做对账审计——离线模拟案例里全流程演示 |

选路原则与 legacy-erp 相同：**能走路 1 就走路 1**，路 2 补文档的盲区（本例是 JWT 登录这个所有企业系统都有的真实痛点），路 3 只做读。本例覆盖前两路 + 登录桥。

## 启动（三步，或一步）

```bash
# 0) 仓库根目录：pnpm install && pnpm build:sdk（首次）
# 1) 一键启动（推荐）：Redis 6379 → 老系统 8001 → loom dev（4645 + Vite 5175），
#    探活一个再起下一个；已在跑的自动"复用"，Ctrl+C 级联退出（只收割自己拉起的）
pnpm demo:fa                       # = node examples/fastapi-admin/start-all.mjs
#    浏览器打开 http://localhost:5175

# 2) 密钥与老系统账号（examples/fastapi-admin/.env，已含则跳过）：
#    DEEPSEEK_API_KEY=sk-...          # 对话需要
#    LEGACY_BASE_URL=http://127.0.0.1:8001
#    LEGACY_ADMIN_USER=admin  LEGACY_ADMIN_PASS=123456   # 老系统登录（登录桥用）

# 3) 手动分步（等价，调试用）：
/f/deepseek/tools/redis/redis-server.exe --port 6379 &
cd /f/deepseek/FastapiAdmin/backend && uv run main.py run --env=dev &
cd /f/deepseek/loom && pnpm dev:fa   # 只起 loom dev（4645 + 5175）
```

自检（不开 UI）：

```bash
curl http://127.0.0.1:4645/~loom/health        # 17 工具（15 导入 + 2 手写）/ 策略 9 规则
curl -s http://127.0.0.1:8001/openapi.json -o /dev/null -w "%{http_code}\n"   # 200：对接的起点
```

## 演示话术（照着输就行）

1. **路 1 查用户（导入工具）**：`系统里有哪些用户？`
   → 模型调 `get_user_list_…`（导入生成）→ 真实用户清单（含演示用户 `zhangsan_demo`，id=4）。
2. **路 2 查角色（手写补位）**：`列出所有角色和它们的编码`
   → 模型调 `legacy_roles_list`（角色域没进导入 glob，手写包装补位）→ 超级管理员/管理员/普通用户[USER] 带 id 对照。
3. **创建用户 + 审批（允许）**：`创建用户 wangwu_demo，昵称王五，角色普通用户`
   → 聊天流出现**审批卡**（工具/参数预览）→ 点"允许" → 老系统 SQLite 真实落库（异步写，~6s 后再查可见）→ 模型引用 id 作答。点"拒绝"则工具以 rejected 失败，模型如实告知"未执行成功"。
4. **401 自愈（token 失效的真实痛点，实测可行）**：老系统每个认证请求都要查 Redis 会话（db 1 的 `user_session:*`）。管理员踢会话/Redis 重启都会让 token 失效——演示时就模拟它：
   ```bash
   /f/deepseek/tools/redis/redis-cli.exe -p 6379 -n 1 keys 'user_session:*' | tr -d '\r' \
     | xargs /f/deepseek/tools/redis/redis-cli.exe -p 6379 -n 1 del
   ```
   → 再问 `查一下用户列表` → 导入工具 401（isError）→ 模型按 persona 自动调 `legacy_relogin` 重登录 → fetch 包装按次读 env，新 token 即时生效 → 重试成功，**全程无需重启 loom dev**。

## 已知限制（如实记录——它们本身就是"老系统文档与实现偏差"的活教材）

1. **DELETE 带 body 的端点**：老系统 `DELETE /system/user/delete` 的 body 是 JSON int 数组；生成器把 DELETE 归为只读方法（body 并入 query），导入的 `delete_user` 工具对该端点会 422。演示删除语义时以审批卡 + 模型如实报错为准（文档说有 body、实现按 query 收——对接真实系统必然遇到的偏差形态）。
2. **search JSON 参数老系统不解析**：用户列表的 `search` 参数在 openapi 里是 JSON 对象（FastAPI Query 模型展开为平铺 `username=`），老系统实际只认平铺形态——persona 已指导模型"无条件就传 `{}`"，精确过滤走老系统侧可用的平铺参数。
3. **SQLite 模式写后异步落库**：写接口 HTTP 200 先于数据对后续读可见（实测 ~6s）。演示"创建后再查"若立刻查可能暂时看不到——等几秒重问即可（e2e 用轮询容忍，人类演示自然节奏正好）。

## 技术要点（这次对接踩出来的，值得抄）

- **`--base` 必须带 `/api/v1`**：老系统 openapi 的 `servers[0].url` 是相对前缀 `/api/v1`，生成器的 `--base` 是整体替换不是拼接——写 `http://127.0.0.1:8001/api/v1`。
- **导入规模**：195 路径/198 operation 里用 `--include '*system_user*'` 聚焦用户域 → **15 个工具 / 过滤 183 / 降级警告 493 条**（真实老 schema 的 pattern/format/min·max 约束被诚实降级，分类大头是 maxLength 等约束丢弃；全部留 `WARN(openapi-import)` 注释，绝不静默出错）。
- **登录桥三层结构**（`loom.import-env.ts`，生成物零手改、框架零改动）：① 顶层 `await` 登录（POST `x-www-form-urlencoded`——老系统登录是 form 不是 JSON）写 `LOOM_IMPORT_TOKEN`，失败则整个应用带中文报错退出；② 包装 `globalThis.fetch` 只对老系统请求按**每次调用实时读 env** 注入 `Bearer`——这绕开了生成物 token 是模块顶层 const（运行时改 env 无效）的限制；③ `legacy_relogin` 工具重登录即热刷新，token 过期不用重启。
- **oauth2 生成器缺口**：老系统 securitySchemes 是 `oauth2(password flow)`，生成器只覆盖 http/bearer 与 apiKey，对 oauth2 留 TODO——上面那座 fetch 桥就是通用解法（也适用于任何"文档认证描述与实际不符"的老系统）。
- **这次对接反过来改进了框架**：FastAPI 的 `Optional[X]` 生成 `anyOf:[T,null]` 可空联合，早期生成器把它降级成宽松 json（WARN 858 条）；修复为忠实转成 `oneOf:[T,{type:'null'}]` 后内核按类型接受 null，WARN 858→493。真实系统是最好的测试集。

## 重新生成导入物（源头文档变更后）

```bash
# 老系统在跑（start-all 或手动），然后：
cd examples/fastapi-admin
pnpm exec loom import-openapi http://127.0.0.1:8001/openapi.json \
  --base http://127.0.0.1:8001/api/v1 -o loom.openapi.ts --include '*system_user*'
# 生成日志含"降级警告 493 条"——诚实降级的展示点；loom.openapi.ts 零手改
```

## 测试

```bash
# 仓库根目录（老系统 8001 + Redis 6379 在跑时全量，不在则本示例自跳）
pnpm test
./node_modules/.bin/vitest run examples/fastapi-admin/tests/fa.e2e.test.ts   # 带 key 四链 e2e
```

四条证据链：查询（真实角色名）→ 写+审批允许（老系统侧直查确认落库）→ 审批拒绝（可见性窗口内始终不出现）→ 401 自愈（注入坏 token → 模型调 `legacy_relogin` → 重试成功）。老系统与 Redis 是外部常驻进程，测试只探活不自起（CI 无老系统时不红）。

## 目录

```
examples/fastapi-admin/
├── start-all.mjs         # 一键启动：redis → 老系统 → loom dev（探活串联；Ctrl+C 级联）
├── loom.app.ts           # 路 1 注册 + 路 2 手写工具 + agent/persona + policy（9 规则）+ 投影
├── loom.import-env.ts    # 登录桥（顶层 await 登录 + fetch 包装按次读 env + relogin 导出）
├── loom.openapi.ts       # AUTO-GENERATED（15 工具；WARN 493 诚实降级注释，零手改）
├── src/                  # 极简前端（react-ui 复用 + "真实老系统"徽章 + 任务链）
└── tests/                # helpers（探活/老系统侧直查/SSE）+ fa.e2e 四链
```

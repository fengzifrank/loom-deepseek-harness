# Loom 认证与多用户（M7）

`app.auth()` 一行声明，Loom 应用即刻获得"匿名 UUID + 本地账号"双模身份、
会话归属隔离与记忆隔离。零第三方依赖（node:crypto 的 scrypt 与 HMAC）。

```ts
const app = defineApp('my-app')
app.auth()                                  // 默认 mode: 'anon-and-local'
app.auth({ corsOrigins: ['https://app.example.com'] })  // CORS 白名单（见下）
```

## 身份模型

| 身份 | 载体 | 获得 | 适合 |
| --- | --- | --- | --- |
| 匿名 | `x-loom-user: anon-<uuid>` 头（或 `?user=` query） | 前端自动生成（`useLoomAuth`） | 本地演示、单机工具 |
| 本地账号 | `Authorization: Bearer <token>`（或 `?token=` query） | `POST /~loom/auth/register` / `login` | 多人共用一个部署 |

解析优先级：Bearer token（HMAC 验签）→ `x-loom-user` / `?user=`（宽松格式
`/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/`，**且拒绝 `user-` 前缀**——该前缀是本地
账号 userId 的保留命名空间，防止伪造 `x-loom-user: user-alice` 冒充本地账号；
`hook:` 机器身份含冒号，天然不在匿名字符集内）。EventSource 不能带自定义头，
SSE 端点的 `?token=` 与 `?user=` query 参数与请求头**等价**。

## 访问规则

- **POST（状态变更）需要身份**：建会话 / 发消息 / fork / 审批答复无身份 →
  `401 {error: "该操作需要身份…", code: "IDENTITY_REQUIRED"}`；
- **只读 GET 放行**：`/health`、`/openapi.json` 永久公开；`GET …/events`
  匿名可读（兼容既有只读集成与回放调试）；
- **归属隔离**：带身份访问他人会话 → `404 {error: "会话不存在"}`（不泄露
  存在性；401 优先于 404——不向未认证方泄露任何会话）；
- **审批答复仅会话属主**；webhook 通道维持每通道 secret（机器身份），不参与
  用户身份体系。

## 本地账号

```
POST /~loom/auth/register {username, password}   → 200 {token, userId, username}（注册即登录）
POST /~loom/auth/login    {username, password}   → 200 {token, userId, username}
GET  /~loom/auth/me       （Bearer 或 ?token=）  → 200 {userId, username} | 401
```

- 用户名 3-32 字符（字母开头，可含数字与 `_ . -`）；密码 ≥ 8 字符；
- `.loom/accounts.json` 存 `{username: {salt, hash, createdAt}}`——scrypt
  派生（每用户独立 salt，登录比较 timingSafeEqual 恒时）；
- token = `base64url(JSON{u,exp})` + `.` + `base64url(HMAC-SHA256(密钥, 前段))`，
  默认 **7 天**过期；签名密钥 `.loom/auth-secret` 首次生成后持久化；
- 登录失败统一中文文案"用户名或密码不正确"——不泄露用户名存在性（注册的
  "已被注册"除外——注册必须可发现重复）。

## 会话索引（sidecar）

`.loom/sessions-index.json`：`{sessionId: {userId, agentId, title, createdAt,
updatedAt, kind}}`。会话创建时原子写入（temp + rename）；服务重启后路由遇到
内存未命中的 sessionId 先查索引——存在则惰性恢复（`agents.resume`，persona/
作用域工具与创建时相同），不存在才 404。`GET /~loom/agents/:id/sessions`
从索引列出该 agent 的会话（带身份只看自己的；title 取首条用户消息前 30 字）。

## 前端

```tsx
const auth = useLoomAuth()                                  // 匿名 UUID 自动生成；login/register/logout
<AuthPanel auth={auth} />                                   // 登录/注册/当前身份
const session = useAgentSession('data-analysis', { identity: auth.identity })
```

`useAgentSession` / `useProjection` / `useSubagentStreams` 自动带身份头，SSE
URL 自动附加 `?token=`/`?user=`；会话 id 持久化在
`localStorage['loom:session:<userId>:<agentId>']`（换账号自动切换各自的存档）。

## CORS 与生产边界

- **未声明 `corsOrigins`**（默认）：响应 `access-control-allow-origin: *`——
  本地演示与同源代理（Vite dev server）形态；
- **声明后**：按白名单回显请求 `Origin`（附 `vary: origin`），不在名单内的
  源不带 CORS 头（浏览器拦截）。

### 生产部署建议（责任边界）

Loom 的认证只覆盖**应用层身份**；TLS 与网络边界是部署者的责任：

1. **必须置于 TLS 反向代理之后**（nginx/Caddy）：Loom 自身只听 127.0.0.1，
   token 与密码明文 HTTP 传输在公网不可接受；
2. 反代透传 `Authorization` / `x-loom-user` 头与 SSE（`X-Accel-Buffering: no`
   已由服务端下发）；
3. 跨域访问时在 `app.auth({corsOrigins: [...]})` 声明白名单，避免 `*` 暴露；
4. 本地账号是**单部署内**的轻量方案（无找回密码/2FA/限流）——面向公网的大
   规模用户体系请接入反代层的 OIDC/SSO，把下游身份注入 `x-loom-user` 头；
5. `.loom/`（accounts.json / auth-secret / memory.db / sessions）包含全部
   凭据与用户数据——备份策略与文件权限由部署者负责。

## 设计取舍（现状）

- 匿名 GET 事件流放行是**开发友好的只读姿态**：未认证方可回放公开演示流，
  但任何写操作都需身份；生产要求严格私有请配合反代按路径收紧；
- token 无吊销列表（7 天自然过期）；登出即前端弃 token；
- userId 稳定可预测（`user-<username>`）——隔离语义靠不可猜测的 sessionId
  与归属校验，不靠 userId 保密；匿名身份解析拒绝 `user-` 前缀，本地账号
  userId 只能经 HMAC 验签的 token 获得（伪造头冒充 → 身份解析失败 → 401）。

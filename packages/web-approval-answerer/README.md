# dsh-web-approval-answerer

[English](#english) | [中文](#中文)

## 中文

DeepSeek Harness 的 SSE 审批 answerer 插件（安全关键路径组件）：把
`approval/request` 审批缝路由成宿主 Web 前端的审批卡。

语义全在本包：

- **approval/request answerer**：宿主认领的会话 → 经宿主桥 SSE 推
  `loom/approval-asked` 卡（approvalId/tool/callSeq/argsPreview/timeoutMs），
  等答复或超时；**超时按拒绝处理（fail-closed）**；req.signal abort →
  `cancelled`；非宿主会话 → `next()` 委托（无人应答则内核 fail-closed）。
- **待审批留档重发**：approval-asked 是合成事件（不落会话日志），SSE 重连
  重放拿不到它——宿主事件流在订阅挂上后调 `pendingPayloads(sessionId)`
  按原 approvalId 幂等重发。
- **答复裁决**：`answer(approvalId, sessionId, decision)` →
  `ok` / `unknown` / `wrong-session` / `already-decided` / `invalid-decision`
  （宿主映射 200/404/403/409/400）。**并发答复只认第一次**（幂等闸）。

宿主接缝（loose）：宿主经 cordis 服务 `webApprovalHost`（reflect.provide）
提供 `{ owns(sessionId), push(sessionId, payload), drainArgsPreview(callId),
callSeqOf(sessionId, callId), timeoutMs? }`；插件每次请求惰性解析，无激活
顺序耦合。HTTP 答复路由由宿主持有（身份门是宿主关切），路由处理器把裁决
委托给本插件服务 `webApprovalAnswerer` 的 `answer()`——线形不变，语义
全在插件。

### 用法（cordis.yml）

```yaml
# 前置：审批缝（本插件的 approval/request 事件由它声明）
- id: user-approval
  name: '@deepseek-ai/dsh-user-approval'

- id: web-approval-answerer
  name: dsh-web-approval-answerer   # 或 file:/// 绝对 URL
  # config:
  #   timeoutMs: 300000            # 宿主桥未给 timeoutMs 时的缺省（5 分钟）
```

### 钉版

peer：`@deepseek-ai/cordis` ^4.0.1；运行时仅依赖 `@deepseek-ai/schemastery`
3.18.1。与内核 rc 线同测版本：0.1.0-rc.6（npm latest tag 指向旧版
0.0.1-rc.1，勿裸装 latest）。

## English

An SSE approval answerer plugin for DeepSeek Harness (a security-critical-path
component): routes the `approval/request` seam into host-pushed SSE approval
cards. All approval semantics live in this package: the answerer listener
(timeout = reject, fail-closed; abort = cancelled; non-host sessions delegate
via `next()`), the pending registry with reconnect replay
(`pendingPayloads(sessionId)`), and the answer verdict
(`answer(approvalId, sessionId, decision)` with first-settle-wins 409
semantics). The host provides a loose `webApprovalHost` cordis service
(`owns`/`push`/`drainArgsPreview`/`callSeqOf`/`timeoutMs?`) and keeps the HTTP
route (identity gating is a host concern), delegating verdicts to the
`webApprovalAnswerer` service.

### Pinning

Peer `@deepseek-ai/cordis` ^4.0.1; runtime dep `@deepseek-ai/schemastery`
3.18.1. Tested against the kernel rc line 0.1.0-rc.6 (npm `latest` points at
the stale 0.0.1-rc.1 — never install bare `latest`).

## License

MIT

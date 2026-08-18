# dsh-python-tools

[English](#english) | [中文](#中文)

## 中文

DeepSeek Harness 的 Python 工具桥插件（loom-py v1 协议）：spawn 一个 Python
子进程，握手后把脚本里 `@tool` 声明的清单注册为模型可见的代理工具（进全局
工具层，全部 agent 共享）。进程崩溃自动重启（默认上限 3，超出 fail-loud）；
调用超时/abort 尽力取消。

### 用法（cordis.yml）

```yaml
- id: python-bridge
  name: dsh-python-tools   # 或 file:/// 绝对 URL
  config:
    command: "python py_tools.py"   # 按空格拆 argv，支持引号路径
    # cwd: /path/to/dir            # 子进程工作目录（缺省继承）
    # env: { PYTHONPATH: /x }      # 附加环境变量
    # restartLimit: 3              # 自动重启上限（超出后工具 unavailable）
    # callTimeoutMs: 120000        # 单次调用超时
```

Python 侧用 loom-py 协议：`initialize` 互验 `{protocol:'loom-py', version:1}`，
`tools/list` 返回清单（name/description/parameters/output 的 JSON Schema），
`tools/call {name, args, callId}` 返回 `{value}` 或 `{error:{message}}`；
`tools/cancel` 通知无应答。参考实现见 Loom 仓库 `packages/loom-py`
（`@tool` 装饰器 + `run()` 主循环）。

挂载后插件经 `ctx.reflect.provide('loomPython', ...)` 提供服务
`{ toolNames, call(name, args, signal) }`（宿主 health/横幅计数与直调诊断用）。

### 钉版

peer：`@deepseek-ai/cordis` ^4.0.1；依赖 `@deepseek-ai/dsh-tools` 钉
0.1.0-rc.6（内核 rc 线 npm latest tag 指向旧版 0.0.1-rc.1，勿裸装 latest）。

## English

Python tool bridge plugin for DeepSeek Harness (loom-py v1 protocol): spawns a
Python subprocess, handshakes, and registers the script's `@tool` manifest as
model-facing proxy tools on the global tool layer (shared by all agents).
Crash auto-restart (default limit 3, then fail-loud); best-effort cancellation
on timeout/abort.

### Usage (cordis.yml)

See the Chinese section above — the YAML is identical. The Python side speaks
JSON Lines over stdio: `initialize` → `{protocol:'loom-py', version:1}`,
`tools/list` → manifest, `tools/call {name, args, callId}` → `{value}` or
`{error:{message}}`; `tools/cancel` notifications are fire-and-forget.

The plugin provides the `loomPython` cordis service
(`{ toolNames, call(name, args, signal) }`) for host health banners and
direct-call diagnostics.

### Pinning

Peer `@deepseek-ai/cordis` ^4.0.1; `@deepseek-ai/dsh-tools` pinned to
0.1.0-rc.6 (the rc line's npm `latest` tag points at the stale 0.0.1-rc.1 —
never install bare `latest`).

## License

MIT

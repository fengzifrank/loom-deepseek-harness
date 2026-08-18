# Python 工具桥（loom-py，M6）

**内核保持 TypeScript，Python 成为一等工具作者语言。** 你写一个普通 Python 脚本，
用 `@tool` 装饰器声明工具、末尾 `run()` 进入 stdio 协议主循环；loom.app.ts 里一行
`app.python({ command: 'python py_tools.py' })` 把它们注册为模型可见的代理工具——
调用经 stdin/stdout 往返，内核的策略/审批/投影对它们照常生效。

```
loom.app.ts                                    py_tools.py（你写的）
app.python({ command: 'python py_tools.py' })        @tool 装饰器 + run()
        ▼                                                  ▼
loom-python-bridge（TS 插件）──stdio JSON Lines──► loom_py（Python 包，纯标准库）
  spawn 子进程 → initialize 握手 → tools/list 清单         类型注解 → JSON Schema
  清单项 → defineTool 注册代理工具（模型可见）             tools/call 分发；异常→结构化错误
  调用转发 {name,args,callId} → {value}|{error}            取消尽力而为
  进程退出 → 清晰报错 + 自动重启（上限 3 次，超出 fail-loud）
```

## 快速上手

前置：Python **3.10+** 在 PATH 上（可用 `LOOM_PYTHON` 环境变量覆盖解释器名）。
loom-py 包随仓库源码使用（本阶段不发布 PyPI），脚本里 `sys.path` 指向它即可
（见下方模板），或用 `app.python` 的 `env` 配 `PYTHONPATH`——两种等价。

**1. 写工具脚本**（`py_tools.py`，放在应用目录）：

```python
"""我的 Python 工具。"""
import sys
from pathlib import Path

# loom-py 随仓库源码使用：把仓库里的包目录加进 sys.path（按你的实际相对位置调整）。
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages" / "loom-py"))

from loom_py import tool, run

@tool("两数相加", output_schema={
    "type": "object",
    "properties": {"total": {"type": "integer"}},
    "required": ["total"],
})
def add(a: int, b: int = 10) -> dict:
    return {"total": a + b}

run()  # 末尾进入 stdio 协议主循环（必须有，否则桥握手不到清单）
```

**2. 在 loom.app.ts 里接入**：

```ts
app.python({
  command: 'python py_tools.py',   // 按空格拆 argv；含空格的路径用引号包住
  cwd: undefined,                  // 可选：子进程工作目录（缺省继承当前进程）
  env: undefined,                  // 可选：附加环境变量（合并进 process.env）
  restartLimit: 3,                 // 可选：崩溃自动重启上限（间隔 1s，默认 3）
  callTimeoutMs: 120_000,          // 可选：单次调用超时（默认 120s）
})
```

**3. 自测**（不依赖 Loom，纯 Python 验证包本身）：

```bash
cd packages/loom-py && python -m loom_py.selftest   # → "loom-py selftest OK"
```

就绪横幅会显示 `python 2 个工具（gis_area_stats, gis_rank_change）`，
`GET {prefix}/health` 里有 `pythonTools` 计数字段。

## `@tool` 装饰器

```python
@tool(description, parameters=None, output_schema=None)
```

- **description**（必填）：给模型看的用途说明——写得越清楚，模型选得越准。
- **parameters**（可选）：输入 JSON Schema；缺省从函数签名**类型注解推断**（下表）。
- **output_schema**（可选）：输出 JSON Schema；缺省不声明（桥侧按"任意 JSON"处理）。
- 工具名 = 函数名（`[A-Za-z_][A-Za-z0-9_]*`，清单里重复会被拒绝）。
- 被装饰函数原样返回，本地仍可调用/测试。

### 类型注解 → JSON Schema 推断规则表

| Python 注解 | JSON Schema | 必填性 |
| --- | --- | --- |
| `str` / `int` / `float` / `bool` | `string` / `integer` / `number` / `boolean` | 无默认值 → 必填 |
| `list` | `{"type":"array","items":{}}`（任意元素） | 同上 |
| `list[str]`、`list[dict]` 等 | `{"type":"array","items":<递归推断>}` | 同上 |
| `dict` | `{"type":"object"}`（开放对象，桥侧按需降级 json） | 同上 |
| `X \| None` / `Optional[X]` | 按 X 推断，且**变为非必填** | 非必填 |
| `def f(x, y=1)` 有默认值 | 按上述推断，该参数**非必填** | 非必填 |
| 无注解 `def f(x)` | `{"type":"string"}` + 描述提示"建议补注解" | 无默认值 → 必填 |
| `Literal[1,2,3]` | `{"type":"integer","enum":[1,2,3]}` | 同标量规则 |
| `pydantic.BaseModel` 子类 | `model_json_schema()`（pydantic 可导入时增强；失败降级手写推断） | 同上 |
| 其他类型（`Path` 等） | `{"type":"json"}` + 描述注明 | 同上 |

TS 桥侧用 `jsonSchemaToDsl`（与 `loom import-openapi` 同一转换器）把清单转成
Loom DSL：object 根的 `required:[...]` 下沉为字段级 `required:true`；Loom DSL
不覆盖的 JSON Schema 子集（开放字典、format/min·max 约束等）**诚实降级**为
`{type:'json'}` 并在启动日志里逐条注明——宁可少承诺，不可静默错 schema。

## 协议（loom-py v1，按行 JSON over stdio）

自定轻协议（LSP 风格的简化；**JSON Lines**——双方逐行读写，每行一个 JSON
对象，UTF-8；比 Content-Length 分帧简单，双方一致即可）：

| 方向 | 帧 | 说明 |
| --- | --- | --- |
| 桥 → Python | `{"id":1,"method":"initialize","params":{}}` | 握手 |
| 桥 → Python | `{"id":2,"method":"tools/list","params":{}}` | 拉清单 |
| 桥 → Python | `{"id":3,"method":"tools/call","params":{"name":"add","args":{...},"callId":"py-3"}}` | 调用 |
| 桥 → Python | `{"method":"tools/cancel","params":{"callId":"py-3"}}` | 通知（无 id，不回复） |
| Python → 桥 | `{"id":1,"result":{"protocol":"loom-py","version":1}}` | 握手应答（互验两者） |
| Python → 桥 | `{"id":2,"result":{"tools":[{name,description,parameters,output?}]}}` | 清单（按注册序） |
| Python → 桥 | `{"id":3,"result":{"value":42}}` | 调用成功 |
| Python → 桥 | `{"id":3,"error":{"code":0,"message":"...","type":"ValueError","detail":"py_tools.py:9 in add"}}` | 失败（异常 traceback 最内帧定位） |

未知 `method` → `error code -32601`；未知工具 → `-32602`；非法 JSON 行 → `-32700`。

## 错误与取消语义

- **工具抛异常**：不清进程——转成结构化 `error`（`ValueError: 没有找到村庄…` +
  `detail` 文件:行:函数），桥侧 throw，内核转成 isError 工具结果，模型可见并可自行纠正。
- **取消（尽力而为）**：调用方 abort（`exec.signal`）或调用超时 → 桥发
  `tools/cancel` 通知并不再等待（结果作废）。Python 侧在工具执行**前后**各检查
  一次取消集，命中即报"已取消"；**执行中无法打断**——长任务请自行分段检查。
- **进程退出**：在途调用全部以"Python 子进程退出（code=…）"清晰失败；1s 后自动
  重启（新进程重新握手），超过 `restartLimit`（默认 3）后标记不可用——后续调用
  直接报"Python 桥不可用"并打 fail-loud 日志。
- **握手失败**（command 不是 loom-py 协议进程、清单非法）：boot 直接失败（fail-loud），
  中文报错定位到问题字段。

## ⚠ stdout 污染警告

**协议独占 stdout**——工具函数里的 `print` 会插进协议流，导致桥解析失败。
调试输出一律写 stderr（桥会把 stderr 透传到服务日志）：

```python
import sys
print("调试信息", file=sys.stderr)   # ✅ 安全
print("调试信息")                     # ❌ 会污染协议
```

## 已知边界（v1）

- **仅模型面孔**：Python 工具没有 `.http()` 第二面孔，也不进 `loom client`
  类型化客户端与 OpenAPI 导出（它们只覆盖 AppSpec.tools）。
- **全部 agent 共享**：代理工具注册在全局层，所有 agent 可见（不像 TS 工具那样
  按 `agent.tools` 精确圈定可见性）。
- **v1 单桥**：一个应用只能声明一个 `app.python(...)`。
- **清单在启动时固定**：运行期编辑 py_tools.py 后需重启服务（自动重启后清单
  不重新注册——新工具名会得到"未知工具"错误，属可接受的诚实行为）。
- **同步执行**：`run()` 逐请求处理（工具执行期间不读后续请求）；CPU 密集型长任务
  会阻塞同进程的其他调用——桥的超时/取消语义会兜底。
- **Windows**：`loom_py.run()` 强制把 stdin/stdout 切到 UTF-8（管道缺省走 locale
  编码会乱码），中文描述/参数已验证往返无损。

## 与 OpenAPI 导入的关系

两者互补：`loom import-openapi` 把**已有 HTTP 服务**（任何语言的 OpenAPI 文档）
变成 Loom 工具；`app.python` 让**新业务逻辑直接用 Python 写**（无 HTTP 面，
进程内子进程往返，零依赖零网络）。同一应用里可以同时用。

## 测试与证据

- 永远可跑（不依赖真 Python）：`packages/web/test/python-bridge.test.ts`——
  协议纯函数 + 假子进程（node 模拟 python stdio）全链路 + 故障注入（杀进程 →
  重启 → 超上限 unavailable）。
- 真链（skipIf 无 python）：`packages/web/test/python-real.test.ts`——真解释器
  spawn demo server + `python -m loom_py.selftest`。
- 带 key e2e（skipIf 无 python 或无 key）：
  `examples/gis/tests/python-bridge.e2e.test.ts`——SSE 证据链：
  `tool/call gis_area_stats` → `tool/result`（Python 算出的 5.31/3.83）→
  `turn/end completed` → assistant 文本含数字。

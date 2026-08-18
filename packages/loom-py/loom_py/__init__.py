"""loom_py —— Loom Python 工具桥（Python 侧，纯标准库零依赖）。

内核保持 TypeScript：本包只负责"把 Python 函数变成 Loom 工具"。作者写一个
普通脚本（如 py_tools.py），用 ``@tool`` 装饰器声明工具，最后一行 ``run()``
进入 stdio 协议主循环；TS 侧的 loom-python-bridge 插件 spawn 本进程，握手后
把清单注册为代理工具（模型可见），调用经 stdin/stdout 往返。

协议（loom-py v1，JSON Lines over stdio，双方逐行读写、每行一个 JSON 对象）：

- TS 桥 → 本进程（请求，带 id，必须回复）::

    {"id": 1, "method": "initialize", "params": {}}
    {"id": 2, "method": "tools/list", "params": {}}
    {"id": 3, "method": "tools/call", "params": {"name": "add", "args": {"a": 1}, "callId": "py-3"}}

- TS 桥 → 本进程（通知，无 id，不回复）::

    {"method": "tools/cancel", "params": {"callId": "py-3"}}

- 本进程 → TS 桥（响应，与请求的 id 对应）::

    {"id": 1, "result": {"protocol": "loom-py", "version": 1}}
    {"id": 2, "result": {"tools": [{"name": ..., "description": ..., "parameters": {...}, "output": {...}}]}}
    {"id": 3, "result": {"value": 42}}
    {"id": 3, "error": {"code": -32601, "message": "...", "type": "ValueError", "detail": "py_tools.py:12 in add"}}

method 语义：

- ``initialize``   → ``{"protocol": "loom-py", "version": 1}``（握手校验两者）
- ``tools/list``   → ``{"tools": [清单]}``；每项含 name/description/parameters
  （JSON Schema）/output（JSON Schema，未声明时缺省）
- ``tools/call``   → ``{"name", "args", "callId"?}``；成功 ``{"value": ...}``，
  异常 → error（消息 + 异常类型 + traceback 最内帧定位）
- ``tools/cancel`` → 尽力而为：记录 callId，工具执行**前后**各检查一次取消集，
  命中则结果作废；执行中无法打断
- 未知 method      → error code -32601；未知通知忽略

重要纪律：**stdout 只允许输出协议行**——工具函数里的 ``print`` 会污染协议；
调试输出请写 ``sys.stderr``（TS 桥会把 stderr 透传到日志）。
"""

from __future__ import annotations

import inspect
import json
import sys
import traceback
import types
import typing
from typing import get_args, get_origin, get_type_hints

__all__ = ["tool", "run", "PROTOCOL_NAME", "PROTOCOL_VERSION"]

# ---------------------------------------------------------------------------
# 常量与注册表
# ---------------------------------------------------------------------------

#: 协议名（initialize 握手时与 TS 桥互验）。
PROTOCOL_NAME = "loom-py"
#: 协议版本（握手时互验；不匹配 TS 桥会拒绝清单）。
PROTOCOL_VERSION = 1

#: 已注册工具（保序；tools/list 按注册顺序返回）。
_TOOLS: list[dict] = []

#: 已取消的 callId（按插入序；软上限防缓慢积累——超限丢最旧）。
_CANCELLED: dict[str, None] = {}
_CANCELLED_MAX = 4096


class _LoomError(Exception):
    """协议层错误（未知工具/已取消等；携带 JSON-RPC 风格 code）。"""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# 类型注解 → JSON Schema（推断规则表见 docs/python-tools.zh.md）
# ---------------------------------------------------------------------------

#: Python 标量注解 → JSON Schema type。
_SIMPLE_TYPES: dict[type, str] = {
    str: "string",
    int: "integer",
    float: "number",
    bool: "boolean",
}

#: list/dict 容器注解。
_CONTAINER_TYPES: dict[type, str] = {
    list: "array",
    dict: "object",
}

_NONE_TYPES = (type(None),)


def _is_union(origin: object) -> bool:
    """PEP 604（X | Y）与 typing.Union/Optional 两种联合形态。"""
    return origin is typing.Union or origin is types.UnionType


def _pydantic_schema(annotation: object) -> dict | None:
    """注解是 pydantic.BaseModel 子类且 pydantic 可导入 → model_json_schema()。

    纯标准库纪律：pydantic 只是"可用则增强"，不可用时返回 None 走手写推断。
    """
    if not inspect.isclass(annotation):
        return None
    try:
        from pydantic import BaseModel  # type: ignore[import-not-found]

        if not issubclass(annotation, BaseModel):
            return None
        return dict(annotation.model_json_schema())
    except Exception:
        return None


def _annotation_to_schema(annotation: object) -> tuple[dict, bool]:
    """单个注解 → (JSON Schema, 是否可空)。无法映射的注解落 {type: json}。"""
    if annotation is inspect.Parameter.empty or annotation is None:
        return {"type": "string", "description": "参数无类型注解，默认按 string 处理（建议补注解）"}, False

    pydantic = _pydantic_schema(annotation)
    if pydantic is not None:
        return pydantic, False

    origin = get_origin(annotation)
    if _is_union(origin):
        branches = [a for a in get_args(annotation) if a not in _NONE_TYPES]
        nullable = len(branches) < len(get_args(annotation))
        if len(branches) == 1:
            schema, _ = _annotation_to_schema(branches[0])
            return schema, nullable
        # 多分支联合：JSON Schema anyOf（TS 侧不覆盖时诚实降级为 json）。
        return {"anyOf": [_annotation_to_schema(b)[0] for b in branches]}, nullable

    if annotation in _SIMPLE_TYPES:
        return {"type": _SIMPLE_TYPES[annotation]}, False

    if annotation in _CONTAINER_TYPES or origin in _CONTAINER_TYPES:
        kind = _CONTAINER_TYPES.get(annotation) or _CONTAINER_TYPES[origin]
        if kind == "array":
            args = get_args(annotation)
            # 裸 list → items {}（任意元素）；list[X] → 递归推断元素。
            items = _annotation_to_schema(args[0])[0] if args else {}
            return {"type": "array", "items": items}, False
        # dict（含 dict[str, X]）→ 开放对象（值结构未知，TS 侧按需降级 json）。
        return {"type": "object"}, False

    if origin is typing.Literal:
        values = list(get_args(annotation))
        kinds = {type(v) for v in values}
        if len(kinds) == 1 and kinds <= {str, int, bool}:
            py_kind = {str: "string", int: "integer", bool: "boolean"}[kinds.pop()]
            return {"type": py_kind, "enum": values}, False
        return {"type": "json", "description": f"Literal 值类型混合，按任意 JSON 处理"}, False

    name = getattr(annotation, "__name__", None) or getattr(annotation, "_name", None) or repr(annotation)
    return {"type": "json", "description": f"注解 {name} 无法映射 JSON Schema，按任意 JSON 处理"}, False


def _infer_parameters_schema(func) -> dict:
    """从函数签名推断 parameters JSON Schema（object 根 + 字段表 + required）。"""
    hints: dict = {}
    try:
        hints = get_type_hints(func)
    except Exception:
        # 字符串注解解析失败等：按无注解处理（string + 提示），不炸启动。
        hints = {}
    properties: dict = {}
    required: list[str] = []
    for name, param in inspect.signature(func).parameters.items():
        if param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD):
            continue
        annotation = hints.get(name, inspect.Parameter.empty)
        schema, nullable = _annotation_to_schema(annotation)
        properties[name] = schema
        # 必填规则：无默认值且不可空（Optional[X] 或默认值 None → 非必填）。
        if param.default is inspect.Parameter.empty and not nullable:
            required.append(name)
    schema = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return schema


# ---------------------------------------------------------------------------
# @tool 装饰器与清单
# ---------------------------------------------------------------------------


def tool(description: str, *, parameters: dict | None = None, output_schema: dict | None = None):
    """声明一个 Loom 工具（装饰器）。

    :param description: 工具描述（给模型看的用途说明，必填）。
    :param parameters: 输入 JSON Schema；缺省从函数签名类型注解推断
        （str→string / int→integer / float→number / bool→boolean /
        list→array / dict→object / Optional[X]→非必填可空 /
        pydantic.BaseModel→model_json_schema）。
    :param output_schema: 输出 JSON Schema；缺省不声明（TS 侧按任意 JSON 处理）。
    :return: 装饰器（被装饰函数原样返回，仍可本地调用）。

    示例::

        @tool("两数相加", output_schema={"type": "object",
                "properties": {"total": {"type": "integer"}}, "required": ["total"]})
        def add(a: int, b: int = 10) -> dict:
            return {"total": a + b}

        run()  # 脚本末尾进入 stdio 协议主循环
    """
    if not isinstance(description, str) or not description.strip():
        raise ValueError("@tool 的 description 必须是非空字符串")

    def decorate(func):
        if not inspect.isfunction(func):
            raise TypeError("@tool 只能装饰函数")
        entry = {
            "name": func.__name__,
            "description": description,
            "parameters": dict(parameters) if parameters is not None else _infer_parameters_schema(func),
        }
        if output_schema is not None:
            entry["output"] = dict(output_schema)
        entry["_func"] = func  # 内部键：tools/list 时剥离，tools/call 时分发
        _TOOLS.append(entry)
        return func

    return decorate


def _manifest() -> list[dict]:
    """当前清单（浅拷贝并剥离内部 _func 键；tools/list 用）。"""
    return [{k: v for k, v in entry.items() if k != "_func"} for entry in _TOOLS]


# ---------------------------------------------------------------------------
# 调用分发与错误形状
# ---------------------------------------------------------------------------


def _format_exception(exc: BaseException) -> dict:
    """异常 → 结构化 error（消息 + 类型 + traceback 最内帧定位）。"""
    error: dict = {"message": f"{type(exc).__name__}: {exc}", "type": type(exc).__name__}
    tb = traceback.extract_tb(exc.__traceback__)
    if tb:
        frame = tb[-1]  # 最内帧（抛出点），比首帧更接近作者代码
        error["detail"] = f"{frame.filename}:{frame.lineno} in {frame.name}"
    return error


def _call_tool(params: dict) -> dict:
    """tools/call 分发：查表 → 取消前置检查 → 调用 → 取消后置检查。"""
    name = params.get("name")
    if not isinstance(name, str) or not name:
        raise _LoomError(-32602, f"tools/call 的 params.name 必须是非空字符串，收到 {name!r}")
    args = params.get("args") or {}
    if not isinstance(args, dict):
        raise _LoomError(-32602, f"tools/call 的 params.args 必须是对象，收到 {type(args).__name__}")
    call_id = params.get("callId")
    entry = next((t for t in _TOOLS if t["name"] == name), None)
    if entry is None:
        known = ", ".join(t["name"] for t in _TOOLS) or "(无)"
        raise _LoomError(-32602, f"未知工具：{name}（可用：{known}）")
    if call_id is not None and str(call_id) in _CANCELLED:
        raise _LoomError(0, f"工具 {name} 的调用在执行前已取消（callId={call_id}）")
    value = entry["_func"](**args)
    if call_id is not None and str(call_id) in _CANCELLED:
        raise _LoomError(0, f"工具 {name} 的调用在执行期间被取消，结果作废（callId={call_id}）")
    return {"value": value}


def _handle_request(message: dict) -> dict | None:
    """处理一条请求/通知；返回响应 dict，通知返回 None。"""
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params") or {}
    if not isinstance(params, dict):
        params = {}
    try:
        if method == "initialize":
            return {"id": request_id, "result": {"protocol": PROTOCOL_NAME, "version": PROTOCOL_VERSION}}
        if method == "tools/list":
            return {"id": request_id, "result": {"tools": _manifest()}}
        if method == "tools/call":
            return {"id": request_id, "result": _call_tool(params)}
        if request_id is None:
            # 通知：tools/cancel 记录取消集；其余忽略。
            if method == "tools/cancel":
                call_id = params.get("callId")
                if call_id is not None:
                    if len(_CANCELLED) >= _CANCELLED_MAX:
                        _CANCELLED.pop(next(iter(_CANCELLED)), None)
                    _CANCELLED[str(call_id)] = None
            return None
        return {"id": request_id, "error": {"code": -32601, "message": f"未知 method：{method!r}"}}
    except _LoomError as exc:
        return {"id": request_id, "error": {"code": exc.code, "message": exc.message}}
    except Exception as exc:  # 工具异常 → 结构化 error（不清进程）
        return {"id": request_id, "error": _format_exception(exc)}


# ---------------------------------------------------------------------------
# run()：stdio 主循环
# ---------------------------------------------------------------------------


def _reconfigure_streams() -> None:
    """stdin/stdout/stderr 强制 UTF-8（Windows 管道缺省走 locale 编码，
    中文描述会乱码；协议字节流约定 UTF-8）。"""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8")
        except Exception:
            pass


def run() -> None:
    """阻塞式协议主循环：stdin 逐行 JSON → stdout 逐行 JSON。

    在脚本末尾调用（如 py_tools.py 的最后一行）。**stdout 只输出协议行**——
    工具函数里的 print 会污染协议，调试请写 sys.stderr。
    """
    _reconfigure_streams()
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            sys.stdout.write(json.dumps({"id": None, "error": {"code": -32700, "message": f"请求行不是合法 JSON：{exc}"}}, ensure_ascii=False) + "\n")
            sys.stdout.flush()
            continue
        if not isinstance(message, dict):
            sys.stdout.write(json.dumps({"id": None, "error": {"code": -32600, "message": f"请求必须是 JSON 对象，收到 {type(message).__name__}"}}, ensure_ascii=False) + "\n")
            sys.stdout.flush()
            continue
        response = _handle_request(message)
        if response is not None:
            # tools/list 等结果里不能带不可序列化的函数对象。
            sys.stdout.write(json.dumps(response, ensure_ascii=False, default=_drop_function) + "\n")
            sys.stdout.flush()


def _drop_function(value):
    """json.dumps 兜底：函数对象序列化为空（正常路径清单不含函数）。"""
    if callable(value):
        return None
    raise TypeError(f"返回值含不可 JSON 序列化的对象：{type(value).__name__}")

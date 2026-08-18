"""loom-py 自测：``python -m loom_py.selftest``（无参数自跑，零依赖零网络）。

断言四组不变量，全部通过 exit 0 并打印 ``loom-py selftest OK``：
1. schema 推断——类型注解 → JSON Schema（必填/可选/可空/无注解/容器/Literal）；
2. 调用往返——tools/call 分发返回 ``{"value": ...}``；
3. 错误形状——工具异常 → 结构化 error（消息 + 类型 + 最内帧定位）；
   未知工具 / 未知 method 的协议错误码；
4. 清单序列化——tools/list 可 JSON 序列化且不含内部键。
"""

from __future__ import annotations

import json
from typing import Literal

from . import PROTOCOL_NAME, PROTOCOL_VERSION, _handle_request, _manifest, tool


def _check(actual: object, expected: object, label: str) -> None:
    if actual != expected:
        raise SystemExit(f"selftest 失败：{label}\n  期望 {expected!r}\n  实际 {actual!r}")


def _check_true(condition: bool, label: str) -> None:
    if not condition:
        raise SystemExit(f"selftest 失败：{label}")


# ── 样例工具（自测后留在本进程注册表里无妨——selftest 是独立进程） ───────────


@tool("两数相加", output_schema={
    "type": "object",
    "properties": {"total": {"type": "integer"}},
    "required": ["total"],
})
def add(a: int, b: int = 10) -> dict:
    return {"total": a + b}


@tool("可选参数与可空类型")
def opts(name: str | None = None, tags: list[str] | None = None, meta: dict | None = None) -> dict:
    return {"name": name, "tags": tags or [], "meta": meta or {}}


@tool("无注解参数（降级 string）")
def plain(x) -> dict:  # noqa: ANN001 - 故意无注解，测降级路径
    return {"x": x}


@tool("枚举参数")
def pick_level(level: Literal[1, 2, 3]) -> dict:
    return {"level": level}


@tool("必然抛错")
def boom() -> dict:
    raise ValueError("boom：演示错误形状")


def run_selftest() -> None:
    # ── 1. schema 推断 ─────────────────────────────────────────────────────
    manifest = {entry["name"]: entry for entry in _manifest()}
    _check(
        manifest["add"]["parameters"],
        {"type": "object", "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}}, "required": ["a"]},
        "add 的参数 schema（b 有默认值 → 非必填）",
    )
    _check(manifest["add"]["output"]["required"], ["total"], "add 的输出 schema 原样透传")
    opts_params = manifest["opts"]["parameters"]
    _check_true("required" not in opts_params, "opts 全部参数可选（默认值 None → 非必填）")
    _check(
        opts_params["properties"]["name"],
        {"type": "string"},
        "Optional[str] 的字段 schema（可空性由非必填表达）",
    )
    _check(opts_params["properties"]["tags"], {"type": "array", "items": {"type": "string"}}, "list[str] → array/items")
    _check(opts_params["properties"]["meta"], {"type": "object"}, "dict → 开放 object")
    plain_params = manifest["plain"]["parameters"]
    _check(
        plain_params["properties"]["x"],
        {"type": "string", "description": "参数无类型注解，默认按 string 处理（建议补注解）"},
        "无注解 → string + 描述提示",
    )
    _check(manifest["pick_level"]["parameters"]["properties"]["level"], {"type": "integer", "enum": [1, 2, 3]}, "Literal → enum")
    _check_true("output" not in manifest["plain"], "未声明 output_schema 时清单不含 output 键")

    # ── 2. 调用往返 ────────────────────────────────────────────────────────
    _check(
        _handle_request({"id": 1, "method": "tools/call", "params": {"name": "add", "args": {"a": 2, "b": 3}}}),
        {"id": 1, "result": {"value": {"total": 5}}},
        "tools/call 往返",
    )
    _check(
        _handle_request({"id": 2, "method": "tools/call", "params": {"name": "add", "args": {"a": 7}}}),
        {"id": 2, "result": {"value": {"total": 17}}},
        "缺省参数生效（b=10）",
    )
    init = _handle_request({"id": 3, "method": "initialize", "params": {}})
    _check(init["result"], {"protocol": PROTOCOL_NAME, "version": PROTOCOL_VERSION}, "initialize 握手结果")
    listing = _handle_request({"id": 4, "method": "tools/list", "params": {}})
    _check(listing["result"]["tools"][0]["name"], "add", "tools/list 按注册序返回")

    # ── 3. 错误形状 ────────────────────────────────────────────────────────
    boom_resp = _handle_request({"id": 5, "method": "tools/call", "params": {"name": "boom", "args": {}}})
    boom_error = boom_resp["error"]
    _check_true(boom_error["message"].startswith("ValueError: boom"), "异常消息含类型与文本")
    _check(boom_error["type"], "ValueError", "异常类型")
    _check_true("selftest.py" in boom_error["detail"], "traceback 最内帧定位（detail）")
    unknown_tool = _handle_request({"id": 6, "method": "tools/call", "params": {"name": "nope", "args": {}}})
    _check(unknown_tool["error"]["code"], -32602, "未知工具 → -32602")
    unknown_method = _handle_request({"id": 7, "method": "wat", "params": {}})
    _check(unknown_method["error"]["code"], -32601, "未知 method → -32601")
    cancel_notice = _handle_request({"method": "tools/cancel", "params": {"callId": "py-x"}})
    _check(cancel_notice, None, "通知不回复")
    _check(
        _handle_request({"id": 8, "method": "tools/call", "params": {"name": "add", "args": {"a": 1}, "callId": "py-x"}}),
        {"id": 8, "error": {"code": 0, "message": "工具 add 的调用在执行前已取消（callId=py-x）"}},
        "执行前取消 → 结果作废",
    )

    # ── 4. 清单序列化 ──────────────────────────────────────────────────────
    encoded = json.dumps(_handle_request({"id": 9, "method": "tools/list", "params": {}}), ensure_ascii=False)
    _check_true("_func" not in encoded, "tools/list 序列化不含内部 _func 键")
    json.loads(encoded)  # 可完整往返

    print("loom-py selftest OK")


if __name__ == "__main__":
    run_selftest()

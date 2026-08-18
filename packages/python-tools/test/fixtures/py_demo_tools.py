"""真 Python 链测试的 demo server（被 packages/web/test/python-real.test.ts spawn）。

覆盖三类注解形态：必填/缺省参数、无注解参数、必抛错的工具——验证 loom_py 的
schema 推断与调用往返（真实解释器 + 真实 stdio 管道 + UTF-8 中文）。
"""
from __future__ import annotations

import sys
from pathlib import Path

# 源码随仓库使用：把 packages/loom-py 加进 sys.path（本文件上溯四级 = 仓库根）。
sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "packages" / "loom-py"))

from loom_py import tool, run  # noqa: E402


@tool(
    "两数相加（真 Python 链演示）：b 缺省 10",
    output_schema={
        "type": "object",
        "properties": {"total": {"type": "integer"}},
        "required": ["total"],
    },
)
def add(a: int, b: int = 10) -> dict:
    return {"total": a + b}


@tool("问候某人（中文回显，验证 UTF-8 管道）")
def greet(name: str, prefix: str | None = None) -> dict:
    return {"greeting": f"{prefix or '你好'}，{name}！"}


@tool("无注解参数（降级 string 的真实路径）")
def plain(x) -> dict:  # noqa: ANN001 - 故意无注解
    return {"x": str(x)}


@tool("必然抛错（错误形状透传）")
def fail_always() -> dict:
    raise RuntimeError("boom：演示错误形状")


run()

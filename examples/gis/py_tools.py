"""GIS 平台的 Python 工具（loom-py 桥，M6 演示）。

内核保持 TypeScript，Python 成为一等工具作者语言：本脚本用 @tool 声明两个
纯标准库统计工具，末尾 run() 进入 stdio 协议主循环；loom.app.ts 里一行
app.python({ command: 'python py_tools.py' }) 即把它们注册为模型可见的代理工具。

- gis_area_stats：全镇地类占比统计（均值/标准差，statistics 模块）
- gis_rank_change：某村庄占比与按面积的全镇排名（纯计算）

注意：工具函数里的 print 会污染协议（stdout 只允许协议行）——调试写 sys.stderr。
"""
from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

# loom-py 本阶段不发布 PyPI，源码随仓库使用：把仓库里的包目录加进 sys.path
# （本文件上溯两级 = 仓库根，packages/loom-py 即 loom_py 包）。备选：用
# PYTHONPATH=packages/loom-py 环境变量（app.python 的 env 可配），二者等价。
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages" / "loom-py"))

from loom_py import tool, run  # noqa: E402

DATA_PATH = Path(__file__).resolve().parent / "data" / "land-types.json"


def _load_items() -> list[dict]:
    """读地类数据（相对本文件定位，不受子进程 cwd 影响）。"""
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    items = data.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError(f"地类数据文件顶层缺少非空 items 数组：{DATA_PATH}")
    return items


def _round(value: float, precision: int) -> float:
    return round(value, precision)


@tool(
    "统计全部村庄的地类面积与占比：村庄数、总面积（平方米）、占比均值、占比标准差（样本标准差）、"
    "面积最大的村庄。precision 控制小数位数（默认 2）。",
    output_schema={
        "type": "object",
        "properties": {
            "villages": {"type": "integer"},
            "totalAreaSqm": {"type": "number"},
            "meanRatioPct": {"type": "number"},
            "stdRatioPct": {"type": "number"},
            "topVillage": {"type": "string"},
        },
        "required": ["villages", "totalAreaSqm", "meanRatioPct", "stdRatioPct", "topVillage"],
    },
)
def gis_area_stats(precision: int = 2) -> dict:
    items = _load_items()
    ratios = [float(item["ratioPct"]) for item in items]
    top = max(items, key=lambda item: float(item["areaSqm"]))
    return {
        "villages": len(items),
        "totalAreaSqm": _round(sum(float(item["areaSqm"]) for item in items), precision),
        "meanRatioPct": _round(statistics.mean(ratios), precision),
        "stdRatioPct": _round(statistics.stdev(ratios), precision),
        "topVillage": str(top["village"]),
    }


@tool(
    "查询某个村庄的地类占比（占全镇面积百分比）与按图斑面积的全镇排名（1 = 最大），"
    "并给出全村庄总数。village 支持全名（如“连河村”）。",
    output_schema={
        "type": "object",
        "properties": {
            "village": {"type": "string"},
            "ratioPct": {"type": "number"},
            "rank": {"type": "integer"},
            "totalVillages": {"type": "integer"},
        },
        "required": ["village", "ratioPct", "rank", "totalVillages"],
    },
)
def gis_rank_change(village: str) -> dict:
    items = _load_items()
    target = next((item for item in items if str(item["village"]) == village.strip()), None)
    if target is None:
        known = "、".join(str(item["village"]) for item in items)
        raise ValueError(f"没有找到村庄“{village.strip()}”（可用村庄：{known}）")
    ranked = sorted(items, key=lambda item: float(item["areaSqm"]), reverse=True)
    rank = next(index + 1 for index, item in enumerate(ranked) if item is target)
    return {
        "village": str(target["village"]),
        "ratioPct": float(target["ratioPct"]),
        "rank": rank,
        "totalVillages": len(items),
    }


run()

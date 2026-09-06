"""Semantica × Loom 的 Python 桥服务器（loom-py 协议，融合示例主路径）。

分工：Loom 管"怎么做"（执行/策略/审批/预算/交付），semantica 管"知道什么"
（图记忆/判例/因果链/SHACL/溯源）。本进程是 graph.json 的**单写者**：
启动时惰性建图（文件存在则 load，否则种入确定性农业演示数据），每次变更后 save。

semantica 全部惰性导入（首调用才付 import 成本，30s 桥握手不被拖累）。
stdout 只允许协议行——调试写 sys.stderr。
API 钉在 semantica==0.6.8；--selftest 校验我们用到的每个方法名真实存在
（该项目 README 与实际导出存在命名漂移，selftest 是 fail-loud 保险）。

用法：
  python py_tools.py            # loom-py 桥主循环（app.python 声明）
  python py_tools.py --selftest # API 冒烟（e2e 的 beforeAll 守卫也用它）
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# loom-py 源码随仓库使用：本文件上溯两级 = 仓库根（与 examples/gis/py_tools.py 同款）。
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages" / "loom-py"))

from loom_py import tool, run  # noqa: E402

KG_PATH = Path(__file__).resolve().parent / "graph.json"

_GRAPH = None
_PROV = None
_INIT_LOCK = __import__("threading").Lock()


def _jsonify(value):
    """递归转 JSON 可序列化（dataclass → dict、set → list、其余原样）。"""
    if hasattr(value, "__dataclass_fields__"):
        import dataclasses

        return _jsonify(dataclasses.asdict(value))
    if isinstance(value, dict):
        return {str(k): _jsonify(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonify(v) for v in value]
    if isinstance(value, set):
        return sorted(_jsonify(v) for v in value)
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _save() -> None:
    try:
        _GRAPH.save_to_file(str(KG_PATH))
    except Exception as error:  # noqa: BLE001
        print(f"semantica save 失败（不中断，内存态继续）：{error}", file=sys.stderr)


def _seed(graph) -> None:
    """确定性农业演示数据：2 村庄 / 2 作物 / 2 病虫害 + 1 条历史植保决策。"""
    entities = [
        ("village-lianhe", "Village", "连河村"),
        ("village-hebian", "Village", "河边村"),
        ("crop-rice", "Crop", "水稻"),
        ("crop-wheat", "Crop", "小麦"),
        ("pest-rice-blast", "Pest", "稻瘟病"),
        ("pest-aphid", "Pest", "蚜虫"),
    ]
    for entity_id, entity_type, label in entities:
        graph.add_node(node_id=entity_id, node_type=entity_type, label=label)
    relations = [
        ("village-lianhe", "crop-rice", "GROWS"),
        ("village-hebian", "crop-wheat", "GROWS"),
        ("pest-rice-blast", "crop-rice", "INFECTS"),
        ("pest-aphid", "crop-wheat", "INFECTS"),
    ]
    for source, target, rel_type in relations:
        graph.add_edge(source_id=source, target_id=target, edge_type=rel_type)
    graph.record_decision(
        category="plant_protection",
        scenario="连河村水稻稻瘟病防治方案选择",
        reasoning="抽穗期遇连阴雨、田间见急性型病斑；判例与农技手册均指向生物农药春雷霉素，配合控氮晒田降低再侵染。",
        outcome="喷施春雷霉素并控氮",
        confidence=0.82,
        entities=["pest-rice-blast", "crop-rice", "village-lianhe"],
        decision_maker="loom-semantica-demo",
    )


def graph():
    """惰性建图（线程安全双检）：文件在则 load，否则种子（graph.json 存在性 = 已种子标记）。"""
    global _GRAPH, _PROV
    if _GRAPH is not None:
        return _GRAPH
    with _INIT_LOCK:
        if _GRAPH is not None:
            return _GRAPH
        from semantica.context import ContextGraph

    graph_obj = ContextGraph(advanced_analytics=True)
    if KG_PATH.exists() and KG_PATH.stat().st_size > 0:
        try:
            graph_obj.load_from_file(str(KG_PATH))
        except Exception as error:  # noqa: BLE001
            print(f"semantica load 失败，改用空图重种：{error}", file=sys.stderr)
            graph_obj = ContextGraph(advanced_analytics=True)
    else:
        _seed(graph_obj)
    _GRAPH = graph_obj
    _save()  # 种子/装载后统一落盘（_save 此刻才拿得到 _GRAPH）
    from semantica.provenance import ProvenanceManager

    _PROV = ProvenanceManager()
    return _GRAPH


def prov():
    graph()
    return _PROV


# ---------------------------------------------------------------------------
# 模型面工具（7 个）
# ---------------------------------------------------------------------------


@tool(
    "向农业知识图添加一个对象（地块/村庄、作物、病虫害、药剂等）。id 用 kebab-case "
    "（如 village-lianhe）；type 是对象类型（Village/Crop/Pest/Chemical…）；label 是"
    "中文名；metadata 可放任意结构化属性（面积、剂量上限等）。source 是数据来源"
    "描述（溯源用，如 '物联网平台导入'）。图写入会持久化到 graph.json。",
    output_schema={
        "type": "object",
        "properties": {
            "id": {"type": "string"},
            "type": {"type": "string"},
            "label": {"type": "string"},
            "persisted": {"type": "boolean"},
        },
        "required": ["id", "type", "label", "persisted"],
    },
)
def agri_add_entity(id: str, type: str, label: str, metadata: dict = {}, source: str = "loom-bridge") -> dict:  # noqa: A002
    graph().add_node(node_id=id, node_type=type, label=label, **dict(metadata))
    try:
        prov().track_entity(entity_id=id, source=source, entity_type=type)
    except Exception as error:  # noqa: BLE001
        print(f"provenance track 失败（不影响写入）：{error}", file=sys.stderr)
    _save()
    return {"id": id, "type": type, "label": label, "persisted": True}


@tool(
    "向农业知识图添加一条链接（谁→谁、什么关系）：type 如 GROWS（村庄-种植-作物）、"
    "INFECTS（病虫害-危害-作物）、TREATS（药剂-防治-病虫害）。图写入会持久化。",
    output_schema={
        "type": "object",
        "properties": {
            "source": {"type": "string"},
            "target": {"type": "string"},
            "type": {"type": "string"},
            "persisted": {"type": "boolean"},
        },
        "required": ["source", "target", "type", "persisted"],
    },
)
def agri_add_relation(source: str, target: str, type: str, metadata: dict = {}) -> dict:  # noqa: A002
    graph().add_edge(source_id=source, target_id=target, edge_type=type, **dict(metadata))
    _save()
    return {"source": source, "target": target, "type": type, "persisted": True}


@tool(
    "把一条农业决策入账为图的一等节点（供判例检索与因果追溯）。category 如 "
    "plant_protection / irrigation / fertilization；scenario 描述场景；reasoning 是"
    "决策依据；outcome 是采取的行动；confidence 0~1；entities 是关联对象 id 列表；"
    "caused_by 可选——若本决策沿用/响应了某条历史决策，填它的 decision_id，会自动"
    "补一条因果边（历史判例 → 本决策）。返回决策 id（UUID）。"
    "注意：此工具在 Loom 侧配置了人工审批。",
    output_schema={
        "type": "object",
        "properties": {
            "decisionId": {"type": "string"},
            "category": {"type": "string"},
            "outcome": {"type": "string"},
            "causedBy": {"type": "string"},
            "persisted": {"type": "boolean"},
        },
        "required": ["decisionId", "category", "outcome", "persisted"],
    },
)
def agri_record_decision(
    category: str,
    scenario: str,
    reasoning: str,
    outcome: str,
    confidence: float,
    entities: list = [],
    caused_by: str = "",
) -> dict:
    decision_id = str(graph().record_decision(
        category=category,
        scenario=scenario,
        reasoning=reasoning,
        outcome=outcome,
        confidence=float(confidence),
        entities=list(entities),
        decision_maker="loom-agent",
    ))
    if caused_by.strip() != "":
        graph().add_causal_relationship(
            source_decision_id=caused_by.strip(),
            target_decision_id=decision_id,
            relationship_type="CAUSED",
        )
    _save()
    return {
        "decisionId": decision_id,
        "category": category,
        "outcome": outcome,
        **({} if caused_by.strip() == "" else {"causedBy": caused_by.strip()}),
        "persisted": True,
    }


@tool(
    "判例检索：用场景描述找历史相似决策（按相似度排序，含 scenario/reasoning/outcome/"
    "confidence/similarity）。决策入账前先查判例是植保专家的工作纪律。",
    output_schema={
        "type": "object",
        "properties": {
            "count": {"type": "integer"},
            "precedents": {"type": "array", "items": {"type": "object"}},
        },
        "required": ["count", "precedents"],
    },
)
def agri_find_precedents(scenario: str, limit: int = 5) -> dict:
    # 阈值放 0.05：semantica 的相似度是词面 Jaccard 为主，中文长句普遍低分
    #（实测同义查询 ~0.18，默认 0.5 会全灭）——召回优先，排序交给模型判读。
    hits = graph().find_precedents_by_scenario(scenario=scenario, limit=max(1, int(limit)), similarity_threshold=0.05)
    precedents = []
    for hit in hits:
        decision = hit.get("decision") if isinstance(hit, dict) else None
        decision = decision if isinstance(decision, dict) else {}
        precedents.append({
            "decisionId": str(decision.get("id") or decision.get("decision_id") or ""),
            "category": decision.get("category"),
            "scenario": decision.get("scenario"),
            "reasoning": decision.get("reasoning"),
            "outcome": decision.get("outcome"),
            "confidence": decision.get("confidence"),
            "similarity": hit.get("similarity") if isinstance(hit, dict) else None,
        })
    return {"count": len(precedents), "precedents": precedents}


@tool(
    "追溯一条决策的因果链（direction: upstream=它受谁影响 / downstream=它影响了谁；"
    "返回逐跳 Decision 列表）。decision_id 来自 agri_record_decision 或判例检索结果。",
    output_schema={
        "type": "object",
        "properties": {
            "decisionId": {"type": "string"},
            "direction": {"type": "string"},
            "chain": {"type": "array", "items": {"type": "object"}},
        },
        "required": ["decisionId", "direction", "chain"],
    },
)
def agri_causal_chain(decision_id: str, direction: str = "upstream", max_depth: int = 5) -> dict:
    chain = graph().get_causal_chain(decision_id=decision_id, direction=direction, max_depth=max(1, int(max_depth)))
    return {"decisionId": decision_id, "direction": direction, "chain": _jsonify(chain)}


@tool(
    "SHACL 校验：对一段 Turtle RDF 数据按 SHACL shapes 检查结构合规（MCP 面没有的"
    "能力）。data_ttl 是数据图，shapes_ttl 是约束图；返回 conforms、违规数与逐条"
    "解释——农产品/处方合规检查的语义门禁。",
    output_schema={
        "type": "object",
        "properties": {
            "conforms": {"type": "boolean"},
            "violationCount": {"type": "integer"},
            "summary": {"type": "string"},
            "violations": {"type": "array", "items": {"type": "object"}},
        },
        "required": ["conforms", "violationCount", "summary"],
    },
)
def agri_shacl_validate(data_ttl: str, shapes_ttl: str) -> dict:
    from semantica.ontology import run_shacl_validation

    report = run_shacl_validation(data_ttl, shapes_ttl)
    violations = []
    for violation in getattr(report, "violations", []) or []:
        violations.append(_jsonify(violation))
    summary = ""
    summary_fn = getattr(report, "summary", None)
    if callable(summary_fn):
        summary = str(summary_fn())
    return {
        "conforms": bool(getattr(report, "conforms", False)),
        "violationCount": int(getattr(report, "violation_count", len(violations))),
        "summary": summary,
        "violations": violations,
    }


@tool(
    "溯源检索：查一个对象的完整来源链（何时、从哪个来源进来、来源元数据）。配合 "
    "agri_add_entity 的 source 参数形成闭环——食品安全追溯的图上证据。",
    output_schema={
        "type": "object",
        "properties": {
            "entityId": {"type": "string"},
            "entries": {"type": "array", "items": {"type": "object"}},
        },
        "required": ["entityId", "entries"],
    },
)
def agri_provenance(entity_id: str) -> dict:
    entries = prov().trace_lineage(entity_id=entity_id)
    return {"entityId": entity_id, "entries": [_jsonify(entry) for entry in entries]}


# ---------------------------------------------------------------------------
# selftest：API 命名漂移的 fail-loud 保险（e2e beforeAll 也调它）
# ---------------------------------------------------------------------------


def selftest() -> int:
    from semantica.context import ContextGraph

    graph_cls = ContextGraph
    required = [
        "add_node",
        "add_edge",
        "record_decision",
        "find_precedents_by_scenario",
        "get_causal_chain",
        "save_to_file",
        "load_from_file",
    ]
    missing = [name for name in required if not callable(getattr(graph_cls, name, None))]
    if missing:
        print(f"FAIL semantica API 缺失方法：{missing}（钉的 0.6.8 接口已漂移，需更新 py_tools.py）", file=sys.stderr)
        return 1
    from semantica.provenance import ProvenanceManager

    prov_required = ["track_entity", "trace_lineage"]
    missing_prov = [name for name in prov_required if not callable(getattr(ProvenanceManager, name, None))]
    if missing_prov:
        print(f"FAIL ProvenanceManager 缺失方法：{missing_prov}", file=sys.stderr)
        return 1
    try:
        from semantica.ontology import run_shacl_validation  # noqa: F401
    except ImportError as error:
        print(f"FAIL run_shacl_validation 不可导入（装 semantica[shacl]）：{error}", file=sys.stderr)
        return 1

    smoke = ContextGraph(advanced_analytics=True)
    decision_id = smoke.record_decision(
        category="selftest",
        scenario="selftest smoke",
        reasoning="selftest",
        outcome="ok",
        confidence=0.5,
        entities=[],
        decision_maker="selftest",
    )
    smoke.get_causal_chain(decision_id=str(decision_id), direction="upstream", max_depth=1)
    smoke.find_precedents_by_scenario(scenario="selftest smoke", limit=1, similarity_threshold=0.3)
    print("OK semantica 0.6.8 API selftest", file=sys.stderr)
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(selftest())
    # 惰性初始化：semantica 不在启动期导入（曾试过后台线程预热——主线程阻塞
    # stdin 时次线程的 semantica/OpenMP 初始化会卡死）。首个工具调用付 ~10s
    # 导入成本，在 app.python 的 callTimeoutMs（180s）内绰绰有余。
    run()

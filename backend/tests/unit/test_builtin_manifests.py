"""§8.1 的兩個一致性測試：內建宣告 ↔ 實作（D21）。

積木包靠 `_check_coverage` 在載入期比對 manifest 與 `@block`，內建沒有
`@block` 可比。這兩個測試就是它的替代品：

  1. 宣告的 opcode 集合 == 註冊表的集合，且形狀相符 → 抓少宣告、多宣告、形狀寫錯
  2. §17 題庫用到的每個 input / field 名稱都宣告過        → 抓參數名對不上

第 2 個順帶把「約半數積木沒有專屬題目」那條債變成可量化的東西：**沒有題目的
積木，它的參數名就沒有人守**。所以這裡另外印出覆蓋率，讓那筆債看得見。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from blocky.interpreter import builtins as _builtins  # noqa: F401  匯入即註冊
from blocky.interpreter import declarations
from blocky.interpreter.registry import (
    COMMANDS,
    HAT_OPCODES,
    SHAPE_COMMAND,
    SHAPE_HAT,
    SHAPE_VALUE,
    VALUES,
)

CORPUS = Path(__file__).parents[1] / "conformance"

NAMESPACES = sorted(declarations.manifests())


def _registered_shapes() -> dict[str, set[str]]:
    """實作那一側的真相：積木實際註冊成什麼形狀。"""
    shapes: dict[str, set[str]] = {}
    for op in COMMANDS:
        shapes.setdefault(op, set()).add(SHAPE_COMMAND)
    for op in VALUES:
        shapes.setdefault(op, set()).add(SHAPE_VALUE)
    for op in HAT_OPCODES:
        shapes.setdefault(op, set()).add(SHAPE_HAT)
    return shapes


# --------------------------------------------------------------------------
# 測試 1：宣告 ↔ 註冊表
# --------------------------------------------------------------------------


@pytest.mark.parametrize("ns", NAMESPACES)
def test_declared_opcodes_match_the_registry(ns: str) -> None:
    """少宣告、多宣告都會讓積木在編輯器裡「不存在」或「按了沒反應」。"""
    registered = {op for op in _registered_shapes() if op.split(".", 1)[0] == ns}
    declared = {f"{ns}.{b.opcode}" for b in declarations.manifests()[ns].blocks}

    assert not (declared - registered), (
        f"{ns}.yaml 宣告了沒有實作的積木：{sorted(declared - registered)}"
        "\n（工具箱會出現一顆按了沒反應的積木）"
    )
    assert not (registered - declared), (
        f"{ns} 有實作卻沒宣告的積木：{sorted(registered - declared)}"
        "\n（前端畫不出來，而且形狀驗證會把它當成 §13.3 的佔位符默默放行）"
    )


@pytest.mark.parametrize("ns", NAMESPACES)
def test_declared_shapes_match_the_registry(ns: str) -> None:
    registered = _registered_shapes()
    for spec in declarations.manifests()[ns].blocks:
        op = f"{ns}.{spec.opcode}"
        if op not in registered:
            continue  # 上一個測試負責報這件事
        want = declarations.shapes_of(spec.type, dynamic=spec.dynamic)
        assert want == registered[op], (
            f"{op} 的形狀不符：宣告 {spec.type}"
            f"{'（dynamic）' if spec.dynamic else ''} → {sorted(want)}，"
            f"實際註冊 {sorted(registered[op])}"
        )


def test_builtin_manifests_declare_no_dependencies() -> None:
    """內建沒有 `main.py`，沒有東西可以裝、也沒有邊界可以守（§7.2）。"""
    for ns, mf in declarations.manifests().items():
        assert mf.builtin, ns
        assert not mf.requirements and not mf.permissions, ns


# --------------------------------------------------------------------------
# 測試 2：題庫用到的參數名 ↔ 宣告
# --------------------------------------------------------------------------


def _corpus_usage() -> dict[str, dict[str, set[str]]]:
    """掃過題庫的每一份 project.json，收集每個 opcode 用過的 input / field 名。"""
    usage: dict[str, dict[str, set[str]]] = {}
    for path in sorted(CORPUS.rglob("project.json")):
        project = json.loads(path.read_text(encoding="utf-8"))
        for block in (project.get("blocks") or {}).values():
            op = block.get("opcode", "")
            if op.split(".", 1)[0] not in declarations.manifests():
                continue  # 積木包的積木由它自己的 manifest 守
            seen = usage.setdefault(op, {"inputs": set(), "fields": set()})
            seen["inputs"].update(block.get("inputs") or {})
            seen["fields"].update(block.get("fields") or {})
    return usage


CORPUS_USAGE = _corpus_usage()

# 補完宣告當天（P0b 第 2 步）題庫實際覆蓋到的內建積木數。只准往上。
BASELINE_COVERED = 42


@pytest.mark.parametrize("opcode", sorted(CORPUS_USAGE), ids=lambda o: o)
def test_corpus_input_names_are_declared(opcode: str) -> None:
    """**這是唯一真正的漂移風險**（§8.1）：宣告的參數名與 handler 讀的 key 對不上。

    題庫是現成的證人：它用的 key 就是 handler 讀得到的 key（不然題目不會過）。
    """
    spec = declarations.block(opcode)
    assert spec is not None, f"題庫用到了沒有宣告的積木 {opcode}"

    used = CORPUS_USAGE[opcode]
    inputs = set(spec.args) - {n for n, a in spec.args.items() if a.is_field}
    fields = {n for n, a in spec.args.items() if a.is_field}

    if spec.dynamic:
        # §4.6：`procedure.call` 的參數是函式的參數，來自 project.procedures
        pytest.skip(f"{opcode} 的參數由專案資料決定")

    assert not (used["inputs"] - inputs), (
        f"{opcode} 的輸入孔 {sorted(used['inputs'] - inputs)} 沒有宣告"
        f"（宣告的是 {sorted(inputs)}）"
    )
    assert not (used["fields"] - fields), (
        f"{opcode} 的欄位 {sorted(used['fields'] - fields)} 沒有宣告"
        f"（宣告的欄位是 {sorted(fields)}）"
    )


def test_corpus_coverage_is_reported() -> None:
    """沒有題目的積木，它的參數名就沒有人守（§17.2 的已知債）。

    這個測試是體檢報告，不是門檻——它只擋**倒退**。基準是補完宣告當天的實測值
    （87 顆積木中的 42 顆）。補題目時把數字往上調，這條線才有意義；調不動就
    表示題庫沒有進步。
    """
    all_ops = declarations.opcodes()
    covered = set(CORPUS_USAGE) & all_ops
    uncovered = sorted(all_ops - covered)
    print(
        f"\n題庫覆蓋 {len(covered)}/{len(all_ops)} 顆內建積木"
        f"（{len(covered) / len(all_ops):.0%}）。"
        f"\n沒有題目、參數名無人守的：{uncovered}"
    )
    assert len(covered) >= BASELINE_COVERED, (
        f"題庫覆蓋的內建積木從 {BASELINE_COVERED} 掉到 {len(covered)}："
        f"{sorted(set(CORPUS_USAGE) & all_ops)}"
    )

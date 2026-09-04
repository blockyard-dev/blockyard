"""內建積木的宣告（D21）。

§8.1 的第一句：新增積木不需要改前端一行程式碼——這句話對內建與第三方**同樣
成立**，因為兩者走的是同一條路。實作上那條路就是這個模組：把
`interpreter/builtins/*.yaml` 用**同一個** `Manifest.model_validate` 讀進來，
不為內建另寫 schema。

宣告放在 handler 旁邊（`control.yaml` 與 `control.py` 並列），因為真正的漂移
風險只有一個：**manifest 宣告的參數名與 handler 實際讀的 key 對不上**。積木包
靠 `_check_coverage` 在載入期比對 `@block`，內建沒有 `@block` 可比，只能靠
「改一邊時另一邊就在眼前」加上 §8.1 的兩個一致性測試（`tests/unit/
test_builtin_manifests.py`）。

檔名跟著 handler 走（`object_ns.yaml` 而不是 `object.yaml`），命名空間以
manifest 的 `id` 為準——與積木包「目錄名必須等於 id」的規則不同，因為這裡是
Python 模組名在做主，`object.py` 會遮蔽標準函式庫的想像空間。
"""

from __future__ import annotations

from pathlib import Path

from blockyard.errors import ExtensionError
from blockyard.extensions.manifest import BUILTIN_NAMESPACES, BlockSpec, Manifest, load_manifest

BUILTINS_DIR = Path(__file__).parent / "builtins"

# manifest 的積木形狀 → 引擎認得的形狀。`value` 同時涵蓋 reporter 與 boolean：
# 引擎不區分兩者，區分是編輯器的事（哪種孔吃哪種積木）。
SHAPE_COMMAND = "command"
SHAPE_VALUE = "value"
SHAPE_HAT = "hat"

_BY_TYPE: dict[str, frozenset[str]] = {
    "command": frozenset({SHAPE_COMMAND}),
    "reporter": frozenset({SHAPE_VALUE}),
    "boolean": frozenset({SHAPE_VALUE}),
    "hat": frozenset({SHAPE_HAT}),
}

_cache: dict[str, Manifest] | None = None


def shapes_of(block_type: str, *, also_command: bool = False) -> frozenset[str]:
    """一顆積木**可以**是哪些形狀。空集合 = 不認得。

    回集合而不是單一值，是因為 §4.6 的 `procedure.call`：函式宣告了回傳型別
    它是 reporter，沒宣告就是 command。那取決於專案資料，不是宣告寫得死的
    ——`alsoCommand` 就是宣告用來承認這件事的方式。

    這裡曾經問的是 `dynamic`（「積木由專案資料生成」），而那在只有 `call` 與
    `definition` 兩顆 dynamic 積木時剛好等價。`procedure.param` 一出現就不等價
    了：它也是 dynamic，形狀卻是固定的 reporter。
    """
    shapes = _BY_TYPE.get(block_type, frozenset())
    if also_command and block_type == "reporter":
        return shapes | {SHAPE_COMMAND}
    return shapes


def manifests() -> dict[str, Manifest]:
    """命名空間 → 宣告。第一次呼叫時讀檔，之後走快取。"""
    global _cache
    if _cache is None:
        _cache = _load()
    return _cache


def reload() -> dict[str, Manifest]:
    """丟掉快取重讀。給測試與（P2 的）熱重載用。"""
    global _cache
    _cache = None
    return manifests()


def block(opcode: str) -> BlockSpec | None:
    """`control.repeat` → 那顆積木的宣告。認不得回 None（§13.3 的佔位符）。"""
    ns, _, short = opcode.partition(".")
    mf = manifests().get(ns)
    return mf.block(short) if mf is not None else None


def shapes(opcode: str) -> frozenset[str]:
    spec = block(opcode)
    return frozenset() if spec is None else shapes_of(spec.type, also_command=spec.alsoCommand)


def is_terminal(opcode: str) -> bool:
    """這顆積木是不是 cap block（§4.6）——下面不能再接積木。

    與 `shapes` 同一個理由走宣告：那句規則原本寫死在 `_validate_structure` 裡
    比對 `procedure.return`，於是「哪些積木是終止積木」只有讀過那一行的人知道。
    """
    spec = block(opcode)
    return spec is not None and spec.terminal


def expression_fields(opcode: str) -> frozenset[str]:
    """一顆積木有哪些欄位宣告成 `type: expression`（§4.7b）。

    `ir.schema.load` 靠它決定要解析哪些欄位。答案只看**宣告**——與 `shapes`
    同一個理由：從實作反推會讓一個忘了宣告的運算式欄位默默變成一格字串，
    存檔期的語法檢查對它安靜地失效。

    只查內建。積木包宣告不了 `expression`（`BUILTIN_ONLY_ARG_TYPES`），所以
    這裡不必像 `resolve_shape` 那樣接受一個擴充註冊表——那個參數只會是
    永遠回空集合的裝飾品。
    """
    spec = block(opcode)
    if spec is None:
        return frozenset()
    return frozenset(n for n, a in spec.args.items() if a.type == "expression")


def opcodes() -> set[str]:
    """所有內建積木的完整 opcode。"""
    return {f"{mf.id}.{b.opcode}" for mf in manifests().values() for b in mf.blocks}


def _load() -> dict[str, Manifest]:
    found: dict[str, Manifest] = {}
    for path in sorted(BUILTINS_DIR.glob("*.yaml")):
        mf = load_manifest(path)
        if not mf.builtin:
            raise ExtensionError(f"{path}：內建宣告必須寫 builtin: true")
        if mf.id in found:
            raise ExtensionError(f"{path}：命名空間 {mf.id} 已經由別的檔案宣告過")
        found[mf.id] = mf

    if missing := BUILTIN_NAMESPACES - set(found):
        # 少一份宣告的症狀是「那個命名空間的積木在編輯器裡整個消失」，而形狀
        # 驗證會把它們當成 §13.3 的佔位符默默放行——安靜到不可能被發現。
        raise ExtensionError(f"內建命名空間缺少宣告：{sorted(missing)}")
    return found


__all__ = [
    "BUILTINS_DIR",
    "SHAPE_COMMAND",
    "SHAPE_HAT",
    "SHAPE_VALUE",
    "block",
    "expression_fields",
    "is_terminal",
    "manifests",
    "opcodes",
    "reload",
    "shapes",
    "shapes_of",
]

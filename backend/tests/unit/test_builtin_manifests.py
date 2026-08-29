"""§8.1 的一致性測試：內建宣告 ↔ 實作（D21）。

積木包靠 `_check_coverage` 在載入期比對 manifest 與 `@block`，內建沒有
`@block` 可比。這幾個測試就是它的替代品：

  1. 宣告的 opcode 集合 == 註冊表的集合，且形狀相符 → 抓少宣告、多宣告、形狀寫錯
  2. §17 題庫用到的每個 input / field 名稱都宣告過        → 抓參數名對不上
  3. **handler 原始碼**裡讀的每個 key 都宣告過，且 field / 輸入孔的分類一致

第 2 個只守得到有題目的積木（約半數），所以它順帶把那筆債變成可量化的數字。
第 3 個補上另一半：它不需要題目，直接讀 `builtins/*.py` 的 AST，87 顆全部守得到
——`t.value(b, "cond")` 對上 `args: {condition: …}` 這種漂移，題庫沒寫到的積木
也躲不掉。兩者互補而不重複：AST 看得到 handler 讀什麼，題庫看得到它真的跑得動。
"""

from __future__ import annotations

import ast
import json
from collections import defaultdict
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
        want = declarations.shapes_of(spec.type, also_command=spec.alsoCommand)
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
BASELINE_COVERED = 43


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


# --------------------------------------------------------------------------
# 測試 3：handler 讀的 key ↔ 宣告（不需要題目，87 顆全部守得到）
# --------------------------------------------------------------------------

BUILTINS_DIR = Path(declarations.BUILTINS_DIR)

# `Thread` 的讀取方法 → 這個 key 在 IR 裡是什麼。這張表就是 §4.2 那條線
# （fields 存不可為表達式的選項，inputs 是孔）在 Python 這一側的樣子。
_READERS = {
    "value": "input",
    "number": "input",
    "string": "input",
    "boolean": "input",
    "stack": "stack",
    "field": "field",
    # §4.7b：運算式欄位。歸在 field 這一側是因為它就在 IR 的 `fields` 裡——
    # 少了這一行，`operator.expr` 讀的 key 對不上宣告時沒有人會叫。
    "expression": "field",
}


def _literal(node: ast.expr | None) -> str | None:
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


class _Module:
    """一個 builtins 模組裡「誰讀了哪些 key」。

    要跨函式追，因為 handler 常常把讀取包成小工具：`object.get` 讀的是
    `_require_object(t, b)`，而那個 `"object"` 寫在工具的**參數預設值**上。
    只看 handler 本身會漏掉一半的 object / time 積木。

    追的時候要帶上呼叫端的實參：`time.diff` 呼叫的是 `_require_ts(t, b, "a")`，
    參數預設值 `"time"` 在那裡**不算數**。不帶實參的話這個測試自己會產生假警報，
    而假警報最後一定會被人關掉。
    """

    def __init__(self, tree: ast.Module):
        self.fns: dict[str, ast.FunctionDef | ast.AsyncFunctionDef] = {}
        self.opcodes: dict[str, list[str]] = defaultdict(list)

        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            self.fns[node.name] = node
            for deco in node.decorator_list:
                if (
                    isinstance(deco, ast.Call)
                    and isinstance(deco.func, ast.Name)
                    and deco.func.id in ("command", "value")
                    and (op := _literal(deco.args[0] if deco.args else None))
                ):
                    self.opcodes[node.name].append(op)

    def keys_of(
        self,
        name: str,
        bound: dict[str, str] | None = None,
        seen: frozenset[str] = frozenset(),
    ) -> set[tuple[str, str]]:
        """`name` 這個函式（含它呼叫的同模組工具）讀了哪些 key。"""
        fn = self.fns.get(name)
        if fn is None or name in seen:
            return set()

        names = {**self._defaults(fn), **(bound or {})}
        out: set[tuple[str, str]] = set()
        for node in ast.walk(fn):
            if not isinstance(node, ast.Call):
                continue
            f = node.func
            if isinstance(f, ast.Attribute) and f.attr in _READERS and len(node.args) >= 2:
                arg = node.args[1]
                key = _literal(arg) or (names.get(arg.id) if isinstance(arg, ast.Name) else None)
                if key is not None:
                    out.add((_READERS[f.attr], key))
            elif isinstance(f, ast.Name) and f.id in self.fns:
                out |= self.keys_of(f.id, self._binding(f.id, node), seen | {name})
        return out

    @staticmethod
    def _defaults(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> dict[str, str]:
        """參數的字串預設值：`async def _require_ts(t, b, name="time")`。"""
        params = [a.arg for a in fn.args.args]
        pairs = zip(params[len(params) - len(fn.args.defaults) :], fn.args.defaults)
        return {p: v for p, d in pairs if (v := _literal(d)) is not None}

    def _binding(self, callee: str, call: ast.Call) -> dict[str, str]:
        """呼叫端寫死的字串實參 → 被呼叫函式的參數名。"""
        params = [a.arg for a in self.fns[callee].args.args]
        bound = {
            params[i]: v
            for i, arg in enumerate(call.args)
            if i < len(params) and (v := _literal(arg)) is not None
        }
        bound.update(
            {kw.arg: v for kw in call.keywords if kw.arg and (v := _literal(kw.value)) is not None}
        )
        return bound


def _handler_usage() -> dict[str, set[tuple[str, str]]]:
    usage: dict[str, set[tuple[str, str]]] = {}
    for path in sorted(BUILTINS_DIR.glob("*.py")):
        if path.name == "__init__.py":
            continue
        module = _Module(ast.parse(path.read_text(encoding="utf-8")))
        for fn, opcodes in module.opcodes.items():
            for op in opcodes:
                usage[op] = module.keys_of(fn)
    return usage


HANDLER_USAGE = _handler_usage()


@pytest.mark.parametrize("opcode", sorted(HANDLER_USAGE), ids=lambda o: o)
def test_handler_reads_only_declared_args(opcode: str) -> None:
    """讀 `builtins/*.py` 的 AST，比對它讀的 key 與宣告。

    抓兩種漂移，兩種都是**畫面上完全看不出來**的：

      1. handler 讀 `"cond"` 而宣告寫 `condition` → 使用者填的值到不了 handler，
         積木安靜地拿 default 跑完。
      2. handler 用 `t.field` 讀、宣告卻是輸入孔（或反過來）→ 編輯器把值存進
         `inputs`，handler 去 `fields` 撈，同樣是安靜地拿 default。

    找不到字面值的 key（`if_else` 的 `branch` 是變數）跳過：這裡寧可漏也不要
    誤報，一個會叫的假警報最後會被人加 `# noqa` 關掉。
    """
    spec = declarations.block(opcode)
    assert spec is not None, f"{opcode} 有 handler 卻沒有宣告"
    if spec.dynamic:
        pytest.skip(f"{opcode} 的參數由專案資料決定（§4.6）")

    for kind, key in sorted(HANDLER_USAGE[opcode]):
        arg = spec.args.get(key)
        assert arg is not None, (
            f"{opcode} 的 handler 讀了沒有宣告的 {key!r}"
            f"（宣告的是 {sorted(spec.args)}）——使用者填的值到不了 handler"
        )
        if kind == "field":
            assert arg.is_field, f"{opcode}.{key} handler 當 field 讀，宣告卻是輸入孔"
        elif kind == "input":
            assert not arg.is_field, f"{opcode}.{key} handler 當輸入孔讀，宣告卻是 field"
        elif kind == "stack":
            assert arg.type == "stack", f"{opcode}.{key} handler 當堆疊讀，宣告是 {arg.type}"


def test_declared_args_that_no_handler_reads_are_reported() -> None:
    """反方向只印不擋。

    宣告了卻沒讀到的參數**不一定是 bug**：key 是變數算出來的時候（`if_else` 的
    `then` / `else`）AST 看不到它。當成錯誤會逼人寫例外清單，而例外清單一長，
    這個測試就不再有人相信。所以它是體檢報告——真正的漂移由上面那個測試擋。
    """
    report: dict[str, list[str]] = {}
    for opcode, keys in sorted(HANDLER_USAGE.items()):
        spec = declarations.block(opcode)
        if spec is None or spec.dynamic:
            continue
        unread = sorted(set(spec.args) - {key for _, key in keys})
        if unread:
            report[opcode] = unread
    print("\n宣告了、但 handler 沒有以字面值讀到的參數（key 由變數算出時屬正常）：")
    for opcode, unread in report.items():
        print(f"  {opcode}: {unread}")


# --------------------------------------------------------------------------
# 測試 4：`binds`（§4.5 的靜態檢查靠它分辨讀與寫）
# --------------------------------------------------------------------------

# 「這一格建立一個新名字」的完整名單。**這份名單就是規格**：編輯器的靜態檢查
# （§8.5）拿它算出「已定義的變數」，只出現在其他變數欄位的名字就被標成打錯字。
#
# 寫死在測試裡而不是從實作推導，是因為 AST 看不出差別——`data.change` 也呼叫
# `t.scope.set(name, …)`，但它 §4.5 明定要求變數**已存在**（少打一顆「設定」
# 換來的是打錯字被靜默當成新變數）。「會不會寫」與「會不會建立」是兩件事，
# 只有人分得出來，所以這裡把答案寫下來，新增積木時會被下面那條反向檢查逼著回來。
BINDING_ARGS = {
    ("data.set", "name"),            # 寫入即建立（§4.5）
    ("control.for_each", "name"),    # 迴圈變數
    ("control.try_catch", "error_name"),  # thread-local 的錯誤（§5.4 第 2 層）
}


def test_binding_variable_args_are_exactly_the_declared_ones() -> None:
    declared = {
        (f"{ns}.{b.opcode}", name)
        for ns, mf in declarations.manifests().items()
        for b in mf.blocks
        for name, a in b.args.items()
        if a.binds
    }
    assert declared == BINDING_ARGS, (
        "binds 的宣告與這份名單不一致。多宣告 → 打錯的變數名不再被標警告；"
        "少宣告 → 正確的變數被標成「還沒有被設定過」，而兩者都只在編輯器裡看得見"
    )


# 「這顆積木回傳的就是這一格所指名字的值」的完整名單（§4.6）。同樣寫死：
# `data.get` 與 `data.list_length` 的宣告一模一樣（reporter + 一個 variable
# 參數），AST 也分不出來——差別在回傳的是值還是長度。少宣告的症狀是「函式分類
# 列不出參數的 `取得` 積木」，多宣告的症狀是「列出一顆取長度的積木還說那是參數」。
READING_ARGS = {("data.get", "name")}


def test_variable_reading_args_are_exactly_the_declared_ones() -> None:
    declared = {
        (f"{ns}.{b.opcode}", name)
        for ns, mf in declarations.manifests().items()
        for b in mf.blocks
        for name, a in b.args.items()
        if a.reads
    }
    assert declared == READING_ARGS, (
        "reads 的宣告與這份名單不一致。函式分類（§4.6）用它決定「取得 (參數名)」"
        "要拿哪一顆積木，而那是編輯器裡才看得見的東西"
    )


def test_reads_is_only_declared_on_variable_reporters() -> None:
    """反向：宣告了 reads 的一定是回傳值的積木，不然「回傳這個名字的值」是空話。"""
    for ns, mf in declarations.manifests().items():
        for b in mf.blocks:
            for name, a in b.args.items():
                if a.reads:
                    assert a.type == "variable", f"{ns}.{b.opcode}.{name}"
                    assert b.type in ("reporter", "boolean"), f"{ns}.{b.opcode} 沒有回傳值"


def test_binds_is_only_declared_on_variable_args() -> None:
    """型別驗證已經擋了，這裡守的是「宣告了 binds 的一定是變數欄位」這條反向。"""
    for ns, mf in declarations.manifests().items():
        for b in mf.blocks:
            for name, a in b.args.items():
                if a.binds:
                    assert a.type == "variable", f"{ns}.{b.opcode}.{name}"
                    assert a.is_field, f"{ns}.{b.opcode}.{name} 綁的是名字，必須存在 fields"


# --------------------------------------------------------------------------
# 測試 5：工具箱按鈕（D25）
# --------------------------------------------------------------------------

# 內建宣告的按鈕完整名單。與 `BINDING_ARGS` 同一個理由寫死：按鈕是**唯一**的
# 建立函式入口（§8.5），少一顆的症狀是「畫布上生不出函式」，而那件事沒有任何
# 一條既有測試會叫——工具箱是前端組的。
BUILTIN_BUTTONS = {("procedure", "create", "create_procedure")}


def test_builtin_buttons_are_exactly_the_declared_ones() -> None:
    declared = {
        (ns, b.id, b.action)
        for ns, mf in declarations.manifests().items()
        for b in mf.buttons
    }
    assert declared == BUILTIN_BUTTONS, (
        "內建按鈕的宣告與這份名單不一致。少一顆「創建積木」＝畫布上生不出函式"
    )

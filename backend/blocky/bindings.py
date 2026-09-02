"""綁定的作用範圍（§5.4、D29）。

一句話：**綁進來的名字只在綁它那顆積木的 body 裡看得見。** hat 的 body 是整條
腳本，所以 `yields` 仍然是整條 thread——那不是第二條規則，是同一條規則套在 hat
上的結果。

這個模組是那條規則**在 IR 上**的那一半，兩個消費者：

  - `Interpreter` 建一張「這個名字是哪顆積木綁的」的表，讓範圍外讀它的錯誤
    訊息指得出那顆積木（D29 第 4 條）。
  - `api/validation.py` 在存檔期擋 `設定 [綁定名]` / `改變 [綁定名]`（D29
    第 3 條）——與 v0.23 的 `設定 [參數名]` 是同一條規則，只是「哪顆積木綁的、
    body 是哪一疊」換了一個對象。

**範圍是哪一疊由 manifest 說，不由這裡寫死**（D21）：`ArgSpec.scope` 指的是同
一顆積木上某個 `type: stack` 參數。沒有那個宣告，這裡就得有一份
`{"control.for_each": "body", "control.try_catch": "catch"}` 的名單，而積木包
哪天有了自己的 C 型綁定積木，那份名單就是錯的——而且是**安靜地**錯：那顆積木
綁的名字會被當成全域變數，於是它在迴圈外面讀得到。

## 為什麼存檔期擋，而不是執行期讓它跑

`設定 [item] 為 (…)`（`item` 是那顆 `for_each` 綁的迴圈變數）讀寫會指到兩個
不同的東西：`取得 (item)` 讀第 2 層，`設定` 寫第 3 層——而畫面上那兩顆積木長得
一模一樣。它交出來的不是一個錯誤，是一個**值對了一半**的結果，而那種東西沒有
人查得出來。§8.5 對誤報的態度是這條規則能擋在存檔期的前提：範圍算得準，就不會
有假警報。
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator
from typing import TYPE_CHECKING, Any

from blocky.errors import ValidationError

if TYPE_CHECKING:
    from blocky.extensions.manifest import BlockSpec

#: 一顆積木的宣告從哪裡來。內建走 `interpreter.declarations`，積木包走 registry
#: ——這個模組不知道那個差別，也不該知道（同 `repeat.py`）。
SpecResolver = Callable[[str], "BlockSpec | None"]

_PLACEHOLDER = re.compile(r"%\((\w+)\)")

#: 積木文字裡填不出來的那些孔（它們裝的是別的積木，不是一個念得出來的值）。
_HOLE = "⋯"


# --------------------------------------------------------------------------
# 宣告：哪些格子綁出一個有範圍的名字
# --------------------------------------------------------------------------


def scoped_binds(spec: BlockSpec | None) -> list[tuple[str, str]]:
    """這顆積木上「綁一個名字、範圍是某一疊」的格子：`(名稱欄位, stack 欄位)`。

    `data.set.name` 不在裡面——它也是 `binds`，但沒有 `scope`，因為它建立的是
    第 3 層的名字（整個 Run 都看得見）。分辨這兩種綁定端只有宣告答得出來。
    """
    if spec is None:
        return []
    return [(name, arg.scope) for name, arg in spec.args.items() if arg.scope is not None]


def writes_global(spec: BlockSpec | None) -> list[str]:
    """這顆積木上「寫進第 3 層」的變數名稱欄位。

    兩種：`binds` 但沒有 `scope`（`data.set`：寫入即建立），以及 `writes`
    （`data.change`：要求已存在）。`把 (x) 加到 [清單]` 不算——它就地改那個
    清單、不呼叫 `scope.set`，所以它在迴圈變數上是**對的**，擋它是誤報。
    """
    if spec is None:
        return []
    return [
        name
        for name, arg in spec.args.items()
        if arg.writes or (arg.binds and arg.scope is None)
    ]


def block_label(block: dict[str, Any], spec: BlockSpec | None) -> str:
    """一顆積木在錯誤訊息裡叫什麼：宣告的文字，把填得出來的孔填上。

    `對 %(list) 的每一項 %(name)` → `對 ⋯ 的每一項 item`。填的是 `fields`
    （變數名、下拉值——那些**就是**畫面上看得到的字），輸入孔裡裝的是別的積木，
    念不出來就留一個省略號。

    退回 opcode 是給 §13.3 的佔位符用的：認不得的積木沒有宣告，但它仍然可能
    出現在一句話裡。
    """
    opcode = str(block.get("opcode", ""))
    if spec is None:
        return opcode
    fields = block.get("fields") or {}

    def fill(m: re.Match[str]) -> str:
        v = fields.get(m.group(1)) if isinstance(fields, dict) else None
        return _HOLE if v is None or v == "" else str(v)

    return re.sub(_PLACEHOLDER, fill, spec.text).strip()


# --------------------------------------------------------------------------
# IR 走訪
# --------------------------------------------------------------------------


def ancestors(blocks: dict[str, Any], block_id: str) -> Iterator[tuple[str, dict[str, Any], str | None]]:
    """從這顆積木往外走，`(祖先 id, 祖先, 從它的哪一格進來的)`，由內而外。

    「哪一格」是這條規則的關鍵：C 型積木的**嘴巴就是範圍**，而 `try_catch` 有
    兩張嘴——`error` 只在 `catch` 那一張裡有效。走到 `next` 上去的是同一疊的
    前一顆積木，不是「進到某一格」，所以那時候是 None。

    `parent` 串成環時停下來（`iter_stack` 會另外報那個錯，這裡不重複）。
    """
    seen: set[str] = {block_id}
    cur = block_id
    while True:
        block = blocks.get(cur)
        if not isinstance(block, dict):
            return
        parent_id = block.get("parent")
        if not isinstance(parent_id, str) or parent_id in seen:
            return
        parent = blocks.get(parent_id)
        if not isinstance(parent, dict):
            return
        seen.add(parent_id)
        yield parent_id, parent, _input_holding(parent, cur)
        cur = parent_id


def _input_holding(parent: dict[str, Any], child_id: str) -> str | None:
    inputs = parent.get("inputs")
    if not isinstance(inputs, dict):
        return None
    for name, inp in inputs.items():
        if isinstance(inp, dict) and inp.get("id") == child_id:
            return name
    return None


def binder_index(blocks: dict[str, Any], resolve: SpecResolver) -> dict[str, str]:
    """name → 「綁它的那顆積木叫什麼」。只收有範圍的綁定端（見 `scoped_binds`）。

    給的是**整份專案**的答案而不是「這一刻堆疊上有什麼」，因為那句話要說的正是
    範圍**外**的情形——迴圈跑完，那一層早就被 pop 掉了，執行期已經沒有東西記得
    是誰綁的。

    同一個名字被兩顆不同的積木綁時取字典序第一個：這是一句提示不是規格，而兩顆
    `對每一項 item` 的文字本來就一模一樣，去重之後多半只剩一個。
    """
    found: dict[str, set[str]] = {}
    for block in blocks.values():
        if not isinstance(block, dict):
            continue
        spec = resolve(str(block.get("opcode", "")))
        fields = block.get("fields") or {}
        for field_name, _stack in scoped_binds(spec):
            name = fields.get(field_name) if isinstance(fields, dict) else None
            if isinstance(name, str) and name:
                found.setdefault(name, set()).add(block_label(block, spec))
    return {name: sorted(labels)[0] for name, labels in found.items()}


# --------------------------------------------------------------------------
# 存檔期驗證
# --------------------------------------------------------------------------


def validate_blocks(
    blocks: dict[str, Any], procedures: dict[str, Any], resolve: SpecResolver
) -> None:
    """`設定 [唯讀的名字]` 是存檔期錯誤（§5.4 v0.23 + D29 第 3 條）。

    兩種唯讀的名字，同一條規則：

    1. **函式參數**（第 1 層）。`設定 [次數] 為 (5)` 在 `次數` 剛好是這個函式的
       參數時，`取得 (次數)` 讀 frame、`設定` 寫全域——畫面上那兩顆積木長得一
       模一樣。
    2. **綁定型積木綁的名字**（第 2 層）：迴圈體裡的 `設定 [item]`、catch 裡的
       `設定 [error]`。範圍的算法一樣，只是「哪顆積木綁的、body 是哪一疊」換了
       一個對象。

    想不出有人會**想要**這個行為，而一個會叫的假警報最後會被忽略，然後真的錯誤
    也一起被忽略（§8.5）。
    """
    if not isinstance(blocks, dict):
        return
    params_by_definition = _params_by_definition(procedures)

    for bid, block in blocks.items():
        if not isinstance(block, dict):
            continue
        spec = resolve(str(block.get("opcode", "")))
        targets = writes_global(spec)
        if not targets:
            continue
        fields = block.get("fields") or {}
        for field_name in targets:
            name = fields.get(field_name) if isinstance(fields, dict) else None
            if not isinstance(name, str) or not name:
                continue
            if (owner := _readonly_owner(blocks, bid, name, params_by_definition, resolve)):
                raise ValidationError(owner, block_id=bid)


def _params_by_definition(procedures: dict[str, Any]) -> dict[str, tuple[str, set[str]]]:
    """definitionBlock → (函式名, 參數名集合)。"""
    out: dict[str, tuple[str, set[str]]] = {}
    if not isinstance(procedures, dict):
        return out
    for proc in procedures.values():
        if not isinstance(proc, dict):
            continue
        definition = proc.get("definitionBlock")
        if not isinstance(definition, str):
            continue
        names = {
            p["name"]
            for p in (proc.get("params") or [])
            if isinstance(p, dict) and isinstance(p.get("name"), str)
        }
        out[definition] = (str(proc.get("name") or "這個函式"), names)
    return out


def _readonly_owner(
    blocks: dict[str, Any],
    block_id: str,
    name: str,
    params_by_definition: dict[str, tuple[str, set[str]]],
    resolve: SpecResolver,
) -> str | None:
    """這顆寫入積木身上的名字，撞到了哪個唯讀的東西。回傳那句錯誤訊息。

    **由內而外走，第一個命中的就是答案**：一個 `設定 [x]` 同時在綁 `x` 的迴圈
    裡、又在有參數 `x` 的函式裡時，遮蔽它的是內層那個，訊息要指那一顆。
    """
    for ancestor_id, ancestor, via in ancestors(blocks, block_id):
        spec = resolve(str(ancestor.get("opcode", "")))
        fields = ancestor.get("fields") or {}
        for field_name, stack in scoped_binds(spec):
            if via != stack:
                continue  # 在別張嘴巴裡（`try` 那一疊看不到 `error`）
            bound = fields.get(field_name) if isinstance(fields, dict) else None
            if bound == name:
                return (
                    f"「{name}」是那顆「{block_label(ancestor, spec)}」綁的名字，唯讀；"
                    "這顆積木會寫到一個同名的全域變數，請換個名字"
                )

        if (found := params_by_definition.get(ancestor_id)) and name in found[1]:
            proc_name, _ = found
            return (
                f"「{name}」是函式「{proc_name}」的參數，唯讀；"
                "這顆積木會寫到一個同名的全域變數，請換個名字"
            )
    return None


__all__ = [
    "SpecResolver",
    "ancestors",
    "binder_index",
    "block_label",
    "scoped_binds",
    "validate_blocks",
    "writes_global",
]

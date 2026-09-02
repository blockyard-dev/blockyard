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
from blocky.extensions.manifest import SCOPE_FRAME

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
    return [
        (name, arg.scope)
        for name, arg in spec.args.items()
        if arg.scope is not None and arg.scope != SCOPE_FRAME
    ]


def frame_binds(spec: BlockSpec | None) -> list[str]:
    """這顆積木上「綁一個名字進 frame」的格子（§16 Q6 的 `本次呼叫`）。

    範圍是**所在的函式體**，而函式體不是一疊 stack——它掛在定義積木的 `next`
    上。所以它不能像 `scope: body` 那樣指一格，宣告用的是保留字 `frame`。
    """
    if spec is None:
        return []
    return [name for name, arg in spec.args.items() if arg.scope == SCOPE_FRAME]


def creates_global(spec: BlockSpec | None) -> list[str]:
    """「**建立**一個第 3 層的名字」的欄位（`binds` 但沒有 `scope`，即 `data.set`）。

    它撞到任何唯讀的名字**或函式的暫存變數**都是錯的：`設定` 建立的是全域，
    而同一個函式裡讀那個名字讀到的是第 1 層——寫出去的值永遠看不見。
    """
    if spec is None:
        return []
    return [name for name, arg in spec.args.items() if arg.binds and arg.scope is None]


def writes_existing(spec: BlockSpec | None) -> list[str]:
    """「**寫**一個已經存在的名字」的欄位（`writes: true`，即 `data.change`）。

    與 `creates_global` 分開，因為它們撞到函式暫存變數時的答案**相反**：`改變`
    寫回它讀到的那一層（§16 Q6），所以 `本次呼叫 [總和] 為 (0)` 之後
    `改變 [總和] 增加 (x)` 是對的——那正是累加最自然的寫法。擋它才是誤報。

    唯讀的那幾層（參數、迴圈變數、錯誤變數）兩者一起擋，理由一樣。

    `把 (x) 加到 [清單]` 兩邊都不算——它就地改那個清單、不呼叫 `scope.set`。
    """
    if spec is None:
        return []
    return [name for name, arg in spec.args.items() if arg.writes]


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


def binder_index(
    blocks: dict[str, Any], procedures: dict[str, Any], resolve: SpecResolver
) -> dict[str, str]:
    """name → 「它在**哪裡**有效」的那一句話。只收有範圍的綁定端。

    值是一整句而不是一個標籤，因為兩種綁定端的說法本來就不一樣：

        那顆「對 ⋯ 的每一項 水果」     C block 綁的（第 2 層）
        函式「加總」                   `本次呼叫` 綁的（第 1 層，§16 Q6）

    第二種指的是函式而不是那顆 `本次呼叫` 積木：範圍是整個函式體，而使用者要
    回去的地方是那個函式，不是某一顆積木。

    給的是**整份專案**的答案而不是「這一刻堆疊上有什麼」，因為那句話要說的正是
    範圍**外**的情形——迴圈跑完、函式回傳了，那一層早就沒了，執行期已經沒有東西
    記得是誰綁的。

    同一個名字被兩處綁時取字典序第一個：這是一句提示不是規格，而兩顆
    `對每一項 item` 的文字本來就一模一樣，去重之後多半只剩一個。
    """
    params_by_definition = _params_by_definition(procedures)
    found: dict[str, set[str]] = {}
    for bid, block in blocks.items():
        if not isinstance(block, dict):
            continue
        spec = resolve(str(block.get("opcode", "")))
        fields = block.get("fields") or {}

        for field_name, _stack in scoped_binds(spec):
            name = fields.get(field_name) if isinstance(fields, dict) else None
            if isinstance(name, str) and name:
                found.setdefault(name, set()).add(f"那顆「{block_label(block, spec)}」")

        for field_name in frame_binds(spec):
            name = fields.get(field_name) if isinstance(fields, dict) else None
            if not isinstance(name, str) or not name:
                continue
            owner = _enclosing_definition(blocks, bid, params_by_definition)
            # 不在函式裡是存檔期錯誤，所以這裡幾乎不會發生；真發生了就退回
            # 那顆積木自己，總比一句話裡有個空洞好。
            phrase = f"函式「{owner[1][0]}」" if owner else f"那顆「{block_label(block, spec)}」"
            found.setdefault(name, set()).add(phrase)

    return {name: sorted(phrases)[0] for name, phrases in found.items()}


def _enclosing_definition(
    blocks: dict[str, Any],
    block_id: str,
    params_by_definition: dict[str, tuple[str, set[str]]],
) -> tuple[str, tuple[str, set[str]]] | None:
    """這顆積木在哪個函式定義底下。不在任何函式裡就是 None。

    函式體掛在定義積木的 `next` 上（不是一格 stack），所以這裡不看是從哪一格
    進來的——與 `_validate_structure` 對 `回傳` 位置的判斷同一條規則。
    """
    for ancestor_id, _ancestor, _via in ancestors(blocks, block_id):
        if (found := params_by_definition.get(ancestor_id)) is not None:
            return ancestor_id, found
    return None


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
    locals_by_definition = _locals_by_definition(blocks, params_by_definition, resolve)

    for bid, block in blocks.items():
        if not isinstance(block, dict):
            continue
        spec = resolve(str(block.get("opcode", "")))
        fields = block.get("fields") if isinstance(block.get("fields"), dict) else {}

        # `本次呼叫 [x]`（§16 Q6）——它自己的兩條規則。
        for field_name in frame_binds(spec):
            name = fields.get(field_name)
            if not isinstance(name, str) or not name:
                continue
            label = block_label(block, spec)
            # 規則 3：只准放在函式體內。頂層堆疊沒有 frame，而且「粉紅 = 函式」
            # （§8.5 唯一能用眼睛掃出來的規則）只有在這條成立時才不說謊。
            if _enclosing_definition(blocks, bid, params_by_definition) is None:
                raise ValidationError(
                    f"「{label}」只能放在函式定義裡面；"
                    "這裡沒有「這次呼叫」，頂層的腳本要用「設定」",
                    block_id=bid,
                )
            # 規則 2：與參數同名擋下，不是覆寫。§4.6 的「參數唯讀、只活在這個
            # frame」正撐著帽子上那顆膠囊「看到的就是拿到的」；開放覆寫，膠囊在
            # 函式體中段就開始說謊。換來的只有「不必換個名字」。
            # 順帶也擋掉撞到迴圈變數／錯誤變數的情形——同一個 `_readonly_owner`。
            if owner := _readonly_owner(blocks, bid, name, params_by_definition, {}, resolve):
                raise ValidationError(
                    f"「{name}」已經是{owner}的名字，唯讀；"
                    f"這顆「{label}」會另外建立一個同名的暫存變數，請換個名字",
                    block_id=bid,
                )

        # `設定 [x]`：撞到唯讀的名字**或函式的暫存變數**都是錯的。
        for field_name in creates_global(spec):
            name = fields.get(field_name)
            if not isinstance(name, str) or not name:
                continue
            owner = _readonly_owner(
                blocks, bid, name, params_by_definition, locals_by_definition, resolve
            )
            if owner:
                raise ValidationError(
                    f"「{name}」是{owner}的名字；"
                    "這顆積木會寫到一個同名的全域變數，請換個名字",
                    block_id=bid,
                )

        # `改變 [x]`：只擋唯讀的那幾層。它寫回讀到的那一層，所以撞到函式的暫存
        # 變數是**對的**——`本次呼叫 [總和] 為 (0)` 之後 `改變 [總和]` 正是累加
        # 最自然的寫法，擋它是誤報。
        for field_name in writes_existing(spec):
            name = fields.get(field_name)
            if not isinstance(name, str) or not name:
                continue
            owner = _readonly_owner(
                blocks, bid, name, params_by_definition, {}, resolve
            )
            if owner:
                raise ValidationError(
                    f"「{name}」是{owner}的名字，唯讀；"
                    "這顆積木會寫到一個同名的全域變數，請換個名字",
                    block_id=bid,
                )


def _locals_by_definition(
    blocks: dict[str, Any],
    params_by_definition: dict[str, tuple[str, set[str]]],
    resolve: SpecResolver,
) -> dict[str, set[str]]:
    """definitionBlock → 那個函式體裡 `本次呼叫` 建立的名字。

    要這張表是因為 `設定 [總和]` 與 `本次呼叫 [總和]` 之間是**兄弟**關係，不是
    祖先關係——祖先鏈走不到它。而那兩顆湊在同一個函式裡，讀的是第 1 層、寫的是
    第 3 層，又是一個「值對了一半」。
    """
    out: dict[str, set[str]] = {}
    for bid, block in blocks.items():
        if not isinstance(block, dict):
            continue
        spec = resolve(str(block.get("opcode", "")))
        fields = block.get("fields") if isinstance(block.get("fields"), dict) else {}
        for field_name in frame_binds(spec):
            name = fields.get(field_name)
            if not isinstance(name, str) or not name:
                continue
            if found := _enclosing_definition(blocks, bid, params_by_definition):
                out.setdefault(found[0], set()).add(name)
    return out


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
    locals_by_definition: dict[str, set[str]],
    resolve: SpecResolver,
) -> str | None:
    """這顆積木身上的名字，撞到了哪個唯讀的東西。回傳「那是什麼」的那一句。

    **由內而外走，第一個命中的就是答案**：一個 `設定 [x]` 同時在綁 `x` 的迴圈
    裡、又在有參數 `x` 的函式裡時，遮蔽它的是內層那個，訊息要指那一顆。

    回傳的是名詞片語（`那顆「對 ⋯ 的每一項 x」` / `函式「跳」的參數`），句子由
    呼叫端組——同一個判斷有兩個消費者，而它們要說的下半句不一樣（一個會寫到
    全域變數，一個會另外建一個暫存變數）。
    """
    for ancestor_id, ancestor, via in ancestors(blocks, block_id):
        spec = resolve(str(ancestor.get("opcode", "")))
        fields = ancestor.get("fields") if isinstance(ancestor.get("fields"), dict) else {}
        for field_name, stack in scoped_binds(spec):
            if via != stack:
                continue  # 在別張嘴巴裡（`try` 那一疊看不到 `error`）
            if fields.get(field_name) == name:
                return f"那顆「{block_label(ancestor, spec)}」綁"

        if (found := params_by_definition.get(ancestor_id)) is not None:
            proc_name, params = found
            if name in params:
                return f"函式「{proc_name}」的參數"
            # 同一個函式裡的 `本次呼叫`。這一格是**兄弟**不是祖先，所以它不在
            # 上面那條祖先鏈上，要靠預先掃出來的那張表。
            if name in locals_by_definition.get(ancestor_id, ()):
                return f"函式「{proc_name}」裡「本次呼叫」建立"
    return None


__all__ = [
    "SpecResolver",
    "ancestors",
    "binder_index",
    "block_label",
    "frame_binds",
    "scoped_binds",
    "validate_blocks",
    "creates_global",
    "writes_existing",
]

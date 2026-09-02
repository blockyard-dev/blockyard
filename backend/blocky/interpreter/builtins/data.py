"""data 命名空間：免宣告變數（§4.5）、list 操作、持久化（§5.4、D12）。

§4.5 的兩條嚴格語意是這整個設計最大的風險所在，必須寸步不讓：
  - **寫入即建立**：data.set 對不存在的名稱直接建立
  - **讀取未建立的變數 → 錯誤**，不回 null、不當 0
第二條若放鬆，打錯字的名稱會被靜默當成新變數，而那是免宣告模型的死因。
"""

from __future__ import annotations

from typing import Any

from blocky.errors import BlockyError, UndefinedVariableError
from blocky.interpreter.engine import Thread
from blocky.interpreter.registry import command, value
from blocky.ir.template import suggest_name
from blocky.ir.schema import Block
from blocky.ir.values import (
    TYPE_LABELS_ZH,
    TYPE_LIST,
    normalize_index,
    to_number,
    to_string,
    type_of,
)


def _name(t: Thread, b: Block) -> str:
    n = t.field(b, "name")
    if not isinstance(n, str) or n == "":
        raise BlockyError("積木沒有填變數名稱")
    return n


def _emit_set(t: Thread, name: str, v: Any) -> None:
    t.interp.sink.emit("var.set", threadId=t.id, name=name, value=v)


# --------------------------------------------------------------------------
# 變數
# --------------------------------------------------------------------------


@command("data.set")
async def _set(t: Thread, b: Block) -> None:
    name = _name(t, b)
    v = await t.value(b, "value")
    t.scope.set(name, v)  # 寫入即建立
    _emit_set(t, name, v)


@command("data.set_local")
async def _set_local(t: Thread, b: Block) -> None:
    """`這次 [名稱] 為 (值)`（§16 Q6）：**不共用的**變數。

    `設定` 寫第 3 層，而第 3 層是同一個 Run 的所有 thread 共用的——兩條腳本各
    跑一個計數器、或兩條 thread 各呼叫一次同一個函式，就互相踩。這顆積木存在的
    全部理由就是那個，而它與 D29 修掉的迴圈變數是同一個 bug，只是外層那顆積木
    換了。

    **範圍 = 最近的那一層 body。** 在函式定義底下是這次呼叫（遞迴各自一份，寫進
    frame），在 hat 底下是這條腳本這一次執行（寫進 thread）。那不是兩條規則，是
    D29 那一句「範圍 = 綁它那顆積木的 body」套到不同的外層積木上——同一份文件
    早就說過 hat 的 body 是整條腳本。

    **迴圈與 `如果` 不算一層。** 它們不是一次「執行」，而且把暫存變數綁進迴圈體
    等於每一輪重來一次——那顆積木最常見的用法（在迴圈外面宣告、在迴圈裡累加）
    就整個不能寫了。

    **沒有配對的讀取積木**：§5.4 的解析順序本來就會先看這一層，`取得 (名稱)` 與
    `${名稱}` 直接讀得到。
    """
    name = _name(t, b)
    v = await t.value(b, "value")
    t.scope.set_local(name, v)
    _emit_set(t, name, v)


@command("data.change")
async def _change(t: Thread, b: Block) -> None:
    """§4.5：**同樣要求變數已存在**。

    `change 未建立的變數 by 1` 是錯誤，不是從 0 起算。少打一顆 set 換來的是
    「打錯字被靜默當成新變數」——這個交易不划算。
    """
    name = _name(t, b)
    if not t.scope.has(name):
        raise UndefinedVariableError(
            f'未知變數 "{name}"，「改變」不能用在還沒建立的變數上',
            hint=suggest_name(name, t.scope.known_names()) or "請先用「設定」建立它",
        )
    delta = await t.number(b, "value", default=0)
    cur = to_number(t.scope.get(name), block_id=None)
    v = cur + delta
    # **寫回它讀到的那一層**（§16 Q6）。`設定` 說的是「建立一個全域變數」，
    # 這顆說的是「把既有的那個變大」——寫死全域的話，函式裡的
    # `這次 [總和] 為 (0)` 之後 `改變 [總和]` 會讀 frame、寫全域，那個累加
    # 永遠加不上去，而畫面上什麼都看不出來。
    t.scope.change(name, v)
    _emit_set(t, name, v)


@value("data.get")
async def _get(t: Thread, b: Block) -> Any:
    return t.scope.get(_name(t, b))


@value("data.new_list")
async def _new_list(t: Thread, b: Block) -> list:
    return []


@value("data.new_object")
async def _new_object(t: Thread, b: Block) -> dict:
    return {}


# --------------------------------------------------------------------------
# list 操作。全部要求變數已存在（§4.5）。
# --------------------------------------------------------------------------


def _get_list(t: Thread, b: Block) -> list:
    name = _name(t, b)
    if not t.scope.has(name):
        raise UndefinedVariableError(
            f'未知變數 "{name}"',
            hint=suggest_name(name, t.scope.known_names()) or "請先用「設定」建立它",
        )
    v = t.scope.get(name)
    if type_of(v) != TYPE_LIST:
        raise BlockyError(
            f'"{name}" 是{TYPE_LABELS_ZH[type_of(v)]}不是清單',
            hint="是不是需要先用「設定 [名稱] 為 (空清單)」？",
        )
    return v


@command("data.list_add")
async def _list_add(t: Thread, b: Block) -> None:
    lst = _get_list(t, b)
    lst.append(await t.value(b, "item"))
    _emit_set(t, _name(t, b), lst)


@command("data.list_delete")
async def _list_delete(t: Thread, b: Block) -> None:
    lst = _get_list(t, b)
    idx = await t.value(b, "index", default=1)
    del lst[normalize_index(idx, len(lst))]
    _emit_set(t, _name(t, b), lst)


@command("data.list_clear")
async def _list_clear(t: Thread, b: Block) -> None:
    lst = _get_list(t, b)
    lst.clear()
    _emit_set(t, _name(t, b), lst)


@command("data.list_insert")
async def _list_insert(t: Thread, b: Block) -> None:
    lst = _get_list(t, b)
    item = await t.value(b, "item")
    idx = await t.value(b, "index", default=1)
    # 插入允許 length+1（接在最後面），所以索引正規化多算一格。
    # 空清單 + 索引 1 也走同一條路：長度 1 → pos 0。沒有特例。
    lst.insert(normalize_index(idx, len(lst) + 1), item)
    _emit_set(t, _name(t, b), lst)


@command("data.list_replace")
async def _list_replace(t: Thread, b: Block) -> None:
    lst = _get_list(t, b)
    idx = await t.value(b, "index", default=1)
    lst[normalize_index(idx, len(lst))] = await t.value(b, "item")
    _emit_set(t, _name(t, b), lst)


@value("data.list_item")
async def _list_item(t: Thread, b: Block) -> Any:
    lst = _get_list(t, b)
    idx = await t.value(b, "index", default=1)
    return lst[normalize_index(idx, len(lst))]


@value("data.list_length")
async def _list_length(t: Thread, b: Block) -> int:
    return len(_get_list(t, b))


@value("data.list_contains")
async def _list_contains(t: Thread, b: Block) -> bool:
    return await t.value(b, "item") in _get_list(t, b)


@value("data.list_index_of")
async def _list_index_of(t: Thread, b: Block) -> int:
    """回 1-based 位置；找不到回 0。

    0 在這裡不是索引而是哨兵，正好利用了「1-based 用不到 0」這個空位（§4.3）。
    """
    lst = _get_list(t, b)
    item = await t.value(b, "item")
    return lst.index(item) + 1 if item in lst else 0


# --------------------------------------------------------------------------
# 持久化（§5.4 第 4 層，D12）
# --------------------------------------------------------------------------


@command("data.persist_set")
async def _persist_set(t: Thread, b: Block) -> None:
    t.scope.persist.set(_name(t, b), await t.value(b, "value"))


@value("data.persist_get")
async def _persist_get(t: Thread, b: Block) -> Any:
    """**有預設值孔而非報錯**——這是本設計中少數刻意的寬鬆（§5.4）。

    持久值的「第一次執行」必然不存在，強迫每個人先寫一顆 persist_has
    是純粹的儀式。
    """
    name = _name(t, b)
    if t.scope.persist.has(name):
        return t.scope.persist.get(name)
    return await t.value(b, "default")


@value("data.persist_has")
async def _persist_has(t: Thread, b: Block) -> bool:
    return t.scope.persist.has(_name(t, b))


@command("data.persist_delete")
async def _persist_delete(t: Thread, b: Block) -> None:
    t.scope.persist.delete(_name(t, b))

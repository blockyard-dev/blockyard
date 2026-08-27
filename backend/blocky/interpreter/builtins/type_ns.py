"""type 命名空間（§4.8）。

`is` 與 `can_cast` **必須是兩顆**：`"123"` 對前者是 false、對後者是 true。
兩個問題在工作流裡天天用到，共用一顆積木的話使用者永遠猜不到答案是哪個——
所以積木文字上就用「的型別是」與「可以轉成」把差異寫在臉上。
"""

from __future__ import annotations

from typing import Any

from blocky.errors import TypeCoercionError
from blocky.interpreter.engine import Thread
from blocky.interpreter.registry import value
from blocky.ir.schema import Block
from blocky.ir.values import can_cast, cast, is_empty, is_type, type_of

# `cast` 的下拉**不含清單與物件**（§4.8）：把字串變成物件只可能是 JSON parse，
# 而那必須是一顆看得見的「解析 JSON」積木。
CASTABLE = ("number", "string", "boolean")


def _target(t: Thread, b: Block) -> str:
    return t.field(b, "type", "string")


@value("type.cast")
async def _cast(t: Thread, b: Block) -> Any:
    target = _target(t, b)
    if target not in CASTABLE:
        raise TypeCoercionError(
            f"不能轉成{target}",
            hint="把文字變成物件只可能是 JSON 解析，請用「解析 JSON」積木",
        )
    return cast(await t.value(b, "value"), target)


@value("type.try_cast")
async def _try_cast(t: Thread, b: Block) -> Any:
    """轉不動就用預設值。

    存在的理由是避免使用者為了處理髒資料而把每個轉換都包進 try_catch——
    `if <可轉成數字> then … else …` 是四顆積木，這是一顆。
    """
    v = await t.value(b, "value")
    target = _target(t, b)
    try:
        if target not in CASTABLE:
            raise TypeCoercionError("不可轉換的目標型別")
        return cast(v, target)
    except TypeCoercionError:
        return await t.value(b, "default")


@value("type.is")
async def _is(t: Thread, b: Block) -> bool:
    """問**實際型別**。兩個違反 JS 直覺的地方（§4.8）：

    - 清單與物件是兩種不同型別：`is([], 物件)` 為 False
    - null 是獨立型別：`is(null, 物件)` 為 False
    """
    return is_type(await t.value(b, "value"), _target(t, b))


@value("type.can_cast")
async def _can_cast(t: Thread, b: Block) -> bool:
    """問**可轉換性**。`can_cast("123", 數字)` 為 True。"""
    return can_cast(await t.value(b, "value"), _target(t, b))


@value("type.of")
async def _of(t: Thread, b: Block) -> str:
    return type_of(await t.value(b, "value"))


@value("type.is_empty")
async def _is_empty(t: Thread, b: Block) -> bool:
    """"" [] {} null → True；**0 → False**（§4.3 的刻意不一致）。"""
    return is_empty(await t.value(b, "value"))

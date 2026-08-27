"""debug 命名空間（§4.4）。"""

from __future__ import annotations

from typing import Any

from blocky.interpreter.engine import Thread
from blocky.interpreter.registry import command, value
from blocky.ir.schema import Block
from blocky.ir.values import to_string, type_of


@command("debug.log")
async def _log(t: Thread, b: Block) -> None:
    text = await t.value(b, "text", default="")
    t.log(to_string(text), level=t.field(b, "level", "info"), block_id=t.interp._bid(b))


@value("debug.inspect")
async def _inspect(t: Thread, b: Block) -> Any:
    """把值原樣傳回，順便 log 出來——插在任何輸入孔上都不改變結果。"""
    v = await t.value(b, "value")
    # 用語意型別而不是 type(v).__name__——後者會洩漏 Python 的 int/float 之別，
    # 那正是 D15 要求不得外洩的實作細節。
    t.log(f"{type_of(v)}: {to_string(v)}", level="debug", block_id=t.interp._bid(b))
    return v

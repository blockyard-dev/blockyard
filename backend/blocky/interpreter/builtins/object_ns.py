"""object 命名空間（§4.4、§4.8）。

D10 的核心：**parse 不自動、stringify 自動**。這裡只提供顯式的兩顆積木；
自動的那一半發生在 Host 邊界（§7.5），由 manifest 的參數型別驅動。
"""

from __future__ import annotations

import json
from typing import Any

from blocky.errors import BlockyError, TypeCoercionError
from blocky.interpreter.engine import Thread
from blocky.interpreter.registry import command, value
from blocky.ir.schema import Block
from blocky.ir.values import (
    TYPE_LABELS_ZH,
    TYPE_OBJECT,
    TYPE_STRING,
    object_get,
    to_string,
    type_of,
)


async def _require_object(t: Thread, b: Block, name: str = "object") -> dict:
    o = await t.value(b, name, default=None)
    ty = type_of(o)
    if ty != TYPE_OBJECT:
        # §4.7 說這句訊息是「整份設計裡投入產出比最高的一行字」。
        # 它在這裡與插值路徑共用同一段文案，是刻意的。
        raise BlockyError(
            f"這是{TYPE_LABELS_ZH[ty]}不是物件",
            hint="是不是需要先用「解析 JSON」？" if ty == TYPE_STRING else None,
        )
    return o


@value("object.get")
async def _get(t: Thread, b: Block) -> Any:
    """key 不存在是錯誤（§4.3）——除非接了預設值孔。"""
    o = await _require_object(t, b)
    key = await t.string(b, "key")
    if "default" in b.inputs:
        return o.get(key, await t.value(b, "default"))
    return object_get(o, key)


@command("object.set")
async def _set(t: Thread, b: Block) -> None:
    o = await _require_object(t, b)
    o[await t.string(b, "key")] = await t.value(b, "value")


@command("object.delete")
async def _delete(t: Thread, b: Block) -> None:
    o = await _require_object(t, b)
    o.pop(await t.string(b, "key"), None)


@value("object.has")
async def _has(t: Thread, b: Block) -> bool:
    return await t.string(b, "key") in await _require_object(t, b)


@value("object.keys")
async def _keys(t: Thread, b: Block) -> list[str]:
    return list((await _require_object(t, b)).keys())


@value("object.values")
async def _values(t: Thread, b: Block) -> list[Any]:
    return list((await _require_object(t, b)).values())


@value("object.parse_json")
async def _parse_json(t: Thread, b: Block) -> Any:
    """**永不自動**（D10）。

    parse 是偏函數：會失敗（伺服器回 HTML 錯誤頁），且結果型別由伺服器決定。
    同一顆積木有時回 object 有時回 string 是災難，所以它必須是一顆
    看得見的積木。
    """
    s = await t.string(b, "text")
    try:
        return json.loads(s)
    except json.JSONDecodeError as e:
        preview = s[:60] + ("…" if len(s) > 60 else "")
        raise TypeCoercionError(
            f"這段文字不是合法的 JSON（第 {e.lineno} 行第 {e.colno} 字）",
            hint=f'開頭是："{preview}"' if preview else None,
        ) from None


@value("object.to_json")
async def _to_json(t: Thread, b: Block) -> str:
    """全函數：依 §4.3 任何值都轉得出來，沒有失敗模式。"""
    v = await t.value(b, "value")
    indent = 2 if t.field(b, "pretty", False) else None
    sep = None if indent else (",", ":")
    return json.dumps(v, ensure_ascii=False, indent=indent, separators=sep)

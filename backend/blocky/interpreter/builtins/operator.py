"""operator 命名空間：算術、比較、邏輯、字串（§4.4）。

**比較語意**（原設計文件未定義，這裡補上並進題庫）：

  eq / neq   不做型別轉換。型別不同即不相等，list / object 走深度比較。
             等同 JS 的 ===。不報錯，因為「這兩個東西一不一樣」對任何
             輸入都該有答案。
  lt/gt/lte/gte  兩邊都是數字 → 數值比較；兩邊都是文字 → 字典序比較；
             **型別混用 → 執行期錯誤**，訊息提示用「轉為數字」。

第二條刻意不學 Scratch 的「能轉數字就轉、否則比字串」。那個規則會讓
`"10" < "9"` 的答案取決於使用者看不見的嗅探結果，正是 §4.3 想避免的混亂。
"""

from __future__ import annotations

import math
import re
from typing import Any

from blocky.errors import BlockyError, TypeCoercionError
from blocky.interpreter.engine import Thread
from blocky.interpreter.registry import value
from blocky.ir.schema import Block
from blocky.ir.values import (
    TYPE_LABELS_ZH,
    TYPE_NUMBER,
    TYPE_STRING,
    normalize_index,
    to_boolean,
    to_number,
    to_string,
    type_of,
)

# --------------------------------------------------------------------------
# 算術
# --------------------------------------------------------------------------


async def _two_numbers(t: Thread, b: Block) -> tuple[Any, Any]:
    # §4.6：由左而右求值。副作用型 reporter 讓這個順序可觀察，所以它是語意。
    a = await t.number(b, "a", default=0)
    c = await t.number(b, "b", default=0)
    return a, c


@value("operator.add")
async def _add(t: Thread, b: Block) -> Any:
    a, c = await _two_numbers(t, b)
    return a + c


@value("operator.subtract")
async def _sub(t: Thread, b: Block) -> Any:
    a, c = await _two_numbers(t, b)
    return a - c


@value("operator.multiply")
async def _mul(t: Thread, b: Block) -> Any:
    a, c = await _two_numbers(t, b)
    return a * c


@value("operator.divide")
async def _div(t: Thread, b: Block) -> Any:
    a, c = await _two_numbers(t, b)
    if c == 0:
        raise BlockyError("不能除以 0")
    r = a / c
    # D15：語意層只有 double。`10 / 2` 應該是 5 而不是 5.0，
    # 但那由 js_number_to_string 負責呈現，這裡保持數值即可。
    return int(r) if isinstance(r, float) and r.is_integer() and abs(r) < 2**53 else r


@value("operator.mod")
async def _mod(t: Thread, b: Block) -> Any:
    a, c = await _two_numbers(t, b)
    if c == 0:
        raise BlockyError("不能對 0 取餘數")
    return math.fmod(a, c) if isinstance(a, float) or isinstance(c, float) else a % c


@value("operator.round")
async def _round(t: Thread, b: Block) -> Any:
    n = await t.number(b, "value", default=0)
    # JS 的 Math.round：.5 一律進位到較大值（Python 的 round 是銀行家捨入）
    return math.floor(n + 0.5)


_MATH_OPS = {
    "abs": abs,
    "floor": math.floor,
    "ceiling": math.ceil,
    "sqrt": math.sqrt,
    "sin": lambda x: math.sin(math.radians(x)),
    "cos": lambda x: math.cos(math.radians(x)),
    "tan": lambda x: math.tan(math.radians(x)),
    "ln": math.log,
    "log": math.log10,
    "e^": math.exp,
    "10^": lambda x: 10**x,
}


@value("operator.math_op")
async def _math_op(t: Thread, b: Block) -> Any:
    op = t.field(b, "op", "abs")
    fn = _MATH_OPS.get(op)
    if fn is None:
        raise BlockyError(f"未知的運算 {op}")
    n = await t.number(b, "value", default=0)
    try:
        return fn(n)
    except ValueError as e:
        raise BlockyError(f"{op} 算不出來：{e}") from None


# --------------------------------------------------------------------------
# 比較
# --------------------------------------------------------------------------


@value("operator.eq")
async def _eq(t: Thread, b: Block) -> bool:
    a = await t.value(b, "a")
    c = await t.value(b, "b")
    return _deep_eq(a, c)


@value("operator.neq")
async def _neq(t: Thread, b: Block) -> bool:
    a = await t.value(b, "a")
    c = await t.value(b, "b")
    return not _deep_eq(a, c)


def _deep_eq(a: Any, c: Any) -> bool:
    ta, tc = type_of(a), type_of(c)
    if ta != tc:
        return False
    # Python 的 == 對 list / dict 已是深度比較，且 5 == 5.0 為 True（D15 要的）
    return a == c


async def _ordered(t: Thread, b: Block) -> tuple[Any, Any]:
    a = await t.value(b, "a")
    c = await t.value(b, "b")
    ta, tc = type_of(a), type_of(c)
    if ta == tc == TYPE_NUMBER or ta == tc == TYPE_STRING:
        return a, c
    raise TypeCoercionError(
        f"不能比較{TYPE_LABELS_ZH[ta]}與{TYPE_LABELS_ZH[tc]}的大小",
        hint="請先用「轉為數字」把兩邊變成同一種型別",
    )


@value("operator.lt")
async def _lt(t: Thread, b: Block) -> bool:
    a, c = await _ordered(t, b)
    return a < c


@value("operator.gt")
async def _gt(t: Thread, b: Block) -> bool:
    a, c = await _ordered(t, b)
    return a > c


@value("operator.lte")
async def _lte(t: Thread, b: Block) -> bool:
    a, c = await _ordered(t, b)
    return a <= c


@value("operator.gte")
async def _gte(t: Thread, b: Block) -> bool:
    a, c = await _ordered(t, b)
    return a >= c


# --------------------------------------------------------------------------
# 邏輯。and / or 短路——右邊的 reporter 可以帶副作用，所以短路是語意。
# --------------------------------------------------------------------------


@value("operator.and")
async def _and(t: Thread, b: Block) -> bool:
    return bool(await t.boolean(b, "a") and await t.boolean(b, "b"))


@value("operator.or")
async def _or(t: Thread, b: Block) -> bool:
    return bool(await t.boolean(b, "a") or await t.boolean(b, "b"))


@value("operator.not")
async def _not(t: Thread, b: Block) -> bool:
    return not await t.boolean(b, "value")


# --------------------------------------------------------------------------
# 字串
# --------------------------------------------------------------------------


@value("operator.join")
async def _join(t: Thread, b: Block) -> str:
    return await t.string(b, "a") + await t.string(b, "b")


@value("operator.join_list")
async def _join_list(t: Thread, b: Block) -> str:
    items = await t.value(b, "list", default=[])
    sep = await t.string(b, "separator", default="")
    if type_of(items) != "list":
        raise BlockyError(f"「連接清單」需要清單，收到{TYPE_LABELS_ZH[type_of(items)]}")
    return sep.join(to_string(x) for x in items)


@value("operator.letter_of")
async def _letter_of(t: Thread, b: Block) -> str:
    s = await t.string(b, "text")
    idx = await t.value(b, "index", default=1)
    return s[normalize_index(idx, len(s))]


@value("operator.length")
async def _length(t: Thread, b: Block) -> int:
    return len(await t.string(b, "text"))


@value("operator.contains")
async def _contains(t: Thread, b: Block) -> bool:
    return await t.string(b, "b") in await t.string(b, "a")


@value("operator.substring")
async def _substring(t: Thread, b: Block) -> str:
    s = await t.string(b, "text")
    start = normalize_index(await t.value(b, "start", default=1), len(s) + 1)
    end = normalize_index(await t.value(b, "end", default=len(s)), len(s) + 1)
    return s[start : end + 1]


@value("operator.replace")
async def _replace(t: Thread, b: Block) -> str:
    return (await t.string(b, "text")).replace(
        await t.string(b, "find"), await t.string(b, "replace")
    )


@value("operator.split")
async def _split(t: Thread, b: Block) -> list[str]:
    s = await t.string(b, "text")
    sep = await t.string(b, "separator", default=",")
    return list(s) if sep == "" else s.split(sep)


@value("operator.trim")
async def _trim(t: Thread, b: Block) -> str:
    return (await t.string(b, "text")).strip()


@value("operator.case")
async def _case(t: Thread, b: Block) -> str:
    s = await t.string(b, "text")
    return s.upper() if t.field(b, "case", "upper") == "upper" else s.lower()


@value("operator.regex_match")
async def _regex_match(t: Thread, b: Block) -> bool:
    return _search(await t.string(b, "pattern"), await t.string(b, "text")) is not None


@value("operator.regex_extract")
async def _regex_extract(t: Thread, b: Block) -> Any:
    """回第一個符合的內容；有群組時回群組清單。找不到回空字串。"""
    m = _search(await t.string(b, "pattern"), await t.string(b, "text"))
    if m is None:
        return ""
    return list(m.groups()) if m.groups() else m.group(0)


@value("operator.regex_replace")
async def _regex_replace(t: Thread, b: Block) -> str:
    pattern = await t.string(b, "pattern")
    text = await t.string(b, "text")
    repl = await t.string(b, "replace")
    try:
        return re.sub(pattern, repl.replace("\\", "\\\\"), text)
    except re.error as e:
        raise BlockyError(f"正規表達式有問題：{e}") from None


def _search(pattern: str, text: str) -> re.Match | None:
    try:
        return re.search(pattern, text)
    except re.error as e:
        raise BlockyError(f"正規表達式有問題：{e}") from None


@value("operator.random")
async def _random(t: Thread, b: Block) -> Any:
    import random

    lo = await t.number(b, "from", default=1)
    hi = await t.number(b, "to", default=10)
    if isinstance(lo, int) and isinstance(hi, int):
        return random.randint(min(lo, hi), max(lo, hi))
    return random.uniform(min(lo, hi), max(lo, hi))

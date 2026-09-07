"""operator 命名空間：算術、比較、邏輯、字串（§4.4）。

**比較語意**（原設計文件未定義，這裡補上並進題庫）：

  eq         `=` 不做型別轉換：型別不同即不相等，list / object 走深度比較，
             等同 JS 的 ===。
  approx     `≈` 走 `_approx_eq` 的四條規則。
  neq        `fields.op` 選 `exact`（≠，預設）或 `approx`（≉）。
  lt/gt/lte/gte  比較方式寫在積木上（D24 的同一招）：`fields.mode` 選 `number`
             （預設）時兩邊 `to_number`，轉不動即錯；選 `text` 時兩邊
             `to_string` 後比字典序。`null` / list / object 兩種模式都不能
             比大小。

轉換照做，但**是哪一種轉換寫在積木上**，這與 Scratch 的「能轉數字就轉、否則
比字串」是兩件事：那個規則會讓 `"10" < "9"` 的答案取決於使用者看不見的嗅探
結果，而 `mode` 存得進 IR、讀得出來、diff 得出來。`≈` 同理——選了 `≈` 的人
知道自己選了什麼，而嗅探沒有給任何人這個機會。
"""

from __future__ import annotations

import math
import re
from typing import Any

from blockyard.errors import BlockyardError, TypeCoercionError
from blockyard.interpreter.engine import Thread
from blockyard.interpreter.registry import value
from blockyard.ir.schema import Block
from blockyard.ir.values import (
    TYPE_BOOLEAN,
    TYPE_LABELS_ZH,
    TYPE_LIST,
    TYPE_NULL,
    TYPE_NUMBER,
    TYPE_OBJECT,
    TYPE_STRING,
    divide,
    modulo,
    normalize_index,
    to_number,
    to_string,
    type_of,
)

# --------------------------------------------------------------------------
# 算術
# --------------------------------------------------------------------------


@value("operator.expr")
async def _expr(t: Thread, b: Block) -> Any:
    """`運算 (${a} * 2 / 4 + 1)`（§4.7b）。

    解析在載入期就做完了（`ir/schema.py::load`），這裡只是求值——所以語法錯誤
    是 422 而不是執行到才炸的紅框。
    """
    return t.expression(b, "expr")


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
    # 語意與 §4.7b 運算式裡的 `/` **共用一份實作**（`ir/values.py`）：同一個
    # 算式在積木與運算式裡給出不同答案，是使用者永遠查不出來的錯。
    return divide(a, c)


@value("operator.mod")
async def _mod(t: Thread, b: Block) -> Any:
    a, c = await _two_numbers(t, b)
    return modulo(a, c)  # 與運算式的 `%` 共用一份實作，見 _div


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
        raise BlockyardError(f"未知的運算 {op}")
    n = await t.number(b, "value", default=0)
    try:
        return fn(n)
    except ValueError as e:
        raise BlockyardError(f"{op} 算不出來：{e}") from None


# --------------------------------------------------------------------------
# 比較
# --------------------------------------------------------------------------


@value("operator.eq")
async def _eq(t: Thread, b: Block) -> bool:
    a = await t.value(b, "a")
    c = await t.value(b, "b")
    return _deep_eq(a, c)


@value("operator.approx")
async def _approx(t: Thread, b: Block) -> bool:
    a = await t.value(b, "a")
    c = await t.value(b, "b")
    return _approx_eq(a, c)


@value("operator.neq")
async def _neq(t: Thread, b: Block) -> bool:
    a = await t.value(b, "a")
    c = await t.value(b, "b")
    return not _compare(t.field(b, "op", _EXACT), a, c)


#: `fields.op` 的兩個值（D24）。**選填**：省略即 `exact`，理由同 `mode`（見 `_BY_NUMBER`）。
_EXACT = "exact"
_APPROX = "approx"

#: 相對誤差，等同 Python `math.isclose` 的預設。**沒有絕對下限是刻意的**：
#: 給了下限，任何極小值都會約等於 0，而「算出來幾乎是 0」與「就是 0」在工作流
#: 裡是兩件事。所以 `0 ≈ x` 只在 x 也是 0 時為真。
_APPROX_REL_TOL = 1e-9


def _compare(op: Any, a: Any, c: Any) -> bool:
    if op == _APPROX:
        return _approx_eq(a, c)
    if op not in (_EXACT, None, ""):
        raise BlockyardError(f"未知的比較方式 {op}")
    return _deep_eq(a, c)


def _deep_eq(a: Any, c: Any) -> bool:
    ta, tc = type_of(a), type_of(c)
    if ta != tc:
        return False
    # Python 的 == 對 list / dict 已是深度比較，且 5 == 5.0 為 True（D15 要的）
    return a == c


def _approx_eq(a: Any, c: Any) -> bool:
    """`≈`（D24、§4.4.1）：四條規則依序試，第一條命中就是答案。"""
    ta, tc = type_of(a), type_of(c)

    # 1. null / list / object 一律走 `=`。
    #
    #    §4.3 的轉換表說 `null → number` 是 0、`null → string` 是 ""，照它做
    #    的話「這個欄位 API 沒有回」會約等於「這個欄位是 0」。寬鬆比對可以少
    #    問一個型別，不能少問一次「有沒有值」。
    #
    #    容器不遞迴是同一種收斂：`["a "] ≈ ["a"]` 為假。要那個語意就是要定義
    #    「集合的寬鬆相等」，而那是一顆自己的積木，不是一個下拉選項。
    loose = {TYPE_NUMBER, TYPE_STRING, TYPE_BOOLEAN}
    if ta not in loose or tc not in loose:
        return _deep_eq(a, c)

    # 2. 同型別：文字與數字各自放寬，布林直接比。
    if ta == tc:
        if ta == TYPE_STRING:
            return _fold(a) == _fold(c)
        if ta == TYPE_NUMBER:
            return math.isclose(a, c, rel_tol=_APPROX_REL_TOL)
        return a == c

    # 3. 跨型別而兩邊都是數字（`true` → 1、`" 5 "` → 5）。
    na, nc = _as_number(a), _as_number(c)
    if na is not None and nc is not None:
        return math.isclose(na, nc, rel_tol=_APPROX_REL_TOL)

    # 4. 其餘走文字：`true ≈ "TRUE"` 在這裡為真，`false ≈ ""` 在這裡為假。
    return _fold(to_string(a)) == _fold(to_string(c))


def _fold(s: str) -> str:
    """去頭尾空白 + 不分大小寫。`strip()` 也吃得掉全形空白（U+3000）。"""
    return s.strip().casefold()


def _as_number(v: Any) -> int | float | None:
    """`to_number` 的不丟例外版本；不能轉就回 None 讓規則 4 接手。

    **空字串在這裡不是 0**，儘管 §4.3 的 `to_number("")` 是 0。理由與規則 1
    把 `null` 擋掉是同一條：一格沒填的欄位不該約等於數字 0。差別只在 `null`
    連規則 4 都不走（它連 `""` 都不約等於），而空字串走得到——所以
    `"" ≈ ""` 仍然為真，`"" ≈ 0` 為假。
    """
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str) and v.strip() == "":
        return None
    try:
        return to_number(v)
    except BlockyardError:
        return None


#: `fields.mode` 的兩個值（D27）。**選填**：省略即 `number`。那不是給舊專案的
#: 相容層——這個專案還在測試期，一份既有專案都沒有——而是 D5：IR 要手寫得
#: 出來、AI 生成得出來，而那兩種來源多半只寫最少的欄位。
_BY_NUMBER = "number"
_BY_TEXT = "text"

#: 兩種模式都不能比大小的型別。理由與 `≈` 的規則 1 是同一條：「有沒有值」不是
#: 「誰比較大」。§4.3 的 `to_number(null)` 是 0，照它做的話「這個欄位 API 沒有
#: 回」會變成「這個欄位不大於 0」——一個看起來成功的錯誤答案。容器同理，
#: `to_string` 對 list / object 給的是 JSON 文字，比它的字典序沒有任何意義。
_UNORDERABLE = {TYPE_NULL, TYPE_LIST, TYPE_OBJECT}


async def _ordered(t: Thread, b: Block) -> tuple[Any, Any]:
    a = await t.value(b, "a")
    c = await t.value(b, "b")
    mode = t.field(b, "mode", _BY_NUMBER)
    if mode not in (_BY_NUMBER, _BY_TEXT, None, ""):
        raise BlockyardError(f"未知的比較方式 {mode}")

    bid = t.interp._bid(b)
    for v in (a, c):
        tv = type_of(v)
        if tv in _UNORDERABLE:
            raise TypeCoercionError(
                f"不能比較{TYPE_LABELS_ZH[tv]}的大小",
                block_id=bid,
                hint="清單的長度用「清單的長度」；沒有值的情況請先用「如果」擋掉",
            )

    if mode == _BY_TEXT:
        # `to_string` 是全函數（§4.3），所以文字模式沒有失敗模式——`真` 比得了
        # 大小，值是 "true"。選了「照文字比」的人要的就是這個。
        return to_string(a, block_id=bid), to_string(c, block_id=bid)
    # 轉不動的文字在這裡報錯，訊息由 `to_number` 給（含「轉為數字，失敗時 ()」）。
    return to_number(a, block_id=bid), to_number(c, block_id=bid)


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


@value("operator.true")
async def _true(t: Thread, b: Block) -> bool:
    """`真`。六角形孔沒有影子（§8.1），所以常數布林需要自己的積木。"""
    return True


@value("operator.false")
async def _false(t: Thread, b: Block) -> bool:
    """`假`。與 `真` 成對——只有一顆的話另一半得寫成 `不成立 (真)`。"""
    return False


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
        raise BlockyardError(f"「連接清單」需要清單，收到{TYPE_LABELS_ZH[type_of(items)]}")
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
        raise BlockyardError(f"正規表達式有問題：{e}") from None


def _search(pattern: str, text: str) -> re.Match | None:
    try:
        return re.search(pattern, text)
    except re.error as e:
        raise BlockyardError(f"正規表達式有問題：{e}") from None


@value("operator.random")
async def _random(t: Thread, b: Block) -> Any:
    import random

    lo = await t.number(b, "from", default=1)
    hi = await t.number(b, "to", default=10)
    if isinstance(lo, int) and isinstance(hi, int):
        return random.randint(min(lo, hi), max(lo, hi))
    return random.uniform(min(lo, hi), max(lo, hi))

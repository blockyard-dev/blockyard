"""值模型與型別轉換（§4.3、D15）。

支援型別：null / boolean / number / string / list / object。

D15：語意層只有一種數字型別（IEEE754 double）。Python 內部可以是 int 或
float，但那是實作細節，不得洩漏到任何可觀察的行為——因此字串化一律走
`js_number_to_string`，而不是 Python 的 str()。
"""

from __future__ import annotations

import json
import math
from decimal import Decimal
from typing import Any

from blockyard.errors import BadIndexError, BlockyardError, KeyMissingError, TypeCoercionError

# 語意型別名稱。刻意與 JS 的 typeof 不同：list 與 object 分開、null 獨立（§4.8）。
TYPE_NULL = "null"
TYPE_BOOLEAN = "boolean"
TYPE_NUMBER = "number"
TYPE_STRING = "string"
TYPE_LIST = "list"
TYPE_OBJECT = "object"

ALL_TYPES = (TYPE_NULL, TYPE_BOOLEAN, TYPE_NUMBER, TYPE_STRING, TYPE_LIST, TYPE_OBJECT)

# 積木下拉顯示的中文名 ↔ 內部型別名
TYPE_LABELS_ZH = {
    TYPE_NULL: "空值",
    TYPE_BOOLEAN: "布林",
    TYPE_NUMBER: "數字",
    TYPE_STRING: "文字",
    TYPE_LIST: "清單",
    TYPE_OBJECT: "物件",
}

MAX_SAFE_INTEGER = 2**53 - 1


# --------------------------------------------------------------------------
# 型別判定
# --------------------------------------------------------------------------


def type_of(v: Any) -> str:
    """§4.8 `type.of`。回傳語意型別名。

    注意兩個違反 JS 直覺的地方（設計文件要求寫死）：
    - list 與 object 是不同型別，`type_of([])` 是 "list" 不是 "object"
    - null 是獨立型別，`type_of(None)` 是 "null" 不是 "object"
    """
    if v is None:
        return TYPE_NULL
    # bool 必須在 int 之前檢查——Python 的 bool 是 int 的子類別
    if isinstance(v, bool):
        return TYPE_BOOLEAN
    if isinstance(v, (int, float)):
        return TYPE_NUMBER
    if isinstance(v, str):
        return TYPE_STRING
    if isinstance(v, list):
        return TYPE_LIST
    if isinstance(v, dict):
        return TYPE_OBJECT
    raise TypeCoercionError(f"不支援的值型別：{type(v).__name__}")


def is_type(v: Any, t: str) -> bool:
    """§4.8 `type.is` — 問的是**實際型別**。`is_type("123", "number")` 為 False。"""
    return type_of(v) == t


# --------------------------------------------------------------------------
# 數字字串化（D15）
# --------------------------------------------------------------------------


def js_number_to_string(x: int | float) -> str:
    """依 JS `Number.prototype.toString(10)` 的規則把數字轉字串。

    釘死在這個演算法上，是為了讓未來任何第二套 runtime 都能對齊同一份題庫。
    與 Python 的 str() 有幾個關鍵差異：

        5.0        Python "5.0"    JS "5"
        1e-7       Python "1e-07"  JS "1e-7"
        1e21       Python "1e+21"  JS "1e+21"
        0.1+0.2    兩者皆 "0.30000000000000004"
    """
    if isinstance(x, bool):  # 防呆：bool 不該走到這裡
        raise TypeCoercionError("bool 不是 number")

    if isinstance(x, int):
        # 整數在 JS 的表示範圍內時直接輸出，避免轉 float 損失精度
        if abs(x) < 10**21:
            return str(x)
        x = float(x)

    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0"  # -0 也輸出 "0"，與 JS 一致

    sign = "-" if x < 0 else ""
    digits, n = _shortest_decimal(abs(x))
    k = len(digits)

    # 以下四條分支直接對應 ECMA-262 Number::toString 的規格
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        mantissa = digits if k == 1 else digits[0] + "." + digits[1:]
        e = n - 1
        body = f"{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"

    return sign + body


def _shortest_decimal(x: float) -> tuple[str, int]:
    """回傳 (digits, n)，使得 x == 0.digits × 10^n。

    借用 Python 的 repr——它產生的是能 round-trip 的最短十進位表示，
    與 JS 的 ToString 用的是同一種「最短且唯一」的性質。
    """
    sign, digit_tuple, exp = Decimal(repr(x)).as_tuple()
    full = "".join(map(str, digit_tuple))
    n = len(full) + exp  # 見上式推導：值 = full × 10^exp = 0.full × 10^(len+exp)
    return full.rstrip("0") or "0", n


# --------------------------------------------------------------------------
# 轉換（§4.3 的三張表）
# --------------------------------------------------------------------------


def to_string(v: Any, *, block_id: str | None = None) -> str:
    """→ string。這是全函數：任何值都轉得出來，沒有失敗模式（§4.8）。"""
    t = type_of(v)
    if t == TYPE_STRING:
        return v
    if t == TYPE_NULL:
        return ""
    if t == TYPE_BOOLEAN:
        return "true" if v else "false"
    if t == TYPE_NUMBER:
        return js_number_to_string(v)
    # list / object 以 JSON 序列化。ensure_ascii=False 讓中文保持可讀。
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"), default=_json_default)


def _json_default(o: Any) -> Any:
    raise TypeCoercionError(f"無法序列化的值：{type(o).__name__}")


# --------------------------------------------------------------------------
# 算術
# --------------------------------------------------------------------------
#
# 除法與取餘數放在這裡而不是 handler 裡，是因為它們有**兩個**呼叫端：
# `operator.divide` / `operator.mod` 那兩顆積木，以及 §4.7b 的運算積木裡的
# `/` 與 `%`。同一個算式在兩個地方給出不同答案（`-7 % 2`、`10 / 0`）是使用者
# 永遠查不出來的錯，所以語意只准有一份。


def divide(a: int | float, b: int | float, *, block_id: str | None = None) -> int | float:
    """`a / b`。除以 0 是錯誤，不是 Infinity（§4.3）。"""
    if b == 0:
        raise BlockyardError("不能除以 0", block_id=block_id)
    r = a / b
    # D15：語意層只有 double。`10 / 2` 應該是 5 而不是 5.0，但那由
    # js_number_to_string 負責呈現，這裡保持數值即可。
    return int(r) if isinstance(r, float) and r.is_integer() and abs(r) < 2**53 else r


def modulo(a: int | float, b: int | float, *, block_id: str | None = None) -> int | float:
    """`a % b`。浮點走 fmod（取號跟著被除數，與 JS 一致）。"""
    if b == 0:
        raise BlockyardError("不能對 0 取餘數", block_id=block_id)
    return math.fmod(a, b) if isinstance(a, float) or isinstance(b, float) else a % b


def to_number(v: Any, *, block_id: str | None = None) -> int | float:
    """→ number。偏函數：list / object 與非數字字串會失敗。"""
    t = type_of(v)
    if t == TYPE_NUMBER:
        return v
    if t == TYPE_NULL:
        return 0
    if t == TYPE_BOOLEAN:
        return 1 if v else 0
    if t == TYPE_STRING:
        parsed = _parse_number(v)
        if parsed is None:
            raise TypeCoercionError(
                f'無法把文字 "{_truncate(v)}" 轉成數字',
                block_id=block_id,
                hint="需要容錯的話用「轉為數字，失敗時 ()」",
            )
        return parsed
    raise TypeCoercionError(
        f"{TYPE_LABELS_ZH[t]}不能轉成數字",
        block_id=block_id,
        hint="想知道長度請用「清單的長度」" if t == TYPE_LIST else None,
    )


def _parse_number(s: str) -> int | float | None:
    """字串 → 數字。空字串視為 0（與 JS 一致），前後空白允許。"""
    s = s.strip()
    if s == "":
        return 0
    try:
        # 先試整數，保住大整數的精度
        return int(s, 10)
    except ValueError:
        pass
    try:
        f = float(s)
    except ValueError:
        return None
    # "nan" / "inf" 這類字串不該被當成合法數字輸入
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def to_boolean(v: Any) -> bool:
    """→ boolean。falsy 集合：false / 0 / "" / null / [] / {}（§4.3）。

    注意這與 `is_empty` **刻意不一致**：0 是 falsy，但 0 不是「空的」。
    """
    t = type_of(v)
    if t == TYPE_BOOLEAN:
        return v
    if t == TYPE_NULL:
        return False
    if t == TYPE_NUMBER:
        return v != 0 and not (isinstance(v, float) and math.isnan(v))
    if t == TYPE_STRING:
        return v != ""
    return len(v) > 0  # list / object


def is_empty(v: Any) -> bool:
    """§4.8 `type.is_empty`。"" [] {} null → True；**0 → False**。

    這條刻意的不一致是為了讓「數字 0 不是空的」符合直覺。若與 to_boolean
    共用，使用者就只能寫 `not (值)`，然後被 0 咬。
    """
    t = type_of(v)
    if t == TYPE_NULL:
        return True
    if t in (TYPE_STRING, TYPE_LIST, TYPE_OBJECT):
        return len(v) == 0
    return False  # number（含 0）與 boolean 都不是「空的」


def can_cast(v: Any, t: str) -> bool:
    """§4.8 `type.can_cast` — 問的是**可轉換性**。`can_cast("123", "number")` 為 True。"""
    if t == TYPE_NUMBER:
        try:
            to_number(v)
            return True
        except TypeCoercionError:
            return False
    if t in (TYPE_STRING, TYPE_BOOLEAN):
        return True  # 兩者都是全函數
    # 清單／物件不能由其他型別「轉換」而來——那只可能是 JSON parse，
    # 而 parse 必須是一顆看得見的積木（D10）。
    return is_type(v, t)


def cast(v: Any, t: str, *, block_id: str | None = None) -> Any:
    """§4.8 `type.cast`。失敗即錯誤，維持 §4.3「不靜默吞掉」的原則。"""
    if t == TYPE_NUMBER:
        return to_number(v, block_id=block_id)
    if t == TYPE_STRING:
        return to_string(v, block_id=block_id)
    if t == TYPE_BOOLEAN:
        return to_boolean(v)
    raise TypeCoercionError(
        f"不能轉成{TYPE_LABELS_ZH.get(t, t)}",
        block_id=block_id,
        hint="把文字變成物件只可能是 JSON 解析，請用「解析 JSON」積木",
    )


# --------------------------------------------------------------------------
# 索引與取值（§4.3 索引規則）
# --------------------------------------------------------------------------


def normalize_index(idx: Any, length: int, *, block_id: str | None = None) -> int:
    """把積木／`${}` 的索引轉成 Python 的 0-based 下標。

    這是**索引基底轉換唯一存在的地方**（§10 對 `_path` 的同一條要求）。
    散開來就會長出 off-by-one 的鬼故事。
    """
    if isinstance(idx, str):
        if idx == "last":
            if length == 0:
                raise BadIndexError("清單是空的，沒有最後一項", block_id=block_id)
            return length - 1
        n = _parse_number(idx)
        if n is None:
            raise BadIndexError(f'索引必須是數字或 "last"，收到 "{_truncate(idx)}"', block_id=block_id)
        idx = n

    if isinstance(idx, bool) or not isinstance(idx, (int, float)):
        raise BadIndexError(
            f"索引必須是數字，收到{TYPE_LABELS_ZH[type_of(idx)]}", block_id=block_id
        )

    # 1.0 合法且等同 1；1.5 不合法（D15）
    if isinstance(idx, float):
        if not idx.is_integer():
            raise BadIndexError(
                f"索引必須是整數，收到 {js_number_to_string(idx)}", block_id=block_id
            )
        idx = int(idx)

    if idx == 0:
        raise BadIndexError(
            "索引從 1 開始，沒有第 0 項",
            block_id=block_id,
            hint="你是不是要 1？",
        )

    pos = idx - 1 if idx > 0 else length + idx  # 負數為倒數，與 Python 直覺一致

    if pos < 0 or pos >= length:
        raise BadIndexError(
            f"索引 {js_number_to_string(idx)} 超出範圍，清單長度為 {length}",
            block_id=block_id,
        )
    return pos


def list_item(lst: list, idx: Any, *, block_id: str | None = None) -> Any:
    """1-based 取值。越界是錯誤，不回 null（§4.3）。"""
    return lst[normalize_index(idx, len(lst), block_id=block_id)]


def object_get(obj: dict, key: str, *, block_id: str | None = None) -> Any:
    """key 不存在是錯誤，不是 null（§4.3）。要容錯用 has 或 get 的預設值孔。"""
    if key not in obj:
        raise KeyMissingError(
            f'物件沒有 "{key}" 這個欄位',
            block_id=block_id,
            params={"key": key},
            hint=_did_you_mean(key, list(obj.keys())),
        )
    return obj[key]


# --------------------------------------------------------------------------
# 編輯距離建議（§4.5、§4.7 都要用）
# --------------------------------------------------------------------------


def _did_you_mean(name: str, candidates: list[str], *, max_distance: int = 2) -> str | None:
    """回「你是不是要 X？」。

    §4.7 說這句錯誤訊息是整份設計裡投入產出比最高的一行字，所以它有自己的函式，
    而且被變數查找、object key、下拉選項三處共用。
    """
    if not candidates:
        return None
    best, best_d = None, max_distance + 1
    for c in candidates:
        d = _levenshtein(name.lower(), c.lower(), cutoff=best_d)
        if d < best_d:
            best, best_d = c, d
    return f'你是不是要 "{best}"？' if best is not None else None


def _levenshtein(a: str, b: str, *, cutoff: int) -> int:
    """標準 DP，帶提前放棄。名稱通常很短，不值得引入依賴。"""
    if abs(len(a) - len(b)) >= cutoff:
        return cutoff
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) >= cutoff:
            return cutoff
        prev = cur
    return prev[-1]


def _truncate(s: str, limit: int = 40) -> str:
    return s if len(s) <= limit else s[:limit] + "…"

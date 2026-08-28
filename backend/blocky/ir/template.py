"""字串插值 `${...}` 的解析與求值（§4.7）。

核心限制（D9）：**`${}` 內只能是「路徑」，永遠不是「運算式」。**

`${a + b}`、`${count * 2}`、`${x ? y : z}`、`${upper(name)}` 一律是解析錯誤，
而且是**存檔期**的錯誤，不是執行期。這條線要守得很硬：一旦允許算術，下一步
就是函式呼叫、就是三元運算子，`${}` 會滑成一套藏在文字框裡的迷你語言。

解析結果是 Template；`refs` 是**衍生欄位**（§4.7），載入時一律重新解析，
IR 裡的版本只用於驗證。
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from blocky.errors import BlockyError, TemplateError, ValidationError
from blocky.ir.values import (
    TYPE_LABELS_ZH,
    TYPE_LIST,
    TYPE_OBJECT,
    TYPE_STRING,
    _did_you_mean,
    list_item,
    object_get,
    to_string,
    type_of,
)

# 變數名稱只禁掉會讓路徑無法解析的字元（§4.7）。
# 中文、空格、底線一律允許；`+ - * /` 不禁——它們會在下面被判為運算式，
# 那個錯誤訊息比「不給你打」清楚得多。
NAME_FORBIDDEN = set(".[]{}$")

# 出現在 `${}` 內即判定為運算式的字元。
_EXPRESSION_CHARS = set("+-*/%=<>!&|?:(),~^\"'`")

_INDEX_RE = re.compile(r"^-?\d+$")


@dataclass(frozen=True)
class Ref:
    """一個 `${}` 路徑。root 是變數名，path 是後續的取值鏈。

    path 元素的型別即語意：
        int  → list 索引（來自 `[...]`），1-based，負數為倒數
        str  → object key（來自 `.`）
    `[last]` 在解析時就 desugar 成 -1，因此不需要第三種表示。
    """

    root: str
    path: tuple[int | str, ...] = ()
    # 這段插值在原字串中的位置，錯誤訊息用來指出「第幾段」
    start: int = 0
    end: int = 0

    def to_ir(self) -> dict[str, Any]:
        return {"root": self.root, "path": list(self.path)}

    def display(self) -> str:
        out = self.root
        for p in self.path:
            out += f"[{p}]" if isinstance(p, int) else f".{p}"
        return out


@dataclass
class Template:
    """解析後的插值字串。"""

    value: str
    segments: tuple[str | Ref, ...]
    whole: bool
    refs: tuple[Ref, ...] = field(default_factory=tuple)

    def to_ir(self) -> dict[str, Any]:
        return {
            "kind": "template",
            "value": self.value,
            "refs": [r.to_ir() for r in self.refs],
            "whole": self.whole,
        }

    @property
    def roots(self) -> set[str]:
        """§4.5 靜態檢查直接吃這個，驗證每個 root 是否曾被 data.set。"""
        return {r.root for r in self.refs}


def has_interpolation(s: str) -> bool:
    """字串裡有沒有需要解析的 `${`。

    解譯器**不掃描 literal 找 `${`**（§4.7）——那會讓正當寫著 `${HOME}` 的
    shell 指令被偷偷替換。這個函式只在**存檔時**用來決定 kind 該是
    literal 還是 template。
    """
    i = 0
    while (i := s.find("$", i)) != -1:
        if s.startswith("$${", i):
            i += 3
        elif s.startswith("${", i):
            return True
        else:
            i += 1
    return False


def parse(s: str, *, block_id: str | None = None, input_name: str | None = None) -> Template:
    """解析插值字串。運算式與未閉合的括號都在這裡變成 ValidationError。"""
    segments: list[str | Ref] = []
    buf: list[str] = []
    i, n = 0, len(s)

    def flush() -> None:
        if buf:
            segments.append("".join(buf))
            buf.clear()

    while i < n:
        c = s[i]
        if c != "$":
            buf.append(c)
            i += 1
            continue

        if s.startswith("$${", i):
            buf.append("${")  # 逸出：輸出字面的 ${
            i += 3
            continue

        if not s.startswith("${", i):
            buf.append("$")  # 其餘 $ 一律字面，不需逸出
            i += 1
            continue

        close = s.find("}", i + 2)
        if close == -1:
            raise ValidationError(
                "「${」沒有對應的「}」",
                block_id=block_id,
                path=input_name,
            )
        inner = s[i + 2 : close]
        flush()
        segments.append(parse_path(inner, i, close + 1, block_id=block_id, input_name=input_name))
        i = close + 1

    flush()

    refs = tuple(x for x in segments if isinstance(x, Ref))
    # §4.7 整格取值：恰好只有一個插值、沒有其他文字 → 回傳原值，保留型別
    whole = len(segments) == 1 and isinstance(segments[0], Ref)
    return Template(value=s, segments=tuple(segments), whole=whole, refs=refs)


def parse_path(
    inner: str, start: int, end: int, *, block_id: str | None, input_name: str | None
) -> Ref:
    """`${…}` 的內容 → 一個 Ref。

    **`expression.py` 共用這一個函式**，所以 `${a.b[1]}` 在運算式裡與在字串裡
    是同一件事——路徑語意只有一份實作，D9 的運算式防線也只有一道。
    """
    raw = inner.strip()
    if raw == "":
        raise ValidationError("「${}」是空的", block_id=block_id, path=input_name)

    tokens = _tokenize_path(raw, block_id=block_id, input_name=input_name)

    # --- 這裡是 D9 的防線 ---
    # 只檢查「名稱」片段。`[...]` 內容已由 _parse_index 嚴格驗證（只收整數與
    # last），所以 `items[-1]` 的負號不會被誤判成減法。
    for tok in tokens:
        if not isinstance(tok, str):
            continue
        bad = _EXPRESSION_CHARS & set(tok)
        if bad:
            raise ValidationError(
                f"「${{}}」內不支援運算（出現了 {' '.join(sorted(bad))}），請改用「運算」積木",
                block_id=block_id,
                path=input_name,
            )

    root, rest = tokens[0], tokens[1:]

    if not isinstance(root, str):
        raise ValidationError("「${}」必須以變數名稱開頭", block_id=block_id, path=input_name)
    if root == "":
        raise ValidationError("「${}」內的變數名稱是空的", block_id=block_id, path=input_name)

    return Ref(root=root, path=tuple(rest), start=start, end=end)


def _tokenize_path(
    raw: str, *, block_id: str | None, input_name: str | None
) -> list[int | str]:
    """把 `resp.items[1].title` 切成 ['resp', 'items', 1, 'title']。"""
    out: list[int | str] = []
    buf: list[str] = []
    i, n = 0, len(raw)

    def flush_name() -> None:
        out.append("".join(buf).strip())
        buf.clear()

    while i < n:
        c = raw[i]
        if c == ".":
            flush_name()
            i += 1
        elif c == "[":
            flush_name()
            close = raw.find("]", i)
            if close == -1:
                raise ValidationError(
                    "「[」沒有對應的「]」", block_id=block_id, path=input_name
                )
            token = raw[i + 1 : close].strip()
            out.append(_parse_index(token, block_id=block_id, input_name=input_name))
            i = close + 1
            # `[1].title` 的 `.` 由上面的分支處理；`[1][2]` 也可以
            if i < n and raw[i] == ".":
                i += 1
        elif c == "]":
            raise ValidationError("多餘的「]」", block_id=block_id, path=input_name)
        else:
            buf.append(c)
            i += 1

    if buf or not out:
        flush_name()
    # 去掉因 `a.` 或 `a[1]` 結尾產生的空片段
    return [t for t in out if t != ""] or [""]


def _parse_index(token: str, *, block_id: str | None, input_name: str | None) -> int:
    """`[...]` 內只接受整數與 `last`。`last` desugar 成 -1。"""
    if token == "last":
        return -1
    if _INDEX_RE.match(token):
        return int(token)
    raise ValidationError(
        f'「[]」內只能是整數或 last，收到 "{token}"',
        block_id=block_id,
        path=input_name,
    )


# --------------------------------------------------------------------------
# 求值
# --------------------------------------------------------------------------

# 名稱解析器：吃變數名，回值。找不到時自己拋 UndefinedVariableError（§5.4）。
Resolver = Callable[[str], Any]


def evaluate(
    tpl: Template,
    resolve: Resolver,
    *,
    block_id: str | None = None,
) -> Any:
    """求值。整格取值回原值（保留型別），否則各段轉字串後拼接（§4.7）。"""
    if tpl.whole:
        ref = tpl.segments[0]
        assert isinstance(ref, Ref)
        return resolve_ref(ref, resolve, block_id=block_id)

    parts: list[str] = []
    for seg in tpl.segments:
        if isinstance(seg, str):
            parts.append(seg)
        else:
            parts.append(to_string(resolve_ref(seg, resolve, block_id=block_id)))
    return "".join(parts)


def resolve_ref(ref: Ref, resolve: Resolver, *, block_id: str | None) -> Any:
    """走完一條路徑。`expression.py` 共用（見 `parse_path`）。"""
    cur = resolve(ref.root)  # 找不到時由 resolver 拋出，訊息含編輯距離建議
    walked = ref.root

    for step in ref.path:
        t = type_of(cur)
        if isinstance(step, int):
            if t != TYPE_LIST:
                raise TemplateError(
                    f"{walked} 是{TYPE_LABELS_ZH[t]}，不能用 [] 取值",
                    block_id=block_id,
                    hint=_parse_json_hint(t),
                )
            cur = list_item(cur, step, block_id=block_id)
            walked += f"[{step}]"
        else:
            if t != TYPE_OBJECT:
                # 這句訊息 §4.7 說是「整份設計裡投入產出比最高的一行字」，
                # 它同時服務 object.get 誤用的場景。
                raise TemplateError(
                    f"{walked} 是{TYPE_LABELS_ZH[t]}不是物件，不能取 .{step}",
                    block_id=block_id,
                    hint=_parse_json_hint(t),
                )
            cur = object_get(cur, step, block_id=block_id)
            walked += f".{step}"

    return cur


def _parse_json_hint(t: str) -> str | None:
    if t == TYPE_STRING:
        return "是不是需要先用「解析 JSON」？"
    return None


def suggest_name(name: str, known: list[str]) -> str | None:
    """給 resolver 用的「你是不是要 X？」。"""
    return _did_you_mean(name, known)


def validate_name(name: str) -> None:
    """§4.7 / §8.5 變數名稱欄位的限制。只禁會讓路徑無法解析的字元。"""
    if name != name.strip():
        raise ValidationError(f'變數名稱前後不能有空白："{name}"')
    if name == "":
        raise ValidationError("變數名稱不能是空的")
    bad = NAME_FORBIDDEN & set(name)
    if bad:
        raise ValidationError(f"變數名稱不能包含 {' '.join(sorted(bad))}：\"{name}\"")


__all__ = [
    "Ref",
    "Template",
    "BlockyError",
    "evaluate",
    "has_interpolation",
    "parse",
    # expression.py 共用：路徑的解析與求值只有一份實作
    "parse_path",
    "resolve_ref",
    "suggest_name",
    "validate_name",
]

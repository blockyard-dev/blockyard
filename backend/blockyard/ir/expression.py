"""運算積木的運算式（§4.7b、D23）。

一顆積木、一個欄位、一套只有算術的文法：

    ${帳單.金額} * 2 / 4 + 1

**這不是 D9 的破口。** §4.7 那條硬線守的是**字串欄位**——使用者在那裡寫
Discord 訊息、URL、shell 指令，一旦那些地方能算數學，`${}` 就變成藏在文字框裡
的迷你語言。這裡的欄位不是字串欄位，它的型別叫 `expression`，唯一的用途就是
算術，而且在畫布上看得出來自己在算東西。線沒有移動；移動的是「請改用積木」
那句錯誤訊息——它終於有了去處。三層巢狀的 reporter 正是使用者回報的痛點，而
一句只會說「不准」的錯誤訊息等於沒有回答那個痛點。

文法收得很死，而且刻意不留擴充的縫：

    expr    := term (("+" | "-") term)*
    term    := unary (("*" | "/" | "%") unary)*
    unary   := ("-" | "+") unary | primary
    primary := NUMBER | "${" 路徑 "}" | "(" expr ")"

沒有函式呼叫、沒有比較、沒有三元、沒有字串常值。要比較就拉 `>` 積木——那顆
積木一點都不肥，肥的是算式。這條界線由 tokenizer 擋：**任何沒有出現在上面的
字元都是解析錯誤**，所以「下一步就是函式呼叫、就是三元運算子」不會偷偷發生，
它需要有人來改這個檔案。

運算元的 `${路徑}` 與 §4.7 **共用同一個 parser**（`template.parse_path`），
所以 `${a.b[1]}` 在運算式裡與在字串裡是同一件事；`refs` 的靜態檢查（§4.5）
也直接沿用，不必再寫一份。

解析在**存檔期**（`ir/schema.py::load`），與 template 同一條路：語法錯誤帶
blockId 回到那顆積木上，而不是等到那條路徑真的被執行到才說。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from blockyard.errors import ValidationError
from blockyard.ir.template import Ref, Resolver, parse_path, resolve_ref
from blockyard.ir.values import divide, modulo, to_number

# 數字常值。刻意不收指數寫法（`1e3`）：它在算式裡幾乎不會出現，而少一條規則
# 就少一個「我以為可以這樣寫」的機會。要那個數字請直接寫出來。
_NUMBER_RE = re.compile(r"\d+(?:\.\d+)?")

_ADD_OPS = frozenset("+-")
_MUL_OPS = frozenset("*/%")

# 錯誤訊息裡列給使用者看的東西。與上面的文法同步。
_ALLOWED = "數字、${變數}、+ - * / % 與括號"


# --------------------------------------------------------------------------
# AST
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Num:
    value: int | float


@dataclass(frozen=True)
class Get:
    """一個 `${路徑}` 運算元。"""

    ref: Ref


@dataclass(frozen=True)
class Neg:
    operand: Node


@dataclass(frozen=True)
class BinOp:
    op: str
    left: Node
    right: Node


Node = Num | Get | Neg | BinOp


@dataclass
class Expression:
    """解析後的運算式。

    `refs` 與 Template 的同名欄位是同一種東西（§4.5 的靜態檢查吃它），所以
    這裡刻意用同一個型別、同一個名字——「這個欄位引用了哪些變數」在整個
    專案裡只該有一個答案。
    """

    source: str
    node: Node
    refs: tuple[Ref, ...] = ()

    @property
    def roots(self) -> set[str]:
        return {r.root for r in self.refs}


# --------------------------------------------------------------------------
# 解析
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class _Token:
    kind: str          # "num" | "ref" | "op" | "(" | ")"
    value: Any
    pos: int


def parse(s: str, *, block_id: str | None = None, field_name: str | None = None) -> Expression:
    """解析運算式。語法錯誤一律是 ValidationError（存檔期）。"""
    tokens = _tokenize(s, block_id=block_id, field_name=field_name)
    if not tokens:
        raise ValidationError("運算式是空的", block_id=block_id, path=field_name)

    parser = _Parser(tokens, s, block_id=block_id, field_name=field_name)
    node = parser.expr()
    parser.expect_end()

    refs = tuple(t.value for t in tokens if t.kind == "ref")
    return Expression(source=s, node=node, refs=refs)


def _tokenize(
    s: str, *, block_id: str | None, field_name: str | None
) -> list[_Token]:
    out: list[_Token] = []
    i, n = 0, len(s)

    while i < n:
        c = s[i]

        if c.isspace():
            i += 1
            continue

        if c == "$":
            # `${` 之外的 `$` 沒有意義。字串欄位裡它是字面值，這裡不是字串。
            if not s.startswith("${", i):
                raise ValidationError(
                    "運算式裡的變數要寫成 ${名稱}",
                    block_id=block_id,
                    path=field_name,
                )
            close = s.find("}", i + 2)
            if close == -1:
                raise ValidationError(
                    "「${」沒有對應的「}」", block_id=block_id, path=field_name
                )
            # 路徑的解析與 §4.7 共用，連 `${a+b}` 的錯誤訊息都是同一句
            ref = parse_path(
                s[i + 2 : close], i, close + 1, block_id=block_id, input_name=field_name
            )
            out.append(_Token("ref", ref, i))
            i = close + 1
            continue

        if (m := _NUMBER_RE.match(s, i)) is not None:
            raw = m.group()
            # 沒有小數點就保持整數：`2 * 3` 是 6，不是 6.0。呈現層雖然兩者
            # 一樣（D15），但 §4.3 的索引與 type.of 看得到差別。
            out.append(_Token("num", float(raw) if "." in raw else int(raw), i))
            i = m.end()
            continue

        if c in _ADD_OPS or c in _MUL_OPS:
            out.append(_Token("op", c, i))
            i += 1
            continue

        if c in "()":
            out.append(_Token(c, c, i))
            i += 1
            continue

        # 走到這裡就是文法裡沒有的東西——比較、函式呼叫、字串常值全部在此止步。
        # 字母另給一句：`max(a, b)` 與 `a * 2` 是使用者最常試的兩種寫法，而
        # 「不能用『m』」對他們一點忙都幫不上。
        if c.isalpha() or c == "_":
            raise ValidationError(
                "運算式裡不能呼叫函式；變數要寫成 ${名稱}",
                block_id=block_id,
                path=field_name,
            )
        raise ValidationError(
            f"運算式裡不能用「{c}」，只能有{_ALLOWED}",
            block_id=block_id,
            path=field_name,
        )

    return out


class _Parser:
    """遞迴下降。優先序由 expr → term → unary → primary 的層次表達。"""

    def __init__(
        self, tokens: list[_Token], source: str, *, block_id: str | None, field_name: str | None
    ):
        self.tokens = tokens
        self.source = source
        self.block_id = block_id
        self.field_name = field_name
        self.i = 0

    # ---- 這一層 ----

    def expr(self) -> Node:
        node = self.term()
        while (t := self.peek()) is not None and t.kind == "op" and t.value in _ADD_OPS:
            self.i += 1
            node = BinOp(t.value, node, self.term())
        return node

    def term(self) -> Node:
        node = self.unary()
        while (t := self.peek()) is not None and t.kind == "op" and t.value in _MUL_OPS:
            self.i += 1
            node = BinOp(t.value, node, self.unary())
        return node

    def unary(self) -> Node:
        t = self.peek()
        if t is not None and t.kind == "op" and t.value in _ADD_OPS:
            self.i += 1
            operand = self.unary()
            return Neg(operand) if t.value == "-" else operand
        return self.primary()

    def primary(self) -> Node:
        t = self.peek()
        if t is None:
            raise self.fail("運算式在這裡就結束了，少了一個數字或變數")
        self.i += 1

        if t.kind == "num":
            return Num(t.value)
        if t.kind == "ref":
            return Get(t.value)
        if t.kind == "(":
            node = self.expr()
            nxt = self.peek()
            if nxt is None or nxt.kind != ")":
                raise self.fail("「(」沒有對應的「)」")
            self.i += 1
            return node
        if t.kind == ")":
            raise self.fail("多餘的「)」")
        raise self.fail(f"這裡應該是數字或變數，卻是「{t.value}」")

    # ---- 雜項 ----

    def peek(self) -> _Token | None:
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def expect_end(self) -> None:
        t = self.peek()
        if t is not None:
            raise self.fail(f"運算式在「{t.value}」之後多了東西")

    def fail(self, message: str) -> ValidationError:
        return ValidationError(message, block_id=self.block_id, path=self.field_name)


# --------------------------------------------------------------------------
# 求值
# --------------------------------------------------------------------------


def evaluate(expr: Expression, resolve: Resolver, *, block_id: str | None = None) -> int | float:
    """求值。運算元一律先過 §4.3 的 to_number，所以 `${a}` 是 "12" 也算得出來。

    **不發 block.enter / block.exit**：一顆積木一個值。這是這顆積木的代價，也是
    它的賣點——使用者要看見每一步的中間值就該拉積木，那條路一顆都沒有拿掉。
    """
    return _eval(expr.node, resolve, block_id)


def _eval(node: Node, resolve: Resolver, block_id: str | None) -> int | float:
    if isinstance(node, Num):
        return node.value

    if isinstance(node, Get):
        # 轉換在葉子做：錯誤訊息才指得到是哪一個變數不是數字
        return to_number(resolve_ref(node.ref, resolve, block_id=block_id), block_id=block_id)

    if isinstance(node, Neg):
        return -_eval(node.operand, resolve, block_id)

    left = _eval(node.left, resolve, block_id)
    right = _eval(node.right, resolve, block_id)
    if node.op == "+":
        return left + right
    if node.op == "-":
        return left - right
    if node.op == "*":
        return left * right
    # `/` 與 `%` 的語意與 `operator.divide` / `operator.mod` **共用一份實作**
    # （`ir/values.py`）：同一個算式在兩個地方給出不同答案是查不出來的錯。
    if node.op == "/":
        return divide(left, right, block_id=block_id)
    return modulo(left, right, block_id=block_id)


__all__ = ["BinOp", "Expression", "Get", "Neg", "Num", "evaluate", "parse"]

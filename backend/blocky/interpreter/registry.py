"""內建 opcode 的註冊表。

分成 command 與 value 兩張表，因為積木形狀決定了它出現在哪裡：
command 只能接在堆疊上，value（reporter / boolean）只能插在輸入孔裡。
把兩者分開，形狀錯誤在 dispatch 時就會被抓到而不是回傳 None。
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, TypeVar

Handler = Callable[..., Awaitable[Any]]
F = TypeVar("F", bound=Handler)

COMMANDS: dict[str, Handler] = {}
VALUES: dict[str, Handler] = {}

# hat 不在上面兩張表裡：引擎從 `hat.next` 起跑，從不「執行」hat 本身。
# 但形狀驗證需要認得它們，否則「事件積木夾在堆疊中間」查不出來。
HAT_OPCODES = frozenset(
    {
        "event.when_flag_clicked",
        "event.when_cron",
        "event.when_webhook",
        "procedure.definition",
    }
)

# 形狀。`value` 同時涵蓋 reporter 與 boolean——引擎不區分兩者，區分是編輯器
# 的事（哪種孔吃哪種積木）。
SHAPE_COMMAND = "command"
SHAPE_VALUE = "value"
SHAPE_HAT = "hat"

_EXT_SHAPES: dict[str, frozenset[str]] = {
    "command": frozenset({SHAPE_COMMAND}),
    "reporter": frozenset({SHAPE_VALUE}),
    "boolean": frozenset({SHAPE_VALUE}),
    "hat": frozenset({SHAPE_HAT}),
}

# 這些 opcode 自行控制輸入孔的求值時機（迴圈條件要重複求值、
# if 分支不能兩邊都算），因此引擎不對它們做自動的 enter/exit 包裝以外的事。
LAZY_INPUTS: set[str] = set()


def command(opcode: str) -> Callable[[F], F]:
    def deco(fn: F) -> F:
        COMMANDS[opcode] = fn
        return fn

    return deco


def value(opcode: str) -> Callable[[F], F]:
    def deco(fn: F) -> F:
        VALUES[opcode] = fn
        return fn

    return deco


def builtin_shapes(opcode: str) -> frozenset[str]:
    """一顆內建積木**可以**是哪些形狀。空集合 = 不認得這個 opcode。

    回集合而不是單一值，因為 `procedure.call` 兩者皆是：有宣告回傳型別時是
    reporter，沒有時是 command（§4.6）。
    """
    shapes = set()
    if opcode in COMMANDS:
        shapes.add(SHAPE_COMMAND)
    if opcode in VALUES:
        shapes.add(SHAPE_VALUE)
    if opcode in HAT_OPCODES:
        shapes.add(SHAPE_HAT)
    return frozenset(shapes)


def resolve_shape(extensions: Any = None) -> Callable[[str], frozenset[str]]:
    """組出「opcode → 形狀」的查詢函式，內建與積木包共用一個入口。

    `extensions` 只要有 `.shape(opcode)`（`ExtensionRegistry` 有）。刻意不
    import 它：形狀查詢是 IR 驗證要用的東西，不該把 ir 層綁上擴充系統。
    """

    def resolve(opcode: str) -> frozenset[str]:
        if shapes := builtin_shapes(opcode):
            return shapes
        ext = extensions.shape(opcode) if extensions is not None else None
        return _EXT_SHAPES.get(ext or "", frozenset())

    return resolve

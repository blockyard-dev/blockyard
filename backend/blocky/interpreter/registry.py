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

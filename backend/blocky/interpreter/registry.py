"""內建 opcode 的註冊表。

分成 command 與 value 兩張表，因為積木形狀決定了它出現在哪裡：
command 只能接在堆疊上，value（reporter / boolean）只能插在輸入孔裡。
把兩者分開，形狀錯誤在 dispatch 時就會被抓到而不是回傳 None。
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, TypeVar

from blocky.interpreter import declarations

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
# 的事（哪種孔吃哪種積木）。定義在 `declarations` 裡，內建與積木包共用同一張表。
SHAPE_COMMAND = declarations.SHAPE_COMMAND
SHAPE_VALUE = declarations.SHAPE_VALUE
SHAPE_HAT = declarations.SHAPE_HAT

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

    答案來自**宣告**（`builtins/*.yaml`），不是從「handler 註冊在 COMMANDS 還是
    VALUES」反推（D21）。反推看起來省事，但它讓形狀成為實作的副產物：一顆忘了
    註冊的積木會變成「不認得」，而 §13.3 說不認得的 opcode 要當佔位符放行——
    於是形狀驗證對它默默失效。宣告是獨立的第二個來源，兩者不一致由
    `tests/unit/test_builtin_manifests.py` 的第一個測試抓。

    回集合而不是單一值，因為 `procedure.call` 兩者皆是：有宣告回傳型別時是
    reporter，沒有時是 command（§4.6）。
    """
    return declarations.shapes(opcode)


def resolve_terminal(extensions: Any = None) -> Callable[[str], bool]:
    """組出「opcode → 是不是 cap block」的查詢函式（§4.6）。

    與 `resolve_shape` 同一個形狀，理由也同一個：`terminal` 積木包也宣告得起
    （它不碰 §7.5 的邊界），所以這個問題不能只問內建。認不得的 opcode 回
    False——§13.3 的佔位符不該因為「查不到宣告」就被說成接錯。
    """

    def resolve(opcode: str) -> bool:
        if declarations.block(opcode) is not None:
            return declarations.is_terminal(opcode)
        found = extensions.lookup(opcode) if extensions is not None else None
        return found is not None and found[1].terminal

    return resolve


def resolve_shape(extensions: Any = None) -> Callable[[str], frozenset[str]]:
    """組出「opcode → 形狀」的查詢函式，內建與積木包共用一個入口。

    `extensions` 只要有 `.shape(opcode)`（`ExtensionRegistry` 有）。刻意不
    import 它：形狀查詢是 IR 驗證要用的東西，不該把 ir 層綁上擴充系統。
    """

    def resolve(opcode: str) -> frozenset[str]:
        if shapes := builtin_shapes(opcode):
            return shapes
        ext = extensions.shape(opcode) if extensions is not None else None
        return declarations.shapes_of(ext or "")

    return resolve

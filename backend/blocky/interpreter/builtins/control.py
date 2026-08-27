"""control 命名空間（§4.4）。

相對於 Scratch 多了 `try_catch`——工作流一定會碰到網路失敗，沒有它使用者
只能眼睜睜看著 thread 中止。
"""

from __future__ import annotations

import asyncio

from blocky.errors import BlockyError, StopSignal
from blocky.interpreter.registry import command
from blocky.ir.schema import Block
from blocky.ir.values import TYPE_LABELS_ZH, TYPE_LIST, to_number, type_of
from blocky.interpreter.engine import Thread


@command("control.if")
async def _if(t: Thread, b: Block) -> None:
    if await t.boolean(b, "condition"):
        await t.exec_stack(t.stack(b, "then"))


@command("control.if_else")
async def _if_else(t: Thread, b: Block) -> None:
    # 只求值成立的那一邊——分支的 reporter 可以帶副作用（§4.6）
    branch = "then" if await t.boolean(b, "condition") else "else"
    await t.exec_stack(t.stack(b, branch))


@command("control.repeat")
async def _repeat(t: Thread, b: Block) -> None:
    # 次數在進入迴圈前求值一次，與 Scratch 一致
    n = await t.number(b, "times", default=0)
    body = t.stack(b, "body")
    for _ in range(max(0, int(n))):
        await t.exec_stack(body)


@command("control.repeat_until")
async def _repeat_until(t: Thread, b: Block) -> None:
    body = t.stack(b, "body")
    while not await t.boolean(b, "condition"):
        await t.exec_stack(body)


@command("control.forever")
async def _forever(t: Thread, b: Block) -> None:
    body = t.stack(b, "body")
    while True:
        await t.exec_stack(body)


@command("control.for_each")
async def _for_each(t: Thread, b: Block) -> None:
    name = t.field(b, "name")
    items = await t.value(b, "list", default=[])
    if type_of(items) != TYPE_LIST:
        raise BlockyError(
            f"「對每一項」需要清單，收到{TYPE_LABELS_ZH[type_of(items)]}",
            hint="是不是需要先用「解析 JSON」？" if isinstance(items, str) else None,
        )
    body = t.stack(b, "body")
    # 迭代前先複製：迴圈體修改原清單不該改變迭代範圍
    for item in list(items):
        t.scope.set(name, item)
        t.interp.sink.emit("var.set", threadId=t.id, name=name, value=item)
        await t.exec_stack(body)


@command("control.wait")
async def _wait(t: Thread, b: Block) -> None:
    await asyncio.sleep(max(0.0, float(await t.number(b, "seconds", default=0))))


@command("control.wait_until")
async def _wait_until(t: Thread, b: Block) -> None:
    while not await t.boolean(b, "condition"):
        await asyncio.sleep(0)


@command("control.stop")
async def _stop(t: Thread, b: Block) -> None:
    # scope: this_script | all
    raise StopSignal(t.field(b, "scope", "this_script"))


@command("control.try_catch")
async def _try_catch(t: Thread, b: Block) -> None:
    """§5.6：**只捕捉積木層級的錯誤**。

    ProcedureReturn / StopSignal / CancelledError 三者必須穿透——它們繼承
    BaseException，所以這裡的 `except BlockyError` 天然攔不到。這不是巧合，
    是 §4.6 明確要求的設計：`except Exception` 會把 return 吞掉，導致
    「函式在 try 裡 return 就沒反應」這種極難查的 bug。
    """
    try:
        await t.exec_stack(t.stack(b, "try"))
    except BlockyError as e:
        name = t.field(b, "error_name", "error")
        t.scope.thread.push({name: e.to_dict()})
        try:
            await t.exec_stack(t.stack(b, "catch"))
        finally:
            t.scope.thread.pop()


# hat 積木不由 COMMANDS 執行——引擎從 hat.next 開始跑堆疊（§5.1）。
# 這裡不註冊它們，是為了讓「把 hat 接在堆疊中間」變成明確的載入期錯誤。

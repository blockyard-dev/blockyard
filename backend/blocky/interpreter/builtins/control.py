"""control 命名空間（§4.4）。

相對於 Scratch 多了 `try_catch`——工作流一定會碰到網路失敗，沒有它使用者
只能眼睜睜看著 thread 中止。
"""

from __future__ import annotations

import asyncio

from blocky.errors import BlockyError, StopSignal, ThrownError
from blocky.interpreter import declarations
from blocky.repeat import count_of
from blocky.interpreter.registry import command
from blocky.ir.schema import Block
from blocky.ir.values import TYPE_LABELS_ZH, TYPE_LIST, to_number, to_string, type_of
from blocky.interpreter.engine import Thread


@command("control.if")
async def _if(t: Thread, b: Block) -> None:
    if await t.boolean(b, "condition"):
        await t.exec_stack(t.stack(b, "then"))


@command("control.if_else")
async def _if_else(t: Thread, b: Block) -> None:
    """`如果⋯否則如果⋯否則`（§16 Q19 的第一個消費者）。

    **由上往下，第一個成立的就停。** 這是 if/elif 在每個語言裡的意思，而它同時
    是「只求值成立的那一邊」（§4.6）的直接延伸：一個不成立的分支，它的條件之後
    的條件仍然要算，但**它之後的分支條件不必算**——分支的 reporter 可以帶副作
    用，多算一次就是多做一次事。
    """
    if await t.boolean(b, "condition"):
        await t.exec_stack(t.stack(b, "then"))
        return

    spec = declarations.block(b.opcode)
    for i in range(count_of(b.mutation, spec)):
        assert spec is not None
        if await t.boolean(b, spec.repeat_arg_name("condition", i)):
            await t.exec_stack(t.stack(b, spec.repeat_arg_name("body", i)))
            return

    await t.exec_stack(t.stack(b, "else"))


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
    #
    # **迴圈變數推的是 thread-local 的一層，不是 `t.scope.set`**（D29 第 1 條）。
    # 寫全域是一個真的 bug：全域層是同一個 Run 的所有 thread 共用的，兩條腳本
    # 各跑一個 `對每一項 item`、迴圈體裡有任何一個 await，兩邊就互相踩——而
    # manifest 早就宣告了 `binds`，只有執行期沒有跟上。
    #
    # 一層撐完整個迴圈、每一輪覆寫那一格，而不是每輪 push／pop：巢狀的深度該
    # 等於畫面上的巢狀深度，一個跑一萬輪的迴圈不該讓堆疊長一萬層。
    t.scope.thread.push({})
    try:
        for item in list(items):
            t.scope.thread.assign(name, item)
            t.interp.sink.emit("var.set", threadId=t.id, name=name, value=item)
            await t.exec_stack(body)
    finally:
        t.scope.thread.pop()


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


@command("control.throw")
async def _throw(t: Thread, b: Block) -> None:
    """使用者自己丟一個錯誤（§5.6）。

    丟的是 `ThrownError`，所以它**走與其他錯誤完全一樣的路**：`try_catch` 接得
    到、接不到就發 `block.error` 並中止這條 thread。這裡刻意不做任何特別處理
    ——一個「使用者丟的錯誤」如果需要引擎為它開一條分支，那它就不是錯誤了。

    `blockId` 不在這裡填：`_exec_block` 對 `block_id is None` 的 `BlockyError`
    會補上正在執行的那一顆（引擎才知道自己在哪）。所以 catch 裡的
    `${錯誤.blockId}` 照樣指得回是哪一顆丟的。
    """
    raise ThrownError(await t.string(b, "message"))


@command("control.retry")
async def _retry(t: Thread, b: Block) -> None:
    """`最多試 N 次，每次間隔 M 秒`（P2 的錯誤重試策略）。

    **一次重試不是一次新的 Run。** 全域變數保留、執行紀錄一列——D12 說「一個
    Run = 一組乾淨的全域變數」，而重播整個 Run 會讓 `count` 的值取決於「這次
    重試了幾遍」，那正是 D12 拒絕的那個形狀。同一個理由讓它落在**積木**上而
    不是 hat 上或 manifest 裡：範圍就是那張嘴巴，與 `try_catch` 同一個形狀，
    而使用者在畫面上看得見它。

    **重試的是整張嘴巴，不是失敗的那一顆。** 嘴巴裡前面幾顆已經跑過的積木會
    再跑一遍——這與迴圈是同一件事，也是唯一畫得出來的語意（「從失敗那一顆繼續」
    要引擎記住半條堆疊的狀態，而那個狀態在畫面上沒有位置）。所以有副作用的東西
    要放在嘴巴外面。

    **只重試 BlockyError**，與 `try_catch` 同一條界線：`回傳` / `停止` / 取消
    繼承 BaseException，天然穿得過去。一顆在 try 裡 `回傳` 的函式不該因為包了
    重試就重跑三遍。

    **每次失敗會發一則 warn log。** 沒有它，「試了三次、前兩次失敗」與「一次
    就成功」在畫面上長得一模一樣——而那正是加這顆積木的人想知道的事（對方是不
    是在限流）。這是引擎唯一會自己說話的地方，理由是那句話只有引擎知道。
    """
    # 與 `重複 N 次` 一樣，兩個數字在進入之前求值一次。
    times = max(1, int(await t.number(b, "times", default=1)))
    seconds = max(0.0, float(await t.number(b, "seconds", default=0)))
    body = t.stack(b, "body")
    bid = t.interp._bid(b)

    for attempt in range(1, times + 1):
        try:
            await t.exec_stack(body)
            return
        except BlockyError as e:
            # 最後一次的錯誤原樣丟出去——**不包裝**。包起來的話外面那顆
            # `出錯時` 拿到的 `${錯誤.code}` 會變成「重試失敗」，而使用者要處理
            # 的是底下那個真正的錯（限流？金鑰不對？）。
            if attempt == times:
                raise
            # 數字進句子走 §4.3 的 `to_string`，不是 Python 的 f-string——
            # 後者把 `間隔 (1) 秒` 印成「1.0 秒」，而語意層只有 double（D15），
            # 那個 `.0` 在畫面上沒有意義。
            t.log(
                f"第 {attempt} 次失敗（{e.message}），"
                f"{to_string(seconds)} 秒後再試（最多 {times} 次）",
                level="warn",
                block_id=bid,
            )
            # `asyncio.sleep` 是取消點，所以等待中按下停止是立刻的（§5.5）。
            await asyncio.sleep(seconds)


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

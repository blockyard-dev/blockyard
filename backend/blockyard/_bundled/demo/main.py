"""示範積木包的實作（§7.3）。

全部是純函式：不打網路、不碰檔案、不需要金鑰。**參數不做任何防呆**——那是
Host 邊界的工作（§7.5、D10），這裡拿到的 `body` 保證已經是 dict / list，
`a` 保證已經是數字。這份檔案的長度就是那個承諾的證據。
"""

import asyncio

from blockyard import block, dropdown, on_load, on_unload, trigger

FRUIT_COLORS = {"apple": "紅色", "banana": "黃色", "grape": "紫色"}


@on_load
async def setup(ctx):
    ctx.state["calls"] = 0


@on_unload
async def teardown(ctx):
    ctx.state.clear()


@block("demo.echo")
async def echo(ctx, text: str) -> str:
    ctx.state["calls"] += 1
    ctx.log(f"echo 第 {ctx.state['calls']} 次")
    return f"{ctx.config['greeting']}, {text}"


@block("demo.announce")
async def announce(ctx, text: str) -> None:
    ctx.log(text, level="info")


@block("demo.say_to_panel")
async def say_to_panel(ctx, text: str) -> None:
    """B 路線：送一則訊息給這個包**自己宣告的**面板。payload 是它自己的協定，
    host 一個字都不解讀。"""
    ctx.send_panel("demo", {"type": "say", "text": text})


@block("demo.say_to_panel_undeclared")
async def say_to_panel_undeclared(ctx) -> None:
    """故意送給一個沒宣告過的 id——收件人由 manifest 決定，不是呼叫時說的。"""
    ctx.send_panel("nope", {"hi": 1})


@block("demo.wrap")
async def wrap(ctx, body) -> dict:
    # body 已經是 dict 或 list——邊界保證的，見 §7.2 的 json 型別
    return {"wrapped": body}


@block("demo.add")
async def add(ctx, a, b):
    return a + b


@block("demo.is_even")
async def is_even(ctx, n) -> bool:
    return int(n) % 2 == 0


@block("demo.color_of")
async def color_of(ctx, fruit: str) -> str:
    return FRUIT_COLORS.get(fruit, "不知道")


@block("demo.broken_returns")
async def broken_returns(ctx) -> str:
    # manifest 宣告 returns: object。這裡回字串，Host 應該在邊界就攔下來。
    return '{"looks": "like json"}'


@block("demo.count_items")
async def count_items(ctx, items):
    return len(items)


@block("demo.not_transportable")
async def not_transportable(ctx):
    # set 不是 §4.3 的六種值之一。in-process 時它「看起來能用」，跨 process
    # 時才會炸——所以邊界從第一天就擋。
    return {"ok"}


@block("demo.blow_up")
async def blow_up(ctx) -> None:
    raise ValueError("這是積木包內部的例外")


@dropdown("demo.list_fruits")
async def list_fruits(ctx):
    return [{"label": k, "value": k} for k in FRUIT_COLORS]


@trigger("demo.on_tick")
async def on_tick(ctx):
    """每 yield 一次啟動一個 Thread（§7.3）。這裡只跳三拍就結束。"""
    for i in range(1, 4):
        if ctx.cancelled:
            return
        yield {"tick": i}
        await asyncio.sleep(0)

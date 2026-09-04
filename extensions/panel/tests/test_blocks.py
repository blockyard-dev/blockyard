"""面板積木包的測試（§7.1、§16 Q17 的 B 路線）。

守的是**送出去的是什麼**——因為編輯器一個字都不解讀 payload，所以「畫出來對不
對」不是這裡回答得了的問題（那要一個瀏覽器，靠實測）。這一份守的是協定沒有漂移：
`ui/main.js` 認得的那幾種 `type`，跟這裡送出去的是同一份。

題目一律**透過 host 呼叫**而不是直接 import `main.py`，這樣連 §7.5 的邊界一起
驗到了（`data` 宣告成 `list`，所以「使用者打了一段 JSON 文字」會在邊界被擋，
而不是進到 `main.py` 才變成一句奇怪的話）。
"""

from __future__ import annotations

from typing import Any

import pytest

from blockyard.errors import BlockyardError
from blockyard.extensions import (
    DEFAULT_EXTENSIONS_ROOT,
    CallContexts,
    EventSinkChannel,
    InProcessHost,
    discover,
)
from blockyard.interpreter.events import EventSink


class Pack:
    """只透過 `ExtensionHost` 的介面跟積木包打交道（同 §17.4 的合約測試）。"""

    def __init__(self, host: InProcessHost, contexts: CallContexts, sink: EventSink) -> None:
        self._host = host
        self._contexts = contexts
        self._sink = sink

    async def call(self, opcode: str, **args: Any) -> Any:
        ctx = self._contexts.open("panel", thread_id="t_1", block_id="blk_1")
        try:
            return await self._host.call(opcode, args, ctx.token)
        finally:
            self._contexts.close(ctx.token)

    def sent(self) -> list[Any]:
        return [e["payload"] for e in self._sink.dicts() if e["op"] == "ext.panel"]

    def events(self) -> list[dict[str, Any]]:
        return [e for e in self._sink.dicts() if e["op"] == "ext.panel"]


@pytest.fixture
async def pack() -> Any:
    """`InProcessHost` 是 §7.6 的快速路徑（內建與測試用）。跨 process 那一半由
    `tests/contract/test_host_boundary.py` 的 `HOSTS` 參數化守著。"""
    contexts = CallContexts()
    sink = EventSink()
    sources = discover(DEFAULT_EXTENSIONS_ROOT)
    channel = EventSinkChannel(
        sink,
        contexts,
        lambda ext_id: tuple(p.id for p in sources[ext_id].manifest.panels),
    )
    host = InProcessHost(sources, channel, contexts)
    await host.load("panel")
    try:
        yield Pack(host, contexts, sink)
    finally:
        await host.unload("panel")


async def test_每顆積木送出自己那一則訊息(pack: Pack) -> None:
    """協定是**這個包定的**。這幾個 `type` 與 `ui/main.js` 的 switch 是同一份
    ——兩邊漂移的話症狀是「送出去了但畫面沒動」，而那沒有任何地方會報錯。"""
    await pack.call("panel.line_chart", data=[3, 1, 4])
    await pack.call("panel.add_point", x=1, y=2)
    await pack.call("panel.clear")
    await pack.call("panel.stat", name="總數", value=42)

    assert pack.sent() == [
        {"type": "line", "values": [3, 1, 4]},
        {"type": "point", "x": 1, "y": 2},
        {"type": "clear"},
        {"type": "stat", "name": "總數", "value": "42"},
    ]


async def test_表格的欄位是所有列的聯集(pack: Pack) -> None:
    """缺的那一格由面板畫成空白——欄位是聯集，缺格是正常的資料不是錯誤。"""
    await pack.call("panel.table", data=[{"a": 1}, {"b": 2}])

    assert pack.sent() == [
        {"type": "table", "columns": ["a", "b"], "rows": [{"a": "1"}, {"b": "2"}]}
    ]


async def test_訊息都送進宣告過的那一格(pack: Pack) -> None:
    """`panelId` 由 manifest 決定，不是呼叫時說的——少了這道檢查，一個包可以把
    訊息送進別人的面板。"""
    await pack.call("panel.clear")

    assert pack.events()[0]["panelId"] == "chart"
    assert pack.events()[0]["extId"] == "panel"


async def test_折線圖的資料要全部是數字_而且指名第幾筆(pack: Pack) -> None:
    """一串 200 個數字裡混進一個字串，「資料裡有東西不是數字」找不到它。

    **這條檢查在包裡，不在編輯器裡**——編輯器不知道什麼是折線圖。
    """
    with pytest.raises(BlockyardError, match="第 2 筆不是"):
        await pack.call("panel.line_chart", data=[1, "兩", 3])


async def test_資料不是清單由邊界擋(pack: Pack) -> None:
    """`type: list` 是嚴格宣告，不做轉換（§7.2）。擋在 §7.5 的邊界，所以
    `main.py` 一行防呆都不用寫。"""
    with pytest.raises(BlockyardError, match="需要清單"):
        await pack.call("panel.line_chart", data="[1, 2, 3]")

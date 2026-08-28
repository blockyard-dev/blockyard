"""§6.2 流量控制：50ms 批次窗口、`block.hot` 聚合、慢客戶端的丟棄策略。

這個檔案存在的理由只有一句話：**一個 `forever` 迴圈每秒會產生幾十萬個
`block.enter`，逐個推出去會在第一秒內打爆 WebSocket。** §6.2 因此標「必須做」。

三層各自解決不同的爆量來源，不可互相取代：

  批次窗口   50ms 收一次，一個 WS frame 一個陣列——省的是 frame 數量。
  熱點聚合   同一顆積木在一個窗口內超過 20 次 → 一個 `block.hot`，帶累計
             次數與最後一個值——省的是事件數量。這是唯一能對付緊迴圈的一層。
  丟棄       訂閱者的佇列滿了就丟最舊的 frame，並在下一個 frame 標 `dropped`。
             §6.3 說 `block.enter/exit/var.set` **不落地**，它們是即時訊號不是
             稽核紀錄——所以丟掉是正確的，靜靜地丟掉才不是。

`block.error` 與 `log` 永遠不參與聚合，也永遠不丟：它們是 §6.3 要落地的那半。
"""

from __future__ import annotations

import asyncio
import contextlib
from collections import Counter
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

# §6.2 的三個常數。改動它們就是改動協定，所以擺在最上面而不是散在程式碼裡。
WINDOW_S = 0.050
HOT_THRESHOLD = 20

# 第一個訂閱者到達之前先留著的事件數。`POST /api/runs` 回應與前端把
# WebSocket 接上之間有幾毫秒的空窗，沒有這個緩衝，前端會固定看不到
# `run.start` 與最前面幾顆積木——而那正是使用者盯著看的部分。
BACKLOG_LIMIT = 2000

# 每個訂閱者最多積幾個 frame。50ms 一個 frame，所以 200 個 ≈ 10 秒的落後。
QUEUE_LIMIT = 200

# 事件的兩種身分：會被聚合的（依 blockId 定位、高頻）、與絕不動的。
_AGGREGATABLE = ("block.enter", "block.exit")


def collapse(
    events: list[dict[str, Any]],
    totals: Counter[str],
    *,
    threshold: int = HOT_THRESHOLD,
) -> list[dict[str, Any]]:
    """把一個 50ms 窗口的原始事件壓成要送出去的那一批（§6.2）。

    純函數（除了把累計次數記進 `totals`），所以測得到——時序留給 `RunBroker`，
    規則留在這裡。

    `count` 是**這個 Run 至今的累計次數**而不是這個窗口的次數。§6.2 的例子
    寫 `"count": 4210`，而 50ms 內跑四千次的窗口下一個窗口又會重來——UI 要顯示
    的「持續執行中 ×4210」問的是「這顆積木總共跑了幾次」，不是「這 50ms 跑了
    幾次」。累計值也讓數字單調遞增，看起來才像個計數器。

    `var.set` 也在這裡收斂：同一個名稱在一個窗口內只留**最後**一次。變數監看
    面板顯示的是現值，中間那四千個值既畫不出來也沒人看得到。這條不在 §6.2 的
    字面上，但它與 `block.hot` 是同一個道理，而且 §6.3 已經說 `var.set` 不落地。
    """
    window: Counter[str] = Counter()
    for e in events:
        if e.get("op") == "block.enter" and (bid := e.get("blockId")) is not None:
            window[bid] += 1
            totals[bid] += 1

    hot = {bid for bid, n in window.items() if n > threshold}

    out: list[dict[str, Any]] = []
    aggregate: dict[str, dict[str, Any]] = {}
    var_at: dict[str, int] = {}

    for e in events:
        op = e.get("op")
        bid = e.get("blockId")

        if op in _AGGREGATABLE and bid in hot:
            # 聚合事件放在**那顆積木第一次出現的位置**，而不是批次末尾。
            # §6.2 的說法是「改送聚合事件」——它取代那些事件，就該站在它們
            # 的位置上。擺末尾的話它會排到同一批的 `run.end` 後面，而任何
            # 「收到 run.end 就收工」的客戶端都會漏掉它。
            if (agg := aggregate.get(bid)) is None:
                agg = aggregate[bid] = {"op": "block.hot", "blockId": bid, "count": totals[bid]}
                out.append(agg)
            if op == "block.exit" and "value" in e:
                agg["lastValue"] = e["value"]
                if e.get("truncated"):
                    agg["truncated"] = True
                elif "truncated" in agg:
                    del agg["truncated"]
            continue

        if op == "var.set" and (name := e.get("name")) is not None:
            if (at := var_at.get(name)) is not None:
                out[at] = e
                continue
            var_at[name] = len(out)

        out.append(e)

    return out


@dataclass
class _Subscriber:
    queue: asyncio.Queue[dict[str, Any] | None]
    dropped: int = 0


@dataclass
class _Backlog:
    events: list[dict[str, Any]] = field(default_factory=list)
    dropped: int = 0


class RunBroker:
    """一個 Run 的事件出口。引擎往裡面 `publish`，WebSocket 從 `subscribe` 拿。

    引擎在 event loop 上跑，`publish` 因此**必須是同步的**：讓它 await 會把
    每個 `sink.emit` 變成一個 yield 點，改掉 §5.2 精心安排的讓出時機。所以
    publish 只是塞進一個 list，真正的送出由 `_flush_loop` 每 50ms 做一次。
    """

    def __init__(
        self,
        run_id: str,
        *,
        window_s: float = WINDOW_S,
        threshold: int = HOT_THRESHOLD,
        backlog_limit: int = BACKLOG_LIMIT,
        queue_limit: int = QUEUE_LIMIT,
    ) -> None:
        self.run_id = run_id
        self._window_s = window_s
        self._threshold = threshold
        self._backlog_limit = backlog_limit
        self._queue_limit = queue_limit

        self._pending: list[dict[str, Any]] = []
        self._totals: Counter[str] = Counter()
        self._subscribers: list[_Subscriber] = []
        self._backlog = _Backlog()
        self._attached = False
        self._closed = False
        self._flusher: asyncio.Task[None] | None = None

    # ---- 生命週期 ----

    def start(self) -> None:
        if self._flusher is None:
            self._flusher = asyncio.create_task(self._flush_loop())

    def close(self) -> None:
        """Run 結束。**同步**——它會在 `_drive` 的 finally 裡被呼叫，那時候
        task 可能正在被取消，多一個 await 就多一個 CancelledError 的機會。
        """
        if self._closed:
            return
        if self._flusher is not None:
            self._flusher.cancel()
        self._flush()
        self._closed = True
        for sub in self._subscribers:
            sub.queue.put_nowait(None)  # 哨兵：訂閱者的迴圈可以收工了

    @property
    def closed(self) -> bool:
        return self._closed

    # ---- 進 ----

    def publish(self, event: dict[str, Any]) -> None:
        if not self._closed:
            self._pending.append(event)

    # ---- 出 ----

    @contextlib.asynccontextmanager
    async def subscribe(self) -> AsyncIterator[AsyncIterator[dict[str, Any]]]:
        """訂閱一個 Run 的 frame 串流。每個 frame 是 `{"events": [...]}`。"""
        # maxsize 多留一格給哨兵：佇列滿的時候仍然要放得進「結束了」，否則
        # 慢客戶端會卡在一個永遠不會結束的 `async for` 上。這是丟棄策略唯一
        # 不能丟的東西。
        sub = _Subscriber(queue=asyncio.Queue(maxsize=self._queue_limit + 1))

        # 第一個訂閱者把積壓的事件一次領走。第二個之後就沒有了——§6.3：
        # `block.enter/exit` 不落地，錯過就是錯過。
        if not self._attached:
            self._attached = True
            if self._backlog.events or self._backlog.dropped:
                sub.queue.put_nowait(_frame(self._backlog.events, self._backlog.dropped))
            self._backlog = _Backlog()
        if self._closed:
            sub.queue.put_nowait(None)

        self._subscribers.append(sub)
        try:
            yield _drain(sub.queue)
        finally:
            if sub in self._subscribers:
                self._subscribers.remove(sub)

    # ---- 內部 ----

    async def _flush_loop(self) -> None:
        while True:
            await asyncio.sleep(self._window_s)
            self._flush()

    def _flush(self) -> None:
        if not self._pending:
            return
        batch = collapse(self._pending, self._totals, threshold=self._threshold)
        self._pending = []
        if not batch:
            return

        if not self._attached:
            self._backlog.events.extend(batch)
            if (excess := len(self._backlog.events) - self._backlog_limit) > 0:
                # 丟最舊的：使用者按下停止之後接上來看的是「現在怎麼了」，
                # 而不是三分鐘前的第一顆積木。
                del self._backlog.events[:excess]
                self._backlog.dropped += excess
            return

        for sub in self._subscribers:
            self._push(sub, batch)

    def _push(self, sub: _Subscriber, events: list[dict[str, Any]]) -> None:
        while sub.queue.qsize() >= self._queue_limit:
            old = sub.queue.get_nowait()
            if old is None:  # 哨兵不該被丟掉，塞回去就好
                sub.queue.put_nowait(None)
                return
            sub.dropped += len(old["events"]) + old.get("dropped", 0)
        sub.queue.put_nowait(_frame(events, sub.dropped))
        sub.dropped = 0


def _frame(events: list[dict[str, Any]], dropped: int = 0) -> dict[str, Any]:
    frame: dict[str, Any] = {"events": events}
    if dropped:
        frame["dropped"] = dropped
    return frame


async def _drain(queue: asyncio.Queue[dict[str, Any] | None]) -> AsyncIterator[dict[str, Any]]:
    while True:
        item = await queue.get()
        if item is None:
            return
        yield item


__all__ = [
    "BACKLOG_LIMIT",
    "HOT_THRESHOLD",
    "QUEUE_LIMIT",
    "WINDOW_S",
    "RunBroker",
    "collapse",
]

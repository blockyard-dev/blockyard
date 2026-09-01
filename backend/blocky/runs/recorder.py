"""§6.3 的落地策略：哪些事件進 SQLite，以及怎麼進。

§6.2（`broker.py`）管的是「送多少給前端」，這裡管的是「存多少到硬碟」。
**兩者必須分開**——一個掛著跑三天的 `forever` 迴圈會寫進幾億列，而前端那條
路上它早就被 50ms 的批次窗口與 `block.hot` 聚合收掉了。

分工：

    storage/runs.py   叫我存什麼就存什麼，不知道事件的語意
    這個檔案          §6.3 的篩選、批次、序號、log 上限
    runs/manager.py   Run 那一列（start/finish）——**同步寫**，見下

**Run 那一列不走這裡。** 一個 Run 只有兩次寫入（開始、結束），而
`POST /api/runs` 回來之後前端立刻會 `GET /api/runs`——排進批次緩衝的話，那次
GET 有機會看不到剛剛才建立的 Run。事件沒有這個問題（它們有自己的端點，而且
本來就是串流），所以只有事件需要批次。
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from blocky.storage.runs import LOG_LIMIT, RunStore

#: §6.3 那張表的「一律存」那一半。**白名單，不是黑名單**——新增一種事件時
#: 預設不落地，要有人來這裡加一行。反過來（黑名單）的話，下一個加事件的人
#: 會在沒注意到的情況下讓執行歷史開始長出他沒想過的東西，而 §6.3 存在的
#: 全部理由就是「不是每個事件都要進 SQLite」。
STORED_OPS = frozenset(
    {
        # 執行歷史的骨架
        "run.start",
        "run.end",
        "thread.start",
        "thread.end",
        # 含完整 traceback
        "block.error",
        # 每個 Run 上限 LOG_LIMIT 筆，超過丟最舊的
        "log",
    }
)

#: 只有這一種會被丟。骨架事件的數量由腳本結構決定，不會被一個迴圈灌爆。
_DROPPABLE = "log"

#: 緩衝區裡積到這麼多筆就先寫一次，不等下一個窗口。
DEFAULT_BATCH = 500

#: 背景 writer 多久醒一次。比 §6.2 的 50ms 慢一個數量級是刻意的：那個窗口
#: 服務的是「使用者盯著畫面看」，這個服務的是「明天回來查」。
DEFAULT_FLUSH_S = 0.25

#: 緩衝區的硬上限。到頂時丟最舊的 `log`——與 §6.3 的規則同一條，只是提早在
#: 記憶體裡發生。沒有這個上限，SQLite 一旦變慢（磁碟忙、鎖競爭），緩衝區就
#: 成了那個掛三天的迴圈的新家。
DEFAULT_BUFFER = 20_000


class RunRecorder:
    """事件 → SQLite 的批次 writer。一個 app 一個。

    `record()` 是**同步**的，因為它掛在 `EventSink.on_emit` 上：引擎在 event
    loop 上跑，emit 不能 await——否則它會變成一個讓出點，改變 §5.2 的讓出
    時機（`EventSink` 的 docstring 講的是同一件事）。所以這裡只做 append，
    真正的寫入在背景 task 上。
    """

    def __init__(
        self,
        store: RunStore,
        *,
        flush_interval_s: float = DEFAULT_FLUSH_S,
        batch: int = DEFAULT_BATCH,
        buffer_limit: int = DEFAULT_BUFFER,
        log_limit: int = LOG_LIMIT,
    ) -> None:
        self._store = store
        self._interval = flush_interval_s
        self._batch = batch
        self._buffer_limit = buffer_limit
        self._log_limit = log_limit
        #: (run_id, seq, op, data)
        self._pending: list[tuple[str, int, str, dict[str, Any]]] = []
        self._seq: dict[str, int] = {}
        #: 這個 Run 到目前為止寫進去的 log 筆數（含還在緩衝區的）。
        self._logs: dict[str, int] = {}
        #: 需要在下一次寫入後執行 §6.3 上限的 Run（資料庫裡超過了）。
        self._over_limit: set[str] = set()
        #: 已經在緩衝區裡丟過 log 的 Run（事件根本沒走到資料庫）。兩條路的
        #: 判斷條件不同，但使用者看到的是同一個標記。
        self._truncated: set[str] = set()
        self._task: asyncio.Task[None] | None = None
        self._wake = asyncio.Event()
        self.dropped = 0

    # ---- 生命週期 ----

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._loop())

    async def close(self) -> None:
        """關機：先停 task 再寫最後一批。順序反過來的話，寫完之後那個還活著的
        迴圈可能又醒來一次，而它要用的連線已經在關機路徑上了。"""
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        self.flush()

    # ---- 寫入端 ----

    def record(self, run_id: str, event: dict[str, Any]) -> None:
        """§6.3 的篩選 + 排進緩衝。不落地的事件在這裡就沒了。"""
        op = event.get("op")
        if op not in STORED_OPS:
            return

        if op == _DROPPABLE:
            self._logs[run_id] = self._logs.get(run_id, 0) + 1
            if self._logs[run_id] > self._log_limit:
                self._over_limit.add(run_id)

        seq = self._seq.get(run_id, 0) + 1
        self._seq[run_id] = seq
        self._pending.append((run_id, seq, op, {k: v for k, v in event.items() if k != "op"}))

        if len(self._pending) >= self._buffer_limit:
            self._spill()
        if len(self._pending) >= self._batch:
            self._wake.set()

    def flush(self) -> None:
        """把緩衝區寫進 SQLite。同步——呼叫端已經在需要它寫完的那一刻了。"""
        if not self._pending:
            self._enforce_limits()
            return
        pending, self._pending = self._pending, []
        by_run: dict[str, list[tuple[int, str, dict[str, Any]]]] = {}
        for run_id, seq, op, data in pending:
            by_run.setdefault(run_id, []).append((seq, op, data))
        for run_id, rows in by_run.items():
            self._store.append_events(run_id, rows)
        self._enforce_limits()

    def forget(self, run_id: str) -> None:
        """Run 收尾之後把它的計數器丟掉。不丟的話，一個開著三天的後端會為
        每一個跑過的 Run 各留一個整數——那正是這次落地要拿掉的那種東西。"""
        self._seq.pop(run_id, None)
        self._logs.pop(run_id, None)
        self._over_limit.discard(run_id)
        self._truncated.discard(run_id)

    # ---- 內部 ----

    def _spill(self) -> None:
        """緩衝區到頂：丟掉最舊的 `log`，骨架事件一筆都不動。

        丟的是**緩衝區裡**的，所以序號會出現空洞——那是對的，`GET .../events`
        回傳的 seq 本來就只保證遞增，不保證連續（§6.3 的 log 上限也會挖洞）。
        """
        keep: list[tuple[str, int, str, dict[str, Any]]] = []
        target = self._buffer_limit // 2
        dropped = 0
        for item in reversed(self._pending):  # 由新到舊，留新的
            if item[2] == _DROPPABLE and len(keep) >= target:
                self._truncated.add(item[0])
                dropped += 1
                continue
            keep.append(item)
        keep.reverse()
        self._pending = keep
        self.dropped += dropped

    def _enforce_limits(self) -> None:
        for run_id in list(self._over_limit):
            removed = self._store.enforce_log_limit(run_id, limit=self._log_limit)
            if run_id in self._logs:
                self._logs[run_id] = max(0, self._logs[run_id] - removed)
        self._over_limit.clear()
        for run_id in list(self._truncated):
            self._store.mark_logs_truncated(run_id)
        self._truncated.clear()

    async def _loop(self) -> None:
        while True:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), timeout=self._interval)
            self._wake.clear()
            try:
                self.flush()
            except Exception:  # noqa: BLE001
                # 寫不進去不該讓 Run 跟著死。歷史掉一批比流程停掉便宜得多，
                # 而 §6.3 的落地從頭到尾都是「事後回來查」用的。
                self._pending.clear()


__all__ = [
    "DEFAULT_BATCH",
    "DEFAULT_BUFFER",
    "DEFAULT_FLUSH_S",
    "STORED_OPS",
    "RunRecorder",
]

"""Run 的生命週期（§5.1、§5.5、附錄 A 的 `/api/runs`）。

一個 Run = 一個 `Interpreter` 實例 + 一個 `RunBroker` + 一個 driver task。
三者一起生、一起死，所以綁在同一個 `RunHandle` 上。

**跑的是已存檔的那一份專案**，不是前端當下畫布上的東西。這條規則讓「執行」
與「存檔」共用同一份驗證（§4 的載入期驗證在 PUT 就跑過了），也讓 Run 的
`projectId` 指得到一份真的存在、拿得回來的 IR——否則執行歷史會指向一份
只在某個瀏覽器分頁裡存在過的專案。前端因此必須先存再跑，那也正是使用者
按下「執行」時預期會發生的事。
"""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from blocky.api.validation import open_project
from blocky.interpreter.engine import Interpreter
from blocky.interpreter.events import EventSink
from blocky.interpreter.scope import InMemoryPersistStore
from blocky.runs.broker import RunBroker
from blocky.storage import ProjectStore

if TYPE_CHECKING:
    from blocky.extensions.registry import ExtensionRegistry

DEFAULT_TRIGGER = "event.when_flag_clicked"

# 記憶體裡留幾個跑完的 Run。§6.3 的 SQLite 落地還沒做，所以這是整個執行歷史
# ——上限存在是為了讓一個開著三天的編輯器不會慢慢吃光記憶體。
HISTORY_LIMIT = 50


class ProjectNotFound(LookupError):
    """`POST /api/runs` 指定的專案不存在。404，不是 422。"""


@dataclass
class RunHandle:
    id: str
    project_id: str
    trigger: str
    status: str  # running | ok | error | cancelled
    started_at: str
    broker: RunBroker
    interp: Interpreter
    payload: dict[str, Any] = field(default_factory=dict)
    registry: ExtensionRegistry | None = None
    task: asyncio.Task[None] | None = None
    ended_at: str | None = None

    @property
    def running(self) -> bool:
        return self.status == "running"

    def summary(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "runId": self.id,
            "projectId": self.project_id,
            "trigger": self.trigger,
            "status": self.status,
            "startedAt": self.started_at,
        }
        if self.ended_at is not None:
            d["endedAt"] = self.ended_at
        return d


class RunManager:
    """所有 Run 的登記處。一個 app 一個。"""

    def __init__(
        self,
        *,
        store: ProjectStore,
        extensions_root: Path,
        history_limit: int = HISTORY_LIMIT,
        broker_options: dict[str, Any] | None = None,
    ) -> None:
        self._store = store
        self._extensions_root = extensions_root
        self._history_limit = history_limit
        self._broker_options = broker_options or {}
        self._runs: dict[str, RunHandle] = {}
        self._seq = 0
        # §5.4 第 4 層：持久值以專案為範圍，**跨 Run 存活**（D12 的第 4 層）。
        # 這裡是 process 記憶體而不是 SQLite——「跨後端重啟」還沒實作（§6.3
        # 的落地一起做）。刻意用同一個物件而不是每個 Run 一份新的，是因為
        # 「跨 Run」才是 persist_* 存在的全部理由；每次重來的話 §5.4 那張表的
        # 第 3 層與第 4 層就沒有差別了。
        self._persist: dict[str, InMemoryPersistStore] = {}

    # ---- 查 ----

    def get(self, run_id: str) -> RunHandle | None:
        return self._runs.get(run_id)

    def list(self) -> list[RunHandle]:
        """新的在前。用插入順序而不是 `startedAt`——同一毫秒內連按兩次執行
        是完全正常的操作，排序鍵撞在一起時順序就不再穩定。"""
        return list(reversed(self._runs.values()))

    # ---- 開始 ----

    async def start(
        self,
        project_id: str,
        *,
        trigger: str = DEFAULT_TRIGGER,
        payload: dict[str, Any] | None = None,
    ) -> RunHandle:
        """驗證 → 載入 → 起 task。回來的時候 Run **已經在跑了**。

        載入期的錯誤（§4 的結構、§4.6 的 return 位置、§4.7 的 `${a+b}`）在這裡
        以 `ValidationError` 拋出，由路由翻成 422 + `blockId`——與存檔同一條路
        （`api/errors.py`）。已存檔的專案照理都驗過了，但積木包可能在存檔之後
        被移除或改壞，所以這一關不能省。
        """
        stored = self._store.get(project_id)
        if stored is None:
            raise ProjectNotFound(project_id)

        self._seq += 1
        run_id = f"r_{self._seq}"

        broker = RunBroker(run_id, **self._broker_options)
        # retain=False：事件送出去就丟。留著的話一個掛著跑的 `forever` 迴圈
        # 會把幾億筆事件堆在記憶體裡，而它們早就從 WebSocket 出去了。
        sink = EventSink(on_emit=lambda e: broker.publish(e.to_dict()), retain=False)

        project, registry = await open_project(
            stored.data, extensions_root=self._extensions_root, sink=sink
        )

        interp = Interpreter(
            project,
            sink=sink,
            persist=self._persist.setdefault(project_id, InMemoryPersistStore()),
            extensions=registry,
        )
        handle = RunHandle(
            id=run_id,
            project_id=project_id,
            trigger=trigger,
            status="running",
            started_at=_now(),
            broker=broker,
            interp=interp,
            payload=payload or {},
            registry=registry,
        )

        broker.start()
        handle.task = asyncio.create_task(self._drive(handle))
        self._runs[run_id] = handle
        self._prune()
        return handle

    # ---- 停 ----

    def stop(self, run_id: str, *, thread_id: str | None = None) -> bool:
        """§5.5 的外部停止。回傳有沒有停到東西。"""
        handle = self._runs.get(run_id)
        if handle is None or not handle.running:
            return False
        return handle.interp.request_stop(thread_id)

    async def shutdown(self) -> None:
        """關機時把還在跑的 Run 收乾淨——不然 uvicorn 會卡在未完成的 task 上。"""
        for handle in list(self._runs.values()):
            if handle.task is not None and not handle.task.done():
                handle.task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await handle.task

    # ---- 內部 ----

    async def _drive(self, handle: RunHandle) -> None:
        try:
            result = await handle.interp.run(
                run_id=handle.id, trigger=handle.trigger, payload=handle.payload
            )
            handle.status = result.status
        except asyncio.CancelledError:
            # 整個 Run 的 task 被砍（關機）。`stop()` 走的不是這條——它只 cancel
            # thread，讓 `run()` 自己收尾成 status=cancelled。
            handle.status = "cancelled"
            handle.broker.publish(
                {"op": "run.end", "runId": handle.id, "status": "cancelled"}
            )
            raise
        except BaseException as e:  # 引擎自己爆了也要有 run.end
            # 到得了這裡代表是 runtime 的 bug（積木層級的錯誤在 `_run_thread`
            # 就變成 `block.error` 了）。前端仍然必須收到一個結尾事件，否則
            # 「執行中」的狀態會永遠掛著。
            handle.status = "error"
            handle.broker.publish(
                {
                    "op": "run.end",
                    "runId": handle.id,
                    "status": "error",
                    "error": {"type": type(e).__name__, "message": str(e)},
                }
            )
        finally:
            handle.ended_at = _now()
            # 先關 broker：最後那個 run.end 還在 50ms 的窗口裡等著，卸載積木包
            # 若卡住，使用者會看到一個永遠沒有結尾的 Run。
            handle.broker.close()
            if handle.registry is not None:
                with contextlib.suppress(Exception):
                    await handle.registry.unload_all()
                handle.registry = None

    def _prune(self) -> None:
        finished = [h for h in self._runs.values() if not h.running]
        excess = len(finished) - self._history_limit
        if excess <= 0:
            return
        for handle in finished[:excess]:  # 插入順序 = 由舊到新
            self._runs.pop(handle.id, None)


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


__all__ = ["DEFAULT_TRIGGER", "ProjectNotFound", "RunHandle", "RunManager"]

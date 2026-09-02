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
from blocky.errors import ValidationError
from blocky.interpreter.engine import DEFAULT_TRIGGER, Entry, Interpreter
from blocky.interpreter.events import Event, EventSink
from blocky.interpreter.scope import InMemoryPersistStore
from blocky.runs.broker import ProjectHub, RunBroker
from blocky.runs.recorder import RunRecorder
from blocky.storage import ProjectStore
from blocky.storage.runs import RUN_LIMIT_PER_PROJECT, RunStore, SqlitePersistStore

if TYPE_CHECKING:
    from blocky.extensions.registry import ExtensionRegistry

# 「點一下就跑」（§5.1）沒有 trigger——它的起點是一顆積木。用一個名字佔住
# `trigger` 欄位而不是留空，執行歷史那一欄才不會有一半是空白。
MANUAL_TRIGGER = "manual"

# 跑完的 Run 在記憶體裡多留一會兒。**這不是執行歷史**——歷史在 SQLite（§6.3
# 的落地），而且不再有筆數上限這種東西（那個上限現在叫 `RUN_LIMIT_PER_PROJECT`，
# 管的是硬碟）。
#
# 留著的理由只有一個：`POST /api/runs` 回來到前端把 WebSocket 接上，中間有幾
# 毫秒空窗，而那段時間的事件由 `RunBroker` 的 backlog 接住。一個跑得夠快的
# Run 會在客戶端連上來之前就結束——把 handle 立刻丟掉，那些事件就跟著沒了，
# 使用者看到的是一個空的執行結果。
#
# 數字小是刻意的：它衡量的是「使用者的瀏覽器慢多久」，不是「使用者想回頭看
# 多少次執行」。後者由 SQLite 回答。
HANDOFF_LIMIT = 50


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
    #: 「點一下就跑」（§5.1）點的那顆積木。None = 這是一次 trigger 執行。
    block_id: str | None = None
    entry: Entry | None = None

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
        # 手動執行的 trigger 是 `manual`，光看它不知道跑的是哪一顆積木——
        # 而執行歷史裡「點了什麼」正是使用者唯一分得出兩次點擊的線索。
        if self.block_id is not None:
            d["blockId"] = self.block_id
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
        runs_store: RunStore | None = None,
        recorder: RunRecorder | None = None,
        run_limit: int = RUN_LIMIT_PER_PROJECT,
        handoff_limit: int = HANDOFF_LIMIT,
        broker_options: dict[str, Any] | None = None,
    ) -> None:
        self._store = store
        self._extensions_root = extensions_root
        self._runs_store = runs_store
        self._recorder = recorder
        self._run_limit = run_limit
        self._handoff_limit = handoff_limit
        self._broker_options = broker_options or {}
        self._runs: dict[str, RunHandle] = {}
        # 專案 → 事件通道（§9）。與 `_runs` 分開的生命週期：一個專案的通道在
        # 兩個 Run 之間仍然活著，因為訂閱它的人要等的正是**下一個** Run。
        self._hubs: dict[str, ProjectHub] = {}
        # 沒有 `runs_store` 時的退路：`r_1`、`r_2`…，同落地之前的行為。給的是
        # 不需要歷史的呼叫端（題庫、單元測試）——有了 store 之後序號改從資料庫
        # 拿，因為 process 的計數器每次重啟都從 1 開始，會直接撞上昨天那一筆。
        self._seq = 0
        # §5.4 第 4 層：持久值以專案為範圍，**跨 Run、跨後端重啟存活**（D12）。
        # 沒有 `runs_store` 時退回記憶體——那時「跨後端重啟」本來就無從談起。
        # 刻意快取同一個物件而不是每個 Run 一份新的，是因為「跨 Run」才是
        # persist_* 存在的全部理由。
        self._persist: dict[str, InMemoryPersistStore | SqlitePersistStore] = {}

    # ---- 查 ----

    def get(self, run_id: str) -> RunHandle | None:
        """記憶體裡那份：還在跑的，加上剛跑完、還在交接窗口裡的。

        停止與 WebSocket 要的是 broker 與 interp，而它們沒有一個存得進 SQLite。
        更早以前的 Run 在這裡查不到是對的——那時候要的是 `summary()`／
        `events()`，不是一個已經關掉的 broker。
        """
        return self._runs.get(run_id)

    def has_project(self, project_id: str) -> bool:
        """這個專案存不存在。`/ws/project/{id}` 用它決定要不要收這條連線——
        打錯 id 的話，那條 socket 會安靜地永遠等不到任何東西。"""
        return self._store.get(project_id) is not None

    def has_running(self, project_id: str, trigger: str) -> bool:
        """這個專案的這個 trigger 現在有沒有還在跑的 Run（§5.1 的 `drop`）。

        只問記憶體：跑完的 Run 在 SQLite，而那裡的 `running` 有可能是上一次
        後端被砍掉留下的（§6.3 的 `interrupted` 補標之前）。**「現在還在跑」
        只有這個 process 答得出來。**
        """
        return any(
            h.running and h.project_id == project_id and h.trigger == trigger
            for h in self._runs.values()
        )

    def summary(self, run_id: str) -> dict[str, Any] | None:
        """給 HTTP 用的那一份。活的、跑完的、上次開機跑的，都走這裡。

        以 SQLite 為準而不是先問記憶體：`start()` 與收尾都是**同步**寫進那一
        列的，所以它永遠是最新的；兩邊都問則要多一條「哪一邊贏」的規則，而
        那條規則遲早會答錯一次。
        """
        if self._runs_store is not None:
            stored = self._runs_store.get(run_id)
            return stored.summary() if stored is not None else None
        handle = self._runs.get(run_id)
        return handle.summary() if handle is not None else None

    def list(self, *, project_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        """新的在前。落地之後這是**執行歷史**，不再只是這個 process 記得的
        那幾筆——P2 的驗收句（關掉瀏覽器，隔天回來查）踩的就是這裡。"""
        if self._runs_store is not None:
            return [r.summary() for r in self._runs_store.list(project_id=project_id, limit=limit)]
        # 退路：用插入順序而不是 `startedAt`——同一毫秒內連按兩次執行是完全
        # 正常的操作，排序鍵撞在一起時順序就不再穩定。
        runs = [h for h in reversed(self._runs.values()) if project_id in (None, h.project_id)]
        return [h.summary() for h in runs[:limit]]

    def events(self, run_id: str, *, after: int = 0, limit: int = 5000) -> list[dict[str, Any]]:
        """§6.3 的執行歷史。沒有落地就沒有歷史——回空的，不是報錯：那個端點
        存在與否不該取決於呼叫端有沒有給 store。"""
        if self._runs_store is None:
            return []
        # 還在跑的 Run 有一批事件卡在 writer 的緩衝區裡。使用者在執行中按下
        # 「歷史」看到的必須是**現在**，不是 250 毫秒前。
        if self._recorder is not None:
            self._recorder.flush()
        return self._runs_store.events(run_id, after=after, limit=limit)

    # ---- 開始 ----

    async def start(
        self,
        project_id: str,
        *,
        trigger: str = DEFAULT_TRIGGER,
        payload: dict[str, Any] | None = None,
        block_id: str | None = None,
    ) -> RunHandle:
        """驗證 → 載入 → 起 task。回來的時候 Run **已經在跑了**。

        載入期的錯誤（§4 的結構、§4.6 的 return 位置、§4.7 的 `${a+b}`）在這裡
        以 `ValidationError` 拋出，由路由翻成 422 + `blockId`——與存檔同一條路
        （`api/errors.py`）。已存檔的專案照理都驗過了，但積木包可能在存檔之後
        被移除或改壞，所以這一關不能省。

        `block_id` 給了就是「點一下就跑」（§5.1）：起點在**建立 task 之前**就
        解析完，所以「畫布上有、存檔裡沒有」（存檔失敗了卻還是點了一下）會是
        一個 422，而不是一個開始了又立刻死掉、還占著一格執行歷史的 Run。
        """
        stored = self._store.get(project_id)
        if stored is None:
            raise ProjectNotFound(project_id)

        if self._runs_store is not None:
            seq = self._runs_store.next_seq()
        else:
            self._seq += 1
            seq = self._seq
        run_id = f"r_{seq}"

        hub = self.hub(project_id)
        broker = RunBroker(
            run_id,
            on_frame=lambda batch: hub.publish(run_id, batch),
            **self._broker_options,
        )
        recorder = self._recorder

        def emit(e: Event) -> None:
            # 兩個消費者，兩套規則：§6.2 決定送多少給前端，§6.3 決定存多少到
            # 硬碟。同一份事件在這裡分岔，而**分岔點只有這一個**——兩邊各自
            # 訂閱一次的話，「這件事有沒有發生過」就有兩個答案。
            d = e.to_dict()
            broker.publish(d)
            if recorder is not None:
                recorder.record(run_id, d)

        # retain=False：事件送出去就丟。留著的話一個掛著跑的 `forever` 迴圈
        # 會把幾億筆事件堆在記憶體裡，而它們早就從 WebSocket 出去了。
        sink = EventSink(on_emit=emit, retain=False)

        project, registry = await open_project(
            stored.data, extensions_root=self._extensions_root, sink=sink
        )

        interp = Interpreter(
            project,
            sink=sink,
            persist=self._persist_for(project_id),
            extensions=registry,
        )
        entry: Entry | None = None
        if block_id is not None:
            try:
                entry = interp.entry_for(block_id)
            except ValidationError:
                if registry is not None:
                    await registry.unload_all()
                raise

        handle = RunHandle(
            id=run_id,
            project_id=project_id,
            trigger=MANUAL_TRIGGER if block_id is not None else trigger,
            status="running",
            started_at=_now(),
            broker=broker,
            interp=interp,
            payload=payload or {},
            registry=registry,
            block_id=block_id,
            entry=entry,
        )

        started_at = handle.started_at
        if self._runs_store is not None:
            # **同步寫，不進 writer 的緩衝區。** `POST /api/runs` 回來之後前端
            # 立刻會 `GET /api/runs`；排進批次的話那次 GET 有機會看不到剛剛
            # 才建立的 Run。一個 Run 只有兩次這種寫入，成本可以忽略。
            self._runs_store.start(
                run_id,
                seq=seq,
                project_id=project_id,
                trigger=handle.trigger,
                started_at=started_at,
                block_id=block_id,
            )

        broker.start()
        handle.task = asyncio.create_task(self._drive(handle))
        self._runs[run_id] = handle
        return handle

    def hub(self, project_id: str) -> ProjectHub:
        """這個專案的事件通道（`/ws/project/{id}`）。第一次問到才建。

        **不隨 Run 結束而消失**：訂閱它的人要等的是下一個 Run，而 hat 觸發的
        Run 什麼時候發生沒有人知道——那正是這條通道存在的理由。
        """
        if (found := self._hubs.get(project_id)) is None:
            found = self._hubs[project_id] = ProjectHub(project_id)
        return found

    def _persist_for(self, project_id: str) -> InMemoryPersistStore | SqlitePersistStore:
        if (existing := self._persist.get(project_id)) is not None:
            return existing
        store: InMemoryPersistStore | SqlitePersistStore
        if self._runs_store is not None:
            store = SqlitePersistStore(self._runs_store, project_id)
        else:
            store = InMemoryPersistStore()
        self._persist[project_id] = store
        return store

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
        # 最後才收 writer：上面那些 task 被 cancel 之後還會走一次 `_settle`，
        # 而它要 writer 還活著。
        if self._recorder is not None:
            await self._recorder.close()

    # ---- 內部 ----

    async def _drive(self, handle: RunHandle) -> None:
        try:
            result = await handle.interp.run(
                run_id=handle.id,
                trigger=handle.trigger,
                payload=handle.payload,
                entry=handle.entry,
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
            self._settle(handle)
            if handle.registry is not None:
                with contextlib.suppress(Exception):
                    await handle.registry.unload_all()
                handle.registry = None
            # 不立刻丟：WebSocket 可能還沒接上來（見 HANDOFF_LIMIT）。
            self._prune_handoff()

    def _prune_handoff(self) -> None:
        """記憶體只留還在跑的 + 最近 N 個跑完的。與 §6.3 的剪枝是兩件事：
        那個管硬碟上的執行歷史，這個管 WebSocket 的交接窗口。"""
        finished = [h for h in self._runs.values() if not h.running]
        excess = len(finished) - self._handoff_limit
        for handle in finished[:excess]:  # 插入順序 = 由舊到新
            self._runs.pop(handle.id, None)

    def _settle(self, handle: RunHandle) -> None:
        """把 Run 的結尾寫進 SQLite。

        順序是**先 flush 再 finish**：緩衝區裡最後那幾筆正是 `thread.end` 與
        `run.end`，而收尾之後才寫的話，一個「已完成」的 Run 會有幾百毫秒是
        少了結尾事件的——那正是使用者點進去要看的東西。
        """
        if self._runs_store is None:
            return
        if self._recorder is not None:
            with contextlib.suppress(Exception):
                self._recorder.flush()
            self._recorder.forget(handle.id)
        with contextlib.suppress(Exception):
            self._runs_store.finish(
                handle.id,
                status=handle.status,
                ended_at=handle.ended_at or _now(),
            )
            self._runs_store.prune(handle.project_id, keep=self._run_limit)

def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


__all__ = [
    "DEFAULT_TRIGGER",
    "HANDOFF_LIMIT",
    "MANUAL_TRIGGER",
    "ProjectNotFound",
    "RunHandle",
    "RunManager",
]

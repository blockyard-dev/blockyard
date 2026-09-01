"""Trigger Manager（§9，P2 第 2 步）。

這是 `runs/listeners.py` 長大之後的樣子。那個檔案的檔頭列了一張「§9.2 要的 /
這裡有嗎」的表，四格全是叉；這裡把前三格補上：

| §9.2 要的 | 這裡 |
|---|---|
| 專案標記為 active，與瀏覽器無關 | ✅ `storage/triggers.py` 的表 |
| diff 新舊 IR 的 hat 集合、只重啟有變動的 | ✅ 見下面的「鍵與規格」 |
| 後端重啟時從 SQLite 恢復 | ✅ `restore()`，由 lifespan 呼叫 |
| cron 內建 trigger | ✅ 第 2b 步 |
| webhook 內建 trigger | ✳️ 第 2c 步 |

## 鍵與規格

§9.2 說「只重啟有變動的」，而要做到那件事就得先回答「什麼算同一顆 trigger」。
每一顆 trigger 有兩個東西：

    key    它是誰。相同的 key 在兩次 sync 之間就是同一顆。
    spec   它靠什麼活著。spec 變了就得重接，key 變了就是換了一顆。

積木包的 hat：key 是 opcode，spec 是空的。一條連線服務畫布上所有同 opcode 的
腳本（`_triggered()` 會把它們全部選中），所以同一顆 hat 放兩次不該開兩條連線。

內建的 cron 是 `event.when_cron#<blockId>`，spec 是 `(運算式, 時區)`——兩顆 cron
積木是兩份排程，而改了時間就得重排。webhook（第 2c 步）會是同一個形狀。

**這個分法的用處全在「不要無謂斷開」上。** 使用者改一顆 log 積木的文字然後存檔，
Discord 的 gateway 不該斷線重連——那會掉訊息，而且要花好幾秒。
"""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from blocky.api.validation import open_project
from blocky.cron import CRON_OPCODE, CronSpec
from blocky.cron import parse as parse_cron
from blocky.extensions import discover
from blocky.interpreter.events import EventSink
from blocky.runs.manager import ProjectNotFound, RunManager
from blocky.storage import ProjectStore
from blocky.storage.triggers import ActiveStore

if TYPE_CHECKING:
    from blocky.extensions.registry import ExtensionRegistry

#: 一個專案留幾則 trigger 期間的錯誤。trigger 可以掛著好幾天，而使用者要看的
#: 永遠是「它為什麼停了」——最後幾則就夠。
ERROR_LIMIT = 20


@dataclass(frozen=True)
class Want:
    """這份 IR 要的一顆 trigger。`_desired()` 的產物，`_bind()` 的輸入。"""

    opcode: str
    spec: tuple[Any, ...]
    #: 內建 cron 才有。有值就走排程器，沒有就走積木包的 `start_trigger`。
    cron: CronSpec | None = None
    #: 積木包 id；內建的（`event.*`）是 None。registry 要不要重載只看這一欄。
    ext_id: str | None = None
    #: §5.1 宣告的併發模式。
    concurrency: str = "parallel"


@dataclass
class Bound:
    """一顆接上去的 trigger。

    `handle` 是積木包的 `TriggerHandle`（有 `stop()`）；內建的 cron 沒有
    handle，它的身分是排程器裡的 job id——兩種停法不同，所以分兩個欄位而不是
    硬湊一個共同介面。**共同的是 key 與 spec**，那才是 diff 要的東西。
    """

    key: str
    opcode: str
    spec: tuple[Any, ...]
    handle: Any = None
    job_id: str | None = None


@dataclass
class ProjectTriggers:
    """一個 active 專案的 trigger 狀態。"""

    project_id: str
    activated_at: str
    #: key → 已接上的那顆
    bound: dict[str, Bound] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    registry: ExtensionRegistry | None = None

    @property
    def hats(self) -> list[str]:
        """接上的 hat opcode。去重複後照接上的順序。"""
        out: list[str] = []
        for b in self.bound.values():
            if b.opcode not in out:
                out.append(b.opcode)
        return out

    def summary(self) -> dict[str, Any]:
        return {
            "projectId": self.project_id,
            "active": True,
            "activatedAt": self.activated_at,
            "hats": self.hats,
            "errors": list(self.errors),
        }


class TriggerManager:
    """所有 active 專案的 trigger。一個 app 一個，與 `RunManager` 並排。"""

    def __init__(
        self,
        *,
        store: ProjectStore,
        extensions_root: Path,
        runs: RunManager,
        active: ActiveStore,
    ) -> None:
        self._store = store
        self._extensions_root = extensions_root
        self._runs = runs
        self._active = active
        self._projects: dict[str, ProjectTriggers] = {}
        #: 整個 app 一個排程器，懶啟動（見 `_scheduler`）。
        self._sched: AsyncIOScheduler | None = None

    # ---- 查 ----

    def get(self, project_id: str) -> ProjectTriggers | None:
        return self._projects.get(project_id)

    def list(self) -> list[ProjectTriggers]:
        return list(self._projects.values())

    # ---- 開關 ----

    async def activate(self, project_id: str) -> ProjectTriggers:
        """標記 active 並接上它的 trigger。**已經 active 就重新同步一次**。

        重複啟用不是錯誤：前端的「執行」會順手打開（使用者不必知道那是兩件
        事），所以「已經開著」是最常見的情況。而重新同步而不是原樣回去，是因為
        使用者按下去的意思是「照現在這份畫布跑」——中間存過檔的話，原樣回去等
        於讓那顆按鈕在最需要它做事的時候什麼都不做。
        """
        stored = self._store.get(project_id)
        if stored is None:
            raise ProjectNotFound(project_id)

        # **先寫 active 再接。** 反過來的話，接到一半炸掉就會留下一個「跑著但
        # 不是 active」的專案，重啟之後安靜消失。寫在前面則最壞情況是「標成
        # active 但這次沒接上」——那個狀態看得見（errors 裡有話），而且重啟會
        # 再試一次。
        self._active.activate(project_id)
        state = self._projects.get(project_id)
        if state is None:
            state = ProjectTriggers(project_id=project_id, activated_at=_now())
            self._projects[project_id] = state
        await self._sync(state, stored.data)
        return state

    async def deactivate(self, project_id: str) -> bool:
        """停掉並取消 active。回傳原本是不是 active。"""
        was = self._active.deactivate(project_id)
        state = self._projects.pop(project_id, None)
        if state is not None:
            await self._teardown(state)
        return was or state is not None

    async def resync(self, project_id: str) -> None:
        """專案存檔之後重新對齊（§9.2 的「專案編輯後」）。

        不是 active 就什麼都不做——存檔不該把一個關著的專案打開。
        """
        state = self._projects.get(project_id)
        if state is None:
            return
        stored = self._store.get(project_id)
        if stored is None:
            await self.deactivate(project_id)
            return
        await self._sync(state, stored.data)

    async def restore(self) -> int:
        """啟動時恢復所有 active 專案（§9.2 最後一句）。回傳恢復了幾個。

        **一個專案接不上不能讓其他的跟著不接。** 這是啟動路徑，而積木包壞掉、
        token 過期、專案被手動刪掉都是完全正常的事——把例外往上拋等於讓一顆壞
        掉的 Discord token 擋住整個後端起不來。
        """
        restored = 0
        for entry in self._active.list():
            stored = self._store.get(entry.project_id)
            if stored is None:
                # 專案在後端沒開的時候被刪掉了（或資料庫被手動改過）。
                self._active.deactivate(entry.project_id)
                continue
            state = ProjectTriggers(
                project_id=entry.project_id, activated_at=entry.activated_at
            )
            self._projects[entry.project_id] = state
            try:
                await self._sync(state, stored.data)
            except Exception as e:  # noqa: BLE001
                _push(state, f"重啟後接不上：{type(e).__name__}: {e}")
            restored += 1
        return restored

    async def shutdown(self) -> None:
        """關機：停掉連線與排程，但**不動 active 那張表**——那正是重啟後要恢復
        的東西。"""
        for project_id in list(self._projects):
            state = self._projects.pop(project_id)
            await self._teardown(state)
        if self._sched is not None:
            with contextlib.suppress(Exception):
                self._sched.shutdown(wait=False)
            self._sched = None

    # ---- 同步 ----

    async def _sync(self, state: ProjectTriggers, data: Any) -> None:
        """把已接上的那組對齊到這份 IR 要的那組。§9.2 的 diff 就是這裡。"""
        desired = _desired(data, self._extensions_root)

        # 積木包的集合變了就整組重來：registry 是一次載入一整組子行程（§7.6），
        # 沒有「只換掉其中一個」這種操作。這比 trigger 層的 diff 粗，但它只在
        # 使用者真的加減了積木包時才發生，而那本來就是一次大改。
        #
        # **cron 不算在裡面。** 它不需要積木包，所以「這份畫布只改了一顆 cron
        # 的時間」不該把 Discord 的 gateway 拆掉重建。
        want_exts = {w.ext_id for w in desired.values() if w.ext_id}
        have_exts = {b.opcode.split(".", 1)[0] for b in state.bound.values() if "." in b.opcode
                     and not b.opcode.startswith("event.")}

        if want_exts and (state.registry is None or want_exts != have_exts):
            for key in [k for k, b in state.bound.items() if b.handle is not None]:
                await self._unbind(state, key)
            if state.registry is not None:
                with contextlib.suppress(Exception):
                    await state.registry.unload_all()
                state.registry = None
            sink = EventSink(on_emit=lambda e: _collect(state, e), retain=False)
            _, registry = await open_project(
                data, extensions_root=self._extensions_root, sink=sink
            )
            state.registry = registry
        elif not want_exts and state.registry is not None:
            # 積木包的 hat 全部拿掉了：那些子行程留著什麼事都不會做（§7.6）。
            for key in [k for k, b in state.bound.items() if b.handle is not None]:
                await self._unbind(state, key)
            with contextlib.suppress(Exception):
                await state.registry.unload_all()
            state.registry = None

        stale = {
            key
            for key, want in desired.items()
            if key in state.bound and state.bound[key].spec != want.spec
        }
        gone = set(state.bound) - set(desired)
        for key in gone | stale:
            await self._unbind(state, key)

        await self._bind(state, desired, (set(desired) - set(state.bound)) | stale)

    async def _bind(
        self, state: ProjectTriggers, desired: dict[str, Want], keys: set[str]
    ) -> None:
        for key in sorted(keys):
            want = desired[key]
            try:
                if want.cron is not None:
                    bound = self._schedule(state, key, want)
                else:
                    bound = await self._connect(state, key, want)
            except Exception as e:  # noqa: BLE001
                # 一顆接不上不該讓其他的跟著不接：一個專案可以同時聽 Discord
                # 與 Slack，而 Discord 的 token 過期不該讓 Slack 也停掉。
                _push(state, f"{want.opcode} 接不上：{type(e).__name__}: {e}")
                continue
            if bound is not None:
                state.bound[key] = bound

    async def _connect(self, state: ProjectTriggers, key: str, want: Want) -> Bound | None:
        registry = state.registry
        if registry is None:
            return None
        handle = await registry.start_trigger(
            want.opcode, _forward(self, state.project_id, want.opcode, want.concurrency)
        )
        return Bound(key=key, opcode=want.opcode, spec=want.spec, handle=handle)

    def _schedule(self, state: ProjectTriggers, key: str, want: Want) -> Bound:
        """把一顆 cron 積木排進 APScheduler（§9.1）。

        job id 含 project_id，因為排程器是**整個 app 一個**：兩個專案各有一顆
        `when_cron` 積木、blockId 又剛好一樣（複製貼上一份專案就會這樣），沒有
        前綴的話後排進去的那顆會蓋掉前一顆——而使用者只會看到「其中一個流程
        不跑了」。
        """
        assert want.cron is not None
        job_id = f"{state.project_id}:{key}"
        fire = _forward(self, state.project_id, want.opcode, want.concurrency)
        payload_of = _cron_payload

        async def tick() -> None:
            await fire(payload_of(want.cron))

        self._scheduler().add_job(
            tick,
            want.cron.trigger(),
            id=job_id,
            replace_existing=True,
            # 錯過的班次不補跑，而且只補最近那一次。後端關了一整夜再開機時，
            # 使用者要的是「從現在開始準時跑」，不是「把昨晚十二次補完」——
            # 那會在開機瞬間送出十二則 Discord 訊息。
            misfire_grace_time=None,
            coalesce=True,
        )
        return Bound(key=key, opcode=want.opcode, spec=want.spec, job_id=job_id)

    def _scheduler(self) -> AsyncIOScheduler:
        """**懶啟動。** 一個沒有任何 cron 的後端不該有一條排程器的執行緒在轉，
        而絕大多數專案沒有 cron。"""
        if self._sched is None:
            self._sched = AsyncIOScheduler(timezone="UTC")
            self._sched.start()
        return self._sched

    async def _teardown(self, state: ProjectTriggers) -> None:
        for key in list(state.bound):
            await self._unbind(state, key)
        if state.registry is not None:
            with contextlib.suppress(Exception):
                await state.registry.unload_all()
            state.registry = None

    async def _unbind(self, state: ProjectTriggers, key: str) -> None:
        bound = state.bound.pop(key, None)
        if bound is None:
            return
        if bound.job_id is not None and self._sched is not None:
            with contextlib.suppress(Exception):
                self._sched.remove_job(bound.job_id)
        if bound.handle is not None:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await bound.handle.stop()


# --------------------------------------------------------------------------


def _desired(data: Any, extensions_root: Path) -> dict[str, Want]:
    """這份 IR 要接哪些 trigger：key → `Want`。

    **只讀 manifest，不載程式碼。** 積木包宣告是資料（manifest 在磁碟上，任何
    process 讀得到），所以「這份畫布上有沒有要接的東西」問得出來，不必先把包載
    起來才知道。差別很實際：`open_project` 會替每個宣告過的包各起一個子行程
    （§7.6），而絕大多數畫布上一顆 hat 都沒有。

    條件跟 §5.1 的觸發條件是同一條——**腳本最上面那顆積木**。綠旗不在這裡：
    它根本不是要接的東西，它的觸發是前端 POST `/api/runs`（§9.1）。
    """
    if not isinstance(data, dict):
        return {}
    blocks = data.get("blocks") or {}
    sources = discover(extensions_root)
    out: dict[str, Want] = {}

    for script in data.get("scripts") or []:
        if not isinstance(script, dict):
            continue
        top = script.get("top")
        block = blocks.get(top) or {}
        opcode = block.get("opcode")
        if not isinstance(opcode, str) or "." not in opcode:
            continue

        if opcode == CRON_OPCODE:
            # 兩顆 cron 積木是兩份排程，所以 key 含 blockId；改了時間或時區就
            # 得重排，所以 spec 是那兩個值。**存檔時已經驗過**（§9.1 的
            # `cron.parse` 是同一份實作），所以這裡解不開才是真的意外——
            # 讓它冒出去，由 `_bind` 記成這個專案的一則錯誤。
            cron = parse_cron(block.get("fields") or {}, block_id=top)
            out[f"{CRON_OPCODE}#{top}"] = Want(
                opcode=opcode,
                spec=cron.spec,
                cron=cron,
                concurrency=_declared_concurrency(opcode),
            )
            continue

        ext_id = opcode.split(".", 1)[0]
        source = sources.get(ext_id)
        spec_decl = source.manifest.block(opcode) if source else None
        if spec_decl is None or spec_decl.type != "hat":
            continue
        # 積木包的 hat：一條連線服務所有同 opcode 的腳本，所以 key 就是 opcode，
        # 而它不吃參數，所以 spec 是空的。
        out[opcode] = Want(
            opcode=opcode,
            spec=(),
            ext_id=ext_id,
            concurrency=spec_decl.concurrency or "parallel",
        )
    return out


def _declared_concurrency(opcode: str) -> str:
    """內建 hat 宣告的併發模式（§5.1）。讀宣告而不是寫死——D21。"""
    from blocky.interpreter import declarations

    spec = declarations.block(opcode)
    return (spec.concurrency if spec else None) or "parallel"


def _cron_payload(cron: CronSpec) -> dict[str, Any]:
    """`when_cron` 的 `yields`：`scheduled_at`（§4.9 的時間戳是 object，不是
    number）。用**排程的那個時區**算，不是 UTC——使用者設的是「早上九點」，
    那句話只在他的時區裡成立。"""
    now = datetime.now(ZoneInfo(cron.timezone))
    return {
        "scheduled_at": {
            "iso": now.isoformat(),
            "epoch": now.timestamp(),
            "timezone": cron.timezone,
        }
    }


def _forward(
    manager: TriggerManager, project_id: str, opcode: str, concurrency: str = "parallel"
) -> Any:
    """一次 yield → 一個 Run。

    起 Run 失敗（專案被刪了、積木包被移掉、IR 在存檔之後壞了）**不能讓整條
    trigger 跟著死**：那條連線還好好的，下一則訊息仍然應該有機會跑起來。所以
    錯誤記在專案上，讓使用者看得到「有事件進來但跑不動」，而不是安靜地少掉
    幾則。

    `concurrency: drop`（§5.1）在這裡實作：上一個還沒跑完就跳過這一次。
    `when_cron` 宣告的就是 drop，而它是真的需要——一個十二點的排程如果自己跑
    兩小時，沒有這條規則就會愈疊愈多。**`queue` 與 `restart` 還沒實作**，目前
    與 `parallel` 同行為（§17.2 那幾題也還寫不出來）。
    """

    async def sink(payload: dict[str, Any]) -> None:
        if concurrency == "drop" and manager._runs.has_running(project_id, opcode):
            state = manager._projects.get(project_id)
            if state is not None:
                _push(state, f"{opcode} 上一次還沒跑完，這一次跳過（concurrency: drop）")
            return
        try:
            await manager._runs.start(project_id, trigger=opcode, payload=payload)
        except Exception as e:  # noqa: BLE001
            state = manager._projects.get(project_id)
            if state is not None:
                _push(state, f"{opcode} 收到事件但跑不起來：{type(e).__name__}: {e}")

    return sink


def _collect(state: ProjectTriggers, event: Any) -> None:
    """trigger 期間的事件流。目前只留錯誤。

    一般的 `log` 不留：trigger 沒有自己的 UI，而每一則訊息真正做的事都在它自己
    那個 Run 的事件流裡（前端本來就在看那條）。留下來的只有**沒有 Run 可以歸屬**
    的那一種——連線死掉的那句話。
    """
    data = event.data
    if event.op == "log" and data.get("level") == "error":
        _push(state, str(data.get("text", "")))


def _push(state: ProjectTriggers, text: str) -> None:
    state.errors.append(text)
    del state.errors[:-ERROR_LIMIT]


def _now() -> str:
    return datetime.now(UTC).isoformat()


__all__ = ["ERROR_LIMIT", "Bound", "ProjectTriggers", "TriggerManager", "Want"]

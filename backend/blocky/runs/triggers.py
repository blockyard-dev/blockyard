"""Trigger Manager（§9，P2 第 2 步）。

這是 `runs/listeners.py` 長大之後的樣子。那個檔案的檔頭列了一張「§9.2 要的 /
這裡有嗎」的表，四格全是叉；這裡把前三格補上：

| §9.2 要的 | 這裡 |
|---|---|
| 專案標記為 active，與瀏覽器無關 | ✅ `storage/triggers.py` 的表 |
| diff 新舊 IR 的 hat 集合、只重啟有變動的 | ✅ 見下面的「鍵與規格」 |
| 後端重啟時從 SQLite 恢復 | ✅ `restore()`，由 lifespan 呼叫 |
| cron / webhook 內建 trigger | ✳️ 第 2b、2c 步 |

## 鍵與規格

§9.2 說「只重啟有變動的」，而要做到那件事就得先回答「什麼算同一顆 trigger」。
每一顆 trigger 有兩個東西：

    key    它是誰。相同的 key 在兩次 sync 之間就是同一顆。
    spec   它靠什麼活著。spec 變了就得重接，key 變了就是換了一顆。

積木包的 hat：key 是 opcode，spec 是空的。一條連線服務畫布上所有同 opcode 的
腳本（`_triggered()` 會把它們全部選中），所以同一顆 hat 放兩次不該開兩條連線。

內建的 cron / webhook（第 2b、2c 步）會是 `opcode#blockId`，spec 是那顆積木的
參數——兩顆 cron 積木是兩份排程，而改了時間就得重排。

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

from blocky.api.validation import open_project
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


@dataclass
class Bound:
    """一顆接上去的 trigger。"""

    key: str
    opcode: str
    spec: tuple[Any, ...]
    handle: Any


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
            await _teardown(state)
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
        """關機：停掉連線，但**不動 active 那張表**——那正是重啟後要恢復的東西。"""
        for state in list(self._projects.values()):
            await _teardown(state)
        self._projects.clear()

    # ---- 同步 ----

    async def _sync(self, state: ProjectTriggers, data: Any) -> None:
        """把已接上的那組對齊到這份 IR 要的那組。§9.2 的 diff 就是這裡。"""
        desired = _desired(data, self._extensions_root)

        if not desired:
            await _teardown(state)
            return

        # 積木包的集合變了就整組重來：registry 是一次載入一整組子行程（§7.6），
        # 沒有「只換掉其中一個」這種操作。這比 trigger 層的 diff 粗，但它只在
        # 使用者真的加減了積木包時才發生，而那本來就是一次大改。
        want_exts = {op.split(".", 1)[0] for op in {v[0] for v in desired.values()}}
        have_exts = {b.opcode.split(".", 1)[0] for b in state.bound.values()}
        if state.registry is None or want_exts != have_exts:
            await _teardown(state)
            sink = EventSink(on_emit=lambda e: _collect(state, e), retain=False)
            project, registry = await open_project(
                data, extensions_root=self._extensions_root, sink=sink
            )
            state.registry = registry
            await self._bind(state, desired, set(desired))
            return

        stale = {
            key
            for key, (_, spec) in desired.items()
            if key in state.bound and state.bound[key].spec != spec
        }
        gone = set(state.bound) - set(desired)
        for key in gone | stale:
            await _unbind(state, key)
        await self._bind(state, desired, (set(desired) - set(state.bound)) | stale)

    async def _bind(
        self,
        state: ProjectTriggers,
        desired: dict[str, tuple[str, tuple[Any, ...]]],
        keys: set[str],
    ) -> None:
        registry = state.registry
        if registry is None:
            return
        for key in sorted(keys):
            opcode, spec = desired[key]
            try:
                handle = await registry.start_trigger(
                    opcode, _forward(self, state.project_id, opcode)
                )
            except Exception as e:  # noqa: BLE001
                # 一顆接不上不該讓其他的跟著不接：一個專案可以同時聽 Discord
                # 與 Slack，而 Discord 的 token 過期不該讓 Slack 也停掉。
                _push(state, f"{opcode} 接不上：{type(e).__name__}: {e}")
                continue
            state.bound[key] = Bound(key=key, opcode=opcode, spec=spec, handle=handle)


# --------------------------------------------------------------------------


def _desired(data: Any, extensions_root: Path) -> dict[str, tuple[str, tuple[Any, ...]]]:
    """這份 IR 要接哪些 trigger：key → (opcode, spec)。

    **只讀 manifest，不載程式碼。** 積木包宣告是資料（manifest 在磁碟上，任何
    process 讀得到），所以「這份畫布上有沒有要接的東西」問得出來，不必先把包載
    起來才知道。差別很實際：`open_project` 會替每個宣告過的包各起一個子行程
    （§7.6），而絕大多數畫布上一顆 hat 都沒有。

    條件跟 §5.1 的觸發條件是同一條——**腳本最上面那顆積木**。內建的 `event.*`
    不在這裡：綠旗根本不是要接的東西，而 cron 與 webhook 是第 2b、2c 步。
    """
    if not isinstance(data, dict):
        return {}
    blocks = data.get("blocks") or {}
    sources = discover(extensions_root)
    out: dict[str, tuple[str, tuple[Any, ...]]] = {}

    for script in data.get("scripts") or []:
        if not isinstance(script, dict):
            continue
        opcode = (blocks.get(script.get("top")) or {}).get("opcode")
        if not isinstance(opcode, str) or "." not in opcode:
            continue
        source = sources.get(opcode.split(".", 1)[0])
        spec_decl = source.manifest.block(opcode) if source else None
        if spec_decl is None or spec_decl.type != "hat":
            continue
        # 積木包的 hat：一條連線服務所有同 opcode 的腳本，所以 key 就是 opcode，
        # 而它不吃參數，所以 spec 是空的。
        out[opcode] = (opcode, ())
    return out


def _forward(manager: TriggerManager, project_id: str, opcode: str) -> Any:
    """一次 yield → 一個 Run。

    起 Run 失敗（專案被刪了、積木包被移掉、IR 在存檔之後壞了）**不能讓整條
    trigger 跟著死**：那條連線還好好的，下一則訊息仍然應該有機會跑起來。所以
    錯誤記在專案上，讓使用者看得到「有事件進來但跑不動」，而不是安靜地少掉
    幾則。
    """

    async def sink(payload: dict[str, Any]) -> None:
        try:
            await manager._runs.start(project_id, trigger=opcode, payload=payload)
        except Exception as e:  # noqa: BLE001
            state = manager._projects.get(project_id)
            if state is not None:
                _push(state, f"{opcode} 收到事件但跑不起來：{type(e).__name__}: {e}")

    return sink


async def _unbind(state: ProjectTriggers, key: str) -> None:
    bound = state.bound.pop(key, None)
    if bound is None:
        return
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await bound.handle.stop()


async def _teardown(state: ProjectTriggers) -> None:
    for key in list(state.bound):
        await _unbind(state, key)
    if state.registry is not None:
        with contextlib.suppress(Exception):
            await state.registry.unload_all()
        state.registry = None


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


__all__ = ["ERROR_LIMIT", "Bound", "ProjectTriggers", "TriggerManager"]

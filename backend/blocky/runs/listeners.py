"""「監聽」：把畫布上的 hat 積木接到真的事件來源上（§9、P1 第 4 步第 3 段）。

**這不是 §9 的 Trigger Manager，是它的前身。** 差別要寫清楚，不然下一個人會
以為 P2 已經做了一半：

| §9.2 要的                        | 這裡有嗎 |
|---|---|
| 專案標記為 active，與瀏覽器無關   | ✗ 監聽是這個 process 的記憶體，重啟就沒了 |
| diff 新舊 IR 的 hat 集合、只重啟有變動的 | ✗ 停掉全部再接一次 |
| 後端重啟時從 SQLite 恢復          | ✗ §6.3 的落地還沒做 |
| cron / webhook 內建 trigger       | ✗ 只接積木包的 hat |

有的只有一件事：**一顆 hat 真的能被接上、真的會因為外面發生的事而跑起來。**
§15 把 `discord` 排在最後就是為了這件事，而它到目前為止只有合約測試裡的
`demo` 包走過（`start_trigger` 在生產路徑上一個呼叫者都沒有）。

**一次 yield = 一個 Run。** 不是「一個常駐 Run 底下長出很多 Thread」——後者要
先回答「這個 Run 什麼時候結束」「執行歷史裡它算幾次」，而那兩題的答案屬於
§6.3 與 P2。走既有的 `RunManager.start(trigger=opcode, payload=...)` 則什麼都
不必新增：引擎的 `_triggered()` 本來就用「top 的 opcode 等於這次的 trigger」
選腳本（§5.1），`payload` 本來就會綁成 hat 的 `yields`（§5.4 第 2 層）。
每則訊息在執行紀錄裡是獨立的一列——那也正是使用者想看到的。

**監聽自己那份積木包是獨立載入的**，跟每次 Run 的那一份不同：那條 WebSocket
要活過每一個 Run，而 Run 的 registry 跑完就卸載。
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

if TYPE_CHECKING:
    from blocky.extensions.registry import ExtensionRegistry

#: 一個專案留幾則監聽期間的錯誤。監聽可以掛著好幾天，而使用者要看的永遠是
#: 「它為什麼停了」——最後幾則就夠。
ERROR_LIMIT = 20


@dataclass
class Listener:
    """一個專案的監聽狀態。"""

    project_id: str
    started_at: str
    #: 接上的 hat opcode。空的代表**畫布上沒有 hat**——那不是錯誤，是這個專案
    #: 目前沒有東西要聽，而使用者按下監聽時看得到這件事比看到一句「成功」有用。
    hats: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    registry: ExtensionRegistry | None = None
    handles: list[Any] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        return {
            "projectId": self.project_id,
            "startedAt": self.started_at,
            "hats": list(self.hats),
            "errors": list(self.errors),
        }


class ListenerManager:
    """所有監聽中的專案。一個 app 一個，與 `RunManager` 並排。"""

    def __init__(
        self,
        *,
        store: ProjectStore,
        extensions_root: Path,
        runs: RunManager,
    ) -> None:
        self._store = store
        self._extensions_root = extensions_root
        self._runs = runs
        self._listeners: dict[str, Listener] = {}

    # ---- 查 ----

    def get(self, project_id: str) -> Listener | None:
        return self._listeners.get(project_id)

    def list(self) -> list[Listener]:
        return list(self._listeners.values())

    # ---- 開始 ----

    async def start(self, project_id: str) -> Listener:
        """接上這個專案畫布上所有積木包的 hat。已經在監聽就原樣回去。

        **重複按不是錯誤**：前端的「執行」會順手把監聽打開（使用者不必知道那
        是兩件事），所以「已經開著」是最常見的情況，不是例外狀況。
        """
        existing = self._listeners.get(project_id)
        if existing is not None:
            return existing

        stored = self._store.get(project_id)
        if stored is None:
            raise ProjectNotFound(project_id)

        listener = Listener(project_id=project_id, started_at=_now())

        # **沒有 hat 就一個子行程都不開。** 積木包宣告是**資料**（manifest 在磁碟
        # 上，任何 process 讀得到），所以「這份畫布上有沒有積木包的 hat」問得出
        # 來，不必先把包載起來才知道。差別很實際：`open_project` 會替每個宣告過
        # 的包各起一個子行程（§7.6），而絕大多數畫布上一顆 hat 都沒有——那些子行
        # 程開起來只是為了立刻被關掉。
        if not _declared_hats(stored.data, self._extensions_root):
            self._listeners[project_id] = listener
            return listener

        # trigger 的 generator 死在一個沒有人 await 的 task 裡（見
        # `loading.trigger_error_text`），它唯一說得出話的地方就是這條事件流。
        sink = EventSink(on_emit=lambda e: _collect(listener, e), retain=False)

        project, registry = await open_project(
            stored.data, extensions_root=self._extensions_root, sink=sink
        )
        listener.registry = registry

        try:
            for opcode in _hat_opcodes(project, registry):
                handle = await registry.start_trigger(opcode, _forward(self, project_id, opcode))
                listener.handles.append(handle)
                listener.hats.append(opcode)
        except BaseException:
            # 接到一半失敗：已經接上的那幾條要收掉，不然它們會活得比這個
            # listener 久，而且沒有人停得了它們（handle 只在這裡）。
            await _shutdown(listener)
            raise

        if not listener.hats and registry is not None:
            # 一顆 hat 都沒有就不留著積木包：它們什麼事都不會做，但每個包都是
            # 一個子 process（§7.6）。
            await registry.unload_all()
            listener.registry = None

        self._listeners[project_id] = listener
        return listener

    # ---- 停 ----

    async def stop(self, project_id: str) -> bool:
        listener = self._listeners.pop(project_id, None)
        if listener is None:
            return False
        await _shutdown(listener)
        return True

    async def shutdown(self) -> None:
        for project_id in list(self._listeners):
            await self.stop(project_id)


# --------------------------------------------------------------------------


def _declared_hats(data: Any, extensions_root: Path) -> bool:
    """這份 IR 的腳本頂端有沒有積木包宣告的 hat——**只讀 manifest，不載程式碼**。

    條件跟 `_hat_opcodes` 一樣（腳本最上面那顆、形狀是 hat、命名空間屬於某個積木
    包），只是資料來源從 registry 換成磁碟上的 manifest——而那正是 §7.1 把
    「manifest 是資料、main.py 是程式碼」分開的用處。

    兩份實作看起來重複，但它們回答的是同一個問題在不同時刻的兩個版本：這裡是
    「值不值得開子行程」，那裡是「開了之後要接哪幾條」。真正接上去的仍然只認
    registry 說的形狀，所以這裡答錯的代價只有效能，不會接錯東西。
    """
    if not isinstance(data, dict):
        return False
    blocks = data.get("blocks") or {}
    tops = {
        (blocks.get(s.get("top")) or {}).get("opcode")
        for s in (data.get("scripts") or [])
        if isinstance(s, dict)
    }
    sources = discover(extensions_root)
    for opcode in tops:
        if not isinstance(opcode, str) or "." not in opcode:
            continue
        source = sources.get(opcode.split(".", 1)[0])
        spec = source.manifest.block(opcode) if source else None
        if spec is not None and spec.type == "hat":
            return True
    return False


def _hat_opcodes(project: Any, registry: ExtensionRegistry | None) -> list[str]:
    """畫布上要接的 hat。

    條件跟 §5.1 的觸發條件是同一條——**腳本最上面那顆積木**。內建的
    `event.*`（綠旗、cron、webhook）不在這裡：綠旗根本不是要接的東西，cron 與
    webhook 是 §9.1 的內建 trigger，屬於 P2。所以只認積木包宣告的 hat，判準是
    問 registry 要形狀，不是比對名單。

    去重複：同一顆 hat 在畫布上放兩次是合法的（兩條腳本各自對同一個事件反應），
    而它們共用同一條連線——`_triggered()` 會把兩條都選中。
    """
    if registry is None:
        return []
    out: list[str] = []
    for script in project.scripts:
        opcode = project.block(script.top).opcode
        if opcode not in out and registry.shape(opcode) == "hat":
            out.append(opcode)
    return out


def _forward(manager: ListenerManager, project_id: str, opcode: str) -> Any:
    """一次 yield → 一個 Run。

    起 Run 失敗（專案被刪了、積木包被移掉、IR 在存檔之後壞了）**不能讓整條
    監聽跟著死**：那條連線還好好的，下一則訊息仍然應該有機會跑起來。所以錯誤
    記在 listener 上，讓使用者看得到「有事件進來但跑不動」，而不是安靜地少掉
    幾則。
    """

    async def sink(payload: dict[str, Any]) -> None:
        try:
            await manager._runs.start(project_id, trigger=opcode, payload=payload)
        except Exception as e:
            listener = manager._listeners.get(project_id)
            if listener is not None:
                _push(listener, f"{opcode} 收到事件但跑不起來：{type(e).__name__}: {e}")

    return sink


async def _shutdown(listener: Listener) -> None:
    for handle in listener.handles:
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await handle.stop()
    listener.handles.clear()
    if listener.registry is not None:
        with contextlib.suppress(Exception):
            await listener.registry.unload_all()
        listener.registry = None


def _collect(listener: Listener, event: Any) -> None:
    """監聽期間的事件流。目前只留錯誤。

    一般的 `log` 不留：監聽沒有自己的 UI，而每一則訊息真正做的事都在它自己那
    個 Run 的事件流裡（前端本來就在看那條）。留下來的只有**沒有 Run 可以歸屬**
    的那一種——連線死掉的那句話。
    """
    data = event.data
    if event.op == "log" and data.get("level") == "error":
        _push(listener, str(data.get("text", "")))


def _push(listener: Listener, text: str) -> None:
    listener.errors.append(text)
    del listener.errors[:-ERROR_LIMIT]


def _now() -> str:
    return datetime.now(UTC).isoformat()

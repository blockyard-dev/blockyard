"""Extension Host 的抽象邊界（§7.5）。

即使 v1 是 in-process，dispatch 一律經過 `ExtensionHost`，這樣 §7.6 的
SubprocessHost 進來時 Interpreter 一行都不用改。

`ExtensionHost` 只描述 host → extension；`ctx.log`、trigger 的 yield、
`ctx.cancelled` 都是**反過來**的，那是 `HostChannel`。設計文件說得很明白：
反向通道是「in-process 時看不見、跨 process 時全部要重寫」的典型，所以它從
第一天就是一個獨立介面，而不是直接抓 EventSink 來用。

### 為什麼只有 `emit` 是 async（D18）

- `log`：§7.3 的 `main.py` 寫的是 `ctx.log(...)`，沒有 await。而且 log 事件
  必須**當場**落在 `block.enter` 與 `block.exit` 之間，否則 §17 的黃金軌跡
  就不是決定性的。跨 process 時，extension 那一側寫 stdout 本來就是同步的，
  非同步的是 host 那一側的 reader task——那是 host 的內部實作，不是介面。
- `is_cancelled`：讀的是 host **推**過來的旗標，不是每次檢查都發一次 RPC。
  長迴圈裡的檢查點若要往返一次 IPC，沒有人會捨得放在迴圈裡。

`emit`（trigger yield）維持 async：它跨越 await 邊界，且需要背壓。
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol

from blocky.interpreter.events import EventSink


@dataclass
class CallContext:
    """一次 extension 呼叫的上下文。`token` 是它的不透明代號。

    介面只傳 token 而不傳這個物件，是因為跨 process 時傳不過去——強制用
    token，in-process 就不會不小心依賴「拿得到 Python 物件」。
    """

    token: str
    ext_id: str
    thread_id: str | None = None
    block_id: str | None = None
    # 由 host 推入的協作式取消旗標（見模組 docstring）
    cancelled: bool = False
    # §12.2：本次呼叫用到的 secret 明文。事件序列化前要據此遮蔽。
    secrets: set[str] = field(default_factory=set)
    # §7.6：SubprocessHost 掛一個回呼在這裡，`cancel_thread` 翻旗標的同時
    # 順便推一個通知給對應的子 process（child 端的 `is_cancelled` 讀的是
    # 本地快取，不能每次都跑一趟 RPC）。in-process 不需要它，維持 None。
    on_cancelled: Callable[[], None] | None = None


class CallContexts:
    """token → CallContext 的表。"""

    def __init__(self) -> None:
        self._by_token: dict[str, CallContext] = {}
        self._ids = itertools.count(1)

    def open(
        self, ext_id: str, *, thread_id: str | None = None, block_id: str | None = None
    ) -> CallContext:
        ctx = CallContext(
            token=f"cx_{next(self._ids)}",
            ext_id=ext_id,
            thread_id=thread_id,
            block_id=block_id,
        )
        self._by_token[ctx.token] = ctx
        return ctx

    def get(self, token: str) -> CallContext | None:
        return self._by_token.get(token)

    def close(self, token: str) -> None:
        self._by_token.pop(token, None)

    def cancel_thread(self, thread_id: str) -> None:
        """推取消旗標給該 thread 上所有在跑的 extension 呼叫（§5.5）。"""
        for ctx in self._by_token.values():
            if ctx.thread_id == thread_id:
                ctx.cancelled = True
                if ctx.on_cancelled is not None:
                    ctx.on_cancelled()


class TriggerHandle(Protocol):
    """一個運轉中的 trigger。P2 的 Trigger Manager 會持有它。"""

    async def stop(self) -> None: ...


class HostChannel(Protocol):
    """extension → host 的反向通道。"""

    def log(self, ctx_token: str, level: str, message: str) -> None: ...

    async def emit(self, ctx_token: str, payload: dict[str, Any]) -> None: ...

    def is_cancelled(self, ctx_token: str) -> bool: ...


class ExtensionHost(Protocol):
    """host → extension。§7.5 的介面，SubprocessHost 換的就是這一層。

    隱含約束：**args 與回傳值必須可 JSON 序列化**。從第一天就強制執行
    （`boundary.ensure_transportable`），否則換 IPC 時會發現到處在傳 Python
    物件。
    """

    async def load(self, ext_id: str) -> None: ...

    async def unload(self, ext_id: str) -> None: ...

    async def call(self, opcode: str, args: dict[str, Any], ctx_token: str) -> Any: ...

    async def dropdown(
        self, ext_id: str, source: str, ctx_token: str, args: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]: ...
    """`args` 是同一顆積木上其他已填參數的值（manifest 的 `depends`）。
    預設 `None` 讓「不吃別格的下拉」的呼叫端一個字都不用改。"""

    async def start_trigger(
        self, opcode: str, sink: Callable[[dict[str, Any]], Awaitable[None]]
    ) -> TriggerHandle: ...


class EventSinkChannel:
    """把反向通道接到 §6.1 的事件流上。in-process 與 subprocess 共用這一層：
    差別只在誰去呼叫它。"""

    def __init__(self, sink: EventSink, contexts: CallContexts) -> None:
        self.sink = sink
        self.contexts = contexts

    def log(self, ctx_token: str, level: str, message: str) -> None:
        ctx = self.contexts.get(ctx_token)
        self.sink.emit(
            "log",
            threadId=ctx.thread_id if ctx else None,
            level=level,
            text=message,
            blockId=ctx.block_id if ctx else None,
        )

    async def emit(self, ctx_token: str, payload: dict[str, Any]) -> None:
        # trigger 的 yield。P2 的 Trigger Manager 接手前，先進事件流備查。
        ctx = self.contexts.get(ctx_token)
        self.sink.emit("trigger.yield", extId=ctx.ext_id if ctx else None, payload=payload)

    def is_cancelled(self, ctx_token: str) -> bool:
        ctx = self.contexts.get(ctx_token)
        return ctx.cancelled if ctx else False


__all__ = [
    "CallContext",
    "CallContexts",
    "EventSinkChannel",
    "ExtensionHost",
    "HostChannel",
    "TriggerHandle",
]

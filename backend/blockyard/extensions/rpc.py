"""雙向 JSON-RPC，父子兩側共用（§7.6 SubprocessHost）。

線上跑的是換行分隔的 JSON：

    request      {"id": N, "method": "...", "params": {...}}
    response     {"id": N, "result": ...} 或 {"id": N, "error": {...}}
    notification {"method": "...", "params": {...}}          # 無 id，不等回應

parent 與 child 用的是同一個類別——差別只在 parent 包的是子 process 的
pipe，child 包的是自己的 stdin/stdout。兩邊都能**主動發起** request/
notification，也都能**被動處理**對方發起的 request/notification：`log`／
`emit`／`is_cancelled` 是 child 發起、parent 處理；`call`／`dropdown`／
`load` 等是 parent 發起、child 處理。

`error` 的形狀就是 `BlockyardError.to_dict()`（見 `blockyard.errors`）——RPC 這一層
不知道、也不需要知道 BlockyardError 的存在，重建例外是呼叫端的事
（`BlockyardError.from_dict`）。
"""

from __future__ import annotations

import asyncio
import itertools
import json
from typing import Any, Awaitable, Callable

Handler = Callable[[dict[str, Any]], Awaitable[Any]]


class PeerClosed(Exception):
    """對方的 pipe 斷了（process 死掉、或正常關閉）。"""


class RpcError(Exception):
    """對方回了一個 error 回應，內容是原始 dict（`BlockyardError.to_dict()` 的形狀）。

    這一層不重建例外類別——呼叫端（SubprocessHost / subprocess_worker）
    才知道要用 `BlockyardError.from_dict` 還是別的規則。
    """

    def __init__(self, payload: dict[str, Any]) -> None:
        super().__init__(payload.get("message", "rpc error"))
        self.payload = payload


class JsonRpcPeer:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._reader = reader
        self._writer = writer
        self._write_lock = asyncio.Lock()
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._handlers: dict[str, Handler] = {}
        self._pump_task: asyncio.Task[None] | None = None
        self._closed = False

    def on(self, method: str, handler: Handler) -> None:
        """註冊一個 request/notification 的處理函式。

        `handler(params) -> result`；notification 呼叫它但忽略回傳值。
        """
        self._handlers[method] = handler

    def start(self) -> None:
        """開始收訊息。呼叫端要先用 `on()` 掛好會用到的 handler。"""
        if self._pump_task is None:
            self._pump_task = asyncio.create_task(self._pump())

    async def call(self, method: str, params: dict[str, Any]) -> Any:
        """送一個 request，等對方回應。error 回應轉成 `RpcError`。"""
        rid = next(self._ids)
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        try:
            await self._write({"id": rid, "method": method, "params": params})
            return await fut
        finally:
            self._pending.pop(rid, None)

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        """fire-and-forget：寫一行就返回，不等對方處理。"""
        await self._write({"method": method, "params": params})

    def notify_nowait(self, method: str, params: dict[str, Any]) -> None:
        """`notify` 的同步版：只呼叫 `writer.write()`，不 await drain。

        `ctx.log`（D18）要的就是這個——它是 `HostChannel` 介面上唯一非 async
        的一半，呼叫端沒有 await 可以讓給我們。`write()` 本身在 asyncio 的
        transport 上是同步、把整段 bytes 原子地放進傳輸緩衝區，所以跟其他
        走 `_write`（有拿鎖）的訊息不會半行插在一起。
        """
        line = json.dumps({"method": method, "params": params}, ensure_ascii=False) + "\n"
        self._writer.write(line.encode("utf-8"))

    async def wait_closed(self) -> None:
        """等到對面斷線（reader pump 收到 EOF 或出錯）。child 端拿這個當
        「該結束了」的訊號：parent 關 stdin，pump 讀到 EOF 就回傳。"""
        if self._pump_task is not None:
            try:
                await self._pump_task
            except asyncio.CancelledError:
                pass

    async def close(self) -> None:
        self._closed = True
        if self._pump_task is not None:
            self._pump_task.cancel()
            try:
                await self._pump_task
            except (asyncio.CancelledError, Exception):
                pass

    # ---- 內部 ----

    async def _write(self, msg: dict[str, Any]) -> None:
        line = json.dumps(msg, ensure_ascii=False) + "\n"
        async with self._write_lock:
            self._writer.write(line.encode("utf-8"))
            await self._writer.drain()

    async def _pump(self) -> None:
        try:
            while True:
                raw = await self._reader.readline()
                if not raw:
                    break
                line = raw.decode("utf-8").strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                self._dispatch(msg)
        finally:
            self._reject_pending(PeerClosed("對方的連線已經斷開"))

    def _dispatch(self, msg: dict[str, Any]) -> None:
        if "method" in msg:
            # 對方發起的 request（有 id）或 notification（沒有）。
            asyncio.create_task(self._handle_incoming(msg))
            return
        # 對方對我方某次 call() 的回應。
        rid = msg.get("id")
        fut = self._pending.get(rid) if rid is not None else None
        if fut is None or fut.done():
            return
        if "error" in msg:
            fut.set_exception(RpcError(msg["error"]))
        else:
            fut.set_result(msg.get("result"))

    async def _handle_incoming(self, msg: dict[str, Any]) -> None:
        method = msg["method"]
        params = msg.get("params") or {}
        rid = msg.get("id")
        handler = self._handlers.get(method)

        if handler is None:
            if rid is not None:
                await self._write({"id": rid, "error": {"message": f"未知的方法 {method}"}})
            return

        try:
            result = await handler(params)
        except Exception as e:
            if rid is not None:
                await self._write({"id": rid, "error": _error_payload(e)})
            return
        if rid is None:
            return
        try:
            await self._write({"id": rid, "result": result})
        except TypeError as e:
            # `result` 不是可 JSON 序列化的值。這種情況理論上該在呼叫端就被
            # `boundary.ensure_transportable` 擋下來，但那道防線不是無死角
            # 保證——寫失敗絕對不能變成「回應永遠沒送出」，parent 端會卡死
            # 等一個不會來的 Future。退而求其次送一個 error 回應。
            await self._write(
                {"id": rid, "error": {"type": "ExtensionError", "code": "extension",
                                       "message": f"回傳值不是可傳輸的值：{e}"}}
            )

    def _reject_pending(self, exc: Exception) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()


def _error_payload(e: Exception) -> dict[str, Any]:
    to_dict = getattr(e, "to_dict", None)
    if callable(to_dict):
        return to_dict()
    return {"type": type(e).__name__, "code": "error", "message": str(e)}


__all__ = ["JsonRpcPeer", "PeerClosed", "RpcError"]

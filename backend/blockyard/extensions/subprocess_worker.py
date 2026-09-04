"""SubprocessHost 的子 process 進入點（§7.6）。

    python -m blockyard.extensions.subprocess_worker <ext_id> <extensions_root>

跑在**跟 backend 相同的 venv**（`sys.executable`）——這一步只做「一個積木
包一個 OS process」，`uv venv` 的依賴隔離留給真的需要它的包（`openai`，
P1 第 3 步）。

第一件事是把 `sys.stdout` 換成 `sys.stderr`：stdout 是 JSON-RPC 的唯一通道，
`main.py` 或它 import 的第三方套件裡任何一個意外的 `print()` 都會弄髒協定。
"""

from __future__ import annotations

import asyncio
import inspect
import sys
from pathlib import Path
from typing import Any, Callable

from blockyard.errors import BlockyardError, ExtensionError
from blockyard.extensions.boundary import ensure_transportable, normalize_dropdown_args
from blockyard.extensions.httpclient import new_client
from blockyard.extensions.loading import (
    Exports,
    check_coverage,
    check_net_permission,
    collect_exports,
    import_extension_module,
    trigger_error_text,
    unimport_extension_module,
)
from blockyard.extensions.manifest import ExtensionSource, discover
from blockyard.extensions.rpc import JsonRpcPeer
from blockyard.extensions.sdk import Ctx


class _Loaded:
    __slots__ = ("source", "module", "exports", "config", "state", "http")

    def __init__(self, source: ExtensionSource, module: Any, exp: Exports) -> None:
        self.source = source
        self.module = module
        self.exports = exp
        self.config: dict[str, Any] = {}
        self.state: dict[str, Any] = {}
        self.http: Any | None = None


class RpcChildChannel:
    """`HostChannel`（child 端）。把反向通道接到跟 parent 的 RPC 連線上。"""

    def __init__(self, peer: JsonRpcPeer, cancelled: dict[str, bool]) -> None:
        self._peer = peer
        self._cancelled = cancelled

    def log(self, token: str, level: str, message: str) -> None:
        # D18：同步、fire-and-forget，跟 `main.py` 寫 `ctx.log(...)` 沒有
        # await 是同一件事——寫 pipe 本身是同步呼叫，不等對面處理。
        self._peer.notify_nowait("log", {"token": token, "level": level, "message": message})

    def panel(self, token: str, payload: dict[str, Any]) -> None:
        # 與 `log` 一模一樣的形狀：同步、fire-and-forget。
        self._peer.notify_nowait("panel", {"token": token, "payload": payload})

    def is_cancelled(self, token: str) -> bool:
        # parent 推過來的旗標，讀的是本地快取，不是每次都跑一趟 RPC
        # （長迴圈裡的檢查點若要往返一次 IPC，沒有人捨得放進迴圈）。
        return self._cancelled.get(token, False)

    async def emit(self, token: str, payload: dict[str, Any]) -> None:
        # request 而非 notification：parent 端 `await sink(payload)` 完成
        # 才回 ack，天然做出背壓。
        await self._peer.call("trigger_yield", {"token": token, "payload": payload})


class Worker:
    def __init__(self, ext_id: str, extensions_root: Path, peer: JsonRpcPeer) -> None:
        self.ext_id = ext_id
        self.extensions_root = extensions_root
        self.peer = peer
        self.loaded: _Loaded | None = None
        self.cancelled: dict[str, bool] = {}
        self.trigger_tasks: dict[str, asyncio.Task[None]] = {}
        self.channel = RpcChildChannel(peer, self.cancelled)

        peer.on("load", self._on_load)
        peer.on("unload", self._on_unload)
        peer.on("call", self._on_call)
        peer.on("dropdown", self._on_dropdown)
        peer.on("start_trigger", self._on_start_trigger)
        peer.on("stop_trigger", self._on_stop_trigger)
        peer.on("cancel", self._on_cancel)

    # ---- 生命週期 ----

    async def _on_load(self, params: dict[str, Any]) -> dict[str, Any]:
        sources = discover(self.extensions_root)
        source = sources.get(self.ext_id)
        if source is None:
            raise ExtensionError(f'找不到積木包「{self.ext_id}」')

        module = import_extension_module(source)
        exp = collect_exports(module)
        check_coverage(source.manifest, exp)

        loaded = _Loaded(source, module, exp)
        loaded.config = {**source.manifest.config_defaults(), **(params.get("config") or {})}
        self.loaded = loaded

        if exp.on_load is not None:
            ctx = self._ctx(loaded, params.get("token", ""))
            await self._invoke(exp.on_load, ctx, {}, what=f"{self.ext_id} 的 on_load")
        return {}

    async def _on_unload(self, params: dict[str, Any]) -> dict[str, Any]:
        loaded = self.loaded
        if loaded is None:
            return {}
        if loaded.exports.on_unload is not None:
            ctx = self._ctx(loaded, params.get("token", ""))
            await self._invoke(
                loaded.exports.on_unload, ctx, {}, what=f"{self.ext_id} 的 on_unload"
            )
        if loaded.http is not None:
            await loaded.http.aclose()
            loaded.http = None
        unimport_extension_module(loaded.module)
        self.loaded = None
        return {}

    # ---- dispatch ----

    async def _on_call(self, params: dict[str, Any]) -> Any:
        loaded = self._require_loaded()
        opcode = params["opcode"]
        block_id = params.get("block_id")
        fn = loaded.exports.blocks.get(opcode)
        if fn is None:
            raise ExtensionError(
                f"{opcode} 在 manifest 裡有宣告，但 main.py 沒有對應的實作",
                block_id=block_id,
            )
        what = f"積木包「{loaded.source.manifest.name}」的 {opcode}"
        ctx = self._ctx(loaded, params["token"], block_id=block_id)
        result = await self._invoke(fn, ctx, params.get("args") or {}, what=what, block_id=block_id)
        # 在這裡先擋一次（而不是只靠 RPC 寫入失敗才發現）：這個 process 手上
        # 還是原始的 Python 物件，能給出跟 `boundary.validate_return`（host
        # 端，收到值之後）完全一樣的訊息，而不是一句 json.dumps 的 TypeError。
        ensure_transportable(result, where=what, what="回傳值", block_id=block_id)
        return result

    async def _on_dropdown(self, params: dict[str, Any]) -> Any:
        loaded = self._require_loaded()
        full = f"{loaded.source.id}.{params['source']}"
        fn = loaded.exports.dropdowns.get(full)
        if fn is None:
            raise ExtensionError(f"積木包「{loaded.source.id}」沒有下拉來源 {params['source']}")
        clean = normalize_dropdown_args(
            loaded.source.manifest, params["source"], params.get("args")
        )
        ctx = self._ctx(loaded, params.get("token", ""))
        return await self._invoke(fn, ctx, clean, what=full)

    async def _on_start_trigger(self, params: dict[str, Any]) -> dict[str, Any]:
        loaded = self._require_loaded()
        opcode = params["opcode"]
        token = params["token"]
        fn = loaded.exports.triggers.get(opcode)
        if fn is None:
            raise ExtensionError(f"{opcode} 沒有對應的 @trigger 實作")
        ctx = self._ctx(loaded, token)

        async def pump() -> None:
            try:
                async for payload in fn(ctx):
                    await ctx.emit(payload)
            except asyncio.CancelledError:
                raise
            except BaseException as e:
                # 與 in-process 同一句話（`trigger_error_text`）。這裡多一層
                # 理由：例外留在 child 的話，parent 端連「它死了」都不知道。
                ctx.log(trigger_error_text(opcode, loaded.source.manifest.name, e), "error")

        # 不等它跑完就回 ack——trigger 本來就是長駐的。
        self.trigger_tasks[token] = asyncio.create_task(pump())
        return {}

    async def _on_stop_trigger(self, params: dict[str, Any]) -> dict[str, Any]:
        task = self.trigger_tasks.pop(params["token"], None)
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        return {}

    async def _on_cancel(self, params: dict[str, Any]) -> None:
        self.cancelled[params["token"]] = True

    # ---- 內部 ----

    def _require_loaded(self) -> _Loaded:
        if self.loaded is None:
            raise ExtensionError(f'積木包「{self.ext_id}」還沒載入')
        return self.loaded

    def _ctx(self, loaded: _Loaded, token: str, *, block_id: str | None = None) -> Ctx:
        return Ctx(
            config=loaded.config,
            state=loaded.state,
            channel=self.channel,
            token=token,
            block_id=block_id,
            http=lambda: self._http_for(loaded),
            secrets=loaded.source.manifest.secret_specs(),
            panels=tuple(p.id for p in loaded.source.manifest.panels),
        )

    def _http_for(self, loaded: _Loaded) -> Any:
        check_net_permission(loaded.source.manifest)
        if loaded.http is None:
            loaded.http = new_client()
        return loaded.http

    async def _invoke(
        self,
        fn: Callable[..., Any],
        ctx: Ctx,
        kwargs: dict[str, Any],
        *,
        what: str,
        block_id: str | None = None,
    ) -> Any:
        try:
            result = fn(ctx, **kwargs)
            if inspect.isawaitable(result):
                result = await result
            return result
        except BlockyardError:
            raise
        except Exception as e:
            raise ExtensionError(
                f"{what} 執行時發生錯誤：{type(e).__name__}: {e}", block_id=block_id
            ) from e


async def _stdio_peer() -> JsonRpcPeer:
    """把子 process 自己的 stdin/stdout 包成一對 asyncio streams。"""
    loop = asyncio.get_running_loop()

    reader = asyncio.StreamReader()
    reader_protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: reader_protocol, sys.stdin)

    write_transport, write_protocol = await loop.connect_write_pipe(
        asyncio.streams.FlowControlMixin, _real_stdout
    )
    writer = asyncio.StreamWriter(write_transport, write_protocol, None, loop)

    return JsonRpcPeer(reader, writer)


# 保留原始 stdout，`main()` 一開始就把 `sys.stdout` 換掉，見模組 docstring。
_real_stdout = sys.stdout


async def main() -> None:
    if len(sys.argv) != 3:
        print("usage: subprocess_worker <ext_id> <extensions_root>", file=sys.stderr)
        raise SystemExit(2)
    ext_id, root = sys.argv[1], sys.argv[2]

    sys.stdout = sys.stderr

    peer = await _stdio_peer()
    Worker(ext_id, Path(root), peer)
    peer.start()
    await peer.wait_closed()


if __name__ == "__main__":
    asyncio.run(main())

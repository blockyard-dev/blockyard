"""SubprocessHost（§7.5、§7.6、D13）。

每個積木包一個獨立 OS process，以 stdio JSON-RPC 溝通（`rpc.py`）。這是 P1
真正跑第三方積木包的路徑——`InProcessHost` 保留給合約測試自身與內建積木。

跟 `InProcessHost` 共用的部分不是靠自律：`boundary.py` 的正規化／驗證在
這裡一樣是**host 端**呼叫（子 process 收到的 `args` 已經是乾淨值），
`loading.py` 的載入/coverage 檢查則是子 process 那一側呼叫同一份函式
（見 `subprocess_worker.py`）——manifest ↔ main.py 的一致性檢查只寫一次。
"""

from __future__ import annotations

import asyncio
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from blocky.errors import BlockyError, ExtensionError
from blocky.extensions.boundary import normalize_args, validate_dropdown_options, validate_return
from blocky.extensions.host import CallContexts, HostChannel
from blocky.extensions.manifest import BlockSpec, ExtensionSource, Manifest
from blocky.extensions.rpc import JsonRpcPeer, PeerClosed, RpcError

_UNLOAD_TIMEOUT = 5.0


@dataclass
class _Worker:
    process: asyncio.subprocess.Process
    peer: JsonRpcPeer


class _SubprocessTriggerHandle:
    def __init__(self, host: "SubprocessHost", worker: _Worker, token: str) -> None:
        self._host = host
        self._worker = worker
        self._token = token

    async def stop(self) -> None:
        self._host._trigger_sinks.pop(self._token, None)
        try:
            await self._worker.peer.call("stop_trigger", {"token": self._token})
        except (RpcError, PeerClosed):
            pass  # 子 process 已經不在了，沒什麼好停的
        self._host.contexts.close(self._token)


class SubprocessHost:
    """實作 §7.5 的 `ExtensionHost`。"""

    def __init__(
        self,
        sources: dict[str, ExtensionSource],
        channel: HostChannel,
        contexts: CallContexts,
        *,
        extensions_root: Path,
        config: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self.sources = sources
        self.channel = channel
        self.contexts = contexts
        self.extensions_root = extensions_root
        self._config = config or {}
        self._workers: dict[str, _Worker] = {}
        # token → trigger 的 sink。跟 CallContexts 分開放，因為它是
        # SubprocessHost 自己的 dispatch 需求，不是通用的呼叫上下文。
        self._trigger_sinks: dict[str, Callable[[dict[str, Any]], Awaitable[None]]] = {}

    # ---- 生命週期 ----

    async def load(self, ext_id: str) -> None:
        if ext_id in self._workers:
            return
        source = self.sources.get(ext_id)
        if source is None:
            raise ExtensionError(f'找不到積木包「{ext_id}」')

        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "blocky.extensions.subprocess_worker",
            ext_id,
            str(self.extensions_root),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
        )
        assert process.stdin is not None and process.stdout is not None
        peer = JsonRpcPeer(process.stdout, process.stdin)
        peer.on("log", self._make_log_handler())
        peer.on("trigger_yield", self._on_trigger_yield)
        peer.start()
        worker = _Worker(process, peer)

        ctx = self.contexts.open(ext_id)
        try:
            await peer.call("load", {"token": ctx.token, "config": self._config.get(ext_id, {})})
        except RpcError as e:
            await self._kill(worker)
            raise BlockyError.from_dict(e.payload) from None
        except PeerClosed:
            await self._kill(worker)
            raise ExtensionError(f'積木包「{ext_id}」的子行程啟動失敗') from None
        except BaseException:
            await self._kill(worker)
            raise
        finally:
            self.contexts.close(ctx.token)

        self._workers[ext_id] = worker

    async def unload(self, ext_id: str) -> None:
        worker = self._workers.pop(ext_id, None)
        if worker is None:
            return
        ctx = self.contexts.open(ext_id)
        try:
            await worker.peer.call("unload", {"token": ctx.token})
        except (RpcError, PeerClosed):
            pass  # 子行程可能已經死了，照樣往下收拾
        finally:
            self.contexts.close(ctx.token)
        await self._kill(worker)

    async def _kill(self, worker: _Worker) -> None:
        await worker.peer.close()
        if worker.process.stdin is not None and not worker.process.stdin.is_closing():
            worker.process.stdin.close()
        if worker.process.returncode is None:
            try:
                await asyncio.wait_for(worker.process.wait(), timeout=_UNLOAD_TIMEOUT)
            except asyncio.TimeoutError:
                worker.process.kill()
                await worker.process.wait()

    # ---- dispatch ----

    async def call(self, opcode: str, args: dict[str, Any], ctx_token: str) -> Any:
        manifest, spec, worker = self._resolve(opcode)
        ctx = self.contexts.get(ctx_token)
        block_id = ctx.block_id if ctx else None

        clean = normalize_args(manifest, spec, args, block_id=block_id)

        if ctx is not None:
            ctx.on_cancelled = lambda: worker.peer.notify_nowait("cancel", {"token": ctx_token})
        try:
            result = await worker.peer.call(
                "call", {"token": ctx_token, "block_id": block_id, "opcode": opcode, "args": clean}
            )
        except RpcError as e:
            raise BlockyError.from_dict(e.payload) from None
        except PeerClosed:
            raise ExtensionError(
                f"{_where(manifest, spec)} 執行時子行程意外結束", block_id=block_id
            ) from None
        finally:
            if ctx is not None:
                ctx.on_cancelled = None

        return validate_return(manifest, spec, result, block_id=block_id)

    async def dropdown(self, opcode: str, source: str, ctx_token: str) -> list[dict[str, Any]]:
        manifest, _, worker = self._resolve(opcode)
        full = f"{manifest.id}.{source}"
        try:
            result = await worker.peer.call("dropdown", {"token": ctx_token, "source": source})
        except RpcError as e:
            raise BlockyError.from_dict(e.payload) from None
        except PeerClosed:
            raise ExtensionError(f"下拉來源 {full} 執行時子行程意外結束") from None
        return validate_dropdown_options(result, full)

    async def start_trigger(
        self, opcode: str, sink: Callable[[dict[str, Any]], Awaitable[None]]
    ) -> _SubprocessTriggerHandle:
        ext_id = opcode.split(".", 1)[0]
        worker = self._workers.get(ext_id)
        if worker is None:
            raise ExtensionError(f'積木包「{ext_id}」還沒載入')

        ctx = self.contexts.open(ext_id)
        # 在送 RPC 之前就註冊 sink：child 一旦回 ack，隨時可能已經在送
        # trigger_yield，這裡要先能接住。
        self._trigger_sinks[ctx.token] = sink
        try:
            await worker.peer.call("start_trigger", {"token": ctx.token, "opcode": opcode})
        except BaseException:
            self._trigger_sinks.pop(ctx.token, None)
            self.contexts.close(ctx.token)
            raise
        return _SubprocessTriggerHandle(self, worker, ctx.token)

    # ---- 內部 ----

    def _resolve(self, opcode: str) -> tuple[Manifest, BlockSpec, _Worker]:
        ext_id = opcode.split(".", 1)[0]
        worker = self._workers.get(ext_id)
        if worker is None:
            raise ExtensionError(f'積木包「{ext_id}」還沒載入')
        manifest = self.sources[ext_id].manifest
        spec = manifest.block(opcode)
        if spec is None:
            raise ExtensionError(f'積木包「{ext_id}」沒有 {opcode} 這顆積木')
        return manifest, spec, worker

    def _make_log_handler(self) -> Callable[[dict[str, Any]], Awaitable[None]]:
        async def handler(params: dict[str, Any]) -> None:
            self.channel.log(params["token"], params["level"], params["message"])

        return handler

    async def _on_trigger_yield(self, params: dict[str, Any]) -> None:
        sink = self._trigger_sinks.get(params["token"])
        if sink is not None:
            await sink(params["payload"])


def _where(manifest: Manifest, spec: BlockSpec) -> str:
    return f"積木包「{manifest.name}」的 {manifest.full_opcode(spec.opcode)}"


__all__ = ["SubprocessHost"]

"""InProcessHost（§7.5、§7.6）。

**只用於內建積木與測試**。第三方程式碼一律走 §7.6 的 SubprocessHost：同一個
process 內 `import httpx` 第一次贏且永久生效，而首批要手寫的三個包全部依賴
同一批 HTTP 函式庫——假的隔離比沒有隔離更糟。

這個實作的價值在於它是 §17 題庫的快速路徑，並且與 SubprocessHost 共用
`boundary.py`：兩者行為一致不是靠自律，是靠共用同一段程式碼。
"""

from __future__ import annotations

import asyncio
import importlib.util
import inspect
import sys
from typing import Any, Awaitable, Callable

from blocky.errors import BlockyError, ExtensionError
from blocky.extensions.boundary import normalize_args, validate_return
from blocky.extensions.host import CallContext, CallContexts, HostChannel
from blocky.extensions.httpclient import new_client
from blocky.extensions.manifest import BlockSpec, ExtensionSource, Manifest
from blocky.extensions.sdk import Ctx, exports


class _Loaded:
    """一個已載入的積木包在 host 這一側的全部狀態。"""

    __slots__ = (
        "source", "module", "blocks", "dropdowns", "triggers", "unload", "config", "state",
        "http",
    )

    def __init__(self, source: ExtensionSource, module: Any) -> None:
        self.source = source
        self.module = module
        self.blocks: dict[str, Callable[..., Any]] = {}
        self.dropdowns: dict[str, Callable[..., Any]] = {}
        self.triggers: dict[str, Callable[..., Any]] = {}
        self.unload: Callable[..., Any] | None = None
        self.config: dict[str, Any] = {}
        self.state: dict[str, Any] = {}
        # `ctx.http` 第一次被碰到才建（§7.4）。碰都沒碰過的包不會有連線池。
        self.http: Any | None = None

    @property
    def manifest(self) -> Manifest:
        return self.source.manifest


class _TaskTriggerHandle:
    def __init__(self, task: asyncio.Task[None]) -> None:
        self._task = task

    async def stop(self) -> None:
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass


class InProcessHost:
    """實作 §7.5 的 `ExtensionHost`。"""

    def __init__(
        self,
        sources: dict[str, ExtensionSource],
        channel: HostChannel,
        contexts: CallContexts,
        *,
        config: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self.sources = sources
        self.channel = channel
        self.contexts = contexts
        self._config = config or {}
        self._loaded: dict[str, _Loaded] = {}

    # ---- 生命週期 ----

    async def load(self, ext_id: str) -> None:
        if ext_id in self._loaded:
            return
        source = self.sources.get(ext_id)
        if source is None:
            raise ExtensionError(f'找不到積木包「{ext_id}」')

        module = self._import(source)
        loaded = _Loaded(source, module)
        on_load = None

        for kind, name, fn in exports(module):
            if kind == "block":
                loaded.blocks[str(name)] = fn
            elif kind == "dropdown":
                loaded.dropdowns[str(name)] = fn
            elif kind == "trigger":
                loaded.triggers[str(name)] = fn
            elif kind == "on_load":
                on_load = fn
            elif kind == "on_unload":
                loaded.unload = fn

        self._check_coverage(loaded)

        mf = source.manifest
        loaded.config = {**mf.config_defaults(), **self._config.get(ext_id, {})}
        self._loaded[ext_id] = loaded

        if on_load is not None:
            ctx = self._ctx(loaded, self.contexts.open(ext_id))
            try:
                await self._invoke(on_load, ctx, {}, what=f"{ext_id} 的 on_load")
            finally:
                self.contexts.close(ctx._token)

    async def unload(self, ext_id: str) -> None:
        loaded = self._loaded.pop(ext_id, None)
        if loaded is None:
            return
        if loaded.unload is not None:
            ctx = self._ctx(loaded, self.contexts.open(ext_id))
            try:
                await self._invoke(loaded.unload, ctx, {}, what=f"{ext_id} 的 on_unload")
            finally:
                self.contexts.close(ctx._token)
        # client 是 host 開的，所以由 host 關——`on_unload` 沒有義務知道它存在。
        if loaded.http is not None:
            await loaded.http.aclose()
            loaded.http = None
        sys.modules.pop(loaded.module.__name__, None)

    # ---- dispatch ----

    async def call(self, opcode: str, args: dict[str, Any], ctx_token: str) -> Any:
        loaded, spec = self._resolve(opcode)
        ctx = self.contexts.get(ctx_token)
        block_id = ctx.block_id if ctx else None

        # 進：正規化（§7.5）
        clean = normalize_args(loaded.manifest, spec, args, block_id=block_id)

        fn = loaded.blocks.get(opcode)
        if fn is None:
            raise ExtensionError(
                f"{opcode} 在 manifest 裡有宣告，但 main.py 沒有對應的實作",
                block_id=block_id,
            )

        result = await self._invoke(
            fn,
            self._ctx(loaded, ctx, block_id=block_id),
            clean,
            what=f"積木包「{loaded.manifest.name}」的 {opcode}",
            block_id=block_id,
        )

        # 出：驗證（§7.5）
        return validate_return(loaded.manifest, spec, result, block_id=block_id)

    async def dropdown(self, opcode: str, source: str, ctx_token: str) -> list[dict[str, Any]]:
        loaded, _ = self._resolve(opcode)
        full = f"{loaded.source.id}.{source}"
        fn = loaded.dropdowns.get(full)
        if fn is None:
            raise ExtensionError(f"積木包「{loaded.source.id}」沒有下拉來源 {source}")

        ctx = self.contexts.get(ctx_token)
        options = await self._invoke(fn, self._ctx(loaded, ctx), {}, what=full)
        return _check_options(options, full)

    async def start_trigger(
        self, opcode: str, sink: Callable[[dict[str, Any]], Awaitable[None]]
    ) -> _TaskTriggerHandle:
        """§7.3：trigger 是 async generator，每 yield 一次餵給 sink 一次。

        真正的排程與 concurrency 策略（§5.1）是 P2 的 Trigger Manager 的事；
        這裡只負責把 generator 轉成一個可停止的 task。
        """
        loaded, _ = self._resolve(opcode)
        fn = loaded.triggers.get(opcode)
        if fn is None:
            raise ExtensionError(f"{opcode} 沒有對應的 @trigger 實作")

        ctx_obj = self.contexts.open(loaded.source.id)
        ctx = self._ctx(loaded, ctx_obj)

        async def pump() -> None:
            try:
                async for payload in fn(ctx):
                    await sink(payload)
            finally:
                self.contexts.close(ctx_obj.token)

        return _TaskTriggerHandle(asyncio.create_task(pump()))

    # ---- 內部 ----

    def _resolve(self, opcode: str) -> tuple[_Loaded, BlockSpec]:
        ext_id = opcode.split(".", 1)[0]
        loaded = self._loaded.get(ext_id)
        if loaded is None:
            raise ExtensionError(f'積木包「{ext_id}」還沒載入')
        spec = loaded.manifest.block(opcode)
        if spec is None:
            raise ExtensionError(f'積木包「{ext_id}」沒有 {opcode} 這顆積木')
        return loaded, spec

    def _ctx(
        self, loaded: _Loaded, ctx: CallContext | None, *, block_id: str | None = None
    ) -> Ctx:
        return Ctx(
            config=loaded.config,
            state=loaded.state,
            channel=self.channel,
            token=ctx.token if ctx else "",
            block_id=block_id,
            http=lambda: self._http_for(loaded),
        )

    def _http_for(self, loaded: _Loaded) -> Any:
        """`ctx.http` 的落點（§7.4）。

        **權限在這裡才真的守得住**：`permissions: [net]` 在 §12.1 是安裝畫面上
        的一句話，而一句沒有人檢查的宣告，使用者讀了也不能信。沒宣告就拿不到
        client——訊息指名是包的宣告漏了，不是使用者的流程錯了。
        """
        if "net" not in loaded.manifest.permissions:
            raise ExtensionError(
                f'積木包「{loaded.manifest.name}」沒有宣告 net 權限，不能使用 ctx.http'
            )
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
        """呼叫積木包的程式碼。

        `async def` 與同步純函式都接受——§7.6 之後跨 process 時兩者沒有差別，
        現在也不該有。
        """
        try:
            result = fn(ctx, **kwargs)
            if inspect.isawaitable(result):
                result = await result
            return result
        except BlockyError:
            # 積木包刻意拋的錯誤（訊息是寫給使用者看的），原樣往上送。
            raise
        except Exception as e:
            # 其餘一律包成 ExtensionError：`try_catch` 才攔得到，而且訊息會
            # 指名是哪個包壞掉，不是使用者的流程壞掉。
            raise ExtensionError(
                f"{what} 執行時發生錯誤：{type(e).__name__}: {e}", block_id=block_id
            ) from e

    def _import(self, source: ExtensionSource) -> Any:
        path = source.entrypoint
        if not path.exists():
            raise ExtensionError(f"積木包「{source.id}」缺少 main.py")
        name = f"blocky_ext.{source.id}"
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise ExtensionError(f"無法載入 {path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except Exception as e:
            sys.modules.pop(name, None)
            raise ExtensionError(f"載入 {path} 失敗：{type(e).__name__}: {e}") from e
        return module

    def _check_coverage(self, loaded: _Loaded) -> None:
        """manifest 與 main.py 必須完全對得起來。

        兩邊漂移的症狀是「工具箱裡有一顆按了沒反應的積木」，而那要等到使用者
        真的拖出來用才會發現。載入期就擋掉。
        """
        mf = loaded.manifest
        declared = {mf.full_opcode(b.opcode) for b in mf.blocks if b.type != "hat"}
        hats = {mf.full_opcode(b.opcode) for b in mf.blocks if b.type == "hat"}
        implemented = set(loaded.blocks)

        if missing := declared - implemented:
            raise ExtensionError(
                f"積木包「{mf.id}」的 manifest 宣告了 {'、'.join(sorted(missing))}，"
                "但 main.py 沒有對應的 @block"
            )
        if extra := implemented - declared:
            raise ExtensionError(
                f"積木包「{mf.id}」的 main.py 實作了 {'、'.join(sorted(extra))}，"
                "但 manifest 沒有宣告——它不會出現在工具箱裡"
            )
        if missing_triggers := hats - set(loaded.triggers):
            raise ExtensionError(
                f"積木包「{mf.id}」的 hat 積木 {'、'.join(sorted(missing_triggers))} "
                "沒有對應的 @trigger"
            )
        for src in sorted(mf.dropdown_sources()):
            if f"{mf.id}.{src}" not in loaded.dropdowns:
                raise ExtensionError(
                    f"積木包「{mf.id}」的參數指定了下拉來源 {src}，"
                    "但 main.py 沒有對應的 @dropdown"
                )


def _check_options(options: Any, source: str) -> list[dict[str, Any]]:
    if not isinstance(options, list) or not all(
        isinstance(o, dict) and isinstance(o.get("label"), str) and "value" in o
        for o in options
    ):
        raise ExtensionError(f"下拉來源 {source} 必須回傳 [{{label, value}}, ...]")
    return options


__all__ = ["InProcessHost"]

"""Interpreter 面對的擴充註冊表。

引擎只認得 `COMMANDS` / `VALUES` 兩張表（`interpreter/registry.py`）。積木包
的 opcode 不在裡面，所以這裡把每顆宣告過的積木包成同樣簽章的 handler
`(Thread, Block) -> Any`，引擎因此不必知道 extension 的存在，只要在查不到
內建 opcode 時多問一句。

**求值仍在引擎這一側**：handler 先把輸入孔求成值，再交給 `host.call`。
這是刻意的——§4.6 的「由左而右、深度優先」是語意，不能因為積木來自第三方
就換一套；而且跨 process 時只有值送得過去，Block 送不過去。
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Literal

from blockyard.errors import ExtensionError
from blockyard.extensions.host import (
    CallContexts,
    EventSinkChannel,
    ExtensionHost,
    HostChannel,
)
from blockyard.extensions.inprocess import InProcessHost
from blockyard.extensions.manifest import BlockSpec, ExtensionSource, Manifest, discover
from blockyard.extensions.subprocess_host import SubprocessHost
from blockyard.interpreter.events import EventSink

if TYPE_CHECKING:  # 只為型別；執行期沒有這條相依，因此與 engine 不成環
    from blockyard.interpreter.engine import Thread
    from blockyard.ir.schema import Block

Handler = Callable[["Thread", "Block"], Awaitable[Any]]

# 引擎的兩張表 → manifest 的積木形狀
_VALUE_SHAPES = frozenset({"reporter", "boolean"})


class ExtensionRegistry:
    def __init__(
        self,
        host: ExtensionHost,
        sources: dict[str, ExtensionSource],
        contexts: CallContexts,
    ) -> None:
        self.host = host
        self.sources = sources
        self.contexts = contexts
        self._loaded: set[str] = set()
        self._cache: dict[str, Handler] = {}

    # ---- 載入 ----

    async def load(self, ext_id: str) -> None:
        await self.host.load(ext_id)
        self._loaded.add(ext_id)

    async def load_all(self) -> None:
        for ext_id in self.sources:
            await self.load(ext_id)

    async def unload_all(self) -> None:
        for ext_id in sorted(self._loaded):
            await self.host.unload(ext_id)
        self._loaded.clear()
        self._cache.clear()

    def is_loaded(self, ext_id: str) -> bool:
        return ext_id in self._loaded

    # ---- 查詢 ----

    def lookup(self, opcode: str) -> tuple[Manifest, BlockSpec] | None:
        ext_id = opcode.split(".", 1)[0]
        if ext_id not in self._loaded:
            return None
        mf = self.sources[ext_id].manifest
        spec = mf.block(opcode)
        return (mf, spec) if spec is not None else None

    def shape(self, opcode: str) -> str | None:
        found = self.lookup(opcode)
        return found[1].type if found else None

    async def dropdown(
        self, ext_id: str, source: str, *, args: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        """動態下拉的選項（D22、§8.1）。`ext_id`／`source` 直接對映
        `POST /api/extensions/{ext_id}/dropdown/{source}`——這是包層級的東西，
        不像 `call()` 需要一個 opcode 去查形狀。

        `args` 是同一顆積木上其他已填參數的值（manifest 的 `depends`）；
        host 會依宣告過濾（`boundary.normalize_dropdown_args`）。"""
        ctx = self.contexts.open(ext_id)
        try:
            return await self.host.dropdown(ext_id, source, ctx.token, args)
        finally:
            self.contexts.close(ctx.token)

    async def start_trigger(
        self, opcode: str, sink: Callable[[dict[str, Any]], Awaitable[None]]
    ) -> Any:
        """接上一顆 hat（§7.3、§9）。回一個 `TriggerHandle`，`stop()` 可以停。

        跟 `dropdown()` 一樣是**包層級**的入口，但生命週期相反：下拉是問完就
        關的一次呼叫，這裡的 ctx 要活到 trigger 被停掉為止（那條 WebSocket 就
        掛在上面），所以 context 由 host 自己開自己關，不是這裡。
        """
        ext_id = opcode.split(".", 1)[0]
        if ext_id not in self._loaded:
            raise ExtensionError(f'積木包「{ext_id}」還沒載入')
        return await self.host.start_trigger(opcode, sink)

    def handler(self, opcode: str, *, want_value: bool) -> Handler | None:
        """回一個與內建積木同簽章的 handler，形狀不符時回 None。

        形狀不符要回 None 而不是拋錯，是為了讓引擎統一產生錯誤訊息——
        「reporter 不能接在堆疊上」對內建與擴充積木應該是同一句話。
        """
        found = self.lookup(opcode)
        if found is None:
            return None
        _, spec = found
        # hat 不是被「執行」的：引擎從 `hat.next` 起跑。它出現在堆疊或輸入孔
        # 裡都是錯的，交給引擎去說明。
        if spec.type == "hat" or (spec.type in _VALUE_SHAPES) != want_value:
            return None
        if opcode not in self._cache:
            self._cache[opcode] = self._make_handler(opcode, spec)
        return self._cache[opcode]

    def _make_handler(self, opcode: str, spec: BlockSpec) -> Handler:
        arg_names = list(spec.args)

        async def handler(t: Thread, b: Block) -> Any:
            block_id = t.interp._bid(b)
            # 宣告順序即求值順序（§4.6）。沒接的孔不送，交給邊界套 default
            # 或報「少了必填參數」——那句話 manifest 才答得出來。
            args: dict[str, Any] = {}
            for name in arg_names:
                if name in b.inputs:
                    args[name] = await t.value(b, name)

            ctx = self.contexts.open(
                opcode.split(".", 1)[0], thread_id=t.id, block_id=block_id
            )
            try:
                return await self.host.call(opcode, args, ctx.token)
            finally:
                self.contexts.close(ctx.token)

        handler.__name__ = f"ext_{opcode.replace('.', '_')}"
        return handler


async def open_registry(
    root: Path | str,
    *,
    sink: EventSink | None = None,
    channel: HostChannel | None = None,
    config: dict[str, dict[str, Any]] | None = None,
    only: list[str] | None = None,
    host: Literal["inprocess", "subprocess"] = "subprocess",
) -> ExtensionRegistry:
    """掃描目錄、建 Host、載入積木包。

    `only` 用來對應 §13.3：專案只宣告了它用到的包，沒宣告的不必付載入成本。

    `host` 預設 `"subprocess"`（§7.6、D13）：這是實際跑第三方積木包的路徑
    （`api/validation.py` 存檔與執行都經過這裡）。`InProcessHost` 保留給
    合約測試自身要直接建構的場合；這裡留一個切換是給未來需要快速路徑
    （例如不碰網路、不需要真隔離）的呼叫端用，不是常態。
    """
    contexts = CallContexts()
    root_path = Path(root)
    sources = discover(root_path)
    # 「這個包宣告了哪幾格面板」只有這裡問得到（`sources` 是 discover 的產物），
    # 而 `EventSinkChannel` 不該知道積木包住在磁碟上的哪裡（§7.5 的介面就是為了
    # 這件事）——所以是注進去的一個函式，不是它自己去掃。
    def panels_of(ext_id: str) -> tuple[str, ...]:
        src = sources.get(ext_id)
        return tuple(p.id for p in src.manifest.panels) if src else ()

    event_channel = channel or EventSinkChannel(sink or EventSink(), contexts, panels_of)
    ext_host: ExtensionHost = (
        InProcessHost(sources, event_channel, contexts, config=config)
        if host == "inprocess"
        else SubprocessHost(
            sources, event_channel, contexts, extensions_root=root_path, config=config
        )
    )
    registry = ExtensionRegistry(ext_host, sources, contexts)

    # **載到一半失敗要把前面那幾個收掉。**
    #
    # 每個包是一個子行程（§7.6），而在這個函式回傳之前，**握得到那些子行程的
    # 只有這個還沒交出去的 `registry`**。所以這裡不收就沒有人收得了：它們會活到
    # 後端關掉為止，而症狀不會出現在失敗的那一次——是後來某一次無關的呼叫拿到
    # 「子行程意外結束」。
    #
    # 兩種失敗都要接住：一個包壞掉（`ExtensionError`），以及**整個請求被取消**
    # （瀏覽器關掉分頁、Run 被停掉）。後者是 `CancelledError`，它不是
    # `Exception` 的子類別，所以這裡接的是 `BaseException`。
    try:
        for ext_id in sources if only is None else only:
            if ext_id in sources:
                await registry.load(ext_id)
    except BaseException:
        await registry.unload_all()
        raise
    return registry


__all__ = ["ExtensionRegistry", "Handler", "open_registry"]

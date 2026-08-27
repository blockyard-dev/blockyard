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
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from blocky.extensions.host import (
    CallContexts,
    EventSinkChannel,
    ExtensionHost,
    HostChannel,
)
from blocky.extensions.inprocess import InProcessHost
from blocky.extensions.manifest import BlockSpec, ExtensionSource, Manifest, discover
from blocky.interpreter.events import EventSink

if TYPE_CHECKING:  # 只為型別；執行期沒有這條相依，因此與 engine 不成環
    from blocky.interpreter.engine import Thread
    from blocky.ir.schema import Block

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
) -> ExtensionRegistry:
    """掃描目錄、建 InProcessHost、載入積木包。

    `only` 用來對應 §13.3：專案只宣告了它用到的包，沒宣告的不必付載入成本。
    """
    contexts = CallContexts()
    sources = discover(Path(root))
    channel = channel or EventSinkChannel(sink or EventSink(), contexts)
    host = InProcessHost(sources, channel, contexts, config=config)
    registry = ExtensionRegistry(host, sources, contexts)

    for ext_id in sources if only is None else only:
        if ext_id in sources:
            await registry.load(ext_id)
    return registry


__all__ = ["ExtensionRegistry", "Handler", "open_registry"]

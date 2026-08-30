"""積木包作者面對的 API（§7.3、§7.4）。

`main.py` 只會 import 這幾個名字：

    from blocky import block, dropdown, trigger, on_load, on_unload

裝飾器不維護任何全域註冊表，只在函式上蓋一個標記，由 loader 掃描模組命名空間
收集。原因很實際：全域表要處理「同一個模組被 import 兩次」與「載入到一半失敗
留下殘骸」，而標記法兩者都不存在——它也讓 `main.py` 可以被單獨 import 來寫
單元測試（§17.4 的「每包自帶 tests/」）。
"""

from __future__ import annotations

from typing import Any, Callable, TypeVar

from blocky.errors import ExtensionError

# 積木包**寫給使用者看的**錯誤。與 `raise ValueError(...)` 的差別在訊息的主詞：
# 未被包住的例外會被 host 包成「積木包「HTTP」的 http.request 執行時發生錯誤：
# ConnectError: …」——那句話說壞掉的是這個包，而連不上一個使用者自己打的網址
# 不是包壞掉。`BlockError` 原樣往上送（`inprocess.py::_invoke` 對 `BlockyError`
# 放行），所以積木包能說出一句主詞正確的話，而 `try_catch` 一樣攔得到。
BlockError = ExtensionError

F = TypeVar("F", bound=Callable[..., Any])

_MARK = "__blocky_export__"


def _mark(kind: str, name: str | None) -> Callable[[F], F]:
    def deco(fn: F) -> F:
        setattr(fn, _MARK, (kind, name))
        return fn

    return deco


def block(opcode: str) -> Callable[[F], F]:
    """一顆積木的實作。`opcode` 是完整的 `包id.短名`。"""
    return _mark("block", opcode)


def dropdown(name: str) -> Callable[[F], F]:
    """動態下拉的選項來源。回傳 `[{"label":..., "value":...}, ...]`。"""
    return _mark("dropdown", name)


def trigger(opcode: str) -> Callable[[F], F]:
    """hat 積木的事件來源。實作是 async generator，每 yield 一次啟動一個 Thread。"""
    return _mark("trigger", opcode)


def on_load(fn: Callable[..., Any]) -> Callable[..., Any]:
    """積木包載入時呼叫一次。建連線、開 client 放進 `ctx.state`。"""
    return _mark("on_load", None)(fn)


def on_unload(fn: Callable[..., Any]) -> Callable[..., Any]:
    """卸載時呼叫一次。"""
    return _mark("on_unload", None)(fn)


def exports(module: Any) -> list[tuple[str, str | None, Callable[..., Any]]]:
    """掃出模組裡所有被標記的函式，回 (kind, name, fn)。"""
    found: list[tuple[str, str | None, Callable[..., Any]]] = []
    for obj in vars(module).values():
        if callable(obj) and hasattr(obj, _MARK):
            kind, name = getattr(obj, _MARK)
            found.append((kind, name, obj))
    return found


class Ctx:
    """§7.4 的 ctx。

    它是**每次呼叫**建立的輕量視角：`config` 與 `state` 指向該積木包共用的
    那一份，`block_id` 與取消旗標則是這一次呼叫的。這個切分是必要的——
    `on_load` 存進 `ctx.state` 的 client，`send_message` 那次呼叫要拿得到；
    而 `ctx.block_id` 每次都不同。
    """

    __slots__ = ("config", "state", "block_id", "_channel", "_token", "_http")

    def __init__(
        self,
        *,
        config: dict[str, Any],
        state: dict[str, Any],
        channel: Any,
        token: str,
        block_id: str | None = None,
        http: Callable[[], Any] | None = None,
    ) -> None:
        self.config = config
        self.state = state
        self.block_id = block_id
        self._channel = channel
        self._token = token
        # 取得 client 的**函式**而不是 client 本身：建一個 `AsyncClient` 會開連線
        # 池，而多數積木碰都不會碰它。權限檢查也在這個函式裡（§12.1）。
        self._http = http

    def log(self, message: str, level: str = "info") -> None:
        """推一個 `log` 事件到前端（§6.1）。同步，見 host.py 的說明。"""
        self._channel.log(self._token, level, message)

    @property
    def cancelled(self) -> bool:
        """協作式取消檢查點（§5.5）。長迴圈中應主動檢查。"""
        return self._channel.is_cancelled(self._token)

    async def emit(self, payload: dict[str, Any]) -> None:
        """trigger 專用：送出一次事件。"""
        await self._channel.emit(self._token, payload)

    @property
    def http(self) -> Any:
        """共用的 httpx client（§7.4、`httpclient.py`）。

        每個包一份、由 host 建立與關閉——積木包不必也不該自己管它的生命週期。
        沒宣告 `permissions: [net]` 的包在這裡就被擋下來。
        """
        if self._http is None:
            raise ExtensionError("這個 host 沒有提供 ctx.http")
        return self._http()


__all__ = [
    "BlockError",
    "Ctx",
    "block",
    "dropdown",
    "exports",
    "on_load",
    "on_unload",
    "trigger",
]

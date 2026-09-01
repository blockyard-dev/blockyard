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

from blocky.errors import ExtensionError, InvalidSecretError, MissingSecretError
from blocky.extensions.httpclient import redact_url

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

    __slots__ = ("config", "state", "block_id", "_channel", "_token", "_http", "_secrets")

    def __init__(
        self,
        *,
        config: dict[str, Any],
        state: dict[str, Any],
        channel: Any,
        token: str,
        block_id: str | None = None,
        http: Callable[[], Any] | None = None,
        secrets: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self.config = config
        self.state = state
        self.block_id = block_id
        self._channel = channel
        self._token = token
        # key → 那一項 `secret` 宣告的描述（extId／extName／envVar／label），由
        # host 從 manifest 算出來。積木包看不到也改不了，見 `require_secret`。
        self._secrets = secrets or {}
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

    def require_secret(self, key: str) -> str:
        """拿一把 `secret` 型 config 的值；沒設定就丟出一個**點得下去**的錯誤。

        每個要金鑰的包都得處理「使用者還沒填」這件事，而各自寫一句中文的結果
        是每個包把使用者送到不同的地方、用不同的說法叫他去找同一個面板。這裡
        統一：訊息由 manifest 的 `label`／`name` 組出來，補救動作
        （`configure_secret`）帶著 extId 與 envVar，前端據此開啟金鑰面板並且
        **把欄位填好**——使用者要做的只剩貼上那一串。

        payload 從 manifest 來而不是從呼叫端的參數來，所以積木包沒有辦法叫前端
        去設定「別人的」金鑰，也沒有辦法把值塞進這條路。
        """
        value = self.config.get(key)
        if value:
            return str(value)

        spec = self._secret_spec(key)
        what = spec.get("label") or key
        raise MissingSecretError(
            f"還沒設定「{spec['extName']}」的{what}",
            action=self._configure_action(spec),
        )

    def invalid_secret(self, key: str, message: str) -> InvalidSecretError:
        """金鑰有設定，但**對方說它不對**。回一個帶著同一顆按鈕的錯誤。

        `require_secret` 只管得到「還沒填」，而「填了、但對方拒絕」是同一條路
        上更常見的一站：token 被 reset 過、複製時少了一個字元、貼成了另一個
        專案那一把。這兩件事對使用者的意思不同（第二種還多一個「我以為我設定
        好了」的落差），要去的地方卻**完全一樣**——所以是同一個
        `configure_secret`，不是一種新的補救動作。

        沒有這個方法，每個包只能自己寫一句「請到右上角『金鑰』重新匯入
        XXX_API_KEY」的純文字——`openai` 現在就是這樣寫的，而那正是 D28 想要
        消滅的東西。**訊息由包供，payload 仍然只從 manifest 來**：包說得出
        「Discord 說這個 token 不對」，說不出「去設定別人的金鑰」。

        回傳而不是 raise，是為了讓呼叫端寫得出 `raise ctx.invalid_secret(...)
        from e`——原始例外要留在 `__cause__` 裡，那是 traceback 唯一說得出
        「SDK 到底丟了什麼」的地方。
        """
        return InvalidSecretError(message, action=self._configure_action(self._secret_spec(key)))

    def _secret_spec(self, key: str) -> dict[str, Any]:
        spec = self._secrets.get(key)
        if spec is None:
            # 包要一把自己沒宣告過的金鑰。這是包的 bug，不是使用者的問題，
            # 所以主詞要指回包身上，也不給補救按鈕。
            raise ExtensionError(f"這個積木包沒有宣告名為「{key}」的 secret 設定項")
        return spec

    @staticmethod
    def _configure_action(spec: dict[str, Any]) -> dict[str, Any]:
        return {
            "kind": "configure_secret",
            "extId": spec["extId"],
            "extName": spec["extName"],
            "key": spec["key"],
            "label": spec.get("label"),
            "envVar": spec.get("envVar"),
        }

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
    "InvalidSecretError",
    "MissingSecretError",
    "block",
    "dropdown",
    "exports",
    "on_load",
    "on_unload",
    "redact_url",
    "trigger",
]

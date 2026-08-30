"""`ctx.http`：所有積木包共用的 HTTP client（§7.4）。

**它由 host 提供，不由積木包自己 `import httpx`。** 三個理由，一個比一個實際：

1. **預設值只設一次。** 逾時、連線重試、redirect、User-Agent 是每個包都會答錯
   一次的東西——沒有逾時的請求會讓一條 Thread 永遠掛著，而 §5.5 的停止只等得到
   一個會回來的 await。
2. **連線池共用。** 一個包一個 client 等於一個包一組連線池；`http` 與 `openai`
   打同一個網域時沒有理由開兩份。
3. **它是權限的落點。** `permissions: [net]` 在 §12.1 是講給使用者看的一句話，
   而這裡是它第一個真的守得住的地方（見 `inprocess.py::_http_for`）——沒宣告
   `net` 的包拿不到 client。守不住的宣告不如不宣告。

**重試只重試「連不上」**（`AsyncHTTPTransport(retries=)` 的語意就是連線建立階段）。
收到回應之後的重試一律不做：`POST` 不是冪等的，而「幫你重送一次訂單」是這一層
最不該自作主張的事。要重試的積木包自己寫迴圈，那時它看得到 status code。

跨 process 之後（§7.6）這份設定跟著 SDK 進到子 process，兩邊仍然是同一段程式碼
——與 `boundary.py` 同一個理由：一致不是靠自律。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # httpx 只在真的有包要用網路時才 import
    import httpx

# 連線 10 秒、整趟 30 秒。整趟的上限刻意不無限：長輪詢那種需求要的是 §7.3 的
# trigger，不是一顆等 10 分鐘的積木。
CONNECT_TIMEOUT = 10.0
TOTAL_TIMEOUT = 30.0
CONNECT_RETRIES = 2

USER_AGENT = "blocky/0.1"


def new_client(**overrides: Any) -> httpx.AsyncClient:
    """建一個帶預設值的 `httpx.AsyncClient`。

    `httpx` 是延遲 import 的：沒有任何包用到網路時，它不必存在於 process 裡。
    """
    import httpx

    kwargs: dict[str, Any] = {
        "timeout": httpx.Timeout(TOTAL_TIMEOUT, connect=CONNECT_TIMEOUT),
        "follow_redirects": True,
        "headers": {"user-agent": USER_AGENT},
        "transport": httpx.AsyncHTTPTransport(retries=CONNECT_RETRIES),
    }
    kwargs.update(overrides)
    return httpx.AsyncClient(**kwargs)


__all__ = ["CONNECT_RETRIES", "CONNECT_TIMEOUT", "TOTAL_TIMEOUT", "USER_AGENT", "new_client"]

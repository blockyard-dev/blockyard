"""`ctx.http`：所有積木包共用的 HTTP client（§7.4）。

**它由 host 提供，不由積木包自己 `import httpx`。** 三個理由，一個比一個實際：

1. **預設值只設一次。** 逾時、連線重試、redirect、User-Agent 是每個包都會答錯
   一次的東西——沒有逾時的請求會讓一條 Thread 永遠掛著，而 §5.5 的停止只等得到
   一個會回來的 await。
2. **連線池共用。** 一個包一個 client 等於一個包一組連線池；`http` 與 `openai`
   打同一個網域時沒有理由開兩份。
3. **它是權限的落點。** `permissions: [net]` 在 §12.1 是講給使用者看的一句話，
   而這裡是它第一個真的守得住的地方（見 `loading.py::check_net_permission`，
   `InProcessHost`／subprocess worker 都呼叫它）——沒宣告 `net` 的包拿不到
   client。守不住的宣告不如不宣告。

**重試只重試「連不上」**（`AsyncHTTPTransport(retries=)` 的語意就是連線建立階段）。
收到回應之後的重試一律不做：`POST` 不是冪等的，而「幫你重送一次訂單」是這一層
最不該自作主張的事。要重試的積木包自己寫迴圈，那時它看得到 status code。

跨 process 之後（§7.6）這份設定跟著 SDK 進到子 process，兩邊仍然是同一段程式碼
——與 `boundary.py` 同一個理由：一致不是靠自律。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

if TYPE_CHECKING:  # httpx 只在真的有包要用網路時才 import
    import httpx

# §12.2：query string 裡這幾類名字（大小寫不分）常常帶著 secret——
# `?api_key=sk-…`、`?token=…`。錯誤訊息把整段 URL 塞進去之前先洗一遍。
_SENSITIVE_QUERY_KEYS = ("token", "key", "secret")

# 連線 10 秒、整趟 30 秒。整趟的上限刻意不無限：長輪詢那種需求要的是 §7.3 的
# trigger，不是一顆等 10 分鐘的積木。
CONNECT_TIMEOUT = 10.0
TOTAL_TIMEOUT = 30.0
CONNECT_RETRIES = 2

USER_AGENT = "blockyard/0.1"


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


def redact_url(url: str) -> str:
    """§12.2：query string 裡看起來像 token／key／secret 的參數值換成 `***`。

    只洗 query string——路徑與網域本身很少帶 secret，而且是使用者最需要看到
    才判斷得出「是哪個網址」的部分。名字比對只看有沒有出現
    `token`／`key`／`secret` 這幾個字（不分大小寫），例如 `api_key`、
    `access_token` 都算——寧可洗多不洗漏，反正這裡只是拿掉錯誤訊息裡的一段
    文字，不影響真正送出去的請求。
    """
    parts = urlsplit(url)
    if not parts.query:
        return url
    cleaned = [
        (k, "***" if any(s in k.lower() for s in _SENSITIVE_QUERY_KEYS) else v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
    ]
    # `safe='*'`：不然 `urlencode` 會把遮蔽用的 `***` 自己 percent-encode 成
    # `%2A%2A%2A`，讀起來比原始明文還難懂，違背遮蔽是為了「看得懂但看不到
    # 明文」的用意。
    return urlunsplit(parts._replace(query=urlencode(cleaned, safe="*")))


__all__ = [
    "CONNECT_RETRIES",
    "CONNECT_TIMEOUT",
    "TOTAL_TIMEOUT",
    "USER_AGENT",
    "new_client",
    "redact_url",
]

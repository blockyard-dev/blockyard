"""HTTP 積木包的實作（§7.3）。

**回應是一個物件，不是四顆積木。** 一顆 `取得狀態碼`、一顆 `取得內容` 的作法
要嘛把請求發兩次，要嘛在包裡藏一份「上一次的回應」——後者是隱藏狀態，兩條
Thread 同時跑就是錯的（§5.1）。回一個物件之後，取值是 §4.7 已經有的東西：

    如果 ${r.ok} → log ${r.body.items[1].title}

**HTTP 錯誤不是積木錯誤。** 404 與 500 回的是 `ok: false` 的正常回應，因為它們
是**伺服器的回答**——把它們變成例外，等於逼使用者用 `try_catch` 寫每一個
「找不到就算了」。真正丟錯的只有「話沒說完」：連不上、逾時、網址不合法。

`import httpx` 但 manifest 的 `requirements` 是空的，不是漏寫：client 由 host
提供（`ctx.http`，§7.4），這裡只是要它的例外型別。
"""

from urllib.parse import quote

import httpx

from blockyard import BlockError, block, dropdown, redact_url

METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]

# 送不送內容看 method，不看內容是不是空的。「空物件等於不送」讀起來很體貼，
# 但它讓 `POST {}` 這件合法的事做不到，而那種例外只有踩到的人才知道。
NO_BODY = frozenset({"GET", "HEAD"})


@block("http.get")
async def get(ctx, url):
    return await _send(ctx, "GET", url, {}, None)


@block("http.post")
async def post(ctx, url, body):
    return await _send(ctx, "POST", url, {}, body)


@block("http.request")
async def request(ctx, method, url, headers, body):
    return await _send(ctx, method, url, headers, body)


@block("http.url_encode")
async def url_encode(ctx, text):
    return quote(text, safe="")


@dropdown("http.methods")
async def methods(ctx):
    return [{"label": m, "value": m} for m in METHODS]


async def _send(ctx, method, url, headers, body):
    m = str(method).strip().upper()
    if m not in METHODS:
        raise BlockError(f"不認得的方法「{method}」。可以用：{'、'.join(METHODS)}")
    if not url.startswith(("http://", "https://")):
        raise BlockError(f"網址要以 http:// 或 https:// 開頭，收到「{url[:60]}」")
    if not isinstance(headers, dict):
        raise BlockError("標頭要是一個物件，例如 {\"authorization\": \"Bearer …\"}")

    kwargs = {}
    if headers:
        kwargs["headers"] = {str(k): str(v) for k, v in headers.items()}
    if body is not None and m not in NO_BODY:
        kwargs["json"] = body

    try:
        resp = await ctx.http.request(m, url, **kwargs)
    except httpx.TimeoutException as e:
        raise BlockError(f"等 {redact_url(url)} 回應超過時間了（{e.__class__.__name__}）") from e
    except httpx.HTTPError as e:
        # 連不上、DNS 查不到、憑證不對——主詞是這個網址，不是這個積木包。
        # §12.2：query string 裡可能帶著呼叫端自己的 token，錯誤訊息先洗過。
        raise BlockError(f"連不上 {redact_url(url)}：{e}") from e

    return {
        "status": resp.status_code,
        "ok": resp.is_success,
        # redirect 之後的最終網址（client 預設 follow_redirects）。
        "url": str(resp.url),
        # 一律小寫：HTTP 的標頭名不分大小寫，而 ${r.headers.content-type} 分。
        "headers": {k.lower(): v for k, v in resp.headers.items()},
        "body": _body(resp),
    }


def _body(resp):
    """是 JSON 就給 dict / list，不是就給原始文字。

    看 `content-type` 而不是「試著 parse 看看」：一段剛好長得像數字的純文字
    （`"42"`）會被後者悄悄變成數字，而那是伺服器沒有說過的話。
    """
    if "json" in resp.headers.get("content-type", ""):
        try:
            return resp.json()
        except ValueError:
            # 說了是 JSON 卻不是。原文交出去，讓使用者看得到伺服器實際回了什麼。
            return resp.text
    return resp.text

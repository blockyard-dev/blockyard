"""OpenAI 積木包的實作（§15、P1 第 3 步）。

**client 由 `AsyncOpenAI(http_client=ctx.http)` 包出來，不讓 SDK 自己開連線。**
§12.1 說 `permissions: [net]` 要有一個真的守得住的落點，而 `ctx.http` 就是那個
落點——SDK 自己 new 一條 client 出來，那句宣告就退回成安裝畫面上的一行字。
`openai` 3.x 相依的是 `httpx2`，`ctx.http` 是 backend 的 `httpx` 0.28，兩個是
不同的發行套件；SDK 內部有一層雙棧相容（`openai/_httpx2.py` 的
`is_legacy_httpx_async_client()`），legacy client 是它明確支援的路徑，不是
碰巧沒被擋下來。

**`max_retries=0`。** SDK 預設會替 429／5xx 退避重試兩次。§7.4 的規矩是「重試
只重試連不上，收到回應之後一律不重試」——而這裡收到回應之後重試的代價比
`http` 那邊更直接：模型可能已經算完並且已經計費了。要重試的人在畫布上寫迴圈，
那時他看得到 status，也看得到自己重試了幾次。

**HTTP 錯誤在這裡是積木錯誤，跟 `http` 包相反。** `http.get` 的 404 是伺服器對
「使用者自己打的那個網址」的回答，所以回 `ok: false` 的正常回應；這裡的 401 是
「你的金鑰不對」，沒有一個合理的工作流會想用 `如果 ${r.ok}` 去接它。分界仍然是
§7.3 的那一句「誰做錯了」，只是這個包的答案落在另一邊。
"""

import openai
from openai import AsyncOpenAI

from blocky import BlockError, block, dropdown

# 策展清單，不是即時打 `GET /v1/models`。理由跟 §7.1「不打真 API」一致：一份
# 會因為上游多上架一顆模型就變長的下拉，等於把「選哪一顆」這個決定丟回給使用
# 者去讀 80 個 id。日後要換成活的，只要改這個函式的實作——manifest、IR、前端
# widget 都不用動。
MODELS = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]


@block("openai.chat")
async def chat(ctx, model, prompt):
    resp = await _create(ctx, model=model, input=prompt)

    text = resp.output_text
    if text:
        return text

    # 空字串是這個包最容易讓人「我明明做對了」的一種結果：畫布上看起來成功，
    # 接下來每一顆積木都拿到空的。把模型為什麼沒說話講出來。
    raise BlockError(f"模型這次沒有回任何文字（{_why_empty(resp)}）")


@block("openai.chat_full")
async def chat_full(ctx, model, prompt, instructions, max_output_tokens):
    kwargs = {
        "model": model,
        "input": prompt,
        "max_output_tokens": int(max_output_tokens),
    }
    # 空的系統指示就不送。這裡的「空等於不送」跟 `http` 拒絕的那個不一樣：
    # `POST {}` 是一件使用者可能真的想做的事，而「送一段空的角色設定」不是。
    if instructions.strip():
        kwargs["instructions"] = instructions

    resp = await _create(ctx, **kwargs)
    incomplete = resp.incomplete_details

    return {
        "text": resp.output_text,
        "model": resp.model,
        "id": resp.id,
        "status": resp.status,
        # 被 max_output_tokens 砍掉時 status 是 incomplete。少了這一欄，使用者
        # 看到的是一段莫名其妙斷在半句的文字。
        "incomplete_reason": incomplete.reason if incomplete else None,
        "usage": _usage(resp.usage),
    }


@dropdown("openai.models")
async def models(ctx):
    return [{"label": m, "value": m} for m in MODELS]


async def _client(ctx):
    """這個包共用的一份 client，建好放 `ctx.state`。

    `on_load` 不建：建 client 要碰 `ctx.http`，而 §7.4 的 client 是碰到才開連線
    池——在 `on_load` 建等於每個「裝了這個包但這次沒用到」的專案都付一次連線池。
    也不必 `on_unload` 關：底下那條 httpx client 是 host 的，host 自己會收。
    """
    client = ctx.state.get("client")
    if client is not None:
        return client

    # 沒設定時丟的是 `MissingSecretError`，前端會把它畫成一顆「去設定」的按鈕
    # 並且預先填好 `OPENAI_API_KEY`——訊息與那顆按鈕都由 host 從 manifest 組出
    # 來，這個包不必也不該自己寫一次「右上角金鑰在哪裡」。
    api_key = ctx.require_secret("api_key")

    kwargs = {"api_key": api_key, "http_client": ctx.http, "max_retries": 0}
    base_url = (ctx.config.get("base_url") or "").strip()
    if base_url:
        kwargs["base_url"] = base_url

    client = AsyncOpenAI(**kwargs)
    ctx.state["client"] = client
    return client


async def _create(ctx, **kwargs):
    client = await _client(ctx)
    try:
        return await client.responses.create(**kwargs)
    except openai.AuthenticationError as e:
        raise BlockError(
            "OpenAI 說這把金鑰不對或已經失效。右上角「金鑰」重新匯入一次 OPENAI_API_KEY"
        ) from e
    except openai.RateLimitError as e:
        raise BlockError(
            "被 OpenAI 限流了，或這個帳號的額度已經用完。等一下再試；"
            "要自動重試請在畫布上自己寫迴圈"
        ) from e
    except openai.APITimeoutError as e:
        # APIConnectionError 的子類，所以要排在它前面。
        raise BlockError(f"等 OpenAI 回應超過時間了（{e.__class__.__name__}）") from e
    except openai.APIConnectionError as e:
        raise BlockError(f"連不上 OpenAI：{e}") from e
    except openai.APIStatusError as e:
        # 其餘的 4xx／5xx：模型名打錯、參數不合法、上游掛掉……。原句交出去比
        # 翻成一句籠統的中文有用——那句話裡通常寫著到底哪個參數不對。
        raise BlockError(f"OpenAI 回了 {e.status_code}：{_message(e)}") from e


def _usage(usage):
    if usage is None:
        return None
    return {
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "total_tokens": usage.total_tokens,
    }


def _why_empty(resp):
    if resp.incomplete_details and resp.incomplete_details.reason:
        return f"沒說完就停了：{resp.incomplete_details.reason}"
    if resp.error and resp.error.message:
        return resp.error.message
    return f"status: {resp.status}"


def _message(e):
    """SDK 的 `e.message` 在有些狀況下是整段 JSON。挖得到 API 自己那句就用它。"""
    body = getattr(e, "body", None)
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict) and err.get("message"):
            return err["message"]
    return e.message

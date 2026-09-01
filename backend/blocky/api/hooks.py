"""`/hooks/{token}/{path}`：外面打進來的 webhook（§9.1、§9.3，P2 第 2c 步）。

**不掛在 `/api` 底下**，因為它不是這個編輯器的 API——它是給 GitHub、Stripe、
某個表單服務打的位址，跟 `/ws/run/…` 分開的理由一樣。

**一條 catch-all，不是一條一條動態掛。** §9.1 的原話是「FastAPI 動態路由」，
但 Starlette 沒有移除路由的 API，而 `app.routes` 是一個有順序的 list——真的去
增刪它就是在動框架沒有承諾過的內部狀態，刪到一半的中間狀態還會讓別的路徑也
404。改成查表之後，使用者看到的網址一模一樣，而「現在有哪些 webhook」變成
`TriggerManager` 裡一個 dict 的內容，跟其他 trigger 走同一條生命週期。

**收下就回，不等流程跑完。** webhook 的另一端多半有幾秒的逾時，而一個流程可以
跑好幾分鐘。回 202 + runId：那是「收到了，開始跑了」，不是「做完了」——與
`DELETE /api/runs/{id}` 回 202 是同一條理由。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from blocky.runs.triggers import TriggerManager

router = APIRouter(tags=["hooks"])

#: 收得下的 body 大小。超過就 413——一個 webhook 的 payload 是一份 JSON，
#: 不是一個檔案上傳，而沒有上限的話任何人都能拿這條路徑把記憶體吃光。
MAX_BODY_BYTES = 1024 * 1024

#: 這些 header 不進 payload。`authorization` / `cookie` 是憑證，進了 payload
#: 就會沿著事件流廣播出去（§8.5 的 `block.enter` 帶展開後的字串），而 §12.2
#: 的遮蔽只認得「這次 Run 用到的 secret」——它不認識別人送來的 token。
_STRIPPED_HEADERS = frozenset({"authorization", "cookie", "proxy-authorization"})


@router.api_route(
    "/hooks/{token}/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    status_code=202,
)
async def receive(token: str, path: str, request: Request) -> dict[str, Any]:
    """外面打進來的一則 webhook。

    方法收得寬，是因為對面是誰決定的：GitHub 用 POST，但有些服務會先用 GET
    打一次做驗證。積木上沒有「哪個方法」這一格（§9.1 只說路徑），所以這裡不
    挑——method 進 payload，要分辨就在畫布上用 `如果` 分。
    """
    manager: TriggerManager = request.app.state.triggers

    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        raise HTTPException(
            status_code=413,
            detail={"message": f"webhook 內容超過 {MAX_BODY_BYTES // 1024} KB"},
        )

    payload = {
        "body": _parse_body(raw, request.headers.get("content-type", "")),
        "headers": {
            k.lower(): v for k, v in request.headers.items() if k.lower() not in _STRIPPED_HEADERS
        },
        "query": dict(request.query_params),
        "method": request.method,
    }

    if not await manager.deliver(token, path, payload):
        # **不分「token 錯」與「路徑錯」。** 兩種分開回答等於告訴掃描的人
        # 「token 對了，繼續猜路徑」——而 §9.3 的整個模型建立在那串東西猜不到
        # 上面。也不說「這個專案沒有在跑」，同一個理由。
        raise HTTPException(status_code=404, detail={"message": "找不到這個 webhook"})

    return {"status": "accepted"}


def _parse_body(raw: bytes, content_type: str) -> Any:
    """JSON 就解開，其他一律當文字。

    **不猜。** `application/json` 才解析——一個送 `text/plain` 但內容剛好長得
    像 JSON 的請求，解開之後積木上拿到的型別會跟它宣告的不一樣，而那正是
    D10「parse 不自動」在講的事。解不開的 JSON 也回原文字串，不是 400：那是
    對面的問題，而使用者要看得到自己收到了什麼才查得下去。
    """
    text = raw.decode("utf-8", errors="replace")
    if not text:
        return None
    if "json" not in content_type.lower():
        return text
    import json

    try:
        return json.loads(text)
    except ValueError:
        return text


__all__ = ["MAX_BODY_BYTES", "router"]

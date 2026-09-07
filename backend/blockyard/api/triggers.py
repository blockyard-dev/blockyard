"""`/api/triggers`：把專案標記為 active，讓它的 hat 常駐（§9、P2 第 2 步）。

**取代了 P1 的 `/api/listeners`。** 那條路管的是「這個 process 現在有沒有在
聽」，重啟就沒了；這條管的是「這個專案是不是 active」，那件事寫在 SQLite 上、
與瀏覽器和後端的生死無關（§9.2）。兩條同時留著就是同一件事兩個入口，而其中
一個還會給出過期的答案。

**以專案為單位，不是以 hat 為單位。** 一個專案的 hat 集合來自它的 IR，而
「使用者要聽哪幾顆」不是一個獨立的決定——他要的是「這份流程有沒有在跑」。
§9.2 的 diff 是同一個粒度往下切的**實作細節**，不是一個 API 概念。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, HTTPException, Request, Response
from pydantic import BaseModel

from blockyard.api.errors import invalid_ir
from blockyard.errors import BlockyardError, ValidationError
from blockyard.extensions import secret_store
from blockyard.runs import ProjectNotFound
from blockyard.runs.triggers import TriggerManager

router = APIRouter(prefix="/api/triggers", tags=["triggers"])


class ActivateRequest(BaseModel):
    projectId: str


class SecretRequest(BaseModel):
    #: 哪一顆積木。**在 body 裡而不是網址路徑上**，見下面那段註解。
    blockId: str
    secret: str


def _triggers(request: Request) -> TriggerManager:
    return request.app.state.triggers


@router.get("")
async def list_active(request: Request) -> list[dict[str, Any]]:
    """所有 active 專案。後端重啟之後這一份仍然在（§9.2）。"""
    return [state.summary() for state in _triggers(request).list()]


@router.get("/{project_id}")
async def get_active(project_id: str, request: Request) -> dict[str, Any]:
    """一個專案的狀態。**沒在跑不是 404**：「它是不是 active」對任何存在的
    專案都有答案，而那個答案是 false。"""
    manager = _triggers(request)
    state = manager.get(project_id)
    if state is not None:
        return {**state.summary(), "webhooks": manager.urls(project_id)}
    return {"projectId": project_id, "active": False, "hats": [], "errors": [], "webhooks": []}


@router.post("", status_code=201)
async def activate(request: Request, body: ActivateRequest = Body(...)) -> dict[str, Any]:  # noqa: B008
    """標記 active 並接上。**已經 active 就重新同步一次**，不是 409。

    重新同步而不是原樣回去，是因為使用者按下去的意思是「照現在這份畫布跑」。
    """
    try:
        state = await _triggers(request).activate(body.projectId)
    except ProjectNotFound:
        raise HTTPException(
            status_code=404,
            detail={"code": "project.not_found", "params": {"projectId": body.projectId},
                    "message": f"找不到專案 {body.projectId}",
                    "hintCode": "project.save_before_listen", "hintParams": {}, "hint": "先存檔再啟用"},
        ) from None
    except ValidationError as e:
        raise invalid_ir(e) from None
    except BlockyardError as e:
        # 積木包接不上（token 不對、包壞了）。422 而不是 500：錯的是這份專案
        # 用到的東西，不是後端。
        raise HTTPException(status_code=422, detail=e.to_dict()) from None
    return {**state.summary(), "webhooks": _triggers(request).urls(body.projectId)}


@router.delete("/{project_id}", status_code=204)
async def deactivate(project_id: str, request: Request) -> None:
    """停掉。**沒在跑也是 204**：使用者要的結果是「現在沒在跑」，而那已經成立。"""
    await _triggers(request).deactivate(project_id)


# --------------------------------------------------------------------------
# webhook 的簽章密鑰（§9.3、§16 Q22 決議 (a)）
# --------------------------------------------------------------------------
#
# **不走 `/api/keys`。** 那條路管的是積木包宣告的 `config`（一個 ext_id 一組，
# 見 D28）；這個是一顆積木一把，範圍是專案。兩者存在同一個 keyring，但「哪些
# 東西存在」的問法完全不同——積木包的金鑰列得出來（manifest 說有哪幾把），
# webhook 的密鑰只有畫布知道。
#
# ## blockId 不能進網址路徑
#
# Blockly 產生的 id 是從一鍋含 `!#$%()*+,-./:;=?@[]^_`{|}~` 的字元裡抽出來的
# ——**大約五分之一含有 `/`**。而 ASGI 伺服器會在路由**之前**就把 `%2F` 解碼回
# `/`，於是 `{block_id}` 那一格看到的是多出來的一段路徑，比對不上 → 404。
#
# 症狀特別難查：使用者按了「設定密鑰」，畫面回到清單，而那一列仍然寫著「還沒
# 設密鑰」——看起來像「存了但沒生效」，其實是根本沒存進去。而且它**只有五分之
# 一的積木會發生**，所以換一顆積木試就好了，於是更像是隨機的鬼。
#
# 所以 blockId 走 body（PUT）與 query（DELETE）。不是為了對稱，是各自對：
# 密鑰本來就只能在 body，而 DELETE 沒有 body。


@router.put("/{project_id}/secret", status_code=204)
async def set_webhook_secret(
    project_id: str,
    body: SecretRequest = Body(...),  # noqa: B008
) -> None:
    """設定一顆 webhook 積木的簽章密鑰。

    **密鑰不進 IR**（D28）。所以它也不跟著專案走：分享出去的專案在對方機器上
    會驗不過，而那是對的——`GET /api/triggers/{id}` 的 `secretSet: false` 就是
    講這件事的地方。
    """
    if not body.secret.strip():
        raise HTTPException(
            status_code=422, detail={"message": "密鑰是空的。要拿掉請用 DELETE"}
        )
    secret_store.set(secret_store.webhook_owner(project_id), body.blockId, body.secret)


@router.get("/{project_id}/secret/reveal")
async def reveal_webhook_secret(
    project_id: str, blockId: str, response: Response  # noqa: N803
) -> dict[str, str]:
    """把**一顆積木**的簽章密鑰明文交出來，給前端的複製按鈕用。

    與 `/api/keys/…/reveal` 同一條 D28 的理由：「不顯示明文」擋的是**畫面上一直
    躺著一串密鑰**（肩後偷看、截圖、螢幕分享），而複製按鈕不違反它——值只進剪貼
    簿，不進 DOM、不進列表回應，而且要打一個**指名到這一顆**的端點才拿得到。
    從自己的機器把自己的密鑰複製到自己的剪貼簿，跟「分享專案等於分享金鑰」是
    兩回事。

    刻意是獨立端點而不是 `GET /api/triggers/{id}` 上的一個欄位：那條路每開一次
    面板就打一次，把明文掛在上面等於讓它跟著每一次輪詢多走一趟。

    `no-store` 不是形式：GET 回應預設可被快取，而這一份不該留在任何一層快取裡。
    """
    value = secret_store.get(secret_store.webhook_owner(project_id), blockId)
    if not value:
        raise HTTPException(status_code=404, detail={"message": "這一顆還沒有設定密鑰"})
    response.headers["Cache-Control"] = "no-store"
    return {"value": value}


@router.delete("/{project_id}/secret", status_code=204)
async def clear_webhook_secret(project_id: str, blockId: str) -> None:  # noqa: N803
    """拿掉密鑰。**沒設過也是 204**：要的結果是「現在沒有」，而那已經成立。

    拿掉之後那顆積木會擋掉每一則請求（宣告說要驗但驗不了）——那不是回歸「不
    驗」，見 `runs/triggers.py` 的 `_signature_ok`。
    """
    secret_store.delete(secret_store.webhook_owner(project_id), blockId)


__all__ = ["router"]

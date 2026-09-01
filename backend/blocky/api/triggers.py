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

from fastapi import APIRouter, Body, HTTPException, Request
from pydantic import BaseModel

from blocky.api.errors import invalid_ir
from blocky.errors import BlockyError, ValidationError
from blocky.runs import ProjectNotFound
from blocky.runs.triggers import TriggerManager

router = APIRouter(prefix="/api/triggers", tags=["triggers"])


class ActivateRequest(BaseModel):
    projectId: str


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
            detail={"message": f"找不到專案 {body.projectId}", "hint": "先存檔再啟用"},
        ) from None
    except ValidationError as e:
        raise invalid_ir(e) from None
    except BlockyError as e:
        # 積木包接不上（token 不對、包壞了）。422 而不是 500：錯的是這份專案
        # 用到的東西，不是後端。
        raise HTTPException(status_code=422, detail=e.to_dict()) from None
    return {**state.summary(), "webhooks": _triggers(request).urls(body.projectId)}


@router.delete("/{project_id}", status_code=204)
async def deactivate(project_id: str, request: Request) -> None:
    """停掉。**沒在跑也是 204**：使用者要的結果是「現在沒在跑」，而那已經成立。"""
    await _triggers(request).deactivate(project_id)


__all__ = ["router"]

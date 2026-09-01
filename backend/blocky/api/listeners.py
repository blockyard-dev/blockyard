"""`/api/listeners`：把畫布上的 hat 接上／斷開（§9、P1 第 4 步第 3 段）。

**是 `/api/listeners` 而不是 `/api/triggers`**：這條路管的是「這個專案現在有
沒有在聽」，而 §9 的 trigger 是被聽的那一端（cron、webhook、積木包的 hat）。
P2 的 Trigger Manager 進來時，它管的東西會住在 `/api/triggers`，兩者不該撞名。

**以專案為單位，不是以 hat 為單位。** 一個專案的 hat 集合來自它的 IR，而
「使用者要聽哪幾顆」不是一個獨立的決定——他要的是「這份流程有沒有在跑」。
§9.2 的「diff 新舊 hat 集合、只重啟有變動的」是同一個粒度往下切，屬於 P2。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, HTTPException, Request
from pydantic import BaseModel

from blocky.api.errors import invalid_ir
from blocky.errors import BlockyError, ValidationError
from blocky.runs import ProjectNotFound
from blocky.runs.listeners import ListenerManager

router = APIRouter(prefix="/api/listeners", tags=["listeners"])


class ListenRequest(BaseModel):
    projectId: str


def _listeners(request: Request) -> ListenerManager:
    return request.app.state.listeners


@router.get("")
async def list_listeners(request: Request) -> list[dict[str, Any]]:
    return [listener.summary() for listener in _listeners(request).list()]


@router.post("", status_code=201)
async def start_listening(request: Request, body: ListenRequest = Body(...)) -> dict[str, Any]:  # noqa: B008
    """接上這個專案的 hat。**已經在聽就原樣回去**，不是 409。

    前端的「執行」會順手打這一條（使用者不必知道那是兩件事），所以「已經開著」
    是最常見的情況，不是例外狀況。
    """
    try:
        listener = await _listeners(request).start(body.projectId)
    except ProjectNotFound:
        raise HTTPException(
            status_code=404,
            detail={"message": f"找不到專案 {body.projectId}", "hint": "先存檔再監聽"},
        ) from None
    except ValidationError as e:
        raise invalid_ir(e) from None
    except BlockyError as e:
        # 積木包接不上（token 不對、包壞了）。422 而不是 500：錯的是這份專案
        # 用到的東西，不是後端。
        raise HTTPException(status_code=422, detail=e.to_dict()) from None
    return listener.summary()


@router.delete("/{project_id}", status_code=204)
async def stop_listening(project_id: str, request: Request) -> None:
    """斷開。**沒在聽也是 204**：使用者要的結果是「現在沒在聽」，而那已經成立。"""
    await _listeners(request).stop(project_id)

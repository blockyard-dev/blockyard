"""`/api/runs` 與 `/ws/run/{runId}`（附錄 A、§6.1）。

WebSocket 的路由不掛在 `/api` 底下——附錄 A 就是這樣寫的（`ws://…/ws/run/…`），
而且分開之後前端的代理設定看得出「這條不是 REST」。

**先 POST 拿 runId，再連 WebSocket**，中間必然有幾毫秒的空窗。空窗期間的事件
由 `RunBroker` 的 backlog 接住（見那個檔案）——把 Run 卡住等 WebSocket 才開跑
是另一種做法，但那會讓「執行」這個動作的完成與否取決於前端有沒有連上來，
CLI 或 cron 觸發時就沒有人來解鎖了。
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Request, Response, WebSocket
from fastapi.websockets import WebSocketDisconnect
from pydantic import BaseModel, Field

from blocky.api.errors import invalid_ir
from blocky.errors import ValidationError
from blocky.runs import DEFAULT_TRIGGER, ProjectNotFound, RunManager

router = APIRouter(prefix="/api/runs", tags=["runs"])
ws_router = APIRouter()

# WebSocket 沒有 404；用 close code 表達。4000+ 是應用自訂區間。
WS_RUN_NOT_FOUND = 4404


class RunRequest(BaseModel):
    projectId: str
    trigger: str = DEFAULT_TRIGGER
    payload: dict[str, Any] = Field(default_factory=dict)


def _runs(request: Request | WebSocket) -> RunManager:
    return request.app.state.runs


@router.post("", status_code=201)
async def start_run(request: Request, body: RunRequest = Body(...)) -> dict[str, Any]:  # noqa: B008
    """跑一次**已存檔**的專案。回來時 Run 已經在跑了（見 `runs/manager.py`）。"""
    try:
        handle = await _runs(request).start(
            body.projectId, trigger=body.trigger, payload=body.payload
        )
    except ProjectNotFound:
        raise HTTPException(
            status_code=404,
            detail={"message": f"找不到專案 {body.projectId}", "hint": "先存檔再執行"},
        ) from None
    except ValidationError as e:
        # 存檔時驗過，但積木包可能在那之後被移掉或改壞。與 PUT 同一種 422。
        raise invalid_ir(e) from None
    return handle.summary()


@router.get("")
async def list_runs(request: Request) -> list[dict[str, Any]]:
    return [h.summary() for h in _runs(request).list()]


@router.get("/{run_id}")
async def get_run(run_id: str, request: Request) -> dict[str, Any]:
    handle = _runs(request).get(run_id)
    if handle is None:
        raise HTTPException(status_code=404, detail={"message": f"找不到執行 {run_id}"})
    return handle.summary()


@router.delete("/{run_id}", status_code=202)
async def stop_run(run_id: str, request: Request, response: Response) -> dict[str, Any]:
    """§5.5 的外部停止。

    202 而不是 204：停止是**請求**，不是完成。`cancel()` 要等到那條 thread 走到
    下一個暫停點才生效（§5.2 每 512 顆積木一次），而同步阻塞的擴充函式甚至
    要等它自己跑完（§5.3）。回 204 等於承諾「已經停了」，那是騙人的。
    """
    manager = _runs(request)
    handle = manager.get(run_id)
    if handle is None:
        raise HTTPException(status_code=404, detail={"message": f"找不到執行 {run_id}"})
    manager.stop(run_id)
    return handle.summary()


@ws_router.websocket("/ws/run/{run_id}")
async def run_events(websocket: WebSocket, run_id: str) -> None:
    """§6.1 的事件流。後端 → 前端是批次的 frame，前端 → 後端只有停止。"""
    manager = _runs(websocket)
    handle = manager.get(run_id)
    if handle is None:
        await websocket.close(code=WS_RUN_NOT_FOUND, reason=f"找不到執行 {run_id}")
        return

    await websocket.accept()
    async with handle.broker.subscribe() as frames:
        # 兩個方向同時進行：收到 `{"op":"stop"}` 時 Run 還在送事件，而使用者
        # 要看到的正是停止之後那幾筆（thread.end、run.end）。序列化處理的話
        # 停止指令會排在事件後面，變成「按了沒反應」。
        reader = asyncio.create_task(_client_loop(websocket, manager, run_id))
        try:
            async for frame in frames:
                await websocket.send_json({"runId": run_id, **frame})
        except WebSocketDisconnect:
            pass
        finally:
            reader.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reader

    with contextlib.suppress(RuntimeError, WebSocketDisconnect):
        await websocket.close()


async def _client_loop(websocket: WebSocket, manager: RunManager, run_id: str) -> None:
    """前端 → 後端。§6.1：只有 `stop` 與 `stop_thread` 兩種。"""
    while True:
        try:
            msg = await websocket.receive_json()
        except (WebSocketDisconnect, RuntimeError, ValueError):
            return
        if not isinstance(msg, dict):
            continue
        op = msg.get("op")
        if op == "stop":
            manager.stop(run_id)
        elif op == "stop_thread":
            manager.stop(run_id, thread_id=msg.get("threadId"))


__all__ = ["router", "ws_router"]

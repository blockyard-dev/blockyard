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

from fastapi import APIRouter, Body, HTTPException, Query, Request, Response, WebSocket
from fastapi.websockets import WebSocketDisconnect
from pydantic import BaseModel, Field

from blockyard.api.errors import invalid_ir
from blockyard.errors import ValidationError
from blockyard.runs import DEFAULT_TRIGGER, ProjectNotFound, RunManager

router = APIRouter(prefix="/api/runs", tags=["runs"])
ws_router = APIRouter()

# WebSocket 沒有 404；用 close code 表達。4000+ 是應用自訂區間。
WS_RUN_NOT_FOUND = 4404
WS_PROJECT_NOT_FOUND = 4405


class RunRequest(BaseModel):
    projectId: str
    trigger: str = DEFAULT_TRIGGER
    payload: dict[str, Any] = Field(default_factory=dict)
    #: 「點一下就跑」（§5.1、附錄 A）。給了就從這顆積木所在的堆疊頂端起跑，
    #: `trigger` 不看。**不是另一個端點**：同一份事件、同一個停止 API、同一套
    #: §6.2 流量控制——分成兩條路的話這三件事都要各做兩次。
    blockId: str | None = None
    #: 「點一下就跑」點到的是**工具箱裡**那一顆時，它自己那一小段 IR
    #: （`runs/scratch.py`）。那顆積木還沒被拉出來，存檔裡沒有它，所以它得跟著
    #: 這次請求一起來——併進去只活在這個 Run 裡，硬碟上的專案不動。
    scratch: dict[str, Any] | None = None


def _runs(request: Request | WebSocket) -> RunManager:
    return request.app.state.runs


@router.post("", status_code=201)
async def start_run(request: Request, body: RunRequest = Body(...)) -> dict[str, Any]:  # noqa: B008
    """跑一次**已存檔**的專案。回來時 Run 已經在跑了（見 `runs/manager.py`）。"""
    try:
        handle = await _runs(request).start(
            body.projectId,
            trigger=body.trigger,
            payload=body.payload,
            block_id=body.blockId,
            scratch=body.scratch,
        )
    except ProjectNotFound:
        raise HTTPException(
            status_code=404,
            detail={"message": f"找不到專案 {body.projectId}", "hint": "先存檔再執行"},
        ) from None
    except ValidationError as e:
        # 存檔時驗過，但積木包可能在那之後被移掉或改壞。與 PUT 同一種 422。
        # `blockId` 指向存檔裡不存在的積木（畫布改了沒存就點）也走這裡，
        # `scratch` 併不進去（id 撞了、key 不認得）同理。
        raise invalid_ir(e) from None
    return handle.summary()


@router.get("")
async def list_runs(
    request: Request,
    projectId: str | None = None,  # noqa: N803  — 附錄 A 的查詢參數是 camelCase
    limit: int = Query(100, ge=1, le=1000),
) -> list[dict[str, Any]]:
    """執行歷史（§6.3 落地之後**跨後端重啟存活**）。新的在前。"""
    return _runs(request).list(project_id=projectId, limit=limit)


@router.get("/{run_id}")
async def get_run(run_id: str, request: Request) -> dict[str, Any]:
    summary = _runs(request).summary(run_id)
    if summary is None:
        raise HTTPException(status_code=404, detail={"message": f"找不到執行 {run_id}"})
    return summary


@router.get("/{run_id}/events")
async def get_run_events(
    run_id: str,
    request: Request,
    after: int = Query(0, ge=0),
    limit: int = Query(5000, ge=1, le=20000),
) -> dict[str, Any]:
    """§6.3 的執行歷史（重播用）。

    `after` 是**上一頁最後一筆的 seq**，不是 offset：分頁期間 Run 還在跑、
    還在寫，offset 會漏掉或重複，seq 不會。

    這裡回的是**落地過**的那些（§6.3 的白名單），不是 WebSocket 上那一串。
    `block.enter/exit` 查不到是規格，不是缺陷——它們是除錯用的即時訊號。
    """
    manager = _runs(request)
    if manager.summary(run_id) is None:
        raise HTTPException(status_code=404, detail={"message": f"找不到執行 {run_id}"})
    events = manager.events(run_id, after=after, limit=limit)
    return {
        "runId": run_id,
        "events": events,
        # 下一頁從哪裡開始。空的代表沒有更多了——由後端算而不是讓前端自己從
        # 最後一筆挖 seq，因為「還有沒有下一頁」只有這裡知道。
        "nextAfter": events[-1]["seq"] if len(events) == limit else None,
    }


@router.delete("/{run_id}", status_code=202)
async def stop_run(run_id: str, request: Request, response: Response) -> dict[str, Any]:
    """§5.5 的外部停止。

    202 而不是 204：停止是**請求**，不是完成。`cancel()` 要等到那條 thread 走到
    下一個暫停點才生效（§5.2 每 512 顆積木一次），而同步阻塞的擴充函式甚至
    要等它自己跑完（§5.3）。回 204 等於承諾「已經停了」，那是騙人的。
    """
    manager = _runs(request)
    summary = manager.summary(run_id)
    if summary is None:
        raise HTTPException(status_code=404, detail={"message": f"找不到執行 {run_id}"})
    # 已經跑完的照樣回 202 而不是 4xx：使用者按下停止與 Run 自己結束是一場
    # 競賽，而「你按晚了」不是一個錯誤。`stop()` 對死掉的 Run 是 no-op。
    manager.stop(run_id)
    return summary


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


@ws_router.websocket("/ws/project/{project_id}")
async def project_events(websocket: WebSocket, project_id: str) -> None:
    """一個**專案**的事件流：它每一個 Run 的 frame 都從這裡出去（§6.1、§9）。

    `/ws/run/{runId}` 有一個接不到的縫：hat 觸發的 Run 是後端自己起的，前端沒有
    那個 runId，只能先問——而一則 Discord 訊息的 Run 只有零點幾毫秒，所以問到它
    時它一定已經結束了，而對結束的 Run 開 WebSocket 是接不上的。這條通道把順序
    反過來：**在 Run 開始之前就接著**。

    三個問題的答案（`App.tsx` 那段註解欠了很久的那三個）：

      屬於哪個專案   路徑上就是專案 id，frame 帶 `runId`——一個專案同時可以有
                     好幾個 Run（`concurrency: parallel`），客戶端靠它分辨。
      斷線怎麼補     **不補**。這條是「現在怎麼了」的通道，不是稽核紀錄；斷線
                     期間的那幾則在執行歷史裡（§6.3 的落地就是為此）。要補就得
                     先回答下面那個，而那個答案是「不留」。
      backlog 多久   **不留**。`RunBroker` 的 backlog 是為了「POST 回來到 WS
                     接上」那幾毫秒，這條通道沒有那個空窗。

    **單向**：停止一個 Run 仍然走 `/ws/run` 或 `DELETE /api/runs/{id}`——這裡送
    得出好幾個 Run 的事件，一句沒有指名的 `stop` 說不出要停哪一個。
    """
    manager = _runs(websocket)
    if not manager.has_project(project_id):
        await websocket.close(code=WS_PROJECT_NOT_FOUND, reason=f"找不到專案 {project_id}")
        return

    await websocket.accept()
    async with manager.hub(project_id).subscribe() as frames:
        try:
            async for frame in frames:
                await websocket.send_json(frame)
        except WebSocketDisconnect:
            pass

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

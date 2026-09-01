"""`/api/projects`（附錄 A）。

**存的是 body 原文**（見 `storage/projects.py` 的理由），所以 GET 回來的是
PUT 進去的那一份，一個欄位不多一個不少、blockId 一個不改。前端的存檔／讀檔
因此是真正的 round-trip，而不是「大致上一樣」。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Request, Response

from blocky.api.errors import invalid_ir, not_found
from blocky.api.validation import validate_project
from blocky.errors import ValidationError
from blocky.storage import ProjectStore

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _store(request: Request) -> ProjectStore:
    return request.app.state.store


@router.get("")
async def list_projects(request: Request) -> list[dict[str, Any]]:
    return [p.summary() for p in _store(request).list()]


@router.get("/{project_id}")
async def get_project(project_id: str, request: Request) -> dict[str, Any]:
    stored = _store(request).get(project_id)
    if stored is None:
        raise not_found(project_id)
    return stored.data


@router.put("/{project_id}")
async def put_project(
    project_id: str,
    request: Request,
    response: Response,
    data: Any = Body(...),  # noqa: B008 — FastAPI 的依賴注入就是這樣宣告的
) -> dict[str, Any]:
    """存檔。**驗證通過才寫**——壞的 IR 進不了資料庫。

    這比「存了再說、開檔時才報錯」嚴格，理由是後者會讓一份壞掉的專案在磁碟上
    存活，而使用者下一次打開它只會看到一個開不起來的編輯器。
    """
    if isinstance(data, dict):
        declared_id = (data.get("meta") or {}).get("id")
        if declared_id is not None and declared_id != project_id:
            raise invalid_ir(
                ValidationError(
                    f'網址上的 id 是 "{project_id}"，但 meta.id 寫的是 "{declared_id}"',
                    path="meta.id",
                )
            )

    try:
        await validate_project(data, extensions_root=request.app.state.extensions_root)
    except ValidationError as e:
        raise invalid_ir(e) from None

    existed = _store(request).get(project_id) is not None
    stored = _store(request).put(project_id, data)
    # §9.2「專案編輯後：diff 新舊 IR 的 hat 集合，只重啟有變動的 trigger」。
    # 不是 active 就什麼都不做——存檔不該把一個關著的專案打開。
    await request.app.state.triggers.resync(project_id)
    response.status_code = 200 if existed else 201
    return stored.summary()


@router.delete("/{project_id}", status_code=204)
async def delete_project(project_id: str, request: Request) -> Response:
    if not _store(request).delete(project_id):
        raise not_found(project_id)
    # 執行歷史與持久值一起清（§6.3、§5.4 第 4 層）。留著的話，那些紀錄指向
    # 一份不存在的專案——點進去看不到任何積木，而 `persist_values` 會在下一個
    # 剛好同名的專案身上復活。
    request.app.state.runs_store.delete_project_history(project_id)
    await request.app.state.triggers.deactivate(project_id)
    return Response(status_code=204)


__all__ = ["router"]

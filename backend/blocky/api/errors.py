"""HTTP 錯誤的統一形狀。

驗證錯誤一律 **422 + `blockId`**。`blockId` 是這份設計裡錯誤訊息的定位單位
（§5.6 的 `block.error` 也是），前端拿到就能直接把那顆積木標紅——訊息只有
文字的話，使用者得自己在一百顆積木裡找。
"""

from __future__ import annotations

from fastapi import HTTPException

from blocky.errors import ValidationError


def invalid_ir(e: ValidationError) -> HTTPException:
    detail: dict[str, str] = {"message": e.message}
    if e.block_id is not None:
        detail["blockId"] = e.block_id
    if e.path is not None:
        detail["path"] = e.path
    return HTTPException(status_code=422, detail=detail)


def not_found(project_id: str) -> HTTPException:
    return HTTPException(status_code=404, detail={"message": f"找不到專案 {project_id}"})


__all__ = ["invalid_ir", "not_found"]

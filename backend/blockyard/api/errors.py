"""HTTP 錯誤的統一形狀。

驗證錯誤一律 **422 + `blockId`**。`blockId` 是這份設計裡錯誤訊息的定位單位
（§5.6 的 `block.error` 也是），前端拿到就能直接把那顆積木標紅——訊息只有
文字的話，使用者得自己在一百顆積木裡找。
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from blockyard.errors import ValidationError


_STATUS_CODES = {
    400: "http.bad_request",
    401: "http.unauthorized",
    403: "http.forbidden",
    404: "http.not_found",
    409: "http.conflict",
    413: "http.too_large",
    415: "http.unsupported_media",
    422: "http.unprocessable",
}


def error_detail(detail: Any, *, status_code: int) -> dict[str, Any]:
    """Normalize every first-party HTTP error without discarding legacy text."""
    if isinstance(detail, dict):
        out = dict(detail)
        message = out.get("message")
        if not isinstance(message, str):
            out["message"] = str(message if message is not None else detail)
    else:
        out = {"message": str(detail)}
    out.setdefault("code", _STATUS_CODES.get(status_code, f"http.{status_code}"))
    out.setdefault("params", {})
    return out


def invalid_ir(e: ValidationError) -> HTTPException:
    return HTTPException(status_code=422, detail=e.to_dict())


def not_found(project_id: str) -> HTTPException:
    return HTTPException(status_code=404, detail={
        "code": "project.not_found", "params": {"projectId": project_id},
        "message": f"找不到專案 {project_id}",
    })


__all__ = ["error_detail", "invalid_ir", "not_found"]

"""`GET /api/extensions`（附錄 A、§8.1）。

**內建與積木包從同一個端點吐出，格式一模一樣**（D21）。前端的啟動流程因此
只有一條：拿 manifest → 轉成 Blockly 的 block definition → 註冊。新增積木不
需要改前端一行程式碼，這句話對內建與第三方同樣成立。

差別只有 `builtin: true` 這個旗標，而它只影響一件事：UI 不顯示「解除安裝」。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from blocky.extensions import Manifest, discover
from blocky.interpreter import declarations

router = APIRouter(prefix="/api/extensions", tags=["extensions"])


@router.get("")
async def list_extensions(request: Request) -> list[dict[str, Any]]:
    """所有可用的積木宣告。內建在前，因為工具箱的順序就是這個順序。"""
    out = [_dump(mf) for mf in declarations.manifests().values()]
    out.extend(
        _dump(src.manifest) for src in discover(request.app.state.extensions_root).values()
    )
    return out


def _dump(mf: Manifest) -> dict[str, Any]:
    """照 manifest 原樣吐出。

    刻意不折成「前端好用的形狀」——那等於在後端維護一份 Blockly 的知識，而
    §8.4 的教訓正是不要讓後端綁死在前端函式庫的版本上。`%(name)` → `%1` 的
    轉換屬於前端。

    `exclude_defaults` 是為了讓「沒寫 default」與「default: null」在 JSON 上
    仍然分得開（§7.2：後者代表選填，前者代表必填）。
    """
    return mf.model_dump(mode="json", exclude_defaults=True, exclude_none=False)


__all__ = ["router"]

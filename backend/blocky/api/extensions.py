"""`GET /api/extensions`（附錄 A、§8.1）。

**內建與積木包從同一個端點吐出，格式一模一樣**（D21）。前端的啟動流程因此
只有一條：拿 manifest → 轉成 Blockly 的 block definition → 註冊。新增積木不
需要改前端一行程式碼，這句話對內建與第三方同樣成立。

差別只有 `builtin: true` 這個旗標，而它只影響一件事：UI 不顯示「解除安裝」。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from blocky.errors import BlockyError
from blocky.extensions import Manifest, discover, open_registry, secret_store
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


@router.post("/{ext_id}/dropdown/{source}")
async def get_dropdown(ext_id: str, source: str, request: Request) -> list[dict[str, Any]]:
    """動態下拉（D22、§8.1）。內建積木的下拉是靜態的（宣告在 manifest 的
    `options` 裡），永遠不會走到這裡——`source` 只存在於積木包的 `dropdown`
    型參數。

    照 `api/validation.py::open_project` 已有的「開一個用完即關的 registry」
    風格：只載這一個包，查完就卸載，不留著。

    body 是選填的 `{"args": {...}}`——manifest 宣告了 `depends` 的下拉要吃同一
    顆積木上其他已填的值（`discord.channels` 要先知道是哪個伺服器）。**沒有
    body 仍然是合法請求**：不吃別格的下拉佔絕大多數，而讓它們為了一個空物件
    多帶一個 header 只是噪音。收到的東西在 host 邊界依宣告過濾
    （`boundary.normalize_dropdown_args`），這裡不做也不該做那件事。
    """
    root = request.app.state.extensions_root
    sources = discover(root)
    if ext_id not in sources:
        raise HTTPException(status_code=404, detail={"message": f"找不到積木包「{ext_id}」"})

    config = secret_store.resolve_config({ext_id: sources[ext_id].manifest})
    try:
        registry = await open_registry(root, only=[ext_id], config=config)
    except BlockyError as e:
        raise HTTPException(
            status_code=422, detail={"message": f"載入積木包時失敗：{e}"}
        ) from None

    try:
        return await registry.dropdown(ext_id, source, args=await _dropdown_args(request))
    except BlockyError as e:
        raise HTTPException(status_code=422, detail={"message": str(e)}) from None
    finally:
        await registry.unload_all()


async def _dropdown_args(request: Request) -> dict[str, Any]:
    """body 讀不出來就當沒有。

    「沒有 body」與「body 不是 JSON」在這裡是同一件事：無論哪一種，這個請求都
    只是沒有帶 `depends` 的值——而該不該有值是 manifest 說了算，不是這個函式。
    真正宣告了 `depends` 卻沒收到值的下拉會拿到空字串，那是積木包要處理的正常
    狀態（「還沒選伺服器」），不是 400。
    """
    try:
        body = await request.json()
    except Exception:
        return {}
    args = body.get("args") if isinstance(body, dict) else None
    return args if isinstance(args, dict) else {}


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

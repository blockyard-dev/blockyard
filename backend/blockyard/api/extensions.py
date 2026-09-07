"""`GET /api/extensions`（附錄 A、§8.1）。

**內建與積木包從同一個端點吐出，格式一模一樣**（D21）。前端的啟動流程因此
只有一條：拿 manifest → 轉成 Blockly 的 block definition → 註冊。新增積木不
需要改前端一行程式碼，這句話對內建與第三方同樣成立。

差別只有 `builtin: true` 這個旗標，而它只影響一件事：UI 不顯示「解除安裝」。
"""

from __future__ import annotations

import hashlib
import io
import pathlib
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response

from blockyard.api.validation import DEFAULT_PROJECT_ID
from blockyard.errors import BlockyardError
from blockyard.extensions import (
    COVER_TYPES,
    Manifest,
    bundled,
    discover,
    open_registry,
    panel_asset,
    receipt,
    scan,
    secret_store,
)
from blockyard.extensions.install import EXT_ID, uninstall
from blockyard.extensions.manifest import load_manifest, pack_files
from blockyard.interpreter import declarations
from blockyard.storage import PROJECT_ID

router = APIRouter(prefix="/api/extensions", tags=["extensions"])


@router.get("")
async def list_extensions(request: Request) -> list[dict[str, Any]]:
    """所有可用的積木宣告。內建在前，因為工具箱的順序就是這個順序。"""
    builtin_locales = declarations.locales()
    out = [_dump(mf, builtin_locales.get(mf.id)) for mf in declarations.manifests().values()]
    out.extend(
        _dump(src.manifest, src.locales)
        for src in discover(request.app.state.extensions_root).values()
    )
    return out


@router.get("/problems")
async def list_problems(request: Request) -> list[dict[str, str]]:
    """讀不進來的積木包（P3 第 2 步）。

    `scan()` 現在會跳過壞掉的包而不是整批拋（見它的 docstring），所以上面那個
    端點不再 500——但**跳過的代價是一個包安靜地消失**，而那對正在寫包的人是
    最難查的症狀：manifest 少打一個冒號，工具箱上那一整格就不見了，而畫面上
    沒有任何東西說為什麼。

    這條路把那句話端到擴充功能面板上。它是一個**獨立端點**而不是上面那份清單裡
    多一種條目：那份清單的每一筆都是一份 manifest，前端整條註冊流程吃的就是那個
    形狀（D21），而混進一個「這個不是 manifest」會讓每一個消費者都要先問一次。

    **正常情況下它回空陣列**，所以前端那一區平常什麼都不畫。
    """
    found = scan(request.app.state.extensions_root)
    return [{"dir": p.dir, "message": p.message} for p in found.problems]


@router.get("/receipts")
async def list_receipts(request: Request) -> list[dict[str, Any]]:
    """每個包的收據：**這個資料夾是誰搬進來的**（§2）。

    **獨立端點，不是 `/api/extensions` 上多幾個欄位。** 那份清單的每一筆都是
    一份 manifest，前端整條註冊流程吃的就是那個形狀（D21），而收據講的是完全
    不同的一件事——它不是包的作者寫的，內建積木更沒有它。混進去等於讓每一個
    消費者都要先問一次「這幾格是誰的」。

    **沒有收據的包不出現在這份清單裡。** 那不是遺漏，那就是答案：沒有收據 =
    使用者自己放的 = 我們不碰（`extensions/receipt.py`）。所以前端的判斷是
    「這個 id 在不在這份名單上」，而不是去讀某個欄位。
    """
    found = discover(request.app.state.extensions_root)
    out = []
    for ext_id, src in found.items():
        r = receipt.read(src.dir)
        if r is not None:
            out.append({"extId": ext_id, **r.to_json()})
    return out


@router.get("/uninstalled")
async def list_uninstalled(request: Request) -> list[dict[str, str]]:
    """**被使用者拔掉的官方包**（§2、§8 的墓碑）。

    這條路存在的理由是一句驗收句：P3 說匯入與移除「全程不碰檔案總管」。拔掉
    一個官方包之後，那張卡就從擴充功能面板上消失了——而它的出貨來源躺在
    site-packages 底下，使用者沒有任何一條路把它裝回來。墓碑記得他拔過什麼，
    所以這裡說得出「你拔掉過 demo」，而那張卡才有地方可以再出現一次。

    **只列出貨目錄裡真的有的那幾個。** 墓碑對非官方的 id 也會立（見
    `bundled.tombstone`），而那幾個我們手上沒有第二份，說「可以裝回來」是
    騙人的——它們要重新裝一次得走匯入那條路。

    正常情況下回空陣列。
    """
    root = Path(request.app.state.extensions_root)
    out = []
    for ext_id in sorted(bundled.tombstoned(root)):
        src = bundled.BUNDLED_ROOT / ext_id
        if not (src / "manifest.yaml").is_file():
            continue
        try:
            mf = load_manifest(src / "manifest.yaml")
        except BlockyardError:
            continue
        out.append({"id": ext_id, "name": mf.name, "version": mf.version})
    return out


@router.delete("/{ext_id}")
async def remove_extension(ext_id: str, request: Request) -> dict[str, str]:
    """解除安裝：**把這個包搬進垃圾桶**（§5 的第二列）。

    §1 的三層帳裡這一條動的是最上面那層（磁碟）。「從工具箱移除」動的是另一
    層，住在瀏覽器的偏好裡，根本不會走到後端——**兩個動詞不共用一條路，是
    因為它們本來就不是同一件事**，而把它們壓成一個「刪除」正是 §0 那個洞。

    **畫布上還有沒有它的積木不在這裡問。** 那份工作區還沒存檔，後端手上那一
    份可能是十分鐘前的；擋下來的是前端，與「刪除一個擴充功能」共用同一條路。

    404 與 422 分得開：沒有這個包是前者，「有，但那是你自己放的」是後者——
    後面那句話使用者做得了事（把資料夾拿走），所以它不是一個「找不到」。
    """
    root = Path(request.app.state.extensions_root)
    src = discover(root).get(ext_id)
    if src is None:
        raise HTTPException(status_code=404, detail={"message": f"這台機器上沒有裝「{ext_id}」"})
    version = src.manifest.version
    try:
        stashed = uninstall(ext_id, root)
    except BlockyardError as e:
        raise HTTPException(status_code=422, detail={"message": str(e)}) from None
    # 垃圾桶在哪要說出去：那是「更新完發現更糟」與「拔錯了」唯一的退路，而
    # 現在還沒有一頁 UI 在看它（§8 的未答項），所以這句話是使用者手上僅有的
    # 線索。
    return {"id": ext_id, "version": version, "trash": str(stashed.dir)}


@router.post("/{ext_id}/reinstall")
async def reinstall_extension(ext_id: str, request: Request) -> dict[str, str]:
    """把一個拔掉過的官方包裝回來。

    **不走審閱畫面**，而那是這條路唯一的特例：審閱要看的是「這份 bytes 你確
    定要在這台機器上執行嗎」，而這一份正是這個 app 自己出貨的那一份——同一
    個 wheel 裡的東西，使用者第一次啟動時本來就被鋪過一次。要求他審閱一份
    他早就在跑的程式碼，是一個儀式。

    做的事只有一件：把墓碑收掉，讓 `seed_bundled` 重新鋪一次。
    """
    root = Path(request.app.state.extensions_root)
    # **接成路徑之前先驗形狀**，與解除安裝那條路同一份規則（`install.EXT_ID`）：
    # 下面兩行把這個字串接進出貨目錄，而一條路由吃得下的東西不代表它是一個 id。
    if not EXT_ID.match(ext_id) or not (bundled.BUNDLED_ROOT / ext_id / "manifest.yaml").is_file():
        raise HTTPException(
            status_code=404,
            detail={"message": f"「{ext_id}」不是隨 Blockyard 出貨的積木包，裝不回來"},
        )
    if ext_id in discover(root):
        raise HTTPException(status_code=422, detail={"message": f"「{ext_id}」已經裝著了"})
    bundled.forget_tombstone(root, ext_id)
    seeded = bundled.seed_bundled(root)
    if ext_id not in seeded:  # pragma: no cover - 上面兩個檢查之後走不到
        raise HTTPException(status_code=422, detail={"message": f"鋪不回「{ext_id}」"})
    return {"id": ext_id}


#: 面板可以載的東西。**白名單，不是黑名單**——副檔名認不得就 404，而不是猜一個
#: content-type 送出去。少了這條，一個包就能靠這個端點把任意檔案交給瀏覽器，
#: 而瀏覽器會照它自己的嗅探規則決定那是什麼。
_ASSET_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".wasm": "application/wasm",
}


@router.get("/{ext_id}/asset/{path:path}")
async def get_asset(ext_id: str, path: str, request: Request) -> FileResponse:
    """受信任插件的靜態資源；檔案解析後必須仍在包目錄內。"""
    src = discover(request.app.state.extensions_root).get(ext_id)
    if src is None or not (src.manifest.panels or src.manifest.editor):
        raise HTTPException(status_code=404, detail=f"積木包「{ext_id}」沒有前端入口")

    suffix = pathlib.PurePosixPath(path).suffix.lower()
    ctype = _ASSET_TYPES.get(suffix)
    if ctype is None:
        raise HTTPException(status_code=404, detail=f"面板不能載 {suffix or path} 這種檔案")

    try:
        target = panel_asset(src.dir, path)
    except BlockyardError as e:
        raise HTTPException(status_code=404, detail=str(e)) from None
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"找不到 {path}")

    headers = {
        "X-Content-Type-Options": "nosniff",
        # 靜態前端資源可由面板與主頁 module 讀取。
        "Access-Control-Allow-Origin": "*",
        # 開發時改了 panel 的 JS 要看得到。這條路上的檔案是本機磁碟，省下的
        # 那一次讀取不值得一個「我改了為什麼沒變」。
        "Cache-Control": "no-store",
    }

    return FileResponse(
        target,
        media_type=ctype,
        headers=headers,
    )


@router.get("/{ext_id}/cover")
async def get_cover(ext_id: str, request: Request) -> Response:
    """擴充功能面板那張卡上的封面（§8.1、D31）。

    **刻意不走上面的 `/asset/{path}`。** 那個端點只開給宣告過 `panels` 的包，
    而封面是每個包都該有的東西——`http`、`openai` 這種沒有面板的包也要有一張圖。
    為了一張圖把 `panels` 那道門放寬，等於讓一個只想放圖的包換到一條「可以用
    任意路徑取包內檔案」的路，而那正是那道門在擋的事。

    這裡沒有那個問題：**路徑由 manifest 決定，request 一個字都不帶。** 檔案在
    載入期就驗過（`_check_cover`），所以走到這裡還失敗的只剩「manifest 沒宣告」。

    沒有 CSP：這條路吐的是圖片，不是會被當成 document 載的 HTML。`nosniff` 仍然
    要送——content-type 由白名單的副檔名決定，不從內容猜。

    **`no-cache` 而不是 `no-store`。** 兩個名字很像，行為差很多：`no-store` 是
    「不准留」，所以每次打開擴充功能面板都要把每張封面重新下載一次——症狀是那一
    頁的圖每次都晚一拍才出現，而且第十次跟第一次一樣慢。`no-cache` 是「留著，但
    每次用之前先問一下」，而問到 304 的時候瀏覽器直接用手上那份 bytes。

    仍然要問這一句（而不是給一個 `max-age`）的理由跟 `no-store` 當初一樣：這些
    檔案是本機磁碟上的圖，作者換掉 `preview.png` 之後重整就該看到新的。一次 304
    的來回換掉一個「我換了圖為什麼沒變」，划算。

    **304 要自己回**（`_not_modified`）：`FileResponse` 不看 `If-None-Match`，
    那是 `StaticFiles` 才有的一段。這裡送的 ETag 取自內容，少了這幾行，上面那個
    `no-cache` 只換來「每次都問，而每次都整份重傳」，比 `no-store` 還糟。
    """
    src = discover(request.app.state.extensions_root).get(ext_id)
    if src is None or src.manifest.cover is None:
        raise HTTPException(status_code=404, detail=f"積木包「{ext_id}」沒有封面")

    target = panel_asset(src.dir, src.manifest.cover)
    suffix = pathlib.PurePosixPath(src.manifest.cover).suffix.lower()
    etag = f'"{hashlib.sha256(target.read_bytes()).hexdigest()}"'
    headers = {
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
        "ETag": etag,
    }

    if (cached := _not_modified(request, etag)) is not None:
        return cached
    return FileResponse(target, media_type=COVER_TYPES[suffix], headers=headers)


def _not_modified(request: Request, etag: str) -> Response | None:
    """手上那份還新的話，回一個沒有 body 的 304。

    ETag 直接取檔案內容的 sha256，而不是 `mtime-size`。圖片被原地覆蓋時很常維持
    相同大小；若工具還順手保留 mtime，後者會把不同的圖誤答成 304。完整內容雜湊
    對這種小圖很便宜，而且答案不依賴檔案系統時間精度。

    `If-None-Match` 可以帶好幾個值，也可以帶 `W/` 前綴（弱驗證），所以逐一比對而
    不是整串字串比。認不得就回 `None`——那條路上會走回完整的 200，而那永遠是對的
    答案，只是慢一點。
    """
    sent = request.headers.get("if-none-match", "")
    if any(tag.strip().removeprefix("W/") == etag for tag in sent.split(",")):
        return Response(
            status_code=304,
            headers={"ETag": etag, "Cache-Control": "no-cache"},
        )
    return None


@router.get("/{ext_id}/export")
async def export_extension(ext_id: str, request: Request) -> Response:
    """匯出可直接再安裝的積木包 ZIP，不帶 venv、快取或安裝來源收據。"""
    src = discover(request.app.state.extensions_root).get(ext_id)
    if src is None:
        raise HTTPException(status_code=404, detail={"message": f"這台機器上沒有裝「{ext_id}」"})

    root = src.dir.resolve()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in pack_files(src.dir):
            if path.name in {".DS_Store", "Thumbs.db"}:
                continue
            # 手動放進 extensions/ 的包不一定走過匯入器；匯出不能跟著 symlink
            # 把包外的檔案（例如金鑰）讀進 ZIP。
            if not path.resolve().is_relative_to(root):
                raise HTTPException(
                    status_code=422,
                    detail={"message": f"積木包「{ext_id}」含有指向包外的連結，不能匯出"},
                )
            zf.writestr(path.relative_to(src.dir).as_posix(), path.read_bytes())

    filename = f"{ext_id}-{src.manifest.version}.zip"
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


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

    # **下拉要拿得到金鑰，而金鑰屬於某一個專案**（§16 Q23）：`discord.channels`
    # 得先用 bot token 連上去才問得出頻道。專案 id 走 query string 而不是路徑，
    # 因為它是這個請求的**脈絡**不是主詞——主詞是那個包的那個下拉。
    #
    # 沒帶就退回預設的那個專案：舊的前端（還沒重新整理的分頁）打進來時，下拉
    # 至少還是舊的行為，而不是一句 422。
    config = secret_store.resolve_config(
        {ext_id: sources[ext_id].manifest}, project_id=_project_id(request)
    )
    try:
        registry = await open_registry(root, only=[ext_id], config=config)
    except BlockyardError as e:
        raise HTTPException(
            status_code=422, detail={"message": f"載入積木包時失敗：{e}"}
        ) from None

    try:
        return await registry.dropdown(ext_id, source, args=await _dropdown_args(request))
    except BlockyardError as e:
        raise HTTPException(status_code=422, detail={"message": str(e)}) from None
    finally:
        await registry.unload_all()


def _project_id(request: Request) -> str:
    """這個下拉是替哪個專案問的。形狀不合就當作沒帶（見 `resolve_config` 那一段）。"""
    raw = request.query_params.get("project") or ""
    return raw if PROJECT_ID.match(raw) else DEFAULT_PROJECT_ID


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


def _dump(mf: Manifest, locales: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    """照 manifest 原樣吐出。

    刻意不折成「前端好用的形狀」——那等於在後端維護一份 Blockly 的知識，而
    §8.4 的教訓正是不要讓後端綁死在前端函式庫的版本上。`%(name)` → `%1` 的
    轉換屬於前端。

    `exclude_defaults` 是為了讓「沒寫 default」與「default: null」在 JSON 上
    仍然分得開（§7.2：後者代表選填，前者代表必填）。
    """
    out = mf.model_dump(mode="json", exclude_defaults=True, exclude_none=False)
    if locales:
        out["locales"] = locales
    return out


__all__ = ["router"]

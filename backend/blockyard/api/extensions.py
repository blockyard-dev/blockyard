"""`GET /api/extensions`（附錄 A、§8.1）。

**內建與積木包從同一個端點吐出，格式一模一樣**（D21）。前端的啟動流程因此
只有一條：拿 manifest → 轉成 Blockly 的 block definition → 註冊。新增積木不
需要改前端一行程式碼，這句話對內建與第三方同樣成立。

差別只有 `builtin: true` 這個旗標，而它只影響一件事：UI 不顯示「解除安裝」。
"""

from __future__ import annotations

import hashlib
import os
import pathlib
import re
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response

from blockyard.errors import BlockyardError
from blockyard.extensions import (
    COVER_TYPES,
    Manifest,
    discover,
    open_registry,
    panel_asset,
    scan,
    secret_store,
)
from blockyard.interpreter import declarations

router = APIRouter(prefix="/api/extensions", tags=["extensions"])


@router.get("")
async def list_extensions(request: Request) -> list[dict[str, Any]]:
    """所有可用的積木宣告。內建在前，因為工具箱的順序就是這個順序。"""
    out = [_dump(mf) for mf in declarations.manifests().values()]
    out.extend(
        _dump(src.manifest) for src in discover(request.app.state.extensions_root).values()
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
    """積木包自己的面板檔案（§8.3、§16 Q17 的 B 路線）。

    這個端點是「積木包可以把 bytes 交給瀏覽器」的唯一入口，所以它的守衛就是
    那件事的全部守衛：

    1. **解析後仍在包目錄內**（`panel_asset`）——字串規則擋不住 symlink。
    2. **副檔名白名單**決定 content-type，**不從內容猜**（`nosniff` 一起送）。
    3. 只有**宣告過 `panels` 的包**才有這個端點——沒宣告面板的包不該有一條把
       檔案送出去的路。

    4. **CSP 只掛在 `.html` 上**（見 `_panel_csp`）。

    CSP 不走 iframe 的 `csp` 屬性：那個屬性的支援度不齊，而它失敗的樣子是
    **靜靜地沒有生效**。response header 是每個瀏覽器都認的那一條。
    """
    src = discover(request.app.state.extensions_root).get(ext_id)
    if src is None or not src.manifest.panels:
        raise HTTPException(status_code=404, detail=f"積木包「{ext_id}」沒有面板")

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
        # **面板是 opaque origin，所以它拿自己的檔案也算跨來源。**
        #
        # `<script type="module">` 的抓取一律走 CORS（classic script 不會），
        # `@font-face` 與 `fetch` 也是。少了這一行，症狀是「HTML 與 CSS 都到了、
        # JS 沒跑起來」——因為 `<link rel=stylesheet>` 是 no-cors 進得來。
        #
        # 給 `*` 而不是 `null`：opaque origin 送出來的 `Origin` 是字串 `null`，
        # 而回 `Access-Control-Allow-Origin: null` 是各家行為不一致的一格。這些
        # 檔案本來就是要交給瀏覽器的靜態資源，而後端只綁 127.0.0.1（§12.1），
        # 所以讀得到它們的頁面本來就只有這台機器上的。
        "Access-Control-Allow-Origin": "*",
        # 開發時改了 panel 的 JS 要看得到。這條路上的檔案是本機磁碟，省下的
        # 那一次讀取不值得一個「我改了為什麼沒變」。
        "Cache-Control": "no-store",
    }
    if suffix == ".html":
        headers["Content-Security-Policy"] = _panel_csp(request)

    return FileResponse(
        target,
        media_type=ctype,
        headers=headers,
    )


#: 編輯器自己報上來的 origin 長什麼樣子。**一定要驗**——這個值會原樣進到一個
#: response header，而 CSP 是用分號分段的：一個沒驗過的字串就是 header 注入。
_ORIGIN = re.compile(r"^https?://[A-Za-z0-9._~-]+(:\d{1,5})?$")


def _panel_csp(request: Request) -> str:
    """面板那份 HTML 的 CSP。

    **origin 由編輯器用 `?embed=` 帶上來，不是後端自己算的。** 後端算不出來：
    dev 下瀏覽器載的是 `http://localhost:5173/api/...`（Vite 代理），而後端看到的
    是被代理之後的自己。用 `request.url` 組出來的 host 在那個世界裡永遠是錯的，
    而症狀是**整格面板一片空白**——第一次踩到時是 `frame-ancestors` 先擋，訊息
    是「localhost 拒絕連線」。

    `'self'` 也不行：頁面跑在 `sandbox` 的 iframe 裡（opaque origin），而 `'self'`
    是拿 document 的 origin 去比對，opaque 就等於匹配不到自己的 `panel.js`。

    **沒有 `frame-ancestors`。** 它擋的是「別的頁面把這格面板嵌進去」，而後端
    只綁 127.0.0.1（§12.1）——這台機器以外的頁面本來就到不了。留著它換來的是
    「這個值只要有一點不對，面板就整格不見」，而那個代價比它擋下的東西大。

    `'unsafe-inline'` 是**刻意放行**的：包本來就可以在自己的 `.js` 檔裡寫任何
    東西，擋掉行內 script 對惡意的包買不到任何東西，只會讓正常作者寫的第一版
    面板莫名其妙一片空白。`'unsafe-eval'` 沒放（那是把資料變成程式碼的那一步），
    `'wasm-unsafe-eval'` 有，因為 asset 白名單收 `.wasm`。

    真正在守的是這兩條：
      * `connect-src 'none'`——面板連不出去。要打網路是 Python 那側的事
        （`ctx.http`，受 `permissions: [net]` 管），少了它 `permissions` 對這種
        包整個失效。
      * `default-src <origin>`——外部 CDN 載不進來，`<img src="https://…/?偷走的東西">`
        這條外洩路徑也一起沒了。
    """
    embed = request.query_params.get("embed", "")
    if not _ORIGIN.match(embed):
        embed = f"{request.url.scheme}://{request.url.netloc}"
    return (
        f"default-src {embed} data: blob: 'unsafe-inline' 'wasm-unsafe-eval'; "
        "connect-src 'none'; base-uri 'none'; form-action 'none'"
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

    **304 要自己回**（`_not_modified`）：`FileResponse` 會送 `etag`，但它不看
    `If-None-Match`——那是 `StaticFiles` 才有的一段。少了這幾行，上面那個
    `no-cache` 只換來「每次都問，而每次都整份重傳」，比 `no-store` 還糟。
    """
    src = discover(request.app.state.extensions_root).get(ext_id)
    if src is None or src.manifest.cover is None:
        raise HTTPException(status_code=404, detail=f"積木包「{ext_id}」沒有封面")

    target = panel_asset(src.dir, src.manifest.cover)
    suffix = pathlib.PurePosixPath(src.manifest.cover).suffix.lower()
    headers = {"X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache"}

    stat = target.stat()
    if (cached := _not_modified(request, stat)) is not None:
        return cached
    return FileResponse(target, media_type=COVER_TYPES[suffix], headers=headers)


def _not_modified(request: Request, stat: os.stat_result) -> Response | None:
    """手上那份還新的話，回一個沒有 body 的 304。

    ETag 的算法要跟 `FileResponse` 一模一樣（mtime-size 的 md5），因為瀏覽器帶回
    來的就是它上一次發出去的那個值。抄一份是難看，但另一條路是自己送整組
    `etag`／`last-modified`／`content-length`，那等於把 `FileResponse` 重寫一遍。

    `If-None-Match` 可以帶好幾個值，也可以帶 `W/` 前綴（弱驗證），所以逐一比對而
    不是整串字串比。認不得就回 `None`——那條路上會走回完整的 200，而那永遠是對的
    答案，只是慢一點。
    """
    etag_base = f"{stat.st_mtime}-{stat.st_size}"
    etag = f'"{hashlib.md5(etag_base.encode(), usedforsecurity=False).hexdigest()}"'
    sent = request.headers.get("if-none-match", "")
    if any(tag.strip().removeprefix("W/") == etag for tag in sent.split(",")):
        return Response(
            status_code=304,
            headers={"ETag": etag, "Cache-Control": "no-cache"},
        )
    return None


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

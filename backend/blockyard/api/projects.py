"""`/api/projects`（附錄 A、`docs/project-storage-design.md`）。

**存的是 body 原文**（見 `storage/projects.py` 的理由），所以 GET 回來的是
PUT 進去的那一份，一個欄位不多一個不少、blockId 一個不改。前端的存檔／讀檔
因此是真正的 round-trip，而不是「大致上一樣」。

**新增與改名各是一條路，而它們動的東西不一樣**（§3）：`POST` 開一個新的
opaque id，`PATCH` 只改名字、**一個字都不動 id**。分成兩條而不是讓前端自己
挑一個 id 再 PUT，是因為 id 是這份設計裡唯一一個「錯了就回不來」的東西——
keyring 裡那幾把金鑰、執行歷史、trigger 都掛在它身上。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, HTTPException, Request, Response

from blockyard.api.errors import invalid_ir, not_found
from blockyard.api.validation import validate_project
from blockyard.errors import ValidationError
from blockyard.extensions import discover, secret_store
from blockyard.interpreter import declarations
from blockyard.storage import PROJECT_ID, ProjectStore, StoredProject, new_id

#: 名字的長度上限。它會被畫在一張卡上、被拿去當匯出的檔名，而一個 500 字的
#: 名字在兩個地方都只有一種結果。
NAME_MAX = 80

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _store(request: Request) -> ProjectStore:
    return request.app.state.store


def _name(raw: Any) -> str:
    """一個能畫在卡片上、也能當檔名的名字。

    空的就給預設值而不是 400：使用者在那個對話框裡按了 Enter 什麼都沒打，意思
    是「隨便」，不是「這個請求壞了」。控制字元與換行洗掉——它們在卡片上看不見，
    但會跟著跑進匯出的檔名裡。
    """
    text = raw if isinstance(raw, str) else ""
    text = "".join(c for c in text if c.isprintable()).strip()
    return text[:NAME_MAX] or "未命名專案"


def _copy_name(source: str, taken: set[str]) -> str:
    """複製出來的那一份叫什麼。

    「X 的副本」，撞名就往下數。名字本來就可以重複（id 是 opaque 的，§10），所以
    這不是為了避免衝突——是為了讓列表上那兩張卡分得出來：卡片上只有名字與時間，
    而複製兩次的時間差可能小到看不出來。

    數到 99 就停手，回最後那個候選：一台機器上有 99 份同名副本的時候，再數下去
    對使用者也沒有任何幫助，而「這條迴圈跑不完」有。
    """
    base = _name(f"{source} 的副本")
    if base not in taken:
        return base
    # 先把位置讓給後面那個數字：`_name` 會截到 NAME_MAX，而一個已經頂到上限的
    # 名字加上 " 2" 之後會被截回原樣——那才是真的跑不完的迴圈。
    stem = base[: NAME_MAX - 4]
    n = 2
    while (candidate := _name(f"{stem} {n}")) in taken and n < 99:
        n += 1
    return candidate


def _forget_secrets(request: Request, stored: StoredProject | None) -> None:
    """這個專案的金鑰與 webhook 簽章密鑰。

    範圍是**這台機器上每一個包宣告過的 secret**（在這個專案底下的那一份），加上
    畫布上每一顆積木的 webhook 密鑰（那一把的 key 是 blockId，§16 Q22）。

    **不收窄到「這份 IR 用到的包」**，理由與 `api/bundle.py::export_plan` 一樣：
    使用者可能把一個包加進工具箱、填好金鑰、還沒拉出任何一顆積木——那把金鑰確實
    屬於這個專案，而收窄的話它會在專案被刪掉之後永遠留在鑰匙圈裡，沒有任何一條路
    指得到它（專案 id 是 opaque 的）。

    keyring 沒有可攜的「列出全部」，所以刪得掉的只有問得出名字的那些——而問不出
    名字的本來就沒有任何一條路讀得到它。

    **讀不到 keyring 不能擋住刪除**：使用者按的是「刪掉這個專案」，而那件事
    已經做完了。
    """
    if stored is None:
        return
    try:
        manifests = dict(declarations.manifests())
        manifests.update(
            {k: src.manifest for k, src in discover(request.app.state.extensions_root).items()}
        )
        for ext_id, manifest in manifests.items():
            owner = secret_store.owner_of(stored.id, ext_id)
            for spec in manifest.config:
                if spec.type == "secret":
                    secret_store.delete(owner, spec.key)
        webhook = secret_store.webhook_owner(stored.id)
        for block_id in (stored.data.get("blocks") or {}):
            secret_store.delete(webhook, block_id)
    except Exception:  # noqa: BLE001 — 見 docstring
        pass


def _valid_id(project_id: str) -> None:
    """這個字串可不可以被當成專案 id 用（`storage.PROJECT_ID`）。

    它會被接成 keyring 的 username 與檔名，所以每一條吃 `{project_id}` 的路由
    都得先問這一句。**404 而不是 422**：一個形狀不合法的 id 指不到任何專案，
    而那正是 404 在說的事。
    """
    if not PROJECT_ID.match(project_id):
        raise HTTPException(status_code=404, detail=f"找不到專案「{project_id}」")


@router.get("")
async def list_projects(request: Request) -> list[dict[str, Any]]:
    return [p.summary() for p in _store(request).list()]


@router.post("", status_code=201)
async def create_project(
    request: Request,
    body: dict[str, Any] = Body(default={}),  # noqa: B008 — FastAPI 的宣告風格
) -> dict[str, Any]:
    """開一個新專案。**id 由後端給**（§3：opaque、產生一次就不變）。

    前端送的是名字，不是 id。讓前端挑 id 的話，那個字串遲早會是名字的 slug，
    而那會讓「改名」看起來應該跟著改 id——那正是這條規則要擋的事。

    裡面是一份空的 IR，跟前端的 `blankProject()` 同一個形狀。**在這裡生而不是
    讓前端 PUT 一份空的上來**，是為了讓「新專案」這件事在後端也有一個明確的
    時刻：`created_at` 從這一刻算起，而列表上那張卡當場就有東西可以畫。
    """
    name = _name(body.get("name"))
    project_id = new_id()
    data = {
        "formatVersion": 1,
        "meta": {"id": project_id, "name": name},
        "extensions": [],
        "variables": {},
        "procedures": {},
        "scripts": [],
        "blocks": {},
    }
    return _store(request).put(project_id, data).summary()


@router.patch("/{project_id}")
async def rename_project(
    project_id: str,
    request: Request,
    body: dict[str, Any] = Body(...),  # noqa: B008 — FastAPI 的宣告風格
) -> dict[str, Any]:
    """改名。**只改名字**——id、積木、金鑰、執行歷史一個都不動（§3）。

    不走 PUT 的理由：PUT 送的是整份 IR，而改名的那一刻前端手上可能是**別的
    專案**的畫布（在專案面板上替另一張卡改名）。用 PUT 就得先把那份 IR 抓下來
    再送回去，中間隔著一次網路——而那段時間裡另一個分頁存過檔的話，改名會把它
    蓋掉。
    """
    _valid_id(project_id)
    stored = _store(request).rename(project_id, _name(body.get("name")))
    if stored is None:
        raise not_found(project_id)
    return stored.summary()


@router.post("/{project_id}/copy", status_code=201)
async def copy_project(project_id: str, request: Request) -> dict[str, Any]:
    """複製一份（列表上的右鍵）。**新的 id，同一份 IR。**

    複製的是「畫布上的東西」：積木、腳本、函式、變數、那份 `extensions`，以及
    卡片上那張預覽圖——打開副本看到的應該就是剛剛那張畫布。

    **不跟著複製的是掛在專案 id 上的那四樣**：金鑰、執行紀錄、webhook 網址、
    以及 trigger 開著沒有（§3、§16 Q23）。它們一個都不是專案的內容，而是這台
    機器對這一份專案的狀態——把它們一起複製過去，等於讓一份使用者還沒打開過的
    專案已經在收 Discord 訊息了。金鑰那一把是同樣的道理：secret 全部分專案，
    而副本是另一個專案。

    `meta.id` 一起換掉：它與網址上那一格不一致的話，副本第一次存檔就是 422
    （`_validate_input`）。
    """
    _valid_id(project_id)
    store = _store(request)
    source = store.get(project_id)
    if source is None:
        raise not_found(project_id)

    copy_id = new_id()
    data = dict(source.data)
    meta = dict(data.get("meta") or {})
    meta["id"] = copy_id
    meta["name"] = _copy_name(source.name, {p.name for p in store.list()})
    data["meta"] = meta

    stored = store.put(copy_id, data)
    if source.preview is not None:
        # 存檔時截的那張圖（`put_project_preview`）。少了它，副本在列表上是一個
        # 首字母色塊，而旁邊那張原本的卡有圖——兩張同一份東西的卡長得不一樣。
        store.set_preview(copy_id, source.preview)
        stored = store.get(copy_id) or stored
    return stored.summary()


@router.get("/{project_id}")
async def get_project(project_id: str, request: Request) -> dict[str, Any]:
    _valid_id(project_id)
    stored = _store(request).get(project_id)
    if stored is None:
        raise not_found(project_id)
    return stored.data


@router.get("/{project_id}/preview")
async def get_project_preview(project_id: str, request: Request) -> Response:
    """卡片封面。它是衍生資料，不混進 project.json 或匯出的 bundle。"""
    _valid_id(project_id)
    stored = _store(request).get(project_id)
    if stored is None or stored.preview is None:
        raise not_found(project_id)
    return Response(
        content=stored.preview,
        media_type="image/webp",
        # updated_at 只精確到秒；同一秒連存兩次時 query string 可能相同，所以不能
        # 宣告 immutable，否則列表會繼續顯示第一次的圖。
        headers={"Cache-Control": "private, no-cache"},
    )


@router.put("/{project_id}/preview", status_code=204)
async def put_project_preview(project_id: str, request: Request) -> Response:
    """保存存檔當下的工作區截圖；只收小型 WebP，避免把資料庫塞爆。"""
    _valid_id(project_id)
    if request.headers.get("content-type", "").split(";", 1)[0] != "image/webp":
        raise HTTPException(status_code=415, detail="專案預覽只接受 image/webp")
    preview = await request.body()
    if not preview or len(preview) > 512 * 1024:
        raise HTTPException(status_code=413, detail="專案預覽必須小於 512 KiB")
    if not _store(request).set_preview(project_id, preview):
        raise not_found(project_id)
    return Response(status_code=204)


async def _validate_input(project_id: str, request: Request, data: Any) -> None:
    _valid_id(project_id)
    if isinstance(data, dict) and isinstance(data.get("meta"), dict):
        declared_id = data["meta"].get("id")
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


@router.post("/{project_id}/validate", status_code=204)
async def validate_editor_change(
    project_id: str, request: Request, data: Any = Body(...),  # noqa: B008
) -> Response:
    """驗證插件提出的畫布修改，不寫資料庫或重接監聽。"""
    await _validate_input(project_id, request, data)
    return Response(status_code=204)


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
    await _validate_input(project_id, request, data)

    existed = _store(request).get(project_id) is not None
    stored = _store(request).put(project_id, data)
    # §9.2「專案編輯後：diff 新舊 IR 的 hat 集合，只重啟有變動的 trigger」。
    # 不是 active 就什麼都不做——存檔不該把一個關著的專案打開。
    await request.app.state.triggers.resync(project_id)
    response.status_code = 200 if existed else 201
    return stored.summary()


@router.delete("/{project_id}", status_code=204)
async def delete_project(project_id: str, request: Request) -> Response:
    _valid_id(project_id)
    stored = _store(request).get(project_id)
    if not _store(request).delete(project_id):
        raise not_found(project_id)
    # **這個專案自己那幾把金鑰也一起走**（§16 Q23）。它們的擁有者是
    # `{專案 id}:{ext_id}`，而專案 id 是 opaque 的——留著的話那幾行永遠不會再被
    # 任何一條路讀到，是純粹的垃圾，而且是明文的垃圾。
    #
    # **在刪掉那一列之前算**：要刪哪幾把是從那份 IR 的 `extensions` 問出來的。
    # 這件事會出現在刪除的確認對話框上（前端的 `ProjectsGallery`）——它不是
    # 一個副作用，是使用者按下去之前就被告知的事。
    _forget_secrets(request, stored)
    # 執行歷史與持久值一起清（§6.3、§5.4 第 4 層）。留著的話，那些紀錄指向
    # 一份不存在的專案——點進去看不到任何積木，而 `persist_values` 會在下一個
    # 剛好同名的專案身上復活。
    request.app.state.runs_store.delete_project_history(project_id)
    await request.app.state.triggers.deactivate(project_id)
    # 留著的話，下一個剛好同名的專案會繼承一個外面可能還有人在打的網址。
    request.app.state.webhook_tokens.delete(project_id)
    return Response(status_code=204)


__all__ = ["router"]

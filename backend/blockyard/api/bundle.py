"""帶一份專案出門，與收下別人帶來的那一份（`docs/project-storage-design.md`
§5～§8）。

    GET    /api/projects/{id}/export          下載一份 .blockyard
    POST   /api/projects/{id}/export          寫到「瀏覽…」選好的那個位置
    GET    /api/projects/{id}/export/env      下載這個專案的金鑰（另一個檔案）
    GET    /api/projects/{id}/export-plan     這次會走出去什麼（積木包 ＋ 哪幾把金鑰）

    POST   /api/projects/import               收下一個 .blockyard → 審閱資料
    POST   /api/projects/import/{token}/extensions/{ext_id}   裝其中一個包
    POST   /api/projects/import/{token}       開出那個專案
    DELETE /api/projects/import/{token}       取消

**匯入 = 開一個新專案 + 走 N 次已經蓋好的那條安裝管線**（`extension-design.md`
§3）。不必發明新機制，而且不能發明——一條「只有匯入才走」的安裝路，遲早會是
「從專案檔裝的包比較少檢查」。

**金鑰是第二個檔案，不是同一個檔案裡的一個旗標**（§6）。一份帶金鑰的 bundle
與一份不帶的，如果是同一個檔案，那它就會被轉寄、被丟上 GitHub、被貼進 Slack
——而那一刻沒有人記得三天前勾過什麼。所以 D28 那條線（「金鑰不進專案檔」）
**沒有被放寬，只是被說得更準**：不是「金鑰不能離開這台機器」，是**「一份專案
不能夾帶金鑰」**。

**這個 router 掛在 `projects` 前面**（`api/app.py`）：`POST /api/projects/import`
與 `POST /api/projects` 撞不到（段數不同），但 `import` 本身是一段合法的
`{project_id}`——順序寫死是為了讓那件事不必靠巧合。
"""

from __future__ import annotations

import re
import secrets as _secrets
import shutil
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import Response

from blockyard import bundle as bundle_fmt
from blockyard.api.errors import not_found
from blockyard.api.files import require_local, targets
from blockyard.api.validation import validate_project
from blockyard.errors import BlockyardError, ValidationError
from blockyard.extensions import discover, receipt, secret_store
from blockyard.extensions.install import (
    MAX_ZIP_BYTES,
    Staged,
    extract_archive,
    install,
    purge_stale,
)
from blockyard.extensions.manifest import read_pack
from blockyard.extensions.review import review as review_pack
from blockyard.interpreter import declarations
from blockyard.storage import PROJECT_ID, ProjectStore, StoredProject, new_id

router = APIRouter(prefix="/api/projects", tags=["projects"])

#: 匯入編號的形狀。**一定要驗**——它會被接成一個路徑，而 `../../etc` 是一個
#: 看起來很無辜的字串（同 `install.py::_TOKEN`）。
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{16,64}$")

#: 上傳的檔名走 header，因為 body 就是那個 `.blockyard` 的 bytes（同積木包那條
#: 路）。它只有一個用途：收據上那一行「從 我的專案.blockyard 裝的」。
_FILENAME_HEADER = "x-blockyard-filename"
_UPLOADED = "從這台電腦匯入的專案"
_LABEL_MAX = 80


# --------------------------------------------------------------------------
# 匯出
# --------------------------------------------------------------------------


@router.get("/{project_id}/export")
async def export_download(project_id: str, request: Request) -> Response:
    """下載一份 `.blockyard`。**沒有金鑰**（那是下面那條路）。

    這條路永遠成立，也永遠是預設：它不需要 tkinter、不需要後端與瀏覽器同一台，
    落在使用者的下載資料夾裡。「瀏覽…」是它的加值，不是它的前提（§9 第 4 條）。
    """
    stored = _project(request, project_id)
    data = bundle_fmt.build(stored, extensions_root=_root(request))
    return Response(
        content=data,
        media_type="application/zip",
        headers=_attachment(bundle_fmt.filename_for(stored.name)),
    )


@router.post("/{project_id}/export")
async def export_to_path(
    project_id: str,
    request: Request,
    body: dict[str, Any] = Body(default={}),  # noqa: B008 — FastAPI 的宣告風格
) -> dict[str, Any]:
    """寫到「瀏覽…」選好的那個位置。

    **路徑只認 token**（`api/files.py` 開頭那張表）：body 裡永遠不能有一個
    `path`，不然這就是一個從瀏覽器打得到的任意寫入端點。token 一次性、用掉
    就作廢。

    `secrets: true` 時**另外寫一個 `.env`**，檔名是 bundle 換掉副檔名——兩個
    檔案而不是一個檔案裡的一個旗標（§6）。回傳兩個路徑，因為使用者接下來要
    做的事（把哪一個寄出去、哪一個不寄）取決於他看得見它們是兩份東西。
    """
    require_local(request)
    stored = _project(request, project_id)

    token = body.get("token")
    path = targets(request).take(token) if isinstance(token, str) else None
    if path is None:
        raise HTTPException(
            status_code=400,
            detail={"message": "這個存檔位置已經過期了，請再按一次「瀏覽…」"},
        )

    data = bundle_fmt.build(stored, extensions_root=_root(request))
    try:
        path.write_bytes(data)
    except OSError as e:
        raise HTTPException(
            status_code=422, detail={"message": f"寫不進去：{e.strerror or e}"}
        ) from None

    env_path: str | None = None
    if body.get("secrets") is True:
        text = _env_text(request, project_id)
        target = path.with_suffix(".env")
        try:
            target.write_text(text, encoding="utf-8")
        except OSError as e:
            raise HTTPException(
                status_code=422, detail={"message": f"金鑰檔寫不進去：{e.strerror or e}"}
            ) from None
        env_path = str(target)

    return {"path": str(path), "envPath": env_path}


@router.get("/{project_id}/export/env")
async def export_env(project_id: str, request: Request) -> Response:
    """下載這個專案的金鑰，**一個獨立的 `.env`**。

    `.env` 這個副檔名本身就是一句警告——每個開發者都知道它不該進 git。而它是
    第二個檔案這件事，讓「轉寄那個專案」自然只會帶到 bundle。

    收的那一端把它餵進已經存在的 `.env` 匯入（`POST /api/keys/import-env`），
    值進 keyring，檔案不留下。
    """
    stored = _project(request, project_id)
    return Response(
        content=_env_text(request, project_id),
        media_type="text/plain; charset=utf-8",
        headers={
            **_attachment(bundle_fmt.filename_for(stored.name).replace(bundle_fmt.SUFFIX, ".env")),
            # 一份明文金鑰不該留在任何一層快取裡（同 `/api/keys/…/reveal`）。
            "Cache-Control": "no-store",
        },
    )


@router.get("/{project_id}/export-plan")
async def export_plan(project_id: str, request: Request) -> dict[str, Any]:
    """**這次會走出去什麼**——匯出面板上那兩段（§5、§6）。

    一個端點回兩件事，因為它們回答的是同一個問題（「我寄出去的到底是什麼」），
    而那個面板要同時畫出它們：

    * `packs`——這份 bundle 會帶哪幾個積木包的原始碼。一份專案檔不只是一份 IR，
      它帶著別人寫的程式碼，而那句話要在按下匯出之前說。
    * `secrets`——**這次會走出去哪幾把**。範圍是**這個專案的鑰匙圈**（keyring 的
      `{專案 id}:…`），不是整台機器的。沒有這份清單，那個勾選框是在要求使用者
      對一件他看不見的事負責。

      **不再收窄到「這個專案用到的那幾個包」。** 第一版是那樣寫的，而它會安靜地
      漏掉東西：使用者把 `discord` 加進工具箱、填好 token、還沒拉出任何一顆積木
      ——那時候 IR 的 `extensions` 是空的（它是從畫布算出來的），於是面板上寫著
      「這個專案沒有設定過任何金鑰」，而那句話是假的。**一句假話比少一個功能糟。**
      per-project 的 keyring 本來就已經把「別的專案的金鑰」擋在外面了，收窄第二次
      買到的只有那個 bug。

    只給末四碼（D28）。`exportable: false` 的那幾把是**宣告了 secret 卻沒有
    `envVar`** 的：`.env` 是靠變數名對回來的，沒有名字的那一把寫出去也餵不回去
    ——說出來，而不是安靜地少一行。

    **從後端算而不是讓前端數**：使用者在面板上匯出的可能是**另一份**專案（不是
    現在打開的那個），而那份 IR 前端手上根本沒有。
    """
    stored = _project(request, project_id)
    # **積木包那一半仍然是「畫布真的用到的」**——bundle 帶的就是它們（`bundle.build`）。
    sources = discover(_root(request))
    packs = [
        {"id": ext_id, "name": sources[ext_id].manifest.name,
         "version": sources[ext_id].manifest.version}
        for ext_id in sorted(_declared_ids(stored))
        if ext_id in sources
    ]
    out: list[dict[str, Any]] = []
    for ext_id, manifest in _manifests(request).items():
        for spec in manifest.config:
            if spec.type != "secret":
                continue
            owner = secret_store.owner_of(project_id, ext_id)
            out.append(
                {
                    "extId": ext_id,
                    "extName": manifest.name,
                    "key": spec.key,
                    "label": spec.label,
                    "envVar": spec.envVar,
                    "configured": secret_store.is_configured(owner, spec.key),
                    "suffix": secret_store.suffix(owner, spec.key),
                    "exportable": bool(spec.envVar),
                }
            )
    return {"packs": packs, "secrets": out}


def _env_text(request: Request, project_id: str) -> str:
    """這個專案的金鑰，折成一份 `.env`。

    只寫**有 `envVar` 而且真的設定過**的那幾把，範圍與 `export-plan` 完全一樣
    （見那裡的理由：收窄到「畫布用到的包」會安靜地漏掉一把剛填好、還沒拉出積木
    的金鑰）。註解那一行寫的是專案名字，不是 id：這個檔案的讀者是人，而他要回答
    的問題是「這是哪一份專案的金鑰」。
    """
    stored = _project(request, project_id)
    lines = [
        f"# {stored.name} 的金鑰（Blockyard 匯出）",
        "# 這個檔案是明文。不要進 git、不要跟 .blockyard 一起寄出去。",
        "",
    ]
    for ext_id, manifest in _manifests(request).items():
        for spec in manifest.config:
            if spec.type != "secret" or not spec.envVar:
                continue
            value = secret_store.get(secret_store.owner_of(project_id, ext_id), spec.key)
            if value:
                lines.append(f"{spec.envVar}={value}")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# 匯入
# --------------------------------------------------------------------------


@router.post("/import")
async def inspect_bundle(request: Request) -> dict[str, Any]:
    """收下一個 `.blockyard`，解到暫存目錄，回一份審閱資料。**還沒裝任何東西，
    也還沒開出任何專案。**

    每個包分成三種（§7 那張表）：

    | 狀況 | 怎麼辦 |
    |---|---|
    | 已經裝了，而且 digest 一樣 | `same`——**完全不出現**。沒有任何新的程式碼要進來 |
    | 裝過了、但 digest 不一樣 | `different`——**預設跳過，並且說出來**。覆蓋是更新，不能靠匯入偷渡 |
    | 沒裝過的 | `new`——進審閱，一個包一頁 |

    第一列讓最常見的路完全沒有摩擦：一份只用官方包的 demo，收的人一個審閱畫面
    都不會看到。
    """
    staging = _staging(request)
    purge_stale(staging)

    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_ZIP_BYTES:
        raise HTTPException(
            status_code=422,
            detail={"message": f"這個檔案超過 {MAX_ZIP_BYTES // 1024 // 1024}MB 的上限"},
        )
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail={"message": "沒有收到檔案"})

    token = _secrets.token_urlsafe(16)
    dest = _staged_dir(staging, token)
    dest.mkdir(parents=True)
    label = _label(request)
    try:
        # **與積木包共用同一個解壓器**：symlink、壓縮炸彈、`..`、`__MACOSX/`、
        # 還有「丟掉別人的收據」那幾條規則沒有第二份實作。
        extract_archive(data, dest)
        opened = bundle_fmt.read(dest)
    except BlockyardError as e:
        shutil.rmtree(dest, ignore_errors=True)
        raise HTTPException(status_code=422, detail={"message": str(e)}) from None
    _label_path(staging, token).write_text(label, encoding="utf-8")

    installed = discover(_root(request))
    packs: list[dict[str, Any]] = []
    for pack in opened.packs:
        here = installed.get(pack.id)
        if here is None:
            status = "new"
        elif receipt.digest(here.dir) == pack.digest:
            status = "same"
        else:
            status = "different"
        entry: dict[str, Any] = {
            "id": pack.id,
            "name": pack.name,
            "version": pack.version,
            "digest": pack.digest,
            "status": status,
            "installedVersion": None if here is None else here.manifest.version,
        }
        if status == "new":
            # 審閱資料**只給要看的那幾個**。`same` 的那些一個位元組都不必送——
            # 它們不會出現在畫面上。
            entry["review"] = review_pack(_staged_pack(dest, pack.id, label), installed=None)
        packs.append(entry)

    project = opened.project
    name = str((project.get("meta") or {}).get("name") or "未命名專案")
    return {
        "token": token,
        "name": name,
        "exportedAt": opened.exported_at,
        "packs": packs,
        # **同名的已經有一個了**（§10）。id 是 opaque 的，所以技術上一定並存
        # ——這一格只是讓畫面說得出那件事，而不是讓後端替使用者決定。
        "sameName": [p.summary() for p in _store(request).list() if p.name == name],
    }


@router.post("/import/{token}/extensions/{ext_id}")
async def install_bundled_pack(token: str, ext_id: str, request: Request) -> dict[str, Any]:
    """裝這份 bundle 裡的一個積木包。**走的是已經蓋好的那條管線**（`install()`）。

    收據寫 `origin: "bundle"`、label 是那份 bundle 的檔名，所以卡片上那一行會是
    「2026-09-05 從 我的專案.blockyard 裝的」（§7）。

    **只裝 `new` 的那些。** 已經裝著同 id 的一律拒絕——覆蓋是更新（§4），而
    更新那條路上有一段差集要看；讓它從這裡偷渡進去，等於一個使用者按著「下一個」
    就把手上正在用的包換掉了。
    """
    staging = _staging(request)
    dest = _staged_dir(staging, token)
    if not (dest / bundle_fmt.MANIFEST_NAME).is_file():
        raise HTTPException(
            status_code=404,
            detail={"message": "這份匯入已經過期或被取消了，請重新選一次檔案"},
        )
    root = _root(request)
    if ext_id in discover(root):
        raise HTTPException(
            status_code=409,
            detail={
                "message": f"這台機器上已經有一個「{ext_id}」了。"
                "要換成這份專案帶來的那一版，走的是更新那條路（工具箱上右鍵）"
            },
        )
    label = _read_label(staging, token)
    try:
        staged = _staged_pack(dest, ext_id, label)
        source = await install(staged, root)
    except BlockyardError as e:
        raise HTTPException(status_code=422, detail={"message": str(e)}) from None
    return {"id": source.id, "name": source.manifest.name, "version": source.manifest.version}


@router.post("/import/{token}", status_code=201)
async def finish_import(token: str, request: Request) -> dict[str, Any]:
    """開出那個專案。**這是這條路上最後一步**，前面那些包裝了幾個都不影響它。

    沒裝的包不是錯誤（§13.3）：那些 opcode 留成佔位符，畫布打得開、看得懂、
    缺什麼說得出來。硬要「全部裝完才准開」，等於讓一個使用者因為不信任其中
    一個包而整份專案打不開。

    **id 沿用 bundle 裡那一個，除非這台機器上已經有了**（§3、§10）：匯出再
    匯入回來不動 id，那讓 keyring 裡那幾把金鑰仍然指得到同一個專案；而撞號時
    開一個新的，兩份並存。
    """
    staging = _staging(request)
    dest = _staged_dir(staging, token)
    try:
        opened = bundle_fmt.read(dest)
    except BlockyardError:
        raise HTTPException(
            status_code=404,
            detail={"message": "這份匯入已經過期或被取消了，請重新選一次檔案"},
        ) from None

    store = _store(request)
    wanted = bundle_fmt.bundled_id(opened.project)
    project_id = wanted if wanted and store.get(wanted) is None else new_id()

    data = dict(opened.project)
    meta = dict(data.get("meta") or {})
    meta["id"] = project_id
    data["meta"] = meta

    try:
        await validate_project(data, extensions_root=_root(request))
    except ValidationError as e:
        raise HTTPException(
            status_code=422,
            detail={"message": f"這份專案檔讀得開，但裡面的內容驗不過：{e}"},
        ) from None

    stored = store.put(project_id, data)
    _discard(staging, token)
    return {**stored.summary(), "reusedId": project_id == wanted}


@router.delete("/import/{token}", status_code=204)
async def cancel_import(token: str, request: Request) -> None:
    """按下取消。**本來就不在也算成功**——這個端點描述的是結束狀態。"""
    _discard(_staging(request), token)


# --------------------------------------------------------------------------


def _staged_pack(dest: Path, ext_id: str, label: str) -> Staged:
    """bundle 裡的一個包，折成安裝管線吃的那個形狀。

    `dir` 指的是 bundle 暫存目錄底下的 `extensions/<id>`，而 `install()` 會把
    它整個 `move` 進 extensions root——所以裝完之後那一格就不在 bundle 裡了，
    而那正是我們要的：同一個包不會被裝兩次。
    """
    pack_dir = dest / bundle_fmt.EXT_DIR / ext_id
    if not (pack_dir / "manifest.yaml").is_file():
        raise BlockyardError(f"這份專案檔裡沒有「{ext_id}」")
    return Staged(
        token=_secrets.token_urlsafe(16),
        dir=pack_dir,
        source=read_pack(pack_dir, expect_id=ext_id),
        # **收據是收的那一端開的**（§5）：別人的專案檔不能告訴我的機器某個包
        # 是官方的。
        origin=receipt.Origin(origin="bundle", label=label),
    )


def _staged_dir(staging: Path, token: str) -> Path:
    if not _TOKEN.match(token):
        raise HTTPException(status_code=404, detail={"message": "這個匯入編號不合法"})
    return staging / token


def _label_path(staging: Path, token: str) -> Path:
    """那份 bundle 的檔名，一張放在暫存目錄**旁邊**的 sidecar。

    放旁邊而不是裡面，理由同 `install.py::origin_path`：目錄裡的東西會被攤在
    審閱畫面上，而一個使用者沒看過、卻出現在檔案清單裡的檔案本身就是一句需要
    解釋的話。
    """
    return _staged_dir(staging, token).with_name(f"{token}.label")


def _read_label(staging: Path, token: str) -> str:
    try:
        return _label_path(staging, token).read_text(encoding="utf-8").strip() or _UPLOADED
    except OSError:
        # 後端在使用者讀原始碼的那幾分鐘裡重啟過。那時候唯一還說得出口的真話是
        # 「使用者從自己的電腦匯入的」。
        return _UPLOADED


def _discard(staging: Path, token: str) -> None:
    try:
        d = _staged_dir(staging, token)
    except HTTPException:
        return
    shutil.rmtree(d, ignore_errors=True)
    _label_path(staging, token).unlink(missing_ok=True)


def _label(request: Request) -> str:
    """上傳的檔名，當成使用者輸入洗過（同 `api/imports.py::_origin`）。"""
    raw = unquote(request.headers.get(_FILENAME_HEADER, ""))
    name = raw.replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(c for c in name if c.isprintable()).strip()
    return name[:_LABEL_MAX] or _UPLOADED


def _declared_ids(stored: StoredProject) -> set[str]:
    """這份 IR 真的用到哪幾個積木包（§13.3：算出來的事實，不是一份宣告）。"""
    return {
        e["id"]
        for e in (stored.data.get("extensions") or [])
        if isinstance(e, dict) and isinstance(e.get("id"), str)
    }


def _manifests(request: Request) -> dict[str, Any]:
    manifests = dict(declarations.manifests())
    manifests.update({k: src.manifest for k, src in discover(_root(request)).items()})
    return manifests


def _project(request: Request, project_id: str) -> StoredProject:
    if not PROJECT_ID.match(project_id):
        raise not_found(project_id)
    stored = _store(request).get(project_id)
    if stored is None:
        raise not_found(project_id)
    return stored


def _attachment(filename: str) -> dict[str, str]:
    """`Content-Disposition`。**檔名要能是中文**，所以走 RFC 5987 的 `filename*`
    ——header 的值只能是 latin-1，而「我的專案.blockyard」不是。"""
    return {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"}


def _store(request: Request) -> ProjectStore:
    return request.app.state.store


def _root(request: Request) -> Path:
    return Path(request.app.state.extensions_root)


def _staging(request: Request) -> Path:
    path = Path(request.app.state.project_staging_root)
    path.mkdir(parents=True, exist_ok=True)
    return path


__all__ = ["router"]

"""把一個積木包裝進來的四個端點（§15 P3 第 2 步、§12.1）。

    POST   /api/extensions/import          上傳 .zip → 審閱資料（還沒裝）
    POST   /api/extensions/import/github   貼一個 GitHub 網址 → 同一份審閱資料
    POST   /api/extensions/import/{token}  按下安裝／更新 → 真的裝
    DELETE /api/extensions/import/{token}  按下取消 → 清掉暫存

**兩個入口，一份審閱資料，一顆安裝按鈕**（§3：一條管線，三個入口）。前兩條
路的差別只有「怎麼把 bytes 弄到暫存目錄」，之後那一段一個字都不一樣就是
「從 GitHub 裝的包比較少檢查」遲早會是真的。

**上傳走 raw body 不走 multipart**：body 就是那個 `.zip` 的 bytes。這條路上只有
一個檔案、沒有別的欄位，而 multipart 會讓後端多一個相依（`python-multipart`）、
讓前端多一個 `FormData`，換來的是一個沒有人會用到的「還可以再帶幾個欄位」。
前端那一行是 `fetch(url, { method: 'POST', body: file })`。

四個端點都**只驗自己那一段**：形狀與安全在 `extensions/install.py`，審閱資料的
內容在 `extensions/review.py`。這裡剩下的是 HTTP 那一層——狀態碼、暫存目錄在
哪、以及 `BlockyardError` 怎麼變成一句給使用者看的話。
"""

from __future__ import annotations

import secrets
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException, Request

from blockyard.errors import BlockyardError
from blockyard.extensions import discover, github
from blockyard.extensions.install import (
    MAX_ZIP_BYTES,
    UPLOADED,
    Staged,
    discard,
    install,
    purge_stale,
    read_origin,
    stage,
    staged_dir,
    update,
)
from blockyard.extensions.manifest import read_pack
from blockyard.extensions.receipt import Origin
from blockyard.extensions.review import review

router = APIRouter(prefix="/api/extensions/import", tags=["extensions"])


@router.post("")
async def inspect(request: Request) -> dict[str, Any]:
    """收下一個 `.zip`，解到暫存目錄，回一份審閱資料。**還沒有裝任何東西。**"""
    staging = _staging(request)
    # 掛在這裡而不是一個排程上：唯一會累積出暫存目錄的人，就是又來匯入一次的人
    # （見 `install.py::purge_stale`）。
    purge_stale(staging)

    # **先看 header 再收 body**：`request.body()` 會把整份東西讀進記憶體，所以
    # 一個 1GB 的請求在「檔案太大」那句話說出口之前就已經佔掉 1GB 了。這台後端
    # 只綁 127.0.0.1（§12.1），所以這不是在防誰——是在防一個手滑選錯檔案的人
    # 把自己的機器弄到換頁。
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_ZIP_BYTES:
        raise HTTPException(
            status_code=422,
            detail={"message": f"這個檔案超過 {MAX_ZIP_BYTES // 1024 // 1024}MB 的上限"},
        )

    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail={"message": "沒有收到檔案"})

    token = secrets.token_urlsafe(16)
    try:
        staged = stage(data, staging, token=token, origin=_origin(request))
    except BlockyardError as e:
        # **422 不是 500**：一份壞掉的 `.zip` 是使用者送進來的東西，不是後端出事。
        # 而且訊息要原樣送出去——`install.py` 那些句子（「這個 .zip 裡沒有
        # manifest.yaml」）就是寫給這一刻的使用者看的。
        raise HTTPException(status_code=422, detail={"message": str(e)}) from None

    return _reviewed(request, staged)


@router.post("/github")
async def inspect_github(request: Request) -> dict[str, Any]:
    """貼一個 GitHub 網址，回同一份審閱資料。**還沒有裝任何東西。**

    **宣告在 `/{token}` 前面**：路由照宣告順序比對，而 `github` 本身也是一段
    合法的路徑。（它其實過不了 token 的形狀檢查，所以現在就算順序反了也只是
    404——這一行是為了讓那件事不必靠巧合。）

    網址在 body 裡而不是 query string：它會出現在 uvicorn 的存取記錄上，而
    「這台機器去抓了哪個 repo」不必留在那裡。
    """
    body = await _json(request)
    url = body.get("url")
    if not isinstance(url, str):
        raise HTTPException(status_code=400, detail={"message": "沒有收到 GitHub 網址"})

    staging = _staging(request)
    purge_stale(staging)
    try:
        target = github.parse(url)
        # 抓下來與記下來源是同一件事——**這是我們手上真的拿著那份 bytes 的
        # 一刻**，而 commit 也只有這一刻問得到（§2、§6 第 5 點）。
        data, origin = await github.fetch(target)
        staged = stage(data, staging, token=secrets.token_urlsafe(16), origin=origin)
    except BlockyardError as e:
        raise HTTPException(status_code=422, detail={"message": str(e)}) from None
    return _reviewed(request, staged)


def _reviewed(request: Request, staged: Staged) -> dict[str, Any]:
    """審閱資料，**兩個入口共用**。

    「這台機器上已經有同 id 的包了嗎」在這裡問，而不是等按下安裝才 422：
    使用者讀完幾百行原始碼再被告知「這是一次更新」，那幾分鐘是白花的——而且
    更新那一頁要看的東西不一樣（§4 的差集）。
    """
    installed = discover(_root(request)).get(staged.source.id)
    return review(staged, installed=None if installed is None else installed.manifest)


@router.post("/{token}")
async def confirm(token: str, request: Request) -> dict[str, Any]:
    """按下安裝。回 `GET /api/extensions` 那份宣告裡的同一個包。

    **前端拿到這個回應之後要重問 `/api/extensions`**，不是拿這裡的 manifest 去
    註冊：那一份是照 `exclude_defaults=True` 吐的（見 `api/extensions.py::_dump`），
    而這裡不折那個形狀。這裡回的是「裝好了，它叫什麼」——夠前端說一句話、把它
    加進工具箱名單，剩下的走那條已經存在的路。

    **同 id 的已經裝著就是一次更新**，走 `install.update()`（舊的先進垃圾桶）。
    不多一個「你是不是要更新」的旗標，理由是那個旗標問的問題使用者在審閱畫面
    上已經答過了：那一頁畫的是差集、按鈕上寫的是「更新到 v0.2.0」。多一個旗標
    只會讓兩邊有機會不同意，而**不同意的那一次會蓋掉一個裝好的包**。

    更新時多回一個 `replaced`：換掉的是哪一版、舊的那一份去了垃圾桶的哪裡。
    那是「更新完發現更糟」唯一的線索（§8 的未答項）。
    """
    staged = _reopen(request, token)
    root = _root(request)
    installed = discover(root).get(staged.source.id)
    try:
        if installed is None:
            source = await install(staged, root)
            replaced = None
        else:
            source, stashed = await update(staged, root)
            replaced = {"version": installed.manifest.version, "trash": str(stashed.dir)}
    except BlockyardError as e:
        raise HTTPException(status_code=422, detail={"message": str(e)}) from None
    return {
        "id": source.id,
        "name": source.manifest.name,
        "version": source.manifest.version,
        "replaced": replaced,
    }


@router.delete("/{token}", status_code=204)
async def cancel(token: str, request: Request) -> None:
    """按下取消。**本來就不在也算成功**——這個端點描述的是結束狀態。"""
    try:
        discard(_staging(request), token)
    except BlockyardError:
        # token 形狀不合法。那也是「這個暫存不存在」的一種說法。
        return


def _reopen(request: Request, token: str) -> Staged:
    """把一個 token 變回 `Staged`。

    **重讀 manifest，不是把第一次的結果快取起來**。兩個理由，第二個才是真的：
    快取要有生命週期（後端重啟就沒了，而使用者的分頁還開著）；而且審閱與安裝
    之間隔著使用者讀原始碼的那幾分鐘——這一刻重讀一次，讀的就是**真的會被搬
    進去的那份東西**，而那正是 §12.1 那句話要的性質。
    """
    try:
        d = staged_dir(_staging(request), token)
    except BlockyardError as e:
        raise HTTPException(status_code=404, detail={"message": str(e)}) from None
    if not (d / "manifest.yaml").is_file():
        raise HTTPException(
            status_code=404,
            detail={"message": "這份匯入已經過期或被取消了，請重新選一次檔案"},
        )
    try:
        return Staged(
            token=token,
            dir=d,
            source=read_pack(d),
            origin=read_origin(_staging(request), token),
        )
    except BlockyardError as e:
        raise HTTPException(status_code=422, detail={"message": str(e)}) from None


#: 上傳的檔名走 header，因為 body 就是那個 `.zip` 的 bytes（見模組 docstring）。
_FILENAME_HEADER = "x-blockyard-filename"
#: 收據上那一行 label 的長度上限。它會被畫在一張卡上，而一個 300 字的檔名
#: 在那裡的意思是「把版面撐爛」。
_LABEL_MAX = 80


def _origin(request: Request) -> Origin:
    """這份 bytes 從哪來（§2、`extensions/receipt.py`）。

    這是 `.zip` 那個入口的來源，所以 origin 恆為 `zip`。GitHub 那一張由
    `github.fetch()` 開（它才知道 commit），而登記處進來的時候差別也只有這一步
    （§3：**一條管線，三個入口**）。

    **檔名要當成使用者輸入洗過。** 它會原樣進到一個 JSON 檔案、再被畫在卡片
    上——路徑分隔符（`../` 那條路）、控制字元與換行都不能留。洗不出東西就退回
    一句「從這台電腦上傳」：label 只是給人看的一行，沒有它收據仍然成立。
    """
    # header 的值只能是 latin-1，所以前端送的是 `encodeURIComponent` 過的
    # （檔名可以是「打招呼.zip」）。
    raw = unquote(request.headers.get(_FILENAME_HEADER, ""))
    name = raw.replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(c for c in name if c.isprintable()).strip()
    return Origin(origin="zip", label=name[:_LABEL_MAX] or UPLOADED)


async def _json(request: Request) -> dict[str, Any]:
    """body 讀不出來就當空的——缺什麼由呼叫端說，因為那句話才講得出使用者
    要做什麼。"""
    try:
        body = await request.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


def _root(request: Request) -> Path:
    return Path(request.app.state.extensions_root)


def _staging(request: Request) -> Path:
    return Path(request.app.state.staging_root)


__all__ = ["router"]

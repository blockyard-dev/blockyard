"""從電腦匯入 `.zip` 積木包的三個端點（§15 P3 第 2 步、§12.1）。

    POST   /api/extensions/import          上傳 → 審閱資料（還沒裝）
    POST   /api/extensions/import/{token}  按下安裝 → 真的裝
    DELETE /api/extensions/import/{token}  按下取消 → 清掉暫存

**上傳走 raw body 不走 multipart**：body 就是那個 `.zip` 的 bytes。這條路上只有
一個檔案、沒有別的欄位，而 multipart 會讓後端多一個相依（`python-multipart`）、
讓前端多一個 `FormData`，換來的是一個沒有人會用到的「還可以再帶幾個欄位」。
前端那一行是 `fetch(url, { method: 'POST', body: file })`。

三個端點都**只驗自己那一段**：形狀與安全在 `extensions/install.py`，審閱資料的
內容在 `extensions/review.py`。這裡剩下的是 HTTP 那一層——狀態碼、暫存目錄在
哪、以及 `BlockyardError` 怎麼變成一句給使用者看的話。
"""

from __future__ import annotations

import secrets
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from blockyard.errors import BlockyardError
from blockyard.extensions import discover
from blockyard.extensions.install import (
    MAX_ZIP_BYTES,
    Staged,
    discard,
    install,
    purge_stale,
    stage,
    staged_dir,
)
from blockyard.extensions.manifest import read_pack
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
        staged = stage(data, staging, token=token)
    except BlockyardError as e:
        # **422 不是 500**：一份壞掉的 `.zip` 是使用者送進來的東西，不是後端出事。
        # 而且訊息要原樣送出去——`install.py` 那些句子（「這個 .zip 裡沒有
        # manifest.yaml」）就是寫給這一刻的使用者看的。
        raise HTTPException(status_code=422, detail={"message": str(e)}) from None

    installed = discover(_root(request)).get(staged.source.id)
    return review(staged, installed=None if installed is None else installed.manifest)


@router.post("/{token}")
async def confirm(token: str, request: Request) -> dict[str, Any]:
    """按下安裝。回 `GET /api/extensions` 那份宣告裡的同一個包。

    **前端拿到這個回應之後要重問 `/api/extensions`**，不是拿這裡的 manifest 去
    註冊：那一份是照 `exclude_defaults=True` 吐的（見 `api/extensions.py::_dump`），
    而這裡不折那個形狀。這裡回的是「裝好了，它叫什麼」——夠前端說一句話、把它
    加進工具箱名單，剩下的走那條已經存在的路。
    """
    staged = _reopen(request, token)
    try:
        source = await install(staged, _root(request))
    except BlockyardError as e:
        raise HTTPException(status_code=422, detail={"message": str(e)}) from None
    return {"id": source.id, "name": source.manifest.name, "version": source.manifest.version}


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
        return Staged(token=token, dir=d, source=read_pack(d))
    except BlockyardError as e:
        raise HTTPException(status_code=422, detail={"message": str(e)}) from None


def _root(request: Request) -> Path:
    return Path(request.app.state.extensions_root)


def _staging(request: Request) -> Path:
    return Path(request.app.state.staging_root)


__all__ = ["router"]

"""那顆「瀏覽…」（`docs/project-storage-design.md` §9）。

**後端寫的位置只能來自它自己剛剛開的那個對話框，永遠不能來自 request body。**

這條線把 §16 Q25 標的那個安全面關在外面。差別具體到一句話：

* `POST /api/…/export {"path": "/Users/x/.ssh/authorized_keys"}`——路徑是**網頁**
  說的。那是一個任意寫入端點，而它從瀏覽器打得到。
* 對話框回一個路徑 → 後端記在一個一次性 token 底下 → `POST {"token": …}`——路徑是
  **人**說的。網頁從頭到尾沒有說出過任何路徑。

所以形狀是兩步，而路徑**只以顯示字串的身分**經過瀏覽器：

    POST /api/files/save-dialog   → { token, display: "~/work/bots/我的專案.blockyard" }
    POST /api/projects/{id}/export { token, secrets: false }

畫面上那一格路徑是**唯讀的**——它是給人看的回執，不是一個輸入框。
"""

from __future__ import annotations

import secrets as _secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Request

from blockyard import filedialog

router = APIRouter(prefix="/api/files", tags=["files"])

#: 一張 token 活多久。它從對話框關掉的那一刻算起，而下一個動作（按下「匯出」）
#: 就在同一個畫面上——十分鐘是給「選完路徑之後又去看了一眼金鑰清單」的餘裕，
#: 不是給一個放著不管的分頁。
TTL_SECONDS = 600.0

#: 迴圈位址。`request.client.host` 是這個請求真的從哪個網卡進來的，比任何設定值
#: 都準——`blockyard serve --host 0.0.0.0` 之後，設定值說的是「我綁了什麼」，
#: 而我們要問的是「按下按鈕的人跟這個螢幕是不是同一台」。
_LOOPBACK = frozenset({"127.0.0.1", "::1", "::ffff:127.0.0.1"})


@dataclass(frozen=True)
class _Target:
    path: Path
    issued_at: float


class SaveTargets:
    """對話框選過的路徑。**一次性、有期限，用掉就作廢。**

    住在 `app.state` 而不是模組層的一個 dict：測試要各自拿到自己的一份，理由
    與 `create_app()` 是工廠同一個（`api/app.py` 開頭那段）。
    """

    def __init__(self, *, ttl: float = TTL_SECONDS) -> None:
        self._ttl = ttl
        self._targets: dict[str, _Target] = {}

    def issue(self, path: Path) -> str:
        self._purge()
        token = _secrets.token_urlsafe(16)
        self._targets[token] = _Target(path=path, issued_at=time.monotonic())
        return token

    def take(self, token: str) -> Path | None:
        """換一個路徑出來，**並且把它作廢**。過期或不存在都回 `None`。"""
        self._purge()
        target = self._targets.pop(token, None)
        return None if target is None else target.path


    def _purge(self) -> None:
        deadline = time.monotonic() - self._ttl
        for token, target in list(self._targets.items()):
            if target.issued_at < deadline:
                del self._targets[token]


def require_local(request: Request) -> None:
    """這個請求是不是從同一台機器打進來的。

    對話框開在**後端**那台的螢幕上。今天那永遠是同一台（`serve` 只綁
    127.0.0.1，§12.1），但 `--host` 已經允許別的綁法——而少了這一條，症狀是
    **一個沒有人在看的螢幕上開了一個視窗，而那個 HTTP 請求永遠不回來**。
    """
    host = request.client.host if request.client else None
    if host not in _LOOPBACK:
        raise HTTPException(
            status_code=403,
            detail={"message": "「瀏覽…」只在後端與瀏覽器是同一台機器時才給——"
                               "對話框會開在後端那台的螢幕上"},
        )


def targets(request: Request) -> SaveTargets:
    return request.app.state.save_targets


@router.post("/save-dialog")
async def save_dialog(
    request: Request,
    body: dict[str, Any] = Body(default={}),  # noqa: B008 — FastAPI 的宣告風格
) -> dict[str, Any]:
    """開一個原生的「另存新檔」，回一張一次性的 token。

    **三種結果，只有一種是錯誤：**

    * 選好了 → `{ available: true, token, display }`
    * 按了取消（或逾時） → `{ available: true, token: null }`。**那不是錯誤**，
      是「這件事沒發生」——前端該做的是什麼都不做。
    * 這台機器沒有 tkinter → `{ available: false }`。前端那顆「瀏覽…」不畫，
      匯出退回瀏覽器下載（§9 第 4 條）。
    """
    require_local(request)
    if not filedialog.available():
        return {"available": False, "token": None, "display": None}

    suggested = body.get("suggestedName")
    extension = body.get("extension")
    path = await filedialog.save(
        suggested=suggested if isinstance(suggested, str) else "",
        title=body.get("title") if isinstance(body.get("title"), str) else "匯出專案",
        extension=extension if isinstance(extension, str) else "",
    )
    if path is None:
        return {"available": True, "token": None, "display": None}
    return {"available": True, "token": targets(request).issue(path), "display": _display(path)}


@router.get("/dialog-available")
async def dialog_available(request: Request) -> dict[str, bool]:
    """那顆「瀏覽…」該不該畫。

    **問一次就好**（前端記著）：它的答案在一次啟動之內不會變，而 `find_spec`
    在每一次開匯出面板時都跑一遍只是噪音。
    """
    return {"available": bool(request.client and request.client.host in _LOOPBACK)
            and filedialog.available()}


def _display(path: Path) -> str:
    """畫在那一格唯讀欄位裡的字。家目錄縮成 `~`——它佔的寬度是純浪費，而且
    截圖時把使用者的名字一起帶出去。"""
    try:
        return f"~/{path.relative_to(Path.home()).as_posix()}"
    except ValueError:
        return str(path)


__all__ = ["SaveTargets", "require_local", "router", "targets"]

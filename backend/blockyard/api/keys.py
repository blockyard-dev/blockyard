"""D28：右上角的「金鑰」全域入口（§12.1）。

一把一把地管：**清單**（已設定／未設定，附末四碼）、**逐筆寫入與刪除**、
以及仍然留著的**匯入 `.env`**（一次貼一整份還是最快的路）。

列表**永遠只給末四碼**；完整明文只有 `/reveal` 這一個端點給得出來，而且
它一次只回一把、要明確指名。

**D28 原本寫「沒有匯出、不顯示明文」，這兩條都放寬了，理由不一樣：**

- 「不顯示明文」擋的是**畫面上一直躺著一串金鑰**——那是肩後偷看、是截圖、
  是螢幕分享。`/reveal` 不違反它：值進的是剪貼簿，不進 DOM，也不進列表
  回應（所以不會跟著每一次輪詢一起送出來）。
- 「不匯出」原本要擋的是**分享專案等於分享金鑰**。那條線的落點一直是
  「金鑰不進 `project.json`」，而那沒有動。從自己的機器上把自己的金鑰複製
  到自己的剪貼簿，跟分享專案是兩回事——擋掉它只會逼使用者去開鑰匙圈，
  而那裡一次攤開的是他所有的憑證。

（早期的 D28 也寫「沒有單筆刪除／編輯」。那是在只能整份貼 `.env` 的前提下
成立的：整份匯入的介面裡單筆刪除確實沒有位置。有了逐筆新增之後，「拿掉
一把」就是同一件事的另一半。）
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response

from blockyard.extensions import discover, secret_store
from blockyard.interpreter import declarations

router = APIRouter(prefix="/api/keys", tags=["keys"])


def _manifests(request: Request) -> dict[str, Any]:
    """內建在前，跟 `/api/extensions` 同一個排序理由（D21）。"""
    manifests = dict(declarations.manifests())
    root = request.app.state.extensions_root
    manifests.update({ext_id: src.manifest for ext_id, src in discover(root).items()})
    return manifests


def _secret_spec(request: Request, ext_id: str, key: str) -> Any:
    """這個包真的宣告過這一把嗎。

    **宣告是唯一的入口**：`PUT /api/keys/openai/api_key` 對得上宣告才寫得進去。
    沒有這道檢查，這個端點就變成一個「往 OS 鑰匙圈裡塞任意鍵值」的通用寫入口，
    而它是從瀏覽器打得到的。
    """
    manifest = _manifests(request).get(ext_id)
    if manifest is not None:
        for spec in manifest.config:
            if spec.type == "secret" and spec.key == key:
                return spec
    raise HTTPException(status_code=404, detail=f"積木包「{ext_id}」沒有宣告名為「{key}」的金鑰")


@router.get("")
async def list_keys(request: Request) -> list[dict[str, Any]]:
    """所有已載入積木包宣告過的 `secret` 設定項。"""
    manifests = _manifests(request)

    out: list[dict[str, Any]] = []
    for ext_id, manifest in manifests.items():
        for spec in manifest.config:
            if spec.type != "secret":
                continue
            out.append(
                {
                    "extId": ext_id,
                    "extName": manifest.name,
                    "key": spec.key,
                    "label": spec.label,
                    "envVar": spec.envVar,
                    "configured": secret_store.is_configured(ext_id, spec.key),
                    "suffix": secret_store.suffix(ext_id, spec.key),
                }
            )
    return out


@router.post("/import-env")
async def import_env(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    """貼上或選一個 `.env` 檔的原文，逐行比對每個包宣告的 `envVar`。

    對得上的行寫進 keyring；對不上的行**列出來但不寫入**（D28：不是靜默
    略過），且只回變數名稱，不回值——「不顯示明文」這條線在匯入回饋裡
    也要守住。
    """
    text = body.get("text")
    if not isinstance(text, str):
        return {"written": [], "unmatched": []}

    manifests = _manifests(request)

    by_env_var: dict[str, tuple[str, str]] = {}
    for ext_id, manifest in manifests.items():
        for spec in manifest.config:
            if spec.type == "secret" and spec.envVar:
                by_env_var[spec.envVar] = (ext_id, spec.key)

    written: list[dict[str, str]] = []
    unmatched: list[str] = []
    for env_var, value in _parse_env(text):
        target = by_env_var.get(env_var)
        if target is None:
            unmatched.append(env_var)
            continue
        ext_id, key = target
        secret_store.set(ext_id, key, value)
        written.append({"extId": ext_id, "key": key, "envVar": env_var})

    return {"written": written, "unmatched": unmatched}


@router.put("/{ext_id}/{key}")
async def set_key(request: Request, ext_id: str, key: str, body: dict[str, Any]) -> dict[str, Any]:
    """寫一把。已經有值就覆寫——「換一把」跟「第一次填」在使用者眼裡是同一個
    動作，分成兩個端點只會讓前端多問一次「這把存在嗎」。"""
    _secret_spec(request, ext_id, key)

    value = body.get("value")
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(status_code=400, detail="金鑰不能是空的")

    secret_store.set(ext_id, key, value.strip())
    return {"extId": ext_id, "key": key, "configured": True,
            "suffix": secret_store.suffix(ext_id, key)}


@router.get("/{ext_id}/{key}/reveal")
async def reveal_key(request: Request, ext_id: str, key: str, response: Response) -> dict[str, str]:
    """把**一把**金鑰的完整明文交出來，給前端的複製按鈕用。

    刻意是獨立的端點而不是列表上的一個欄位：列表每開一次面板就打一次，把明文
    掛在上面等於讓它跟著每一次輪詢在網路與記憶體裡多走一趟，而 99% 的呼叫根本
    不需要它。要拿就得**指名這一把**。

    `no-store` 不是形式：GET 回應預設是可以被快取的，而這一份不該留在任何一層
    快取裡。
    """
    _secret_spec(request, ext_id, key)
    value = secret_store.get(ext_id, key)
    if not value:
        raise HTTPException(status_code=404, detail="這一把還沒有設定")
    response.headers["Cache-Control"] = "no-store"
    return {"value": value}


@router.delete("/{ext_id}/{key}")
async def delete_key(request: Request, ext_id: str, key: str) -> dict[str, Any]:
    """拿掉一把。本來就沒有也回 200——這個端點描述的是「結束狀態」，而使用者
    連按兩下刪除不該看到一則錯誤。"""
    _secret_spec(request, ext_id, key)
    removed = secret_store.delete(ext_id, key)
    return {"extId": ext_id, "key": key, "configured": False, "removed": removed}


def _parse_env(text: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        name = name.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if name:
            out.append((name, value))
    return out


__all__ = ["router"]

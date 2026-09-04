"""安裝前的那一頁（§12.1「程式碼審閱：安裝前完整顯示原始碼，不可略過」）。

這個模組把一個**還沒裝**的積木包折成使用者要看的東西。它決定的是「攤開什麼」，
而那是一個取捨：

* **原始碼要全部給**，不是摘要、不是前 50 行。§12.1 那句話的重點是「不可略過」，
  而一份被截斷的原始碼與一份沒有給的原始碼，在「使用者有沒有機會看見那一行」
  這件事上是一樣的。
* 但**總量要有上限**。一個 vendored 了 three.js 的面板包有幾百 KB 的 `.js`，
  照單全收會讓這一頁自己先卡住，而那幾百 KB 沒有一個位元組是使用者會讀的。
  所以分兩層：**`.py` 一定給**（那是唯一以完整機器權限執行的東西），其他文字檔
  在預算內給，超出的**列出檔名但不給內容**——`omitted` 那份清單是一句誠實話，
  不是一個被藏起來的角落。
* **宣告的摘要也要給**：權限、依賴、會多出哪幾顆積木、會多出哪幾格分頁、要填
  哪幾把金鑰、`open_url` 按鈕會開到哪裡去。這些是 manifest 說的話，而使用者讀
  程式碼之前先讀的就是它們。

回傳的是純資料（dict），不是 pydantic 模型：這一頁的形狀只有前端一個消費者，
而多一個模型就多一份要跟著 `export_schema.py` 走的東西。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from blockyard.extensions.codescan import scan_pack
from blockyard.extensions.install import Staged
from blockyard.extensions.manifest import ButtonSpec, Manifest, pack_files

#: 攤得開的文字檔。認不得的副檔名（`.png`、`.woff2`、`.glb`）只進檔案清單。
_TEXT_SUFFIXES = frozenset(
    {
        ".py", ".yaml", ".yml", ".json", ".txt", ".md",
        ".html", ".css", ".js", ".mjs", ".toml", ".cfg", ".ini",
    }
)
#: 一定要攤開的那一種（見模組 docstring）。
_ALWAYS = frozenset({".py"})
#: 非 `.py` 的文字檔總共給到這麼多字元。
_TEXT_BUDGET = 400_000
#: 單一檔案的上限。一個 200 萬字元的 `.py` 攤在畫面上不會有人讀，但它會讓瀏覽器
#: 停住——而「畫面卡住」與「這個包有問題」在使用者眼裡長得一模一樣。
_FILE_LIMIT = 200_000


def review(staged: Staged, *, installed: Manifest | None) -> dict[str, Any]:
    """審閱畫面的一整份資料。

    `installed` 是**這台機器上同 id 的包**（沒有就是 `None`）。有值時前端畫的
    是一句「已經裝過了」而不是安裝按鈕——§16 Q24 還沒答，見
    `install.py::install`。它在這裡出現而不是等按下安裝才 422，理由是使用者
    讀完幾百行原始碼再被拒絕，那幾分鐘是白花的。
    """
    mf = staged.source.manifest
    files, sources, omitted = _files(staged.dir)
    return {
        "token": staged.token,
        "id": mf.id,
        "name": mf.name,
        "version": mf.version,
        "author": mf.author,
        "description": mf.description,
        "permissions": list(mf.permissions),
        "requirements": list(mf.requirements),
        "blocks": [{"opcode": mf.full_opcode(b.opcode), "text": b.text} for b in mf.blocks],
        "panels": [{"id": p.id, "title": p.title} for p in mf.panels],
        "config": [
            {"key": c.key, "label": c.label, "type": c.type, "envVar": c.envVar}
            for c in mf.config
        ],
        # `open_url` 的網址要進審閱畫面（§7.2 的 `ButtonSpec` 那條註解說的就是
        # 這一頁）。使用者按下工具箱上那顆按鈕時瀏覽器會開它，而那一刻沒有人會
        # 再問一次。
        "urls": _urls(mf),
        "files": files,
        "sources": sources,
        "omitted": omitted,
        "findings": [
            {
                "path": f.path,
                "line": f.line,
                "message": f.message,
                "permission": f.permission,
                "declared": f.declared,
            }
            for f in scan_pack(staged.dir, mf)
        ],
        "installed": None if installed is None else {"version": installed.version},
    }


def _urls(mf: Manifest) -> list[str]:
    seen: list[str] = []
    for b in mf.buttons:
        if isinstance(b, ButtonSpec) and b.action == "open_url" and b.url and b.url not in seen:
            seen.append(b.url)
    return seen


def _files(pack_dir: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """`(檔案清單, 攤開的原始碼, 沒攤開的文字檔)`。

    檔案清單是**每一個檔案**，含二進位的——「這個 zip 裡到底有什麼」是這一頁
    要回答的第一個問題，而一個叫 `notes.pdf` 的檔案出現在一個積木包裡，本身就是
    值得看見的事。
    """
    files: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    omitted: list[str] = []
    budget = _TEXT_BUDGET

    everything = pack_files(pack_dir)
    for path in everything:
        rel = path.relative_to(pack_dir).as_posix()
        files.append({"path": rel, "size": path.stat().st_size})

    # **`.py` 先攤，其餘照路徑順序**：預算用完時被擋在外面的應該是 vendored 的
    # 那棵樹，不是一支剛好排在字母後面的 `main.py`。
    text = [p for p in everything if p.suffix.lower() in _TEXT_SUFFIXES]
    text.sort(key=lambda p: (p.suffix.lower() not in _ALWAYS, p.relative_to(pack_dir).as_posix()))

    for path in text:
        rel = path.relative_to(pack_dir).as_posix()
        always = path.suffix.lower() in _ALWAYS
        if not always and budget <= 0:
            omitted.append(rel)
            continue
        try:
            body = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            # 副檔名說是文字、內容不是。列出來就好——這一頁不是在猜檔案型別。
            omitted.append(rel)
            continue
        truncated = len(body) > _FILE_LIMIT
        if truncated:
            body = body[:_FILE_LIMIT]
        if not always:
            budget -= len(body)
        sources.append({"path": rel, "text": body, "truncated": truncated})

    return files, sources, omitted


__all__ = ["review"]

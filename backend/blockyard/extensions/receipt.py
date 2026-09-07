"""這個資料夾是誰搬進來的（`docs/extension-design.md` §2）。

一張收據躺在包目錄裡：

    ~/.blockyard/extensions/greet/.blockyard-source.json

**它不進 `manifest.yaml`。** 那個檔案屬於包的作者，寫進去的話更新會整份覆蓋、
diff 從此不能看——而更根本的是**一個包可以謊報自己從哪來**。來源必須是安裝的
人記的，不是被安裝的東西自己說的（所以 `install.py` 在解壓那一步就把 `.zip`
裡同名的檔案丟掉）。

**也不放一份總表**（`extensions/index.json`）。總表看起來方便，但它把「這台
機器上有哪些包」變成兩個答案——現在只有一個（掃資料夾），而兩個答案一定會漂移。
更根本的是**來源是「這個包的性質」，不是「這次安裝的性質」**：「這份東西來自
`github.com/x/y@abc123`」不管搬到哪台機器都還是真的。

## 核心規則：沒有收據 = 使用者自己放的，我們不碰

那不是錯誤狀態——那是一個人正在那個資料夾裡寫他自己的包，而替他刪掉一個他
正在編輯的目錄，是這整份設計裡唯一一件真的會弄丟東西的事。

所以**讀壞掉的收據等於沒有收據**：這個模組每一條讀不出來的路都收斂到 `None`，
而 `None` 的意思是「不准動」。往安全的那一邊倒是刻意的。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from blockyard.extensions.manifest import RECEIPT_FILE, pack_files

#: `origin` 的字彙表。**封頂的**：它只決定兩件事——卡片上的標記，以及我們可不
#: 可以移除這個包。多出第三個讀者時要回來看這一行（§8）。
#:
#: `bundle` 是第五個字，而它進得來是因為它對那兩個讀者都給得出不同的答案
#: （`project-storage-design.md` §7）：卡片上那一行要說得出「這個包是跟著哪一份
#: 專案進來的」，而它跟 `official` 一樣是可以移除的。**label 是那份 bundle 的
#: 檔名**，所以卡片上會是「2026-09-05 從 我的專案.blockyard 裝的」。
ORIGINS = ("official", "zip", "github", "registry", "bundle")


@dataclass(frozen=True)
class Origin:
    """bytes 從哪來。**在取得 bytes 的那一刻記下**，不是安裝時才問出來的。

    §3 的三個入口（`.zip`、GitHub、登記處）只差第一步——怎麼把 bytes 弄到暫存
    目錄——而這個 dataclass 就是那一步唯一的產物。管線的其餘部分收下它、原樣
    寫進收據，不必知道它是怎麼來的。
    """

    origin: str
    #: 給人看的一行：`greet.zip`、`github.com/x/y`、`隨 Blockyard 出貨`。
    label: str
    url: str | None = None
    #: 分支或 tag。**收據記的是 `commit` 不是它**——`main` 明天就不是今天
    #: 那一份了（§6）。這一格留著是為了說得出使用者當初打的是什麼。
    ref: str | None = None
    commit: str | None = None


@dataclass(frozen=True)
class Receipt:
    """一張讀回來的收據。"""

    origin: str
    label: str
    version: str
    digest: str
    installed_at: str
    url: str | None = None
    ref: str | None = None
    commit: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "origin": self.origin,
            "label": self.label,
            "url": self.url,
            "ref": self.ref,
            "commit": self.commit,
            "version": self.version,
            "digest": self.digest,
            "installedAt": self.installed_at,
        }


def path_of(pack_dir: Path) -> Path:
    return pack_dir / RECEIPT_FILE


def read(pack_dir: Path) -> Receipt | None:
    """這個包的收據，沒有或讀不出來就 `None`（= 不准動，見模組 docstring）。"""
    try:
        data = json.loads(path_of(pack_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None

    def text(key: str) -> str | None:
        value = data.get(key)
        return value if isinstance(value, str) else None

    origin = text("origin")
    # **認不得的 `origin` 也當作沒有收據。** 一張未來版本寫的、或被手改過的
    # 收據，我們讀不懂它在說什麼——而讀不懂的東西不該換到「可以刪掉這個目錄」
    # 的權限。
    if origin not in ORIGINS:
        return None
    return Receipt(
        origin=origin,
        label=text("label") or origin,
        version=text("version") or "",
        digest=text("digest") or "",
        installed_at=text("installedAt") or "",
        url=text("url"),
        ref=text("ref"),
        commit=text("commit"),
    )


def write(pack_dir: Path, origin: Origin, *, version: str) -> Receipt:
    """開一張收據。**在包已經到位之後叫**——digest 算的是它現在的樣子。"""
    receipt = Receipt(
        origin=origin.origin,
        label=origin.label,
        version=version,
        digest=digest(pack_dir),
        # 秒就夠了，而且要看得出是 UTC。`isoformat()` 給的是 `+00:00`，
        # 換成 `Z` 只是為了跟 §2 那份範例長得一樣。
        installed_at=datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        url=origin.url,
        ref=origin.ref,
        commit=origin.commit,
    )
    path_of(pack_dir).write_text(
        json.dumps(receipt.to_json(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return receipt


def digest(pack_dir: Path) -> str:
    """這個包現在的內容，一個 `sha256:…`。

    **路徑也要進雜湊，不只是內容**：只餵內容的話，把 `main.py` 改名成
    `evil.py` 再放一支新的 `main.py` 進來，算出來會是同一個值。長度前綴則是
    為了讓「一個檔案叫 `ab`」與「兩個檔案叫 `a`、`b`」分得開。

    收據本身不算在裡面（`pack_files` 已經排除，見 `RECEIPT_FILE`）——它是這個
    值的容器，算進去會是一條自己餵自己的迴圈。

    §7 的登記處索引也放 `sha256`，兩邊天生對得起來——**但要對得起來，兩邊算的
    必須是同一件事**，所以這個函式的規則一旦有人依賴就改不動了。
    """
    h = hashlib.sha256()
    for path in pack_files(pack_dir):
        rel = path.relative_to(pack_dir).as_posix().encode("utf-8")
        body = path.read_bytes()
        h.update(f"{len(rel)}:".encode())
        h.update(rel)
        h.update(f"{len(body)}:".encode())
        h.update(body)
    return f"sha256:{h.hexdigest()}"


__all__ = ["ORIGINS", "Origin", "Receipt", "digest", "path_of", "read", "write"]

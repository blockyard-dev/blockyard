"""從電腦匯入一個 `.zip` 積木包（§15 P3 第 2 步、§12.1）。

**兩段式，而且中間那一步是使用者**：

    stage()    解壓到暫存目錄、讀 manifest、掃程式碼 → 回一份審閱資料
    （使用者看完，按下安裝）
    install()  建 venv、搬進 extensions root

分成兩段不是為了介面好看，是因為 §12.1 那句「安裝前完整顯示原始碼，不可略過」
**只有在審閱的是真的會被裝進去的那份 bytes 時才成立**。做成一次呼叫的話，前端
就得為了「先看再裝」把同一個檔案上傳兩次，而第二次上傳的可以是別的檔案——那份
審閱畫面就變成一個儀式。暫存目錄讓兩段看的是同一份東西。

**順序是先 venv 再搬進去**。`ensure_interpreter()` 會去下載依賴，那是這條路上
唯一真的會失敗的一步（網路、`uv` 沒裝、版本解不開），而它只吃 `requirements`
與 id，不在乎檔案放在哪。先搬再建 venv 的話，失敗留下的是一個裝在那裡、拉出來
卻跑不動的包；先建再搬，失敗留下的是什麼都沒有。
"""

from __future__ import annotations

import io
import re
import shutil
import stat
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from blockyard.errors import ExtensionError
from blockyard.extensions.manifest import ExtensionSource, in_skipped_dir, read_pack
from blockyard.extensions.venv import ensure_interpreter

#: 壓縮檔本身的上限。一個積木包是幾個 `.py` 加一份 manifest，帶了 vendored
#: three.js 的面板包也就幾 MB——32MB 給的是很寬的餘裕，擋的是「有人把整個
#: node_modules 拖進來」與那個 request 在記憶體裡的樣子。
MAX_ZIP_BYTES = 32 * 1024 * 1024
#: 解開之後的總量上限。**這一條才是擋 zip bomb 的那一條**：42KB 的壓縮檔可以
#: 解出 4.5PB，而上面那條看到的永遠是 42KB。
MAX_TOTAL_BYTES = 128 * 1024 * 1024
#: 條目數上限。大小不是唯一的成本——一百萬個空檔案的總量是 0。
MAX_MEMBERS = 4000

#: macOS 的 Finder 對著資料夾按「壓縮」就會多出這兩樣東西。**跳過而不是拒絕**：
#: 這是這個專案的使用者最可能用來包一個積木包的動作，而為了兩個他看不見的檔案
#: 說「這個 zip 有問題」，等於要求他去學 `zip -x`。
_JUNK_PREFIXES = ("__MACOSX/",)
_JUNK_NAMES = (".DS_Store", "Thumbs.db")

#: staging token 的形狀。**一定要驗**——它會被接成一個路徑，而
#: `../../etc` 是一個看起來很無辜的字串。
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{16,64}$")


@dataclass(frozen=True)
class Staged:
    """解開了、讀得進來、還沒裝的一個包。"""

    token: str
    dir: Path
    source: ExtensionSource


def stage(data: bytes, staging_root: Path, *, token: str) -> Staged:
    """把上傳的 bytes 解成一個暫存的積木包目錄。

    讀不進來就丟 `ExtensionError`，而且**暫存目錄會被清掉**——失敗留下的東西
    沒有人會再來收。
    """
    if len(data) > MAX_ZIP_BYTES:
        raise ExtensionError(
            f"這個檔案有 {len(data) // 1024 // 1024}MB，"
            f"超過 {MAX_ZIP_BYTES // 1024 // 1024}MB 的上限"
        )
    dest = staged_dir(staging_root, token)
    dest.mkdir(parents=True)
    try:
        _extract(data, dest)
        if not (dest / "manifest.yaml").is_file():
            raise ExtensionError(
                "這個 .zip 裡沒有 manifest.yaml。一個積木包的最外層要有 "
                "manifest.yaml 與 main.py（壓縮那個資料夾本身也可以）"
            )
        if not (dest / "main.py").is_file():
            raise ExtensionError("這個 .zip 裡沒有 main.py——積木包的程式碼住在那個檔案裡")
        source = read_pack(dest)
    except Exception:
        shutil.rmtree(dest, ignore_errors=True)
        raise
    return Staged(token=token, dir=dest, source=source)


async def install(staged: Staged, extensions_root: Path) -> ExtensionSource:
    """把暫存目錄變成一個裝好的積木包。回傳它在新家的樣子。"""
    ext_id = staged.source.id
    target = extensions_root / ext_id
    if target.exists():
        # §16 Q24 還沒答，所以這裡誠實地不做「更新／替換」。**它不是一個技術
        # 限制，是一個還沒有答案的問題**：換掉檔案很容易，難的是畫布上已經在
        # 用舊版那幾顆積木的下場。訊息要說得出這件事，不然使用者以為是壞了。
        raise ExtensionError(
            f"「{ext_id}」已經裝過了。更新／替換一個裝過的積木包還沒接上——"
            "它要先回答「畫布上正在用它的那幾顆積木怎麼辦」（§16 Q24）"
        )
    if not extensions_root.is_dir():
        raise ExtensionError(f"積木包資料夾不存在：{extensions_root}")

    # 失敗就整條停在這裡：什麼都還沒搬進去，使用者按下「安裝」之前與之後這台
    # 機器上的積木包一模一樣（見模組 docstring 的順序）。
    await ensure_interpreter(ext_id, staged.source.manifest.requirements)
    return _finish(staged, target)


def _finish(staged: Staged, target: Path) -> ExtensionSource:
    """搬進去，然後**用新家的路徑重讀一次**。

    重讀不是保險，是必要的：`ExtensionSource.dir` 指著暫存目錄，而那個目錄下
    一秒就不在了。回傳一份指著舊路徑的東西，症狀會是面板資源與封面 404。
    """
    shutil.move(str(staged.dir), str(target))
    return read_pack(target, expect_id=target.name)


def discard(staging_root: Path, token: str) -> None:
    """使用者按了取消，或審閱畫面被關掉。**本來就不在也算成功**——這個函式
    描述的是結束狀態。"""
    shutil.rmtree(staged_dir(staging_root, token), ignore_errors=True)


def purge_stale(staging_root: Path, *, max_age: float = 3600) -> None:
    """收掉沒有人按下一步的暫存目錄。

    使用者選了一個 `.zip`、看了一眼原始碼、覺得不對就關掉分頁——那條路上沒有
    任何一個請求告訴後端可以清了。掛在「下一次有人匯入」而不是一個排程上：
    這件事的成本與頻率都低到不值得一個活著的 task，而唯一會累積出東西的人正是
    那個又來匯入一次的人。
    """
    if not staging_root.is_dir():
        return
    deadline = time.time() - max_age
    for d in staging_root.iterdir():
        try:
            if d.is_dir() and d.stat().st_mtime < deadline:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            continue


def staged_dir(staging_root: Path, token: str) -> Path:
    if not _TOKEN.match(token):
        raise ExtensionError("這個匯入編號不合法")
    return staging_root / token


# --------------------------------------------------------------------------
# 解壓
# --------------------------------------------------------------------------


def _extract(data: bytes, dest: Path) -> None:
    """把 zip 解到 `dest`，**每一個條目都要自己走一遍規則**。

    `ZipFile.extractall()` 從 3.6 起會擋掉絕對路徑與 `..`，但它擋不住這裡在乎
    的另外三件事：**symlink**（zip 存得下，而一條指向 `~/.ssh` 的連結每個字元
    都合法——`panel_asset()` 那條路正是為了它才比對 `resolve()`）、**解壓後的
    總量**（zip bomb），以及**最外層那一層資料夾**（見 `_strip_root`）。三件都
    要在寫進磁碟之前決定，所以這裡先掃一遍名單再寫。
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ExtensionError("這不是一個 .zip 檔（或者它壞了）") from None

    with zf:
        members: list[tuple[zipfile.ZipInfo, str]] = []
        total = 0
        for info in zf.infolist():
            name = info.filename.replace("\\", "/")
            if _is_junk(name):
                continue
            if info.is_dir():
                continue
            mode = stat.S_IFMT(info.external_attr >> 16)
            if mode == stat.S_IFLNK:
                raise ExtensionError(f"這個 .zip 裡有一條符號連結（{name}），不收")
            if mode not in (0, stat.S_IFREG):
                raise ExtensionError(f"這個 .zip 裡有一個不是普通檔案的東西（{name}），不收")
            members.append((info, _safe_name(name)))
            total += info.file_size
            if total > MAX_TOTAL_BYTES:
                raise ExtensionError(
                    f"解開之後超過 {MAX_TOTAL_BYTES // 1024 // 1024}MB，不收"
                )
            if len(members) > MAX_MEMBERS:
                raise ExtensionError(f"這個 .zip 裡超過 {MAX_MEMBERS} 個檔案，不收")

        if not members:
            raise ExtensionError("這個 .zip 是空的")

        strip = _strip_root([rel for _, rel in members])
        budget = MAX_TOTAL_BYTES
        for info, rel in members:
            out = dest / (rel[len(strip):] if strip else rel)
            if not out.resolve().is_relative_to(dest.resolve()):
                raise ExtensionError(f"{rel} 會寫到積木包資料夾外面")
            out.parent.mkdir(parents=True, exist_ok=True)
            budget -= _copy(zf, info, out, budget)


def _copy(zf: zipfile.ZipFile, info: zipfile.ZipInfo, out: Path, budget: int) -> int:
    """一個檔案，邊寫邊數。

    上面那一輪加總信的是 zip header 自己報的 `file_size`，而**那是壓縮檔說的
    話**：一個手工做出來的 zip 可以報 1 個 byte 然後吐出 4GB。這裡數的是真的
    寫出去了多少。
    """
    written = 0
    with zf.open(info) as src, out.open("wb") as dst:
        while chunk := src.read(64 * 1024):
            written += len(chunk)
            if written > budget:
                raise ExtensionError(
                    f"解開之後超過 {MAX_TOTAL_BYTES // 1024 // 1024}MB，不收"
                )
            dst.write(chunk)
    return written


def _is_junk(name: str) -> bool:
    """**解壓那一步就丟掉**，而不是解完再忽略。

    `__pycache__` 與 `.venv` 進得來的話，審閱畫面上那份檔案清單就會有幾千列
    （而它們不屬於這個包），而且 `.venv` 裡的路徑是絕對的，換一台機器就錯。
    共用 `PACK_SKIP_DIRS` 的理由見那裡：掃描、審閱、解壓要看到同一個包。
    """
    return (
        name.startswith(_JUNK_PREFIXES)
        or PurePosixPath(name).name in _JUNK_NAMES
        or in_skipped_dir(name)
    )


def _safe_name(name: str) -> str:
    """把一個 zip 條目名變成一條乾淨的相對路徑，不合法就丟。

    **不做「清洗後放行」**：把 `../../x` 悄悄改成 `x` 會讓一個惡意的 zip 裝進來
    之後看起來完全正常，而它本來是要告訴我們一件事的。
    """
    parts = [p for p in name.split("/") if p not in ("", ".")]
    if not parts:
        raise ExtensionError(f"這個 .zip 裡有一個怪路徑：{name}")
    if name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        raise ExtensionError(f"這個 .zip 裡有絕對路徑（{name}），不收")
    if ".." in parts:
        raise ExtensionError(f"這個 .zip 裡有一個往外跑的路徑（{name}），不收")
    return "/".join(parts)


def _strip_root(names: list[str]) -> str:
    """對著資料夾按右鍵壓縮，得到的是 `mypack/manifest.yaml` 不是 `manifest.yaml`。

    **這是使用者最可能做的那個動作**，所以它要成立。規則刻意窄：全部條目共用
    同一個最外層資料夾，而且最外層**沒有** manifest.yaml——後者擋的是一個真的
    把面板放在 `ui/` 之外還帶了一個同名子資料夾的包。回傳要砍掉的字首（含斜線），
    沒有就回空字串。
    """
    if any("/" not in n for n in names):
        return ""
    roots = {n.split("/", 1)[0] for n in names}
    if len(roots) != 1:
        return ""
    return roots.pop() + "/"


__all__ = [
    "MAX_MEMBERS",
    "MAX_TOTAL_BYTES",
    "MAX_ZIP_BYTES",
    "Staged",
    "discard",
    "install",
    "purge_stale",
    "stage",
    "staged_dir",
]

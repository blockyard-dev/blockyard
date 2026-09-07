"""跟著 wheel 來的那幾個包，怎麼進到使用者的擴充功能目錄（`docs/extension-design.md` §2）。

**兩個目錄，兩件事**：

* `BUNDLED_ROOT`（`blockyard/_bundled/`）是**出貨的來源**。它跟著 wheel 走，
  所以 `pip install` 之後它在 site-packages 底下——一個使用者不該寫、也不該
  從那裡刪東西的地方。
* `default_extensions_root()`（`~/.blockyard/extensions/`）是**積木包的家**。
  掃描、安裝、解除安裝談的都是這裡。

官方那幾個包第一次啟動時從前者鋪到後者，之後它們就是普通的包——拔得掉、
更新得了，而「官方」只剩收據上的一個標記，不是一種東西。

**在這個 repo 裡改官方包不會生效**：跑起來讀的是家裡那份副本。要改就直接
指過去：`blockyard serve --extensions backend/blockyard/_bundled`。
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path, PurePosixPath

from blockyard.extensions import receipt
from blockyard.extensions.manifest import load_manifest, pack_files
from blockyard.home import blockyard_home

#: 出貨來源。`blockyard/extensions/bundled.py` → parents[1] = `blockyard/`
BUNDLED_ROOT = Path(__file__).resolve().parents[1] / "_bundled"


#: 出貨的目錄裡有、但不屬於這個包的東西。`tests/` 是這個 repo 的回歸網；
#: `__pycache__`／`.venv` 是開發時留下的（而 `.venv` 那一份還是幾百 MB）。
#:
#: **一份名單，兩個用途**：鋪過去的時候略過它們，比對「這是不是我們出貨的
#: 那一份」的時候也要略過——兩邊算的必須是同一組檔案，不然補發收據那條路
#: 永遠比對不成功。
_NOT_PACK_CONTENT = ("__pycache__", "tests", ".venv")

#: 官方包收據上的那一行。§2：**「官方」是一個來源，不是一種東西。**
_OFFICIAL = receipt.Origin(origin="official", label="隨 Blockyard 出貨")

#: 拔掉過的那幾個 id，一份 JSON 陣列，躺在擴充功能目錄的最上層。
#:
#: **這是這個系統裡唯一一份中央檔案，而它記的是一件資料夾記不了的事**：
#: 收據講的是「這個資料夾是誰搬進來的」，所以它跟著資料夾走——而「使用者
#: 拔掉了 `demo`」說的正是**那個資料夾不在了**，沒有地方可以掛。
#:
#: 沒有它，「只鋪不存在的」對「還沒鋪過」與「使用者拔掉了」看起來一模一樣，
#: 於是拔掉的官方包重啟一次就自己長回來（§8）。
TOMBSTONE_FILE = ".blockyard-uninstalled.json"


def _ignore(_dir: str, names: list[str]) -> set[str]:
    return {n for n in names if n in _NOT_PACK_CONTENT}


def _shipped(rel: str) -> bool:
    return not any(part in _NOT_PACK_CONTENT for part in PurePosixPath(rel).parts)


def default_extensions_root() -> Path:
    """積木包的家。

    函式而不是模組層的常數：`blockyard_home()` 讀 `BLOCKYARD_HOME`，而環境變數
    在 import 的那一刻可能還沒設好（測試就是這樣改它的）。
    """
    return blockyard_home() / "extensions"


def seed_bundled(root: Path) -> list[str]:
    """把出貨的包鋪過去，回鋪了哪幾個。

    **只鋪不存在的。** 已經在那裡的一律不碰——使用者可能改過它、也可能已經
    把它更新到比出貨那份新的版本，而「開機時默默覆蓋磁碟上的東西」正是 §2
    的「沒有收據的不碰」在保護的事。

    **拔掉的也不長回來**，而那需要的不只是這一條：一個被解除安裝掉的包，它的
    資料夾就是不存在的，所以「只鋪不存在的」看它跟看一台全新的機器一模一樣。
    分辨兩者的是墓碑（`TOMBSTONE_FILE`），由解除安裝那一步立起來。
    """
    if not BUNDLED_ROOT.is_dir():
        return []
    root.mkdir(parents=True, exist_ok=True)
    gone = tombstoned(root)
    seeded = []
    for src in sorted(BUNDLED_ROOT.iterdir()):
        if not src.is_dir() or not (src / "manifest.yaml").is_file():
            continue
        target = root / src.name
        if target.exists() or src.name in gone:
            continue
        shutil.copytree(src, target, ignore=_ignore)
        # 開一張 `origin: "official"` 的收據（§2）。**「官方」是一個來源，不是
        # 一種東西**：有了它，`demo` 跟一個從 `.zip` 裝進來的包走完全相同的路
        # ——拔得掉、更新得了——而「官方」只剩卡片上的一個標記。
        receipt.write(target, _OFFICIAL, version=_version(target))
        seeded.append(src.name)
    return seeded


def backfill_official(root: Path) -> list[str]:
    """補發收據給**在收據存在之前就裝好的**官方包，回補了哪幾個。

    這條路只為了不做資料遷移而存在：這幾個目錄是舊版本的我們鋪過去的，而它們
    沒有收據——沒有收據的意思是「使用者自己放的，不碰」（見 `receipt.py`），
    所以不補的話它們從此拔不掉。

    **判準是「跟出貨那一份逐位元組相同」，不是「id 對得上」。** 後者會把一個
    使用者手寫的、剛好也叫 `demo` 的包判成我們的，然後給它一張讓我們可以刪掉
    它的收據——而那正是核心規則在擋的那件事。逐位元組比對貴一點，但它問的是
    真正該問的問題：**這是不是我們放的那一份。**
    """
    if not BUNDLED_ROOT.is_dir() or not root.is_dir():
        return []
    filled = []
    for src in sorted(BUNDLED_ROOT.iterdir()):
        target = root / src.name
        if not target.is_dir() or receipt.read(target) is not None:
            continue
        if not _is_pristine(target, src):
            continue
        receipt.write(target, _OFFICIAL, version=_version(target))
        filled.append(src.name)
    return filled


def tombstoned(root: Path) -> set[str]:
    """使用者拔掉過的那幾個 id。讀不出來就當作空的。

    讀壞掉的墓碑往「鋪」那一邊倒，而收據讀壞了是往「不碰」那一邊倒——兩者
    相反是對的：那裡弄錯會刪掉使用者的東西，這裡弄錯只是一個官方包又出現在
    工具箱的目錄上，而他可以再拔一次。
    """
    try:
        data = json.loads((root / TOMBSTONE_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    if not isinstance(data, list):
        return set()
    return {x for x in data if isinstance(x, str)}


def tombstone(root: Path, ext_id: str) -> None:
    """立一張墓碑：**使用者拔掉了這個 id，不要再鋪回去。**

    對非官方的包立墓碑不會有任何效果（`seed_bundled` 只認 `_bundled/` 裡有的
    那幾個名字），但仍然一律立——判斷「這個 id 是不是官方的」要問出貨目錄，
    而讓解除安裝這條路依賴那個答案，等於同一件事有兩個地方說了算。
    """
    _write_tombstones(root, tombstoned(root) | {ext_id})


def forget_tombstone(root: Path, ext_id: str) -> None:
    """裝進來就把墓碑收掉。

    墓碑說的是「我現在不要這個 id」，而使用者剛剛親手裝了一個同名的包——那句
    話已經不成立了。不收的話，他之後再拔掉這一份，那張舊墓碑會讓一件早就結束
    的事繼續生效。
    """
    gone = tombstoned(root)
    if ext_id in gone:
        _write_tombstones(root, gone - {ext_id})


def _write_tombstones(root: Path, ids: set[str]) -> None:
    path = root / TOMBSTONE_FILE
    if not ids:
        # 空陣列與沒有這個檔案是同一件事，而後者不必解釋。
        path.unlink(missing_ok=True)
        return
    root.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(sorted(ids), ensure_ascii=False) + "\n", encoding="utf-8")


def _version(pack_dir: Path) -> str:
    """manifest 說的版本。讀不出來就空字串——收據不該因為 manifest 有問題而
    開不出來（那個包本來就會在 `scan()` 的 `problems` 裡說話）。"""
    try:
        return load_manifest(pack_dir / "manifest.yaml").version
    except Exception:
        return ""


def _is_pristine(target: Path, src: Path) -> bool:
    """`target` 是不是 `src` 原封不動的一份。

    比的是**檔案集合與內容**，不是 digest：`src` 那一側還帶著 `tests/`
    （`_NOT_PACK_CONTENT`），所以兩邊的 digest 天生就不會相等。
    """
    want = {
        p.relative_to(src).as_posix(): p
        for p in pack_files(src)
        if _shipped(p.relative_to(src).as_posix())
    }
    have = {p.relative_to(target).as_posix(): p for p in pack_files(target)}
    if want.keys() != have.keys():
        return False
    try:
        return all(want[rel].read_bytes() == have[rel].read_bytes() for rel in want)
    except OSError:
        return False


__all__ = [
    "BUNDLED_ROOT",
    "TOMBSTONE_FILE",
    "backfill_official",
    "default_extensions_root",
    "forget_tombstone",
    "seed_bundled",
    "tombstone",
    "tombstoned",
]

"""搬走一個包，而不是刪掉它（`docs/extension-design.md` §4、§5）。

    ~/.blockyard/trash/greet-20260904T165912Z/

**這個垃圾桶同時是三件事的答案**：更新失敗的退路、「更新完發現更糟」的退路，
以及**解除安裝的實作本身**——移除一個包就是把它搬進來，不是 `rm -rf` 一個
使用者可能還想要的目錄。

`shutil.move` 而不是 copy＋delete：同一顆磁碟上它是一次 rename，所以「搬到
一半斷電」留下的不會是兩份半個包。跨檔案系統時 `move` 會自己退化成複製，
那條路慢，但它仍然是原子的那一側先完成。

**垃圾桶跟著積木包的家走**（`extensions_root.parent / "trash"`），不是自己
去問 `blockyard_home()`。預設情況下兩者是同一個答案（家是
`~/.blockyard/extensions/`），而差別出現在另外兩種情形，兩種都是這樣才對：
測試指到 tmp 目錄時垃圾桶也在那裡（不會把東西丟進使用者真正的家），
`--extensions backend/blockyard/_bundled` 時垃圾桶落在 repo 裡而不是混進
使用者的資料。
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path


def root_for(extensions_root: Path) -> Path:
    """這個擴充功能目錄的垃圾桶在哪（見模組 docstring）。"""
    return extensions_root.parent / "trash"


@dataclass(frozen=True)
class Stashed:
    """垃圾桶裡的一份，以及它本來在哪。"""

    ext_id: str
    #: 垃圾桶裡那個目錄。
    dir: Path
    #: 它本來的位置。`restore()` 要用，UI 要說得出「從哪裡搬走的」。
    was: Path


def stash(pack_dir: Path, *, trash_root: Path) -> Stashed:
    """把一個包搬進垃圾桶，回它去了哪裡。"""
    trash_root.mkdir(parents=True, exist_ok=True)
    dest = _free_name(trash_root, pack_dir.name)
    shutil.move(str(pack_dir), str(dest))
    return Stashed(ext_id=pack_dir.name, dir=dest, was=pack_dir)


def restore(stashed: Stashed) -> None:
    """把它搬回去。**更新失敗時走的就是這條**（§4：任何一步失敗就搬回來）。

    搬回去之前先清掉原位置：走到這裡的唯一情形是「新的那一份搬到一半失敗」，
    而那個半成品正站在舊的包該回去的位子上。留著它等於讓退路自己失敗，而
    失敗的樣子會是「更新失敗了，然後那個包也不見了」——這個垃圾桶存在的理由
    正是不要有那一刻。
    """
    if stashed.was.exists():
        shutil.rmtree(stashed.was, ignore_errors=True)
    stashed.was.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(stashed.dir), str(stashed.was))


def _free_name(trash_root: Path, ext_id: str) -> Path:
    """`<id>-<時間>`，撞名就加一個號。

    同一秒裡解除安裝兩次同一個 id 是做得到的（更新就是「搬走再搬進來」，而
    一次沒成功的更新後面常常緊跟著第二次）。撞名時 `shutil.move` 會把新的那
    一份搬**進**舊的那個目錄裡，於是兩份東西疊在一起——而那正是垃圾桶不該
    發生的事。
    """
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    base = trash_root / f"{ext_id}-{stamp}"
    if not base.exists():
        return base
    for n in range(2, 100):
        candidate = trash_root / f"{ext_id}-{stamp}-{n}"
        if not candidate.exists():
            return candidate
    # 同一秒 100 次。走不到，但沉默地覆蓋是這個模組唯一不能做的事。
    raise OSError(f"{trash_root} 裡已經有太多同名的東西了")


__all__ = ["Stashed", "restore", "root_for", "stash"]

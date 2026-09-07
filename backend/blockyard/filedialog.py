"""原生的「另存新檔」／「選一個檔案」（`docs/project-storage-design.md` §9）。

**這是這條路上唯一一個需要新開後端能力的東西**，所以規則寫得比別處細。

原本的判斷是「不要路徑欄、走瀏覽器下載」，理由是「瀏覽器給不了路徑，所以那格
只能手打，而手打比對話框難用」——**那個理由在有 tkinter 之後就不成立了**：
它給的不是一格文字，是使用者每天在用的那個「另存新檔」。

## 四條規則

1. **一定走 subprocess，不在 uvicorn 的行程裡開 Tk。** Tk 要求主執行緒，而請求
   處理跑在事件迴圈或執行緒池上——macOS 上那會怪掉或直接爆掉。開一支
   `sys.executable -c "…"`，它印出路徑就結束。順帶：一個卡住或崩掉的對話框
   因此帶不走後端。
2. **只在後端跟瀏覽器是同一台機器時給**（那條檢查在 `api/files.py`，因為它問的
   是「這個請求從哪來」）。對話框開在**後端**那台的螢幕上；少了那條，症狀是
   一個沒有人在看的螢幕上開了一個視窗，而那個 HTTP 請求永遠不回來。
3. **要有逾時，取消要回得乾淨。** 使用者按取消 = 空字串 = 這件事沒發生，不是
   錯誤。逾時之後那個 subprocess 要被殺掉。
4. **tkinter 不在就退回瀏覽器下載。** 某些 Linux 發行版要另外裝 `python3-tk`。

## 一個會浪費半小時的細節

**原生對話框會開在瀏覽器視窗後面。** 使用者按了「瀏覽…」，畫面沒反應，因為
那個視窗在下面。所以子行程裡要 `-topmost`，macOS 上再用 `osascript` 把自己
activate 到最前面。這是「按了沒反應」這句 bug report 最常見的來源之一。

## 它是一條死路，而那沒關係

P4 的 Tauri 會換掉它。**這不是問題，因為它是三十行**——而換過去的時候，
`api/files.py` 那條「路徑只能來自後端自己開的對話框」的規則一個字都不用改：
變的只是誰開那個對話框。
"""

from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path

#: 使用者在那個對話框前面能待多久。五分鐘不是為了他挑檔案要那麼久，是為了
#: 「他按了瀏覽…然後去接了一通電話」不要變成一個失敗。
TIMEOUT_SECONDS = 300.0

_SCRIPT = r"""
import sys, os

try:
    import tkinter as tk
    from tkinter import filedialog
except Exception:
    sys.exit(2)

mode, title, initial_file, extension = sys.argv[1:5]

root = tk.Tk()
root.withdraw()
# 原生對話框預設會開在瀏覽器視窗後面，而那看起來就是「按了沒反應」。
root.attributes("-topmost", True)
if sys.platform == "darwin":
    try:
        # `-topmost` 在 macOS 上只保證它在自己那個 app 的最上層——真正要做的
        # 是把這支 python 行程本身 activate 起來。失敗就算了：最壞的情況是
        # 視窗在下面，而那正是不做這件事的現況。
        os.system(
            "/usr/bin/osascript -e 'tell application \"System Events\" to set "
            "frontmost of the first process whose unix id is %d to true' "
            ">/dev/null 2>&1" % os.getpid()
        )
    except Exception:
        pass
root.update()

if mode == "save":
    path = filedialog.asksaveasfilename(
        title=title, initialfile=initial_file, defaultextension=extension
    )
else:
    path = filedialog.askopenfilename(title=title)

# 取消回空字串。**那不是錯誤**，是「這件事沒發生」。
sys.stdout.write(path or "")
sys.stdout.flush()
"""


def available() -> bool:
    """這台機器開得出原生對話框嗎。

    問的是 `import tkinter` 找不找得到，而不是真的開一個——後者要一個螢幕，
    而這個答案在沒有人按下任何東西的時候就要給得出來（那顆「瀏覽…」畫不畫）。
    """
    return importlib.util.find_spec("tkinter") is not None


async def save(*, suggested: str, title: str = "匯出專案", extension: str = "") -> Path | None:
    """開一個「另存新檔」。回傳使用者選的路徑，取消或逾時回 `None`。"""
    return await _run("save", title=title, initial_file=suggested, extension=extension)


async def open_file(*, title: str = "選一個檔案") -> Path | None:
    """開一個「開啟檔案」。§16 Q25 的 `type: "path"` 用的是同一支東西——所以
    這三十行不是為匯出寫的，是為那個先蓋了一半。"""
    return await _run("open", title=title, initial_file="", extension="")


async def _run(mode: str, *, title: str, initial_file: str, extension: str) -> Path | None:
    if not available():
        return None
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        _SCRIPT,
        mode,
        title,
        initial_file,
        extension,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=TIMEOUT_SECONDS)
    except TimeoutError:
        # 逾時之後那個視窗還開著，而沒有人在等它了。不殺的話它會留在使用者的
        # 螢幕上，下一次按「瀏覽…」就會有兩個。
        proc.kill()
        await proc.wait()
        return None
    if proc.returncode != 0:
        return None
    path = stdout.decode("utf-8", "replace").strip()
    return Path(path) if path else None


__all__ = ["TIMEOUT_SECONDS", "available", "open_file", "save"]

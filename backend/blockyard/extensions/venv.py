"""每個積木包一份獨立 venv（D13、§7.6 第 3 步）。

`http` 的 `requirements: []` 沒有東西要裝，所以一路以來 `SubprocessHost`
的子 process 都跟 backend 用同一個直譯器（`sys.executable`）。
`requirements` 非空的包才是這裡真正要解決的問題：用 `uv venv` 建一個獨立
的環境，`uv pip install` 裝進去，子 process 用那個環境的直譯器啟動。

`ensure_interpreter()` 是熱路徑——`open_registry()` 在存檔驗證與每次執行都
會呼叫一次，所以已經裝好、`requirements` 沒變的情況下要能立刻回傳，不能
每次都重新 resolve 依賴。
"""

from __future__ import annotations

import asyncio
import hashlib
import shutil
import sys
import sysconfig
from pathlib import Path

from blockyard.errors import ExtensionError
from blockyard.home import blockyard_home

_LOCK_FILE = ".requirements.lock"

# 每個 ext_id 一支鎖，避免兩個併發呼叫同時搶著建同一個 venv。
_locks: dict[str, asyncio.Lock] = {}


def _venv_dir(ext_id: str) -> Path:
    return blockyard_home() / "venvs" / ext_id


def _interpreter_path(venv_dir: Path) -> Path:
    if sys.platform == "win32":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def _venv_site_packages(venv_dir: Path) -> Path:
    if sys.platform == "win32":
        return venv_dir / "Lib" / "site-packages"
    v = sys.version_info
    return venv_dir / "lib" / f"python{v.major}.{v.minor}" / "site-packages"


def _backend_link_line() -> str:
    """接 backend 那一行 `.pth` 的內容。

    **是 `import site; site.addsitedir(...)`，不是一條路徑。** 兩者的差別是一個
    真的踩到的 bug：

    * 一條**路徑**只會被加進 `sys.path`——Python **不會**去處理那個目錄裡的
      `.pth` 檔。
    * 而 `blockyard` 在開發時是 **editable 安裝**：backend 的 site-packages 裡
      只有一份 `_editable_impl_blockyard.pth`，指著 repo 的原始碼目錄。那份
      `.pth` 沒有被處理，`blockyard` 就不存在。

    症狀是子 process 一啟動就死：
    `No module named 'blockyard'` → 「積木包的子行程啟動失敗」，而那句話指錯
    了主詞（看起來像那個積木包壞了）。

    **它以前看起來是好的，靠的是一個巧合**：從 `backend/` 底下啟動後端時，子
    process 繼承那個 cwd，而 `python -m` 會把 cwd 放進 `sys.path`——於是
    `./blockyard` 剛好找得到。換一個目錄啟動（`blockyard serve` 從家目錄跑、
    `pip install` 之後、或任何一個不在 repo 裡的地方）就不成立了。**一個依賴
    cwd 的 import 不是一條路，是一次僥倖。**

    `addsitedir` 會把那個目錄當成真的 site 目錄處理，於是裡面的 `.pth`（含
    editable 那一份）都會生效。隔離沒有變：`addsitedir` 是**附加**在後面，
    積木包自己 venv 的 site-packages 仍然排在前面，`requirements` 裝的東西
    照樣優先。
    """
    return f"import site; site.addsitedir({sysconfig.get_paths()['purelib']!r})\n"


def _link_backend_site_packages(venv_dir: Path) -> None:
    """讓子 process 找得到 `blockyard` 本體與它的執行期相依（pydantic、pyyaml、
    httpx……）。

    `uv venv --python sys.executable` 建出來的是一個乾淨的環境——`sys.executable`
    本身通常也是一支 venv 的直譯器（backend 的 `.venv`），而 venv 疊 venv 時
    `--system-site-packages` 繼承的是最底層系統直譯器的 site-packages，不是
    backend 這一層，所以子 process 連自己要跑的入口模組
    `blockyard.extensions.subprocess_worker` 都 import 不到。用一份 `.pth` 檔把
    backend 的 site-packages 接進這個新 venv，而不是 `--system-site-packages`：
    積木包宣告的 `requirements` 照樣裝進這個 venv 自己的 site-packages，import
    時優先於接進來的那一份，隔離要的效果沒有少。

    **內容對不上就重寫**（見 `ensure_interpreter` 的呼叫點）：這一行會因為
    backend 換了位置、或因為修掉上面那個 bug 而改變，而一支已經建好的 venv
    不會自己知道。只在建立時寫的話，那幾支舊的從此壞著。
    """
    site_dir = _venv_site_packages(venv_dir)
    site_dir.mkdir(parents=True, exist_ok=True)
    link = site_dir / "_blockyard_backend.pth"
    want = _backend_link_line()
    # 讀一次再決定要不要寫：`ensure_interpreter` 是熱路徑（每次存檔與執行都會
    # 經過），而絕大多數時候這個檔案已經是對的。
    try:
        if link.read_text(encoding="utf-8") == want:
            return
    except OSError:
        pass
    link.write_text(want, encoding="utf-8")


def _digest(requirements: list[str]) -> str:
    return hashlib.sha256("\n".join(sorted(requirements)).encode()).hexdigest()


async def ensure_interpreter(ext_id: str, requirements: list[str]) -> Path:
    """回傳這個積木包該用哪個直譯器啟動子 process。

    `requirements` 是空的就直接回 `sys.executable`——不建 venv，不付任何
    額外成本，這是 `http` 現況。非空才真的動手。
    """
    if not requirements:
        return Path(sys.executable)

    lock = _locks.setdefault(ext_id, asyncio.Lock())
    async with lock:
        venv_dir = _venv_dir(ext_id)
        interpreter = _interpreter_path(venv_dir)
        lock_file = venv_dir / _LOCK_FILE
        digest = _digest(requirements)

        if interpreter.exists() and lock_file.exists() and lock_file.read_text().strip() == digest:
            # **接 backend 那一行也要在這條快路上檢查。** 它不是「建立時做一次」
            # 的事：backend 搬了位置、或那一行的寫法修過（見 `_backend_link_line`），
            # 已經建好的 venv 不會自己知道——而症狀是子行程啟動失敗，一句指錯
            # 主詞的話。讀一次字串的成本買一個會自己修好的狀態。
            _link_backend_site_packages(venv_dir)
            return interpreter

        if not (venv_dir / "pyvenv.cfg").exists():
            await _run(["uv", "venv", str(venv_dir), "--python", sys.executable], ext_id=ext_id)
        _link_backend_site_packages(venv_dir)

        await _run(
            ["uv", "pip", "install", "--python", str(interpreter), *requirements],
            ext_id=ext_id,
        )
        lock_file.write_text(digest)
        return interpreter


def discard_venv(ext_id: str) -> None:
    """把一個積木包的 venv 刪掉。解除安裝那條路上的最後一步。

    **這一份不進垃圾桶。** 垃圾桶存在的理由是「使用者可能還想要它」，而一支
    venv 裡沒有任何使用者寫的東西——它整份都是 `uv pip install` 從
    `requirements` 算出來的，而那份宣告躺在被搬進垃圾桶的那個包裡。留著它換來
    的是幾百 MB 的東西沒有人會再打開，而重建它只要一句 `ensure_interpreter`。

    刪不掉不算失敗（Windows 上那支直譯器可能還被某個子行程握著）：解除安裝
    真正的動作是把包搬走，而那一步已經成功了。剩下的是一個佔空間的資料夾，
    不是一個壞掉的狀態——下一次裝同一個 id 回來時 `ensure_interpreter` 會看
    `.requirements.lock` 決定要不要重裝，那條路對「一支舊的 venv 還在那裡」
    本來就是對的。
    """
    shutil.rmtree(_venv_dir(ext_id), ignore_errors=True)


async def _run(cmd: list[str], *, ext_id: str) -> None:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except FileNotFoundError:
        raise ExtensionError(
            f'積木包「{ext_id}」需要獨立安裝依賴，但這台機器沒裝 `uv`。'
            "去 https://docs.astral.sh/uv/ 安裝之後再試一次"
        ) from None

    out, _ = await proc.communicate()
    if proc.returncode != 0:
        raise ExtensionError(
            f'積木包「{ext_id}」的依賴安裝失敗（`{" ".join(cmd)}`）：\n'
            f"{out.decode(errors='replace').strip()[-2000:]}"
        )


__all__ = ["discard_venv", "ensure_interpreter"]

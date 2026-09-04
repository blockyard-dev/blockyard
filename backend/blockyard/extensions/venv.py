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


def _link_backend_site_packages(venv_dir: Path) -> None:
    """讓子 process 找得到 `blockyard` 本體與它的執行期相依（pydantic、pyyaml、
    httpx……）。

    `uv venv --python sys.executable` 建出來的是一個乾淨的環境——`sys.executable`
    本身通常也是一支 venv 的直譯器（backend 的 `.venv`），而 venv 疊 venv 時
    `--system-site-packages` 繼承的是最底層系統直譯器的 site-packages，不是
    backend 這一層，所以子 process 連自己要跑的入口模組
    `blockyard.extensions.subprocess_worker` 都 import 不到。用一份 `.pth` 檔把
    backend 的 site-packages 接進這個新 venv 的 sys.path，而不是
    `--system-site-packages`：積木包宣告的 `requirements` 照樣裝進這個 venv
    自己的 site-packages，import 時優先於 `.pth` 接進來的路徑，隔離要的效果
    沒有少。
    """
    site_dir = _venv_site_packages(venv_dir)
    site_dir.mkdir(parents=True, exist_ok=True)
    backend_site = sysconfig.get_paths()["purelib"]
    (site_dir / "_blockyard_backend.pth").write_text(backend_site + "\n")


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


__all__ = ["ensure_interpreter"]

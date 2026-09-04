"""這個 app 的資料目錄在哪（§14）。

`~/.blockyard`，可用 `BLOCKYARD_HOME` 覆寫。`storage/projects.py` 的 SQLite 落地與
`extensions/venv.py` 的積木包 venv 共用同一個定義——兩邊各自算一次，遲早會
在某個平台上算出不一樣的答案。
"""

from __future__ import annotations

import os
from pathlib import Path


def blockyard_home() -> Path:
    home = os.environ.get("BLOCKYARD_HOME")
    return Path(home) if home else Path.home() / ".blockyard"


__all__ = ["blockyard_home"]

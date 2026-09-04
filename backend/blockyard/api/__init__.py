"""HTTP 介面（§14、附錄 A）。

P0b 第 1 步只有 `/api/projects` 與 `/api/health`；第 2 步加 `/api/extensions`。
`/api/runs` 與 WebSocket 事件流是第 5 步。
"""

from __future__ import annotations

from typing import Any

__all__ = ["create_app"]


def __getattr__(name: str) -> Any:
    """延遲載入，讓 `import blockyard.api.validation` 不必先把 FastAPI 拖進來。"""
    if name == "create_app":
        from blockyard.api.app import create_app

        return create_app
    raise AttributeError(f"module 'blockyard.api' has no attribute {name!r}")

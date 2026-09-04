"""Blockyard runtime。

這裡只做一件事：讓積木包的 `main.py` 能寫 `from blockyard import block`（§7.3）。
用 PEP 562 的 module `__getattr__` 延遲載入，`import blockyard.errors` 之類的
內部匯入因此不會被拖去初始化 extension 子系統，也就不可能有環。
"""

from __future__ import annotations

from typing import Any

_SDK = frozenset(
    {"BlockError", "Ctx", "block", "dropdown", "on_load", "on_unload", "redact_url", "trigger"}
)

__all__ = sorted(_SDK)


def __getattr__(name: str) -> Any:
    if name in _SDK:
        from blockyard.extensions import sdk

        return getattr(sdk, name)
    raise AttributeError(f"module 'blockyard' has no attribute {name!r}")

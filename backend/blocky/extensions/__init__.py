"""擴充系統（§7）。

分層刻意如此：

    manifest.py   宣告（資料）。任何 process 都讀得到，是積木包的契約。
    boundary.py   §7.5 的進／出兩件事。所有 Host 實作共用同一份。
    host.py       ExtensionHost / HostChannel 兩個方向的介面。
    inprocess.py  in-process 實作。只給內建積木與題庫用（§7.6）。
    registry.py   Interpreter 面對的門面。
    sdk.py        積木包作者面對的 API。

`SubprocessHost`（§7.6、D13）進來時只新增一個檔案：它實作同一個 Protocol、
呼叫同一份 boundary，並跑 §17.4 的同一份合約測試。
"""

from __future__ import annotations

from pathlib import Path

from blocky.extensions.boundary import ensure_transportable, normalize_args, validate_return
from blocky.extensions.host import (
    CallContext,
    CallContexts,
    EventSinkChannel,
    ExtensionHost,
    HostChannel,
    TriggerHandle,
)
from blocky.extensions.inprocess import InProcessHost
from blocky.extensions.manifest import (
    BUILTIN_NAMESPACES,
    BUILTIN_ONLY_ARG_TYPES,
    ArgSpec,
    BlockSpec,
    ConfigSpec,
    ExtensionSource,
    Manifest,
    OptionSpec,
    discover,
    load_manifest,
    parse_manifest,
)
from blocky.extensions.registry import ExtensionRegistry, open_registry

# §14：積木包住在 repo 根目錄的 `extensions/`。
# backend/blocky/extensions/__init__.py → parents[3] = repo 根目錄
DEFAULT_EXTENSIONS_ROOT = Path(__file__).resolve().parents[3] / "extensions"

__all__ = [
    "BUILTIN_NAMESPACES",
    "BUILTIN_ONLY_ARG_TYPES",
    "DEFAULT_EXTENSIONS_ROOT",
    "ArgSpec",
    "BlockSpec",
    "CallContext",
    "CallContexts",
    "ConfigSpec",
    "EventSinkChannel",
    "ExtensionHost",
    "ExtensionRegistry",
    "ExtensionSource",
    "HostChannel",
    "InProcessHost",
    "Manifest",
    "OptionSpec",
    "TriggerHandle",
    "discover",
    "ensure_transportable",
    "load_manifest",
    "normalize_args",
    "open_registry",
    "parse_manifest",
    "validate_return",
]

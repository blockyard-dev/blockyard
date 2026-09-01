"""擴充系統（§7）。

分層刻意如此：

    manifest.py          宣告（資料）。任何 process 都讀得到，是積木包的契約。
    boundary.py           §7.5 的進／出兩件事。所有 Host 實作共用同一份。
    loading.py             載入 main.py 與 manifest ↔ 程式碼一致性檢查。
                            InProcessHost 與 subprocess_worker 共用。
    host.py                 ExtensionHost / HostChannel 兩個方向的介面。
    rpc.py                   雙向 JSON-RPC，parent／child 共用。
    inprocess.py             in-process 實作。只給內建積木與合約測試用。
    subprocess_host.py        SubprocessHost（§7.6、D13）：parent 端。
    subprocess_worker.py       同一顆的 child 端進入點。
    registry.py                 Interpreter 面對的門面。
    sdk.py                       積木包作者面對的 API。

`SubprocessHost` 實作跟 `InProcessHost` 一樣的 `ExtensionHost` Protocol、
呼叫同一份 `boundary.py`，並跑 §17.4 的同一份合約測試（`HOSTS` 參數化）。
"""

from __future__ import annotations

from pathlib import Path

from blocky.extensions.boundary import (
    ensure_transportable,
    normalize_args,
    validate_dropdown_options,
    validate_return,
)
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
from blocky.extensions.subprocess_host import SubprocessHost

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
    "SubprocessHost",
    "TriggerHandle",
    "discover",
    "ensure_transportable",
    "load_manifest",
    "normalize_args",
    "open_registry",
    "parse_manifest",
    "validate_dropdown_options",
    "validate_return",
]

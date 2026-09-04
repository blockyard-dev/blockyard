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
    install.py                    從電腦匯入一個 .zip（P3 第 2 步）。
    codescan.py                    §12.1 的靜態掃描。審閱畫面上那支手指。
    review.py                       安裝前那一頁攤開什麼。

`SubprocessHost` 實作跟 `InProcessHost` 一樣的 `ExtensionHost` Protocol、
呼叫同一份 `boundary.py`，並跑 §17.4 的同一份合約測試（`HOSTS` 參數化）。
"""

from __future__ import annotations

from pathlib import Path

from blockyard.extensions.boundary import (
    ensure_transportable,
    normalize_args,
    validate_dropdown_options,
    validate_return,
)
from blockyard.extensions.host import (
    CallContext,
    CallContexts,
    EventSinkChannel,
    ExtensionHost,
    HostChannel,
    TriggerHandle,
)
from blockyard.extensions.inprocess import InProcessHost
from blockyard.extensions.manifest import (
    BUILTIN_NAMESPACES,
    BUILTIN_ONLY_ARG_TYPES,
    COVER_TYPES,
    ArgSpec,
    BlockSpec,
    ConfigSpec,
    Discovery,
    ExtensionSource,
    Manifest,
    OptionSpec,
    PackProblem,
    PanelSpec,
    discover,
    load_manifest,
    panel_asset,
    parse_manifest,
    read_pack,
    scan,
)
from blockyard.extensions.registry import ExtensionRegistry, open_registry
from blockyard.extensions.subprocess_host import SubprocessHost

# §14：積木包住在 repo 根目錄的 `extensions/`。
# backend/blockyard/extensions/__init__.py → parents[3] = repo 根目錄
DEFAULT_EXTENSIONS_ROOT = Path(__file__).resolve().parents[3] / "extensions"

__all__ = [
    "BUILTIN_NAMESPACES",
    "BUILTIN_ONLY_ARG_TYPES",
    "COVER_TYPES",
    "DEFAULT_EXTENSIONS_ROOT",
    "ArgSpec",
    "BlockSpec",
    "CallContext",
    "CallContexts",
    "ConfigSpec",
    "Discovery",
    "EventSinkChannel",
    "ExtensionHost",
    "ExtensionRegistry",
    "ExtensionSource",
    "HostChannel",
    "InProcessHost",
    "Manifest",
    "PackProblem",
    "PanelSpec",
    "OptionSpec",
    "SubprocessHost",
    "TriggerHandle",
    "discover",
    "panel_asset",
    "ensure_transportable",
    "load_manifest",
    "normalize_args",
    "open_registry",
    "parse_manifest",
    "read_pack",
    "scan",
    "validate_dropdown_options",
    "validate_return",
]

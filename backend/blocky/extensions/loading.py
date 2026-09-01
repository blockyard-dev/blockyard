"""載入一個積木包 `main.py` 的共用邏輯（§7.5、§7.6）。

`InProcessHost` 與 subprocess worker 都要做同一件事：import `main.py`、
掃出 `@block`/`@dropdown`/`@trigger`/`@on_load`/`@on_unload`、驗
manifest 與程式碼對得起來。**只寫一次**——manifest ↔ main.py 漂移的檢查
與 `boundary.py` 是同一種東西，兩個 host 共用同一份程式碼，行為一致不是
靠自律。
"""

from __future__ import annotations

import importlib.util
import sys
from dataclasses import dataclass, field
from typing import Any, Callable

from blocky.errors import ExtensionError
from blocky.extensions.manifest import ExtensionSource, Manifest
from blocky.extensions.sdk import exports


@dataclass
class Exports:
    blocks: dict[str, Callable[..., Any]] = field(default_factory=dict)
    dropdowns: dict[str, Callable[..., Any]] = field(default_factory=dict)
    triggers: dict[str, Callable[..., Any]] = field(default_factory=dict)
    on_load: Callable[..., Any] | None = None
    on_unload: Callable[..., Any] | None = None


def import_extension_module(source: ExtensionSource) -> Any:
    """把 `main.py` 當一個獨立模組載進來（不進全域 `sys.modules` 的正式命名空間，
    用 `blocky_ext.<id>` 這個字首隔開，避免撞名）。"""
    path = source.entrypoint
    if not path.exists():
        raise ExtensionError(f"積木包「{source.id}」缺少 main.py")
    name = f"blocky_ext.{source.id}"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ExtensionError(f"無法載入 {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as e:
        sys.modules.pop(name, None)
        raise ExtensionError(f"載入 {path} 失敗：{type(e).__name__}: {e}") from e
    return module


def unimport_extension_module(module: Any) -> None:
    sys.modules.pop(module.__name__, None)


def collect_exports(module: Any) -> Exports:
    out = Exports()
    for kind, name, fn in exports(module):
        if kind == "block":
            out.blocks[str(name)] = fn
        elif kind == "dropdown":
            out.dropdowns[str(name)] = fn
        elif kind == "trigger":
            out.triggers[str(name)] = fn
        elif kind == "on_load":
            out.on_load = fn
        elif kind == "on_unload":
            out.on_unload = fn
    return out


def check_coverage(manifest: Manifest, exp: Exports) -> None:
    """manifest 與 main.py 必須完全對得起來。

    兩邊漂移的症狀是「工具箱裡有一顆按了沒反應的積木」，而那要等到使用者
    真的拖出來用才會發現。載入期就擋掉。
    """
    declared = {manifest.full_opcode(b.opcode) for b in manifest.blocks if b.type != "hat"}
    hats = {manifest.full_opcode(b.opcode) for b in manifest.blocks if b.type == "hat"}
    implemented = set(exp.blocks)

    if missing := declared - implemented:
        raise ExtensionError(
            f"積木包「{manifest.id}」的 manifest 宣告了 {'、'.join(sorted(missing))}，"
            "但 main.py 沒有對應的 @block"
        )
    if extra := implemented - declared:
        raise ExtensionError(
            f"積木包「{manifest.id}」的 main.py 實作了 {'、'.join(sorted(extra))}，"
            "但 manifest 沒有宣告——它不會出現在工具箱裡"
        )
    if missing_triggers := hats - set(exp.triggers):
        raise ExtensionError(
            f"積木包「{manifest.id}」的 hat 積木 {'、'.join(sorted(missing_triggers))} "
            "沒有對應的 @trigger"
        )
    for src in sorted(manifest.dropdown_sources()):
        if f"{manifest.id}.{src}" not in exp.dropdowns:
            raise ExtensionError(
                f"積木包「{manifest.id}」的參數指定了下拉來源 {src}，"
                "但 main.py 沒有對應的 @dropdown"
            )


def check_net_permission(manifest: Manifest) -> None:
    """`ctx.http` 的權限檢查（§7.4、§12.1）。

    **權限在這裡才真的守得住**：`permissions: [net]` 在安裝畫面上是一句話，
    而一句沒有人檢查的宣告，使用者讀了也不能信。沒宣告就拿不到 client——
    訊息指名是包的宣告漏了，不是使用者的流程錯了。兩個 host 共用同一段，
    不是各自重寫（子 process 那一側也要擋，見 `subprocess_worker.py`）。
    """
    if "net" not in manifest.permissions:
        raise ExtensionError(f'積木包「{manifest.name}」沒有宣告 net 權限，不能使用 ctx.http')


__all__ = [
    "Exports",
    "check_coverage",
    "check_net_permission",
    "collect_exports",
    "import_extension_module",
    "unimport_extension_module",
]

"""載入一個積木包 `main.py` 的共用邏輯（§7.5、§7.6）。

`InProcessHost` 與 subprocess worker 都要做同一件事：import `main.py`、
掃出 `@block`/`@dropdown`/`@trigger`/`@on_load`/`@on_unload`、驗
manifest 與程式碼對得起來。**只寫一次**——manifest ↔ main.py 漂移的檢查
與 `boundary.py` 是同一種東西，兩個 host 共用同一份程式碼，行為一致不是
靠自律。
"""

from __future__ import annotations

import importlib.util
import inspect
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from blockyard.errors import ExtensionError
from blockyard.extensions.manifest import ExtensionSource, Manifest
from blockyard.extensions.sdk import exports


@dataclass
class Exports:
    blocks: dict[str, Callable[..., Any]] = field(default_factory=dict)
    dropdowns: dict[str, Callable[..., Any]] = field(default_factory=dict)
    triggers: dict[str, Callable[..., Any]] = field(default_factory=dict)
    on_load: Callable[..., Any] | None = None
    on_unload: Callable[..., Any] | None = None


def import_extension_module(source: ExtensionSource) -> Any:
    """把 `main.py` 當一個獨立模組載進來（不進全域 `sys.modules` 的正式命名空間，
    用 `blockyard_ext.<id>` 這個字首隔開，避免撞名）。"""
    path = source.entrypoint
    if not path.exists():
        raise ExtensionError(f"積木包「{source.id}」缺少 main.py")
    name = f"blockyard_ext.{source.id}"
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
    depends = manifest.dropdown_depends()
    for src in sorted(manifest.dropdown_sources()):
        fn = exp.dropdowns.get(f"{manifest.id}.{src}")
        if fn is None:
            raise ExtensionError(
                f"積木包「{manifest.id}」的參數指定了下拉來源 {src}，"
                "但 main.py 沒有對應的 @dropdown"
            )
        _check_dropdown_signature(manifest, src, fn, depends.get(src, []))


def _check_dropdown_signature(
    manifest: Manifest, source: str, fn: Callable[..., Any], depends: list[str]
) -> None:
    """`depends` 宣告的每一格，`@dropdown` 函式都得收得下。

    manifest 說「這份選項取決於 server」，而 main.py 寫的是 `async def
    channels(ctx)`——host 呼叫時就是 `TypeError: got an unexpected keyword
    argument 'server'`，主詞指著積木包，發生的時機是**使用者點開那顆下拉的
    那一刻**。這是 manifest ↔ main.py 漂移的老形狀（同 `check_coverage`
    上面那幾條），所以擋在同一個地方。

    只檢查「收不收得下」，不檢查「有沒有多的」：多出來的參數如果有預設值，那
    是積木包自己的事。
    """
    if not depends:
        return
    params = inspect.signature(fn).parameters
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return
    if missing := [d for d in depends if d not in params]:
        raise ExtensionError(
            f"積木包「{manifest.id}」的下拉來源 {source} 宣告了 depends "
            f"{'、'.join(sorted(depends))}，但它的 @dropdown 函式收不下 "
            f"{'、'.join(missing)}"
        )


def trigger_error_text(opcode: str, pack_name: str, exc: BaseException) -> str:
    """trigger 的 generator 死掉時，寫給使用者看的那一句。

    **兩個 host 共用同一句**（同 `boundary.py` 的理由）：一條長連線在
    in-process 與 subprocess 底下用不同的說法失敗，等於同一個問題要查兩次。

    這句話必須存在，是因為 trigger 跟積木不一樣：積木的例外沿著呼叫堆疊回到
    按下執行的那個人身上，而 trigger 的 generator 跑在一個沒有人在等的 task
    裡——不主動說出來的話，症狀是**按了監聽、什麼都沒發生、也沒有任何錯誤**。
    """
    from blockyard.errors import BlockyardError

    if isinstance(exc, BlockyardError):
        return f"{pack_name} 的監聽停了：{exc}"
    return f"{pack_name} 的監聽因為一個未預期的錯誤停了：{type(exc).__name__}: {exc}"


__all__ = [
    "Exports",
    "check_coverage",
    "collect_exports",
    "import_extension_module",
    "unimport_extension_module",
]

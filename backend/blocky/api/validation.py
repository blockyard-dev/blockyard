"""PUT 專案時跑的載入期驗證（§15 P0b 第 1 步的驗收條件 3）。

**這一層不重寫任何驗證規則**，只是把 `ir.schema.load` 接到 HTTP 上。§4 的
結構驗證、§4.6 的 return 位置、§4.7 的 `${a+b}`、D20 的形狀檢查全都在那裡，
在 API 層再寫一份必然會漂移——那是本專案最不想要的一種 bug。

順序照抄 `conformance.py::run_case`：**先載積木包，再驗專案**。形狀驗證要
問得到積木包，才知道 `demo.echo` 是 reporter 還是 command（D20）。
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError as PydanticError

from blocky.cron import validate_blocks as validate_cron_blocks
from blocky.errors import BlockyError, ValidationError
from blocky.extensions import discover, open_registry, secret_store
from blocky.interpreter import builtins as _builtins  # noqa: F401  匯入即註冊
from blocky.interpreter.declarations import expression_fields
from blocky.interpreter.events import EventSink
from blocky.interpreter.registry import resolve_shape, resolve_terminal
from blocky.ir.schema import LoadedProject, load

if TYPE_CHECKING:
    from blocky.extensions.registry import ExtensionRegistry


async def open_project(
    data: Any,
    *,
    extensions_root: Path,
    sink: EventSink | None = None,
) -> tuple[LoadedProject, ExtensionRegistry | None]:
    """驗證並載入一份 IR，**積木包留在載入狀態**交給呼叫端。

    存檔（`validate_project`）與執行（`runs/manager.py`）需要的是同一件事的
    兩個切面：前者驗完就把積木包關掉，後者要讓它活到 Run 結束。分成兩個函式
    但共用這一份，是為了不讓「載入順序」出現第二份實作——順序照抄
    `conformance.py::run_case`：**先載積木包，再驗專案**，形狀驗證要問得到
    積木包才知道 `demo.echo` 是 reporter 還是 command（D20）。

    §13.3：專案宣告了但磁碟上沒有的積木包**不是**驗證錯誤——那些 opcode 保留
    為佔位符，執行期才以 `unknown_block` 呈現。所以這裡不檢查 `only` 是不是
    全部都載到了。

    失敗時保證積木包已經卸載：拋例外的路徑上呼叫端拿不到 registry，不在這裡
    收拾就沒有人收拾得了。
    """
    if not isinstance(data, dict):
        raise ValidationError("專案必須是一個 JSON 物件")

    declared = [
        e["id"] for e in (data.get("extensions") or []) if isinstance(e, dict) and "id" in e
    ]

    registry: ExtensionRegistry | None = None
    if declared:
        # 金鑰要在 open_registry() 之前就準備好：SubprocessHost.load() 的第一個
        # RPC 就帶著 config，太晚給就沒用（§12.1、D28）。
        sources = discover(extensions_root)
        declared_manifests = {k: sources[k].manifest for k in declared if k in sources}
        config = secret_store.resolve_config(declared_manifests)
        if sink is not None:
            # §12.2：這次 Run 用到的 secret 明文值進遮蔽名單，事件流從第一筆
            # 開始就擋得住——不能等 Run 跑到一半才補。
            sink.register_secrets(secret_store.secret_values(declared_manifests, config))
        try:
            registry = await open_registry(extensions_root, sink=sink, only=declared, config=config)
        except BlockyError as e:
            # 積木包自己壞掉（manifest 寫錯、main.py 匯入失敗）。這不是
            # 專案的錯，但專案在這個 runtime 上確實驗不完，得說清楚是誰壞的。
            raise ValidationError(f"載入積木包時失敗：{e}") from None

    try:
        loaded = load(
            data,
            strict_refs=True,
            shapes=resolve_shape(registry),
            expressions=expression_fields,
            terminals=resolve_terminal(registry),
        )
        # §9.1／§4.9：`when_cron` 的排程與時區在**存檔期**就解析。留到執行期的
        # 話，一顆設錯的 cron 可以安靜地不觸發好幾個月（同 §4.7b 的運算式）。
        # 跟真的排程走同一個 `cron.parse()`，所以「存檔時驗過的一定排得上」是
        # 結構上的事實，不是一句承諾。
        #
        # **排在 `load()` 之後**：結構錯誤比一顆設錯的 cron 更根本，而且那時
        # `blocks` 已經確定是一份格式正確的積木表。
        validate_cron_blocks(data.get("blocks") or {})
        return loaded, registry
    except PydanticError as e:
        if registry is not None:
            await registry.unload_all()
        raise ValidationError(_first_error(e)) from None
    except BaseException:
        if registry is not None:
            await registry.unload_all()
        raise


async def validate_project(data: Any, *, extensions_root: Path) -> LoadedProject:
    """驗證一份 IR。不通過就丟 `ValidationError`。積木包驗完就卸載。"""
    project, registry = await open_project(data, extensions_root=extensions_root)
    if registry is not None:
        await registry.unload_all()
    return project


def _first_error(e: PydanticError) -> str:
    """pydantic 的第一個錯誤，翻成「哪個欄位」。

    只取第一個：一份 IR 壞掉時 pydantic 常常吐十幾條同源的訊息，全部丟給前端
    只會讓真正的原因埋在噪音裡。
    """
    err = e.errors()[0]
    loc = ".".join(str(p) for p in err["loc"])
    msg = err["msg"].removeprefix("Value error, ")
    return f"{loc}：{msg}" if loc else msg


__all__ = ["open_project", "validate_project"]

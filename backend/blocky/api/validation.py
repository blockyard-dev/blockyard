"""PUT 專案時跑的載入期驗證（§15 P0b 第 1 步的驗收條件 3）。

**這一層不重寫任何驗證規則**，只是把 `ir.schema.load` 接到 HTTP 上。§4 的
結構驗證、§4.6 的 return 位置、§4.7 的 `${a+b}`、D20 的形狀檢查全都在那裡，
在 API 層再寫一份必然會漂移——那是本專案最不想要的一種 bug。

順序照抄 `conformance.py::run_case`：**先載積木包，再驗專案**。形狀驗證要
問得到積木包，才知道 `demo.echo` 是 reporter 還是 command（D20）。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import ValidationError as PydanticError

from blocky.errors import BlockyError, ValidationError
from blocky.extensions import open_registry
from blocky.interpreter import builtins as _builtins  # noqa: F401  匯入即註冊
from blocky.interpreter.registry import resolve_shape
from blocky.ir.schema import LoadedProject, load


async def validate_project(data: Any, *, extensions_root: Path) -> LoadedProject:
    """驗證一份 IR。不通過就丟 `ValidationError`。

    §13.3：專案宣告了但磁碟上沒有的積木包**不是**驗證錯誤——那些 opcode 保留
    為佔位符，執行期才以 `unknown_block` 呈現。所以這裡不檢查 `only` 是不是
    全部都載到了。
    """
    if not isinstance(data, dict):
        raise ValidationError("專案必須是一個 JSON 物件")

    declared = [
        e["id"] for e in (data.get("extensions") or []) if isinstance(e, dict) and "id" in e
    ]

    registry = None
    try:
        if declared:
            try:
                registry = await open_registry(extensions_root, only=declared)
            except BlockyError as e:
                # 積木包自己壞掉（manifest 寫錯、main.py 匯入失敗）。這不是
                # 專案的錯，但專案在這個 runtime 上確實驗不完，得說清楚是誰壞的。
                raise ValidationError(f"載入積木包時失敗：{e}") from None
        try:
            return load(data, strict_refs=True, shapes=resolve_shape(registry))
        except PydanticError as e:
            raise ValidationError(_first_error(e)) from None
    finally:
        if registry is not None:
            await registry.unload_all()


def _first_error(e: PydanticError) -> str:
    """pydantic 的第一個錯誤，翻成「哪個欄位」。

    只取第一個：一份 IR 壞掉時 pydantic 常常吐十幾條同源的訊息，全部丟給前端
    只會讓真正的原因埋在噪音裡。
    """
    err = e.errors()[0]
    loc = ".".join(str(p) for p in err["loc"])
    msg = err["msg"].removeprefix("Value error, ")
    return f"{loc}：{msg}" if loc else msg


__all__ = ["validate_project"]

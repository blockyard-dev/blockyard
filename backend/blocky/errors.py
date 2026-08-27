"""執行期與驗證期的錯誤型別。

設計依據 §5.6：`try_catch` 只捕捉「積木層級的錯誤」，也就是 BlockyError。
控制流訊號（ProcedureReturn / StopSignal）與 CancelledError 必須穿透，
因此它們繼承 BaseException 而非 Exception——這是 §4.6 明確點名、
「函式在 try 裡 return 就沒反應」那類極難查的 bug 的根源。
"""

from __future__ import annotations

from typing import Any


class BlockyError(Exception):
    """積木層級的錯誤。這是 `try_catch` 唯一會捕捉的類別。"""

    code = "error"

    def __init__(self, message: str, *, block_id: str | None = None, hint: str | None = None):
        super().__init__(message)
        self.message = message
        self.block_id = block_id
        self.hint = hint

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "type": type(self).__name__,
            "code": self.code,
            "message": self.message,
        }
        if self.block_id is not None:
            d["blockId"] = self.block_id
        if self.hint is not None:
            d["hint"] = self.hint
        return d

    def __str__(self) -> str:
        return f"{self.message}（{self.hint}）" if self.hint else self.message


class TypeCoercionError(BlockyError):
    """§4.3 型別轉換失敗。"""

    code = "type"


class BadIndexError(BlockyError):
    """§4.3 索引錯誤。0 有專用訊息。"""

    code = "index"


class KeyMissingError(BlockyError):
    """§4.3 object key 不存在。這是錯誤，不是 null。"""

    code = "key"


class UndefinedVariableError(BlockyError):
    """§4.5 讀取未建立的變數。附編輯距離建議。"""

    code = "undefined_variable"


class TemplateError(BlockyError):
    """§4.7 `${}` 插值錯誤。"""

    code = "template"


class RecursionLimitError(BlockyError):
    """§5.4 遞迴深度超過 200。"""

    code = "recursion_limit"


class UnknownBlockError(BlockyError):
    """§13.3 這個 runtime 不認得的積木。

    刻意是 BlockyError 而非 ValidationError：專案用到不認得的積木時，**保留
    為佔位符**而不報廢整個專案，所以它必然會走到執行期。既然會走到執行期，
    它就得像其他執行期錯誤一樣看得見——能被 `try_catch` 接住、能發出
    `block.error` 事件。
    """

    code = "unknown_block"


class ExtensionError(BlockyError):
    """§7.5 Host 邊界的正規化／驗證失敗。"""

    code = "extension"


class ValidationError(Exception):
    """存檔／載入期的驗證錯誤（§4.7 的 `${a+b}`、§4.6 的 return 位置）。

    不是 BlockyError——它根本不該進到執行期。
    """

    def __init__(self, message: str, *, block_id: str | None = None, path: str | None = None):
        super().__init__(message)
        self.message = message
        self.block_id = block_id
        self.path = path

    def __str__(self) -> str:
        loc = self.block_id or self.path
        return f"{self.message} [{loc}]" if loc else self.message


# --- 控制流訊號：必須穿透 try_catch（§4.6、§5.5、§5.6）---


class ControlSignal(BaseException):
    """所有控制流訊號的基底。繼承 BaseException 是刻意的。"""


class ProcedureReturn(ControlSignal):
    """§4.6 `return` 積木。unwind 邊界是 frame，不是整個 thread。"""

    def __init__(self, value: Any):
        super().__init__("procedure return")
        self.value = value


class StopSignal(ControlSignal):
    """§4.4 `control.stop`。"""

    def __init__(self, scope: str):
        super().__init__(f"stop {scope}")
        self.scope = scope  # "this_script" | "all"

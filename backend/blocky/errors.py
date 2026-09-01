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

    def __init__(
        self,
        message: str,
        *,
        block_id: str | None = None,
        hint: str | None = None,
        action: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.message = message
        self.block_id = block_id
        self.hint = hint
        # 前端可以**點下去**的補救動作（§6.1）。`hint` 是給人讀的一句話，這個
        # 是給 UI 讀的一個結構——「還沒設定金鑰」那句話的正確結局是一顆把你送
        # 到設定畫面、而且欄位已經填好的按鈕，不是要使用者自己去記變數名。
        #
        # **只有 host 產得出來**（`Ctx.require_secret`），積木包沒有手刻的路徑：
        # payload 裡的 extId／envVar 是從 manifest 讀的，不是包自己說的。前端
        # 另外只認白名單內的 `kind`。
        self.action = action

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
        if self.action is not None:
            d["action"] = self.action
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "BlockyError":
        """`to_dict()` 的反函式（§7.6：SubprocessHost 在 RPC 邊界重建例外）。

        用 `code` 查表選子類別，不是 `type`——`code` 是 §7.5 錯誤事件裡本來就
        對外承諾的欄位，`type` 只是除錯用的類別名。認不得的 `code` 退回基底
        `BlockyError`，這樣子 process 端就算跑了個 unknown 的 BlockyError
        子類別，parent 端也重建得出一個行為正確（雖然類別不精確）的例外。
        """
        target = _BY_CODE.get(d.get("code"), BlockyError)
        return target(
            d.get("message", ""),
            block_id=d.get("blockId"),
            hint=d.get("hint"),
            action=d.get("action"),
        )

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


class ParamOutOfScopeError(BlockyError):
    """§4.6 參數積木被拖到定義它的函式外面。

    刻意是 BlockyError 而非 ValidationError：它**會**走到執行期。載入期看不出
    來——一顆 `procedure.param` 可以合法地待在某個 `if` 的分支裡，而那條分支跑
    不跑得到是執行期的事。既然會走到執行期，它就得像其他執行期錯誤一樣看得見
    （能被 `try_catch` 接住、能發出 `block.error`）。
    """

    code = "param_out_of_scope"


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


class MissingSecretError(ExtensionError):
    """積木要用一把還沒設定的金鑰（§12.1、D28）。

    自成一個 `code` 而不是一句普通的 `ExtensionError`，是為了讓前端認得出
    「這一種失敗有一顆按鈕可以按」——訊息文字會因為包不同而不同，`code` 不會。
    值本身**不在**這條路上：payload 只有「哪個包的哪一把、對應哪個環境變數
    名」，這樣它才能安全地一路傳到瀏覽器。
    """

    code = "missing_secret"


_BY_CODE: dict[str, type[BlockyError]] = {
    cls.code: cls
    for cls in (
        TypeCoercionError,
        BadIndexError,
        KeyMissingError,
        UndefinedVariableError,
        ParamOutOfScopeError,
        TemplateError,
        RecursionLimitError,
        UnknownBlockError,
        ExtensionError,
        MissingSecretError,
    )
}


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

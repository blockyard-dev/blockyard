"""可重複參數群組的 IR 那一半（§16 Q19）。

宣告在 `extensions/manifest.py` 的 `RepeatSpec`；這裡是「一顆積木說它有幾份」
怎麼存、怎麼驗、怎麼讀。

## 份數存在 `mutation`，不動頂層形狀

`mutation: {"repeat": 2}`。那個欄位本來就是為了這種事存在的（`procedure.call`
在用），而且它是**唯一**一個「積木的形狀由自己的資料決定」的合法出口——放到
`fields` 的話，一顆積木的參數數量會由一個參數決定，那是一個讀不完的圈。

## 展開後的名字是 `<參數名>_<n>`，n 從 1 開始

基底那一份不編號，因為它本來就在 `args` 裡、而且是這顆積木沒有按過任何一次
`+` 時的樣子。所以編號從 1 開始不是選擇，是那件事的直接後果。

## 少一份不是「刪掉裡面的東西」

按 `−` 之後，那一份裡面的積木**留在原地成為孤兒 + 警告**，不靜默刪除——與
`reshape.ts` 對「積木包改了宣告」的處理同一條規則（§8.5）。這個檔案只管數字；
孤兒那一半在前端，因為只有畫布知道那些積木要放到哪裡去。
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from blocky.errors import ValidationError

if TYPE_CHECKING:
    from blocky.extensions.manifest import BlockSpec

#: `mutation` 裡放份數的 key。
REPEAT_KEY = "repeat"

#: 一顆積木的宣告從哪裡來。內建走 `interpreter.declarations`，積木包走 registry
#: ——這個模組不知道那個差別，也不該知道。
SpecResolver = Callable[[str], "BlockSpec | None"]


def count_of(mutation: dict[str, Any] | None, spec: BlockSpec | None) -> int:
    """這顆積木有幾份重複群組。**不驗證**，讀不出來就是 0。

    執行期用這個：一份存得進去的 IR 已經驗過（見 `validate_blocks`），而讀一個
    沒宣告 `repeat` 的積木的 `mutation.repeat` 應該安靜地是 0，不是拋錯——那顆
    積木根本沒有這個概念。
    """
    if spec is None or spec.repeat is None or not mutation:
        return 0
    raw = mutation.get(REPEAT_KEY)
    if not isinstance(raw, int) or isinstance(raw, bool) or raw < 0:
        return 0
    return min(raw, spec.repeat.max)


def validate_blocks(blocks: dict[str, Any], resolve: SpecResolver) -> None:
    """存檔期驗證（§16 Q19）。

    擋三件事，每一件的症狀都是「存得進去、但畫面或執行不對」：

    1. **沒宣告 `repeat` 的積木帶著 `mutation.repeat`**——多半是手寫 IR 或別的
       版本產生的。放行的話那個數字永遠不會有人讀，而使用者以為他設了什麼。
    2. **份數超出 `min` / `max`**。上限存在的理由見 `RepeatSpec`；下限是宣告說
       「這顆積木至少要有這麼多份」。
    3. **份數說有 n 份，孔卻少了**。這一條最要緊：少的那一格在執行期是「沒填」，
       而 `如果` 少了條件會安靜地走 false 那一邊——一個看不出來的錯。
    """
    if not isinstance(blocks, dict):
        return
    for bid, block in blocks.items():
        if not isinstance(block, dict):
            continue
        opcode = block.get("opcode")
        if not isinstance(opcode, str):
            continue
        mutation = block.get("mutation") or {}
        spec = resolve(opcode)
        declared = spec.repeat if spec is not None else None

        if declared is None:
            if isinstance(mutation, dict) and REPEAT_KEY in mutation:
                raise ValidationError(
                    f"{opcode} 沒有可重複的參數群組，但 IR 裡寫了 {REPEAT_KEY}",
                    block_id=bid,
                )
            continue

        raw = mutation.get(REPEAT_KEY, 0) if isinstance(mutation, dict) else 0
        if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
            raise ValidationError(
                f"{REPEAT_KEY} 必須是 0 或正整數，拿到 {raw!r}", block_id=bid
            )
        if raw < declared.min or raw > declared.max:
            raise ValidationError(
                f"{opcode} 的份數 {raw} 不在宣告的 {declared.min}～{declared.max} 之間",
                block_id=bid,
            )

        assert spec is not None
        inputs = block.get("inputs") or {}
        fields = block.get("fields") or {}
        for i in range(raw):
            for name, arg in declared.args.items():
                expanded = spec.repeat_arg_name(name, i)
                where = fields if arg.field else inputs
                if expanded not in where:
                    raise ValidationError(
                        f"{opcode} 說有 {raw} 份，但第 {i + 1} 份少了 {name}",
                        block_id=bid,
                        path=expanded,
                    )


__all__ = ["REPEAT_KEY", "SpecResolver", "count_of", "validate_blocks"]

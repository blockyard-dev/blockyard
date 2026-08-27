"""procedure 命名空間：可回傳值的自訂函式（§4.6、D8）。

Scratch 的自訂積木不能回傳值，使用者只能靠全域變數傳值——那正是它最痛的
地方。工作流本質是資料加工，不能回傳值的函式無法組合。

`return` 的 unwind 邊界是 **frame**，不是整個 thread（那是 control.stop 的
差別）。實作用 ProcedureReturn 例外，而它繼承 BaseException，所以
`try_catch` 的 `except BlockyError` 天然攔不到它。
"""

from __future__ import annotations

from typing import Any

from blocky.errors import ProcedureReturn, ValidationError
from blocky.interpreter.engine import Thread
from blocky.interpreter.registry import command, value
from blocky.ir.schema import Block


def _proc(t: Thread, b: Block) -> tuple[str, Any]:
    pid = (b.mutation or {}).get("proc")
    proc = t.interp.project.procedures.get(pid) if pid else None
    if proc is None:
        raise ValidationError(f"找不到函式定義 {pid}", block_id=t.interp._bid(b))
    return pid, proc


async def _invoke(t: Thread, b: Block) -> Any:
    pid, proc = _proc(t, b)
    bid = t.interp._bid(b)

    # §4.6：輸入孔一律由左而右、深度優先求值。參數順序即宣告順序。
    args: dict[str, Any] = {}
    for p in proc.params:
        args[p.name] = await t.value(b, p.id)

    t.scope.push_frame(pid, args, block_id=bid)
    try:
        await t.exec_stack(proc.body)
    except ProcedureReturn as r:
        return r.value          # frame 邊界攔截——這就是 unwind 的終點
    finally:
        t.scope.pop_frame()
    # 跑完 body 沒遇到 return → 回傳 null（§4.6）
    return None


@command("procedure.call")
async def _call_command(t: Thread, b: Block) -> None:
    """returns == null 的呼叫積木是 command 形狀。"""
    await _invoke(t, b)


@value("procedure.call")
async def _call_value(t: Thread, b: Block) -> Any:
    """有 returns 的呼叫積木是 reporter / boolean 形狀。

    它必然帶副作用（函式體可以發 HTTP、寫變數），所以求值順序是語意。
    """
    return await _invoke(t, b)


@command("procedure.return")
async def _return(t: Thread, b: Block) -> None:
    """cap block。巢狀在迴圈或 if 內同樣有效。"""
    raise ProcedureReturn(await t.value(b, "value"))

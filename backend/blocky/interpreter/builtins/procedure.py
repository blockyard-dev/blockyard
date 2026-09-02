"""procedure 命名空間：可回傳值的自訂函式（§4.6、D8）。

Scratch 的自訂積木不能回傳值，使用者只能靠全域變數傳值——那正是它最痛的
地方。工作流本質是資料加工，不能回傳值的函式無法組合。

`return` 的 unwind 邊界是 **frame**，不是整個 thread（那是 control.stop 的
差別）。實作用 ProcedureReturn 例外，而它繼承 BaseException，所以
`try_catch` 的 `except BlockyError` 天然攔不到它。
"""

from __future__ import annotations

from typing import Any

from blocky.errors import ParamOutOfScopeError, ProcedureReturn, ValidationError
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


@value("procedure.param")
async def _param(t: Thread, b: Block) -> Any:
    """定義帽子上拖出來的那顆參數（§4.6）。

    **只讀 frame，不落到變數**。`data.get` 走的是 §5.4 的完整解析順序（參數 →
    thread-local → 全域），所以一顆讀 `次數` 的 `取得` 在函式外面仍然可能讀到
    一個剛好同名的全域變數。參數積木不該有那個行為：它說的是「這次呼叫傳進來
    的值」，被拖到函式外面就是拖錯了，而**當場說出來**比默默讀到別人的變數好
    ——後者會變成一個「值對了一半」的 bug。

    參數以 **id** 記在 `mutation` 裡而不是把名字寫進 `fields`：改一次參數名不
    該讓函式體裡那幾顆積木失聯（`procedures[].params` 是名字的唯一來源）。
    """
    m = b.mutation or {}
    pid, proc = _proc(t, b)
    bid = t.interp._bid(b)

    param = next((p for p in proc.params if p.id == m.get("param")), None)
    if param is None:
        raise ValidationError(
            f"函式 {pid} 沒有這個參數 {m.get('param')}", block_id=bid
        )

    frame = t.scope.current_frame
    if frame is None or frame.proc_id != pid:
        raise ParamOutOfScopeError(
            f"參數「{param.name}」只能放在定義它的函式裡",
            block_id=bid,
            hint="這顆積木是從那個函式的定義積木上拖出來的，把它搬回函式體裡。",
        )
    return frame.params.get(param.name)


@command("procedure.set_local")
async def _set_local(t: Thread, b: Block) -> None:
    """`本次呼叫 [名稱] 為 (值)`（§16 Q6）。

    **寫進當前 frame，不是全域。** 這顆積木存在的全部理由是：`data.set` 寫的
    第 3 層是同一個 Run 的所有 thread 共用的，所以兩條腳本各呼叫一次同一個
    函式，函式體裡那個暫存變數就互相踩——與 D29 修掉的迴圈變數是同一個 bug，
    往上一層。遞迴同理，各層各自一份。

    **沒有配對的讀取積木。** §5.4 第 1 層就是 frame，既有的 `取得 (名稱)` 與
    `${名稱}` 本來就讀得到它。再發一顆是同一件事兩個入口。

    三條規則在存檔期擋（`blocky/bindings.py`）：只准放在函式體內、不可與參數
    同名、不可與 `設定` 撞名。三條都是「讀的與寫的不是同一個東西」——而畫面上
    那兩顆積木長得一模一樣。
    """
    name = t.field(b, "name")
    if not isinstance(name, str) or name == "":
        raise ValidationError("積木沒有填變數名稱", block_id=t.interp._bid(b))
    v = await t.value(b, "value")
    t.scope.set_local(name, v, block_id=t.interp._bid(b))
    # `var.set` 照發：變數面板看得到函式跑到一半的暫存值，那是它最有用的時候。
    t.interp.sink.emit("var.set", threadId=t.id, name=name, value=v)


@command("procedure.return")
async def _return(t: Thread, b: Block) -> None:
    """cap block。巢狀在迴圈或 if 內同樣有效。"""
    raise ProcedureReturn(await t.value(b, "value"))

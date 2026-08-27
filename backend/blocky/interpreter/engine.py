"""IR tree-walking 直譯器（§5）。

三條必須守住的語意，全部進 §17 題庫：

  §4.6  `return` 的 unwind 邊界是 **frame**，不是整個 thread；
        且 `try_catch` 不可捕捉它——所以 ProcedureReturn 繼承 BaseException。
  §4.6  輸入孔一律**由左而右、深度優先**求值。這是唯一無法從畫面上看出來、
        但會改變結果的語意（reporter 可以帶副作用）。
  §5.6  一個 thread 出錯，其餘 thread **繼續執行**。
"""

from __future__ import annotations

import asyncio
import itertools
import sys
import time
from typing import Any, Callable

from blocky.errors import (
    BlockyError,
    ControlSignal,
    ProcedureReturn,
    RecursionLimitError,
    StopSignal,
    ValidationError,
)
from blocky.interpreter.events import EventSink, clip_value
from blocky.interpreter.registry import COMMANDS, VALUES
from blocky.interpreter.scope import (
    MAX_FRAME_DEPTH,
    InMemoryPersistStore,
    PersistStore,
    RunScope,
    Scope,
    ThreadScope,
)
from blocky.ir import template as tpl
from blocky.ir.schema import Block, LoadedProject, TemplateInput
from blocky.ir.values import to_boolean, to_number, to_string

# §5.2：沒有 frame clock。每執行 N 顆積木讓出一次 event loop，
# 確保取消訊號與 WebSocket 能被處理——但迴圈仍以最快速度跑。
YIELD_EVERY_N_BLOCKS = 512

# 一層 Blocky frame 會吃掉大約這麼多層 Python frame（_invoke → exec_stack →
# _exec_block → handler → t.value → _eval_input → _eval_block → handler → …）。
# 沒有這個保險，Python 自己的遞迴上限（預設 1000）會先炸，而 RecursionError
# 不是 BlockyError——結果是使用者看不到 §5.4 設計的「超過 200 層」錯誤，
# thread 只是無聲死掉。這是題庫 procedure/recursion_limit 抓到的。
PYTHON_FRAMES_PER_BLOCKY_FRAME = 24
_REQUIRED_RECURSION_LIMIT = MAX_FRAME_DEPTH * PYTHON_FRAMES_PER_BLOCKY_FRAME + 1000


def _ensure_recursion_headroom() -> None:
    if sys.getrecursionlimit() < _REQUIRED_RECURSION_LIMIT:
        sys.setrecursionlimit(_REQUIRED_RECURSION_LIMIT)

_HAT_OPCODES = {
    "event.when_flag_clicked",
    "event.when_cron",
    "event.when_webhook",
    "procedure.definition",
}


class Thread:
    """一個 Script 的一次執行 = 一個 asyncio.Task（§5.1）。"""

    def __init__(self, interp: Interpreter, thread_id: str, script_id: str, scope: Scope):
        self.interp = interp
        self.id = thread_id
        self.script_id = script_id
        self.scope = scope
        self.status = "ok"

    # ---- 輸入孔求值 ----

    async def value(self, block: Block, name: str, *, default: Any = None) -> Any:
        """求一個輸入孔的值。缺孔時回 default。"""
        inp = block.inputs.get(name)
        if inp is None:
            return default
        return await self.interp._eval_input(self, block, name, inp)

    async def number(self, block: Block, name: str, *, default: Any = 0) -> Any:
        v = await self.value(block, name, default=default)
        return to_number(v, block_id=self.interp._bid(block))

    async def string(self, block: Block, name: str, *, default: str = "") -> str:
        v = await self.value(block, name, default=default)
        return to_string(v, block_id=self.interp._bid(block))

    async def boolean(self, block: Block, name: str, *, default: bool = False) -> bool:
        v = await self.value(block, name, default=default)
        return to_boolean(v)

    def stack(self, block: Block, name: str) -> str | None:
        """C 型積木的內部堆疊第一顆積木。"""
        inp = block.inputs.get(name)
        return getattr(inp, "id", None) if inp is not None else None

    def field(self, block: Block, name: str, default: Any = None) -> Any:
        return block.fields.get(name, default)

    # ---- 給 builtins 用的捷徑 ----

    async def exec_stack(self, first: str | None) -> None:
        await self.interp._exec_stack(self, first)

    def log(self, text: str, level: str = "info", block_id: str | None = None) -> None:
        self.interp.sink.emit("log", threadId=self.id, level=level, text=text, blockId=block_id)


class RunResult:
    def __init__(self, run_id: str, status: str, events: list[dict[str, Any]]):
        self.run_id = run_id
        self.status = status
        self.events = events


class Interpreter:
    def __init__(
        self,
        project: LoadedProject,
        *,
        sink: EventSink | None = None,
        persist: PersistStore | None = None,
        clock: Callable[[], float] | None = None,
        timezone: str = "UTC",
    ):
        self.project = project
        self.sink = sink or EventSink()
        self.persist = persist or InMemoryPersistStore()
        # 可注入時鐘：題庫需要可重現的 time.now（§17.1）。
        # 回傳 epoch 毫秒。
        self.clock = clock or (lambda: time.time() * 1000)
        self.timezone = timezone
        _ensure_recursion_headroom()
        # D12：全域層的生命週期 = 一次 Run。Interpreter 實例即一次 Run。
        self.run_scope = RunScope()
        self._ids = itertools.count(1)
        self._block_budget = YIELD_EVERY_N_BLOCKS
        self._stop_all = False
        # 反查表：Block 物件 → blockId。錯誤訊息與事件都要靠它定位，
        # 每次線性掃描會讓深迴圈變成 O(n²)。
        self._block_ids = {id(b): bid for bid, b in project.blocks.items()}

    # ---- 執行 ----

    async def run(
        self,
        *,
        trigger: str = "event.when_flag_clicked",
        payload: dict[str, Any] | None = None,
    ) -> RunResult:
        run_id = f"run_{next(self._ids)}"
        self.sink.emit("run.start", runId=run_id, ts=time.time())

        scripts = [
            s
            for s in self.project.scripts
            if s.enabled and self.project.block(s.top).opcode == trigger
        ]

        tasks = [
            asyncio.create_task(self._run_thread(s.id, s.top, payload or {}))
            for s in scripts
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        status = "ok"
        for r in results:
            if isinstance(r, BaseException):
                status = "error"
            elif r == "error":
                status = "error"
        if self._stop_all and status == "ok":
            status = "cancelled"

        self.sink.emit("run.end", runId=run_id, status=status, ts=time.time())
        return RunResult(run_id, status, self.sink.dicts())

    async def _run_thread(self, script_id: str, top_id: str, payload: dict[str, Any]) -> str:
        thread_id = f"t_{next(self._ids)}"
        hat = self.project.block(top_id)

        # hat 的 yields 綁成 thread-local（§5.4 第 2 層，唯讀）
        scope = Scope(self.run_scope, ThreadScope(payload), self.persist)
        thread = Thread(self, thread_id, script_id, scope)

        self.sink.emit("thread.start", threadId=thread_id, scriptId=script_id)
        status = "ok"
        try:
            await self._exec_stack(thread, hat.next)
        except StopSignal as sig:
            if sig.scope == "all":
                self._stop_all = True
            status = "cancelled" if sig.scope == "all" else "ok"
        except ProcedureReturn:
            # `return` 掛在 hat 底下已在載入期擋掉（§4.6），能到這裡代表 IR 壞了
            status = "error"
        except BlockyError as e:
            # §5.6：該 Thread 中止，其餘 Thread **繼續執行**
            self.sink.emit(
                "block.error", threadId=thread_id, blockId=e.block_id, error=e.to_dict()
            )
            status = "error"
        except RecursionError:
            # 保險絲：即使 headroom 估錯，使用者也該拿到看得懂的訊息而非
            # 一個從解譯器內部漏出來的 Python 例外。
            err = RecursionLimitError(
                f"函式呼叫層數超過上限 {MAX_FRAME_DEPTH}",
                hint="遞迴是不是沒有終止條件？",
            )
            self.sink.emit("block.error", threadId=thread_id, blockId=None, error=err.to_dict())
            status = "error"
        except asyncio.CancelledError:
            status = "cancelled"
            raise
        finally:
            self.sink.emit("thread.end", threadId=thread_id, status=status)
        return status

    # ---- 堆疊與單顆積木 ----

    async def _exec_stack(self, thread: Thread, first: str | None) -> None:
        for bid, block in self.project.iter_stack(first):
            await self._exec_block(thread, bid, block)

    async def _exec_block(self, thread: Thread, bid: str, block: Block) -> None:
        handler = COMMANDS.get(block.opcode)
        if handler is None:
            if block.opcode in VALUES:
                raise ValidationError(
                    f"{block.opcode} 是回報型積木，不能接在堆疊上", block_id=bid
                )
            raise ValidationError(f"未知的積木 {block.opcode}", block_id=bid)

        await self._tick()
        self.sink.emit("block.enter", threadId=thread.id, blockId=bid)
        started = time.perf_counter()
        try:
            await handler(thread, block)
        except BlockyError as e:
            if e.block_id is None:
                e.block_id = bid
            raise
        self.sink.emit(
            "block.exit",
            threadId=thread.id,
            blockId=bid,
            durationMs=(time.perf_counter() - started) * 1000,
        )

    async def _eval_block(self, thread: Thread, bid: str, block: Block) -> Any:
        handler = VALUES.get(block.opcode)
        if handler is None:
            if block.opcode in COMMANDS:
                raise ValidationError(
                    f"{block.opcode} 是指令型積木，不能插進輸入孔", block_id=bid
                )
            raise ValidationError(f"未知的積木 {block.opcode}", block_id=bid)

        await self._tick()
        self.sink.emit("block.enter", threadId=thread.id, blockId=bid)
        started = time.perf_counter()
        try:
            result = await handler(thread, block)
        except BlockyError as e:
            if e.block_id is None:
                e.block_id = bid
            raise
        clipped, truncated = clip_value(result)
        ev: dict[str, Any] = {
            "threadId": thread.id,
            "blockId": bid,
            "value": clipped,
            "durationMs": (time.perf_counter() - started) * 1000,
        }
        if truncated:
            ev["truncated"] = True
        self.sink.emit("block.exit", **ev)
        return result

    async def _eval_input(self, thread: Thread, block: Block, name: str, inp: Any) -> Any:
        kind = inp.kind
        if kind == "literal":
            return inp.value
        if kind == "block":
            return await self._eval_block(thread, inp.id, self.project.block(inp.id))
        if kind == "template":
            return self._eval_template(thread, block, name)
        raise ValidationError(f"輸入 {name} 是堆疊，不能當值用", block_id=self._bid(block))

    def _eval_template(self, thread: Thread, block: Block, name: str) -> Any:
        bid = self._bid(block)
        # §4.7：一律用**載入時重新解析**的 Template，不信任 IR 裡的 refs
        parsed = self.project.template(bid, name)
        return tpl.evaluate(
            parsed,
            lambda n: thread.scope.get(n, block_id=bid),
            block_id=bid,
        )

    # ---- 雜項 ----

    def _bid(self, block: Block) -> str | None:
        return self._block_ids.get(id(block))

    async def _tick(self) -> None:
        """§5.2：沒有 frame clock，但要定期讓出 event loop。"""
        self._block_budget -= 1
        if self._block_budget <= 0:
            self._block_budget = YIELD_EVERY_N_BLOCKS
            await asyncio.sleep(0)


__all__ = ["Interpreter", "RunResult", "Thread"]

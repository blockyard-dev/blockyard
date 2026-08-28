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
from typing import TYPE_CHECKING, Any, Callable

from blocky.errors import (
    BlockyError,
    ControlSignal,
    ExtensionError,
    ProcedureReturn,
    RecursionLimitError,
    StopSignal,
    UnknownBlockError,
    ValidationError,
)
from blocky.interpreter.events import EventSink, clip_value
from blocky.interpreter.registry import COMMANDS, HAT_OPCODES, VALUES
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

if TYPE_CHECKING:  # 只為型別。執行期沒有這條相依，extensions 才能反過來 import 本模組
    from blocky.extensions.registry import ExtensionRegistry

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
        extensions: ExtensionRegistry | None = None,
    ):
        self.project = project
        # §7.5：積木包一律經過 Host 介面 dispatch。None 代表這個 Run 只用內建積木。
        self.extensions = extensions
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
        self.run_id: str | None = None
        # threadId → task。外部停止（§5.5）與 §6.1 的 stop_thread 都靠它。
        self._threads: dict[str, asyncio.Task[str]] = {}
        # 反查表：Block 物件 → blockId。錯誤訊息與事件都要靠它定位，
        # 每次線性掃描會讓深迴圈變成 O(n²)。
        self._block_ids = {id(b): bid for bid, b in project.blocks.items()}

    # ---- 執行 ----

    async def run(
        self,
        *,
        run_id: str | None = None,
        trigger: str = "event.when_flag_clicked",
        payload: dict[str, Any] | None = None,
    ) -> RunResult:
        """跑一次。`run_id` 由呼叫端指定時（API 的 `/api/runs`）事件用它，
        這樣 WebSocket 的 `runId` 與 HTTP 回應是同一個字串——省掉一層對照表。
        """
        run_id = run_id or f"run_{next(self._ids)}"
        self.run_id = run_id
        self.sink.emit("run.start", runId=run_id, ts=time.time())

        scripts = [
            s
            for s in self.project.scripts
            if s.enabled and self.project.block(s.top).opcode == trigger
        ]

        # thread id 在**建立 task 之前**就決定，`_threads` 才能在 task 還沒被
        # 排到之前就回答「t_2 是哪一條」——§6.1 的 `stop_thread` 需要它。
        for s in scripts:
            tid = f"t_{next(self._ids)}"
            self._threads[tid] = asyncio.create_task(
                self._run_thread(tid, s.id, s.top, payload or {})
            )
        results = await asyncio.gather(*self._threads.values(), return_exceptions=True)

        status = "ok"
        for r in results:
            # 外部停止（§5.5）走的是 task.cancel()，gather 會把 CancelledError
            # 當成結果收回來。它不是「錯誤」——把它算成 error 會讓使用者按下
            # 停止之後看到一個紅色的 run.end。
            if isinstance(r, asyncio.CancelledError):
                status = "cancelled" if status == "ok" else status
            elif isinstance(r, BaseException) or r == "error":
                status = "error"
        if self._stop_all and status == "ok":
            status = "cancelled"

        self.sink.emit("run.end", runId=run_id, status=status, ts=time.time())
        return RunResult(run_id, status, self.sink.dicts())

    def request_stop(self, thread_id: str | None = None) -> bool:
        """**外部**停止（§5.5：使用者按下停止），不是 `control.stop` 積木。

        兩者的差別是誰決定的：`control.stop` 是腳本自己走到那顆積木，丟
        `StopSignal` 讓 `_run_thread` 依 §5.1 收尾；這裡是外面的人插手，只能
        cancel task。`_stop_all` 仍然要設，`run()` 才知道最後的 status 是
        `cancelled` 而不是 `ok`——一個被砍掉的 Run 不該回報成功。

        能立即中斷緊迴圈，靠的是 §5.2 每 512 顆積木一次的 `sleep(0)`：那是
        真正的暫停點，CancelledError 會在那裡丟進 coroutine。

        回傳有沒有東西被停到（`stop_thread` 拿不存在的 threadId 時是 False）。
        """
        if thread_id is not None:
            task = self._threads.get(thread_id)
            if task is None or task.done():
                return False
            task.cancel()
            return True

        self._stop_all = True
        stopped = False
        for task in self._threads.values():
            if not task.done():
                task.cancel()
                stopped = True
        return stopped

    async def _run_thread(
        self, thread_id: str, script_id: str, top_id: str, payload: dict[str, Any]
    ) -> str:
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
        handler = COMMANDS.get(block.opcode) or self._ext_handler(block.opcode, want_value=False)
        if handler is None:
            raise self._no_handler(bid, block, want_value=False)

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
        handler = VALUES.get(block.opcode) or self._ext_handler(block.opcode, want_value=True)
        if handler is None:
            raise self._no_handler(bid, block, want_value=True)

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

    # ---- opcode 解析 ----

    def _ext_handler(self, opcode: str, *, want_value: bool):
        if self.extensions is None:
            return None
        return self.extensions.handler(opcode, want_value=want_value)

    def _no_handler(self, bid: str, block: Block, *, want_value: bool) -> BaseException:
        """查不到 handler 時，說出**為什麼**查不到。

        四種原因的處置完全不同，混成一句「未知的積木」等於叫使用者自己猜：
        形狀放錯、hat 放錯位置、積木包沒安裝（§13.3）、真的不存在。
        """
        op = block.opcode
        shape = self.extensions.shape(op) if self.extensions is not None else None

        if op in HAT_OPCODES or shape == "hat":
            return ValidationError(f"{op} 是事件積木，只能放在腳本最上面", block_id=bid)
        if want_value and (op in COMMANDS or shape == "command"):
            return ValidationError(f"{op} 是指令型積木，不能插進輸入孔", block_id=bid)
        if not want_value and (op in VALUES or shape in ("reporter", "boolean")):
            return ValidationError(f"{op} 是回報型積木，不能接在堆疊上", block_id=bid)

        # §13.3：專案宣告用到某個包，但它沒裝／沒載入。積木在畫布上是佔位符，
        # 執行到它時要說得出「裝了就會好」，而不是「未知的積木」。
        ns = block.namespace
        if any(e.id == ns for e in self.project.extensions):
            return ExtensionError(
                f"這顆積木來自積木包「{ns}」，但它還沒安裝",
                block_id=bid,
                hint="安裝這個積木包後就能執行",
            )
        # 認不得的 opcode 同樣是佔位符（§13.3）：可能是更新版 runtime 存的專案。
        # 用 BlockyError 而非 ValidationError，Thread 才不會安靜地死掉。
        return UnknownBlockError(
            f"這個版本不認得積木 {op}",
            block_id=bid,
            hint="這份專案可能來自比較新的版本",
        )

    async def _tick(self) -> None:
        """§5.2：沒有 frame clock，但要定期讓出 event loop。"""
        self._block_budget -= 1
        if self._block_budget <= 0:
            self._block_budget = YIELD_EVERY_N_BLOCKS
            await asyncio.sleep(0)


__all__ = ["Interpreter", "RunResult", "Thread"]

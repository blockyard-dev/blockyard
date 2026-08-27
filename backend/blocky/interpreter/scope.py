"""變數作用域與生命週期（§5.4、D12）。

四層，由內而外：

    1. Procedure 參數  — 一次呼叫（frame），唯讀
    2. Thread-local    — 一個 Thread，唯讀（hat 的 yields、try_catch 的 error）
    3. 全域變數        — **一次 Run**，data.set 寫這裡
    4. 持久化儲存      — 永久，只能用 data.persist_* 存取

第 3 層的「一次 Run」是 D12 的核心：cron 會讓同一份專案被觸發成千上萬次，
若變數隱式跨 Run 存活，`count` 的值就取決於「後端上次重啟是什麼時候」——
那是不可推理的，而且無法寫進題庫。
"""

from __future__ import annotations

from typing import Any, Protocol

from blocky.errors import RecursionLimitError, UndefinedVariableError
from blocky.ir.template import suggest_name

# §5.4 遞迴深度上限
MAX_FRAME_DEPTH = 200


class PersistStore(Protocol):
    """第 4 層。真實後端是 SQLite，題庫用 InMemoryPersistStore。"""

    def get(self, key: str) -> Any: ...
    def has(self, key: str) -> bool: ...
    def set(self, key: str, value: Any) -> None: ...
    def delete(self, key: str) -> None: ...


class InMemoryPersistStore:
    def __init__(self, initial: dict[str, Any] | None = None) -> None:
        self._d: dict[str, Any] = dict(initial or {})

    def get(self, key: str) -> Any:
        return self._d[key]

    def has(self, key: str) -> bool:
        return key in self._d

    def set(self, key: str, value: Any) -> None:
        self._d[key] = value

    def delete(self, key: str) -> None:
        self._d.pop(key, None)

    def snapshot(self) -> dict[str, Any]:
        return dict(self._d)


class RunScope:
    """第 3 層：全域變數。生命週期 = 一次 Run（D12）。

    Run 開始時是空的，Run 結束時整個丟棄。並發寫入以 asyncio 單執行緒語意
    保證原子性——不會有 torn read。
    """

    def __init__(self) -> None:
        self.vars: dict[str, Any] = {}

    def has(self, name: str) -> bool:
        return name in self.vars

    def get(self, name: str) -> Any:
        return self.vars[name]

    def set(self, name: str, value: Any) -> None:
        self.vars[name] = value


class Frame:
    """第 1 層：procedure 參數。唯讀。"""

    __slots__ = ("params", "proc_id", "depth")

    def __init__(self, proc_id: str, params: dict[str, Any], depth: int) -> None:
        self.proc_id = proc_id
        self.params = params
        self.depth = depth


class ThreadScope:
    """第 2 層：thread-local。hat 的 yields 與 try_catch 綁定的 error，唯讀。

    try_catch 的 error 綁定是巢狀的，所以用一個堆疊而非單一 dict。
    """

    def __init__(self, yields: dict[str, Any] | None = None) -> None:
        self._layers: list[dict[str, Any]] = [dict(yields or {})]

    def push(self, values: dict[str, Any]) -> None:
        self._layers.append(dict(values))

    def pop(self) -> None:
        self._layers.pop()

    def has(self, name: str) -> bool:
        return any(name in layer for layer in reversed(self._layers))

    def get(self, name: str) -> Any:
        for layer in reversed(self._layers):
            if name in layer:
                return layer[name]
        raise KeyError(name)

    def names(self) -> list[str]:
        return sorted({n for layer in self._layers for n in layer})


class Scope:
    """把四層綁在一起，實作 §5.4 的名稱解析順序。"""

    def __init__(self, run: RunScope, thread: ThreadScope, persist: PersistStore) -> None:
        self.run = run
        self.thread = thread
        self.persist = persist
        self.frames: list[Frame] = []

    # ---- frame ----

    def push_frame(self, proc_id: str, params: dict[str, Any], *, block_id: str | None) -> Frame:
        depth = len(self.frames) + 1
        if depth > MAX_FRAME_DEPTH:
            raise RecursionLimitError(
                f"函式呼叫層數超過上限 {MAX_FRAME_DEPTH}",
                block_id=block_id,
                hint="遞迴是不是沒有終止條件？",
            )
        f = Frame(proc_id, params, depth)
        self.frames.append(f)
        return f

    def pop_frame(self) -> None:
        self.frames.pop()

    @property
    def current_frame(self) -> Frame | None:
        return self.frames[-1] if self.frames else None

    # ---- 名稱解析（§5.4：參數 → thread-local → 全域）----

    def get(self, name: str, *, block_id: str | None = None) -> Any:
        f = self.current_frame
        if f is not None and name in f.params:
            return f.params[name]
        if self.thread.has(name):
            return self.thread.get(name)
        if self.run.has(name):
            return self.run.get(name)

        # §4.5：讀取未建立的變數是**錯誤**，不回傳 null、不當作 0。
        # 靜默把打錯字的名稱當成新變數，正是這個設計最大的風險。
        raise UndefinedVariableError(
            f'未知變數 "{name}"',
            block_id=block_id,
            hint=suggest_name(name, self.known_names()),
        )

    def has(self, name: str) -> bool:
        f = self.current_frame
        return (
            (f is not None and name in f.params)
            or self.thread.has(name)
            or self.run.has(name)
        )

    def set(self, name: str, value: Any) -> None:
        """§5.4：`data.set` **一律寫入全域層**（前兩層唯讀）。"""
        self.run.set(name, value)

    def known_names(self) -> list[str]:
        names = set(self.run.vars) | set(self.thread.names())
        f = self.current_frame
        if f is not None:
            names |= set(f.params)
        return sorted(names)

    def shadows_param(self, name: str) -> bool:
        """編輯器要對此警告 shadowing（§5.4）。"""
        f = self.current_frame
        return f is not None and name in f.params

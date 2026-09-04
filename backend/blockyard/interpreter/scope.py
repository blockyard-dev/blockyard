"""變數作用域與生命週期（§5.4、D12）。

四層，由內而外：

    1. Procedure 參數  — 一次呼叫（frame），唯讀
    2. Thread-local    — **綁它那顆積木的一次執行**，唯讀（D29）
    3. 全域變數        — **一次 Run**，data.set 寫這裡
    4. 持久化儲存      — 永久，只能用 data.persist_* 存取

第 2 層的範圍是 D29：綁進來的名字只在**綁它那顆積木的 body** 裡看得見。hat 的
body 是整條腳本，所以 `yields` 仍然是整條 thread——「整條 thread」不是第二條
規則，是同一條規則套在 hat 上的結果。

第 3 層的「一次 Run」是 D12 的核心：cron 會讓同一份專案被觸發成千上萬次，
若變數隱式跨 Run 存活，`count` 的值就取決於「後端上次重啟是什麼時候」——
那是不可推理的，而且無法寫進題庫。
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Protocol

from blockyard.errors import RecursionLimitError, UndefinedVariableError
from blockyard.ir.template import suggest_name

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
    """第 1 層：procedure 參數。唯讀。

    `thread_base` 是 D29 的那半：**推 frame 時記下 thread-local 堆疊有多高**，
    比它矮的那幾層在這個 frame 裡看不見。少了它，push／pop 是動態作用域——
    從 catch 裡呼叫的函式看得見 `error`，而那個名字在函式的畫面上不存在。
    """

    __slots__ = ("params", "locals", "proc_id", "depth", "thread_base")

    def __init__(self, proc_id: str, params: dict[str, Any], depth: int, thread_base: int) -> None:
        self.proc_id = proc_id
        self.params = params
        # §16 Q6：`這次 [x] 為 ()` 在函式裡寫這裡。與 `params` 分開而不是合成一個
        # dict，因為 `procedure.param` 讀的必須**只有**參數——那顆膠囊說的是
        # 「這次呼叫傳進來的值」，讓它讀得到一個同名的暫存變數，膠囊就在函式體
        # 中段開始說謊。兩者撞名是存檔期錯誤，所以這裡不必決定誰贏。
        self.locals: dict[str, Any] = {}
        self.depth = depth
        self.thread_base = thread_base


class ThreadScope:
    """第 2 層：thread-local。綁定型積木建立的名字，唯讀（§5.4、D29）。

    綁定是巢狀的（迴圈裡的迴圈、catch 裡的 try_catch），所以是一個堆疊而非
    單一 dict。

    **layer 0 是 hat 的 `yields`，其餘每一層是一顆 C 型積木的一次執行。** 兩者
    的差別只有一個地方看得到：`floor`。函式體不在任何一顆 hat 底下，遮掉
    `yields` 等於讓函式讀不到任何 hat 欄位，所以 layer 0 永遠可見；C block 推
    的那幾層則被 frame 遮蔽（D29 第 2 條）。
    """

    #: layer 0 = hat 的 `yields`（永不遮蔽）；layer 1 = 這條腳本的 `這次` 變數。
    SCRIPT_LAYER = 1

    def __init__(self, yields: dict[str, Any] | None = None) -> None:
        # **兩層，不是一層。** layer 1 是「這條腳本這一次執行」的暫存變數
        # （§16 Q6 的 `這次` 放在 hat 底下時）。它與 layer 0 分開，是因為兩者
        # 對 frame 的態度相反：`yields` 穿得過函式呼叫（函式體不在任何 hat 底下，
        # 遮了等於讓函式讀不到任何 hat 欄位），而腳本的暫存變數**要**被遮——
        # 那個名字在函式的畫面上不存在，同 `error`（D29 第 2 條）。
        self._layers: list[dict[str, Any]] = [dict(yields or {}), {}]

    def push(self, values: dict[str, Any]) -> None:
        self._layers.append(dict(values))

    def pop(self) -> None:
        self._layers.pop()

    def assign(self, name: str, value: Any) -> None:
        """改寫**最內層**那一格。

        給迴圈變數用：一層撐完整個迴圈、每一輪覆寫，巢狀深度才等於畫面上的巢狀
        深度。這**不是**在放寬「第 2 層唯讀」——唯讀說的是畫布上沒有任何積木寫
        得到它（`data.set` 一律寫第 3 層），綁它的那顆積木自己當然寫得到。
        """
        self._layers[-1][name] = value

    def depth(self) -> int:
        """現在有幾層。`Scope.push_frame` 拿它當 `thread_base`。"""
        return len(self._layers)

    def _visible(self, floor: int):
        """從 `floor` 看得見的層，**由內而外**。layer 0 永遠在最後。"""
        for i in range(len(self._layers) - 1, max(floor, 1) - 1, -1):
            yield self._layers[i]
        yield self._layers[0]

    def has(self, name: str, *, floor: int = 0) -> bool:
        return any(name in layer for layer in self._visible(floor))

    def get(self, name: str, *, floor: int = 0) -> Any:
        for layer in self._visible(floor):
            if name in layer:
                return layer[name]
        raise KeyError(name)

    def names(self, *, floor: int = 0) -> list[str]:
        return sorted({n for layer in self._visible(floor) for n in layer})

    def has_script_local(self, name: str) -> bool:
        return name in self._layers[self.SCRIPT_LAYER]

    def set_script_local(self, name: str, value: Any) -> None:
        """寫「這條腳本這一次執行」那一層。迴圈與 catch 推的層在它上面，不影響。"""
        self._layers[self.SCRIPT_LAYER][name] = value

    def hidden_names(self, *, floor: int) -> set[str]:
        """被 frame 遮掉的那些名字（D29 第 2 條）。

        只給錯誤訊息用：「這個名字存在，但它是呼叫你的那個地方綁的」與「這個
        名字根本沒有人綁過」是兩件不同的事，而使用者要做的補救也不同。
        """
        return {n for layer in self._layers[1:max(floor, 1)] for n in layer}


#: name → 「綁它的那顆積木叫什麼」。由 `Interpreter` 從專案掃出來（D29 第 4 條：
#: 範圍外讀那個名字，訊息要**指名是哪顆積木綁的**）。
BinderLookup = Callable[[str], str | None]


class Scope:
    """把四層綁在一起，實作 §5.4 的名稱解析順序。"""

    def __init__(
        self,
        run: RunScope,
        thread: ThreadScope,
        persist: PersistStore,
        *,
        binder: BinderLookup | None = None,
    ) -> None:
        self.run = run
        self.thread = thread
        self.persist = persist
        self.frames: list[Frame] = []
        # 只影響錯誤訊息，不影響解析。給 None 就退回一般的「未知變數」。
        self.binder = binder

    # ---- frame ----

    @property
    def thread_floor(self) -> int:
        """現在看得見 thread-local 的哪幾層（D29 第 2 條）。"""
        f = self.current_frame
        return f.thread_base if f is not None else 0

    def push_frame(self, proc_id: str, params: dict[str, Any], *, block_id: str | None) -> Frame:
        depth = len(self.frames) + 1
        if depth > MAX_FRAME_DEPTH:
            raise RecursionLimitError(
                f"函式呼叫層數超過上限 {MAX_FRAME_DEPTH}",
                block_id=block_id,
                hint="遞迴是不是沒有終止條件？",
            )
        f = Frame(proc_id, params, depth, self.thread.depth())
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
        if f is not None:
            if name in f.params:
                return f.params[name]
            if name in f.locals:
                return f.locals[name]
        floor = self.thread_floor
        if self.thread.has(name, floor=floor):
            return self.thread.get(name, floor=floor)
        if self.run.has(name):
            return self.run.get(name)
        raise self._undefined(name, block_id=block_id, floor=floor)

    def _undefined(self, name: str, *, block_id: str | None, floor: int) -> UndefinedVariableError:
        """§4.5：讀取未建立的變數是**錯誤**，不回傳 null、不當作 0。

        D29 讓這句話多出第二種說法。「這個名字沒有人建立過」與「這個名字有人
        建立過，只是不在這裡看得見」對使用者是兩件完全不同的事：前者多半是打
        錯字（所以配編輯距離建議），後者是把積木放到了嘴巴外面，而一句
        `未知變數 "item"` 會讓人去找一個根本沒打錯的字。

        既有專案在迴圈後讀迴圈變數，會從「拿得到最後一項」變成錯誤——**這句話
        是這次改動唯一會被使用者看到的地方**，所以它必須指名是哪顆積木綁的。
        """
        label = self.binder(name) if self.binder is not None else None
        if label is None:
            return UndefinedVariableError(
                f'未知變數 "{name}"',
                block_id=block_id,
                hint=suggest_name(name, self.known_names()),
            )
        if name in self.thread.hidden_names(floor=floor):
            hint = "函式看不到呼叫它的地方綁的名字（§5.4）。要用它就用參數傳進來。"
        else:
            hint = "綁進來的名字只在那顆積木的嘴巴裡看得見。要在外面用，先用「設定」把值存起來。"
        return UndefinedVariableError(
            f"變數「{name}」只在{label}裡面有效",
            block_id=block_id,
            hint=hint,
        )

    def has(self, name: str) -> bool:
        f = self.current_frame
        return (
            (f is not None and (name in f.params or name in f.locals))
            or self.thread.has(name, floor=self.thread_floor)
            or self.run.has(name)
        )

    def set(self, name: str, value: Any) -> None:
        """§5.4：`data.set` **一律寫入全域層**。

        第 2 層唯讀（D29），第 1 層只有 `這次` 寫得到（Q6）——而那顆積木撞
        到這裡的名字是存檔期錯誤，所以這一行不必問「現在有沒有 frame」。
        """
        self.run.set(name, value)

    def change(self, name: str, value: Any) -> None:
        """`改變 [x] 增加 (n)`：**寫回它讀到的那一層**（§4.5、§16 Q6）。

        `data.set` 說的是「建立一個全域變數」，所以它一律寫第 3 層；`data.change`
        說的是「把既有的那個變大」——它先讀，而讀到哪一層，寫就該回哪一層。寫死
        第 3 層才是那個讀寫分家的 bug：`這次 [總和] 為 (0)` 之後
        `改變 [總和]` 會讀 frame、寫全域，於是那個累加**永遠加不上去**。

        **對既有專案是同一個行為。** 在這顆積木之前，第 1 層只有參數、第 2 層
        唯讀，而 `改變` 撞到那兩層都是存檔期錯誤——所以每一份存得進去的專案裡，
        `改變` 讀到的一定是第 3 層。這是純粹的加法。

        前兩層唯讀的那些（參數、迴圈變數、錯誤變數）走不到這裡：`bindings.py`
        在存檔期就擋掉了，理由是讀寫指到兩個不同的東西。
        """
        f = self.current_frame
        if f is not None:
            if name in f.locals:
                f.locals[name] = value
                return
            # frame 遮住了腳本那一層（D29），所以在函式裡不看它——`get` 也沒看。
        elif self.thread.has_script_local(name):
            self.thread.set_script_local(name, value)
            return
        self.run.set(name, value)

    def set_local(self, name: str, value: Any) -> None:
        """§16 Q6：`這次 [x] 為 ()` 寫進**最近的那一層 body**。

        在函式裡是那個 frame（遞迴各自一份），在 hat 底下是這條 thread 的腳本層
        （兩條腳本各自一份）。那不是兩條規則——D29 說的是「範圍 = 綁它那顆積木
        的 body」，而 hat 的 body 就是整條腳本。**thread 是最外面的那一個 frame**，
        這一行只是照著這句話寫。

        迴圈與 `如果` 推的層不算：它們不是一次「執行」，而且綁進迴圈體的話，那顆
        積木最常見的用法（迴圈外面宣告、迴圈裡累加）整個不能寫。
        """
        f = self.current_frame
        if f is not None:
            f.locals[name] = value
        else:
            self.thread.set_script_local(name, value)

    def known_names(self) -> list[str]:
        names = set(self.run.vars) | set(self.thread.names(floor=self.thread_floor))
        f = self.current_frame
        if f is not None:
            names |= set(f.params) | set(f.locals)
        return sorted(names)

    def shadows_param(self, name: str) -> bool:
        """編輯器要對此警告 shadowing（§5.4）。"""
        f = self.current_frame
        return f is not None and name in f.params

"""綁定的作用範圍（§5.4、D29）。

執行期的三條規則有題目守著（`tests/conformance/control/*`）。這裡跑的是題庫
到不了的那幾格：

  - **hat 的 `yields` 穿過函式呼叫**。題庫永遠用綠旗跑（`Case` 沒有
    trigger／payload），所以 layer 0 一定是空的——那條規則在題庫裡看不見。
  - **`設定 [參數名]`**：v0.23 的那一半，與 D29 是同一條規則的兩個對象。
  - **`try` 那一疊看不到 `error`**：一個放行的例子。誤報比漏報貴（§8.5），
    所以「不該擋的沒有被擋」要有題目。
  - **宣告本身**：`scope` 指到不是 stack 的那一格。
"""

from __future__ import annotations

from typing import Any

import pytest

from blocky.bindings import (
    binder_index,
    block_label,
    creates_global,
    validate_blocks,
    yields_of,
)
from blocky.errors import ValidationError, UndefinedVariableError
from blocky.extensions.manifest import BlockSpec
from blocky.interpreter import declarations
from blocky.interpreter.registry import resolve_spec
from blocky.interpreter.scope import (
    InMemoryPersistStore,
    RunScope,
    Scope,
    ThreadScope,
)

SPECS = resolve_spec(None)


def scope(yields: dict[str, Any] | None = None, **kw: Any) -> Scope:
    return Scope(RunScope(), ThreadScope(yields), InMemoryPersistStore(), **kw)


# --------------------------------------------------------------------------
# 解析：frame 遮蔽 C block 推的層，但不遮 layer 0
# --------------------------------------------------------------------------


def test_hat_yields_survive_a_call_but_a_catch_binding_does_not() -> None:
    """D29 第 2 條的兩半，一次講完。

    函式體本來就不在任何一顆 hat 底下，遮掉 `yields` 等於讓函式讀不到任何 hat
    欄位；而 `error` 是呼叫它的那個地方綁的，函式的畫面上沒有那個名字。
    """
    s = scope({"body": {"ok": True}})
    s.thread.push({"錯誤": "爆了"})

    assert s.get("錯誤") == "爆了"          # 還在 catch 裡
    s.push_frame("p", {}, block_id=None)
    assert s.get("body") == {"ok": True}     # layer 0 穿得過去
    with pytest.raises(UndefinedVariableError):
        s.get("錯誤")
    s.pop_frame()
    assert s.get("錯誤") == "爆了"          # 回到 catch，又看得見了


def test_a_binding_pushed_inside_the_frame_is_visible() -> None:
    """遮的是**比 frame 矮**的那幾層，不是「函式裡沒有第 2 層」。

    函式體裡的 `對每一項` 綁的名字當然要看得見——不然那顆積木在函式裡就不能用。
    """
    s = scope()
    s.push_frame("p", {}, block_id=None)
    s.thread.push({"x": 1})
    assert s.get("x") == 1


def test_known_names_does_not_leak_hidden_bindings() -> None:
    """「你是不是要 X？」不該建議一個在這裡根本讀不到的名字。"""
    s = scope()
    s.thread.push({"錯誤": "爆了"})
    s.push_frame("p", {"n": 1}, block_id=None)
    assert s.known_names() == ["n"]


def test_the_message_names_the_block_that_bound_it() -> None:
    """D29 第 4 條。這句話是這次改動唯一會被使用者看到的地方。"""
    s = scope(binder=lambda n: "那顆「對 ⋯ 的每一項 x」" if n == "x" else None)
    with pytest.raises(UndefinedVariableError) as e:
        s.get("x")
    assert e.value.message == "變數「x」只在那顆「對 ⋯ 的每一項 x」裡面有效"

    # 沒有人綁過的名字仍然是一般的打錯字，配編輯距離建議
    s.run.set("count", 1)
    with pytest.raises(UndefinedVariableError) as e2:
        s.get("conut")
    assert e2.value.message == '未知變數 "conut"'
    assert "count" in (e2.value.hint or "")


# --------------------------------------------------------------------------
# 宣告
# --------------------------------------------------------------------------


def test_scope_must_point_at_a_stack_on_the_same_block() -> None:
    """指錯的症狀是一個**永遠看不見的名字**，而那在畫面上長得跟打錯變數名一樣。"""
    with pytest.raises(ValueError, match="不存在的參數"):
        BlockSpec.model_validate({
            "opcode": "loop", "type": "command", "text": "跑 %(name)",
            "args": {"name": {"type": "variable", "binds": True, "scope": "nope"}},
        })
    with pytest.raises(ValueError, match="那不是 stack"):
        BlockSpec.model_validate({
            "opcode": "loop", "type": "command", "text": "跑 %(name) %(n)",
            "args": {
                "name": {"type": "variable", "binds": True, "scope": "n"},
                "n": {"type": "number"},
            },
        })
    with pytest.raises(ValueError, match="scope 只適用於 binds"):
        BlockSpec.model_validate({
            "opcode": "loop", "type": "command", "text": "跑 %(name)",
            "args": {
                "name": {"type": "variable", "scope": "body"},
                "body": {"type": "stack"},
            },
        })


def test_the_three_builtin_binders_are_declared_as_the_spec_says() -> None:
    """§5.4 說第 2 層有三個建立端；`data.set` 是第 3 層的那一個。

    這條守的是「宣告漂移」——少一個 `scope`，那顆積木綁的名字會安靜地變成全域
    變數，於是它在迴圈外面讀得到，而所有測試照樣綠。
    """
    assert declarations.block("control.for_each").args["name"].scope == "body"
    assert declarations.block("control.try_catch").args["error_name"].scope == "catch"
    assert declarations.block("data.set").args["name"].scope is None
    assert declarations.block("data.change").args["name"].writes is True


def test_block_label_fills_fields_and_leaves_holes() -> None:
    label = block_label(
        {"opcode": "control.for_each", "fields": {"name": "項目"}},
        declarations.block("control.for_each"),
    )
    assert label == "對 ⋯ 的每一項 項目"


# --------------------------------------------------------------------------
# 存檔期：設定 [唯讀的名字]
# --------------------------------------------------------------------------


def blocks(*items: dict[str, Any]) -> dict[str, Any]:
    """`(id, opcode, parent, fields, inputs)` 的縮寫。"""
    return {b.pop("id"): {"inputs": {}, "fields": {}, "next": None, **b} for b in items}


def loop_with(child: dict[str, Any]) -> dict[str, Any]:
    """一顆綁 `x` 的 `對每一項`，body 裡放一顆積木。"""
    return blocks(
        {"id": "loop", "opcode": "control.for_each", "parent": None,
         "fields": {"name": "x"}, "inputs": {"body": {"kind": "stack", "id": "inner"}}},
        {"id": "inner", "parent": "loop", **child},
    )


def test_setting_a_loop_variable_is_a_load_error() -> None:
    with pytest.raises(ValidationError, match="是那顆「對 ⋯ 的每一項 x」綁的名字"):
        validate_blocks(
            loop_with({"opcode": "data.set", "fields": {"name": "x"}}), {}, SPECS
        )


def test_changing_a_loop_variable_is_a_load_error() -> None:
    """`改變` 一起擋：它在這條規則裡是寫入端，讀第 2 層、寫第 3 層。"""
    with pytest.raises(ValidationError, match="唯讀"):
        validate_blocks(
            loop_with({"opcode": "data.change", "fields": {"name": "x"}}), {}, SPECS
        )


def test_adding_to_a_loop_variable_is_fine() -> None:
    """`把 (x) 加到 [清單]` 就地改那個清單、不呼叫 `scope.set`——擋它是誤報。"""
    validate_blocks(
        loop_with({"opcode": "data.list_add", "fields": {"name": "x"}}), {}, SPECS
    )


def test_setting_the_same_name_outside_the_loop_is_fine() -> None:
    """範圍外沒有歧義：那裡本來就只有一個全域變數。"""
    b = loop_with({"opcode": "debug.log"})
    b["after"] = {
        "opcode": "data.set", "parent": "loop", "fields": {"name": "x"},
        "inputs": {}, "next": None,
    }
    b["loop"]["next"] = "after"
    validate_blocks(b, {}, SPECS)


def test_the_try_stack_does_not_see_the_error_binding() -> None:
    """兩張嘴巴，只有 `catch` 那張綁得到 `error`——`try` 跑的時候還沒有錯誤。"""
    common = {
        "id": "tc", "opcode": "control.try_catch", "parent": None,
        "fields": {"error_name": "錯誤"},
    }
    ok = blocks(
        {**common, "inputs": {"try": {"kind": "stack", "id": "inner"},
                              "catch": {"kind": "stack", "id": "other"}}},
        {"id": "inner", "parent": "tc", "opcode": "data.set", "fields": {"name": "錯誤"}},
        {"id": "other", "parent": "tc", "opcode": "debug.log"},
    )
    validate_blocks(ok, {}, SPECS)

    bad = blocks(
        {**common, "inputs": {"catch": {"kind": "stack", "id": "inner"}}},
        {"id": "inner", "parent": "tc", "opcode": "data.set", "fields": {"name": "錯誤"}},
    )
    with pytest.raises(ValidationError, match="嘗試 ⋯ 出錯時把錯誤存進 錯誤"):
        validate_blocks(bad, {}, SPECS)


def test_setting_a_procedure_param_is_a_load_error() -> None:
    """v0.23 的那一半：`取得 (次數)` 讀 frame、`設定` 寫全域，而畫面上那兩顆
    積木長得一模一樣——它交出來的是一個「值對了一半」的結果。"""
    b = blocks(
        {"id": "def", "opcode": "procedure.definition", "parent": None,
         "fields": {"proc": "p1"}, "next": "body"},
        {"id": "body", "opcode": "data.set", "parent": "def", "fields": {"name": "次數"}},
    )
    procs = {"p1": {"name": "跳", "definitionBlock": "def",
                    "params": [{"id": "a1", "name": "次數", "type": "number"}]}}
    with pytest.raises(ValidationError, match="是函式「跳」的參數"):
        validate_blocks(b, procs, SPECS)

    # 函式外面的同名 `設定` 照常寫全域：那裡沒有 frame，也沒有歧義。
    outside = blocks(
        {"id": "s", "opcode": "data.set", "parent": None, "fields": {"name": "次數"}},
    )
    validate_blocks(outside, procs, SPECS)


def test_the_innermost_binder_wins() -> None:
    """一個 `設定 [x]` 同時在綁 `x` 的迴圈裡、又在有參數 `x` 的函式裡時，
    遮蔽它的是內層那顆——訊息要指那一顆，不然使用者會去改錯的地方。"""
    b = blocks(
        {"id": "def", "opcode": "procedure.definition", "parent": None,
         "fields": {"proc": "p1"}, "next": "loop"},
        {"id": "loop", "opcode": "control.for_each", "parent": "def",
         "fields": {"name": "x"}, "inputs": {"body": {"kind": "stack", "id": "inner"}}},
        {"id": "inner", "opcode": "data.set", "parent": "loop", "fields": {"name": "x"}},
    )
    procs = {"p1": {"name": "跳", "definitionBlock": "def",
                    "params": [{"id": "a1", "name": "x", "type": "number"}]}}
    with pytest.raises(ValidationError, match="對 ⋯ 的每一項 x"):
        validate_blocks(b, procs, SPECS)


def test_binder_index_only_collects_scoped_bindings() -> None:
    """`data.set` 建立的名字整個 Run 都看得見，所以它不該出現在這張表裡——
    出現的話，一個打錯字的全域變數會拿到一句「它只在那顆積木裡有效」。"""
    b = blocks(
        {"id": "loop", "opcode": "control.for_each", "parent": None,
         "fields": {"name": "x"}},
        {"id": "s", "opcode": "data.set", "parent": None, "fields": {"name": "總和"}},
    )
    assert binder_index(b, {}, SPECS) == {"x": "那顆「對 ⋯ 的每一項 x」"}


# --------------------------------------------------------------------------
# D32：hat 的 `yields` 由使用者命名
# --------------------------------------------------------------------------


def named_hat() -> BlockSpec:
    """一顆「收到訊息」帽子：`message` 那個 yield 的名字寫在積木上。"""
    return BlockSpec.model_validate({
        "opcode": "on_message",
        "type": "hat",
        "text": "當聊天室收到訊息 %(message)",
        "args": {"message": {"type": "variable", "binds": True, "default": "message"}},
        "yields": [{"name": "message", "type": "object"}],
    })


def with_hat(spec: BlockSpec) -> Any:
    """`SPECS` 再加上一顆積木包的 hat。"""
    return lambda opcode: spec if opcode == "chat.on_message" else SPECS(opcode)


def test_setting_the_name_a_hat_bound_is_a_load_error() -> None:
    """`設定 [訊息]` 在那顆帽子底下讀第 2 層、寫第 3 層——又一個「值對了一半」。

    要擋得住它，讀的必須是**那顆積木上填的名字**：宣告裡那個 `message` 只是
    預設值，而使用者早就把它改掉了。
    """
    resolve = with_hat(named_hat())
    b = blocks(
        {"id": "hat", "opcode": "chat.on_message", "parent": None,
         "fields": {"message": "訊息"}, "next": "s"},
        {"id": "s", "opcode": "data.set", "parent": "hat", "fields": {"name": "訊息"}},
    )
    with pytest.raises(ValidationError, match="當聊天室收到訊息 訊息"):
        validate_blocks(b, {}, resolve)

    # 反過來：宣告裡那個名字**沒有**被綁出來，所以 `設定 [message]` 在這顆帽子
    # 底下就是一顆普通的全域變數積木。擋它才是誤報。
    b["s"]["fields"]["name"] = "message"
    validate_blocks(b, {}, resolve)


def test_a_hat_binding_is_not_a_global_binder() -> None:
    """它與 `data.set` 在宣告上長得幾乎一樣（`binds`、沒有 `scope`），但綁的是
    第 2 層。算成第 3 層的話，**別的腳本**裡的 `${訊息}` 會靜靜地不再被標成
    未知變數——一個漏報，而且是在使用者最需要那句話的時候。"""
    assert creates_global(named_hat()) == []
    assert yields_of({"fields": {"message": "訊息"}}, named_hat()) == ["訊息"]
    # 沒有命名格的 hat 照宣告走（`demo.on_tick`、`when_cron` 那種）
    assert yields_of({}, declarations.block("event.when_webhook")) == [
        "body", "headers", "query"
    ]


async def test_two_hats_bind_the_same_message_to_their_own_names() -> None:
    """一條連線服務所有同 opcode 的腳本，所以改名發生在**綁的那一刻**。

    同一則訊息同時落進兩顆帽子，而那兩顆積木上寫的名字本來就可以不一樣——
    payload 在 trigger 那一側改名的話，第二顆就永遠拿不到值。
    """
    from blocky.interpreter import builtins as _builtins  # noqa: F401  匯入即註冊
    from blocky.interpreter.engine import Interpreter
    from blocky.interpreter.events import EventSink
    from blocky.ir.schema import load
    from blocky.testing import Tpl, blk, build

    spec = named_hat()

    class Pack:
        """`resolve_spec` / `resolve_shape` 只問這兩個問題。"""

        def lookup(self, opcode: str) -> Any:
            return ("chat", spec) if opcode == "chat.on_message" else None

        def shape(self, opcode: str) -> Any:
            return frozenset({"hat"}) if opcode == "chat.on_message" else None

    project = build(scripts=[
        [blk("chat.on_message", fields={"message": "訊息"}),
         blk("debug.log", text=Tpl("${訊息.content}"))],
        [blk("chat.on_message", fields={"message": "m"}),
         blk("debug.log", text=Tpl("${m.content}"))],
    ])
    sink = EventSink()
    interp = Interpreter(load(project, strict_refs=False), sink=sink, extensions=Pack())
    result = await interp.run(
        trigger="chat.on_message", payload={"message": {"content": "哈囉"}}
    )

    assert result.status == "ok"
    said = [e["text"] for e in sink.dicts() if e["op"] == "log"]
    assert said == ["哈囉", "哈囉"]


# --------------------------------------------------------------------------
# 腳本 id 必須唯一
# --------------------------------------------------------------------------


def test_two_scripts_cannot_share_an_id() -> None:
    """`thread.start` 的 `scriptId`、`_script_of()` 與前端的執行高亮都拿它當 key。

    兩條同 id 的腳本在畫面上**完全看不出來**——兩條都在、都跑得動，只是它們會
    宣稱自己是同一條。來源是複製一整條腳本（id 記在 Blockly 的 `data` 上，而
    `data` 跟著複製走），在一份真實專案裡撞到過。
    """
    from blocky.ir.schema import load

    data = {
        "blocks": {
            "a": {"opcode": "event.when_flag_clicked"},
            "b": {"opcode": "event.when_flag_clicked"},
        },
        "scripts": [{"id": "sc_1", "top": "a"}, {"id": "sc_1", "top": "b"}],
    }
    with pytest.raises(ValidationError, match="都是 sc_1"):
        load(data, strict_refs=False)

    data["scripts"][1]["id"] = "sc_2"  # type: ignore[index]
    load(data, strict_refs=False)

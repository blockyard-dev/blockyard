"""Host 邊界的合約測試（§17.4）。

> §7.5 的正規化與驗證。**同一份測試同時跑 InProcessHost 與 SubprocessHost**，
> 這是兩者行為一致的唯一保證。

所以這份檔案的每一題都必須只透過 `ExtensionHost` 的介面表達——不 import
任何 host 實作的內部、不假設 extension 跑在同一個 process。§7.6 的
SubprocessHost 進來時，只在 `HOSTS` 加一行。

題目跑的是 `extensions/demo`：純函式、不打網路，所以合約測試不會因為別人的
API 掛了而變紅。
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from blocky.errors import ExtensionError
from blocky.extensions import (
    DEFAULT_EXTENSIONS_ROOT,
    CallContexts,
    EventSinkChannel,
    ExtensionHost,
    InProcessHost,
    SubprocessHost,
    discover,
)
from blocky.interpreter.events import EventSink

# §7.6：一行就跑得起來——這就是那一行。
HOSTS = ["inprocess", "subprocess"]


class Harness:
    """把 host 與它的反向通道綁在一起，讓題目只跟介面打交道。"""

    def __init__(self, host: ExtensionHost, contexts: CallContexts, sink: EventSink) -> None:
        self.host = host
        self.contexts = contexts
        self.sink = sink

    async def call(self, opcode: str, **args: Any) -> Any:
        ctx = self.contexts.open("demo", thread_id="t_1", block_id="blk_1")
        try:
            return await self.host.call(opcode, args, ctx.token)
        finally:
            self.contexts.close(ctx.token)

    async def dropdown(self, ext_id: str, source: str) -> list[dict[str, Any]]:
        ctx = self.contexts.open(ext_id)
        try:
            return await self.host.dropdown(ext_id, source, ctx.token)
        finally:
            self.contexts.close(ctx.token)

    def logs(self) -> list[str]:
        return [e["text"] for e in self.sink.dicts() if e["op"] == "log"]


@pytest.fixture(params=HOSTS)
async def h(request: pytest.FixtureRequest):
    contexts = CallContexts()
    sink = EventSink()
    channel = EventSinkChannel(sink, contexts)
    sources = discover(DEFAULT_EXTENSIONS_ROOT)

    if request.param == "inprocess":
        host: ExtensionHost = InProcessHost(sources, channel, contexts)
    elif request.param == "subprocess":
        host = SubprocessHost(
            sources, channel, contexts, extensions_root=DEFAULT_EXTENSIONS_ROOT
        )
    else:
        raise AssertionError(f"未知的 host 實作 {request.param}")

    await host.load("demo")
    yield Harness(host, contexts, sink)
    await host.unload("demo")


# --------------------------------------------------------------------------
# 進：args 正規化（§7.5）
# --------------------------------------------------------------------------


async def test_json_arg_passes_structured_values_through(h: Harness) -> None:
    assert await h.call("demo.wrap", body={"a": 1}) == {"wrapped": {"a": 1}}
    assert await h.call("demo.wrap", body=[1, 2]) == {"wrapped": [1, 2]}


async def test_json_arg_parses_strings(h: Harness) -> None:
    assert await h.call("demo.wrap", body='{"a": 1}') == {"wrapped": {"a": 1}}


async def test_json_arg_rejects_invalid_text(h: Harness) -> None:
    with pytest.raises(ExtensionError, match="參數 body 收到的文字不是合法 JSON"):
        await h.call("demo.wrap", body="{oops")


async def test_json_arg_rejects_scalars(h: Harness) -> None:
    """`json` 的承諾是「main.py 永遠拿到 dict / list」，所以純量沒有例外。"""
    with pytest.raises(ExtensionError, match="需要物件或清單"):
        await h.call("demo.wrap", body="5")
    with pytest.raises(ExtensionError, match="需要物件或清單"):
        await h.call("demo.wrap", body=5)


async def test_number_arg_converts_per_spec(h: Harness) -> None:
    """number 是邊界上**唯一**會做轉換的型別（§4.3 的轉換表）。"""
    assert await h.call("demo.add", a="3", b=4) == 7
    assert await h.call("demo.add", a=True, b=0) == 1
    assert await h.call("demo.add", a=None, b=2) == 2


async def test_number_arg_rejects_non_numeric_text(h: Harness) -> None:
    with pytest.raises(ExtensionError, match="無法把文字"):
        await h.call("demo.add", a="三", b=1)


async def test_number_arg_enforces_declared_bounds(h: Harness) -> None:
    with pytest.raises(ExtensionError, match="參數 b 不能大於 100"):
        await h.call("demo.add", a=0, b=101)
    with pytest.raises(ExtensionError, match="參數 b 不能小於 0"):
        await h.call("demo.add", a=0, b=-1)


async def test_string_args_follow_the_conversion_table(h: Harness) -> None:
    """邊界套用的是 §4.3 那張表本身，不是第二套規則。

    積木包的參數孔與內建積木的參數孔對同一個值必須有同一種反應——畫面上兩者
    長得一模一樣，使用者沒有辦法知道哪顆會轉、哪顆不會。
    """
    assert await h.call("demo.echo", text=5) == "hi, 5"
    assert await h.call("demo.echo", text=None) == "hi, "
    assert await h.call("demo.echo", text=[1, 2]) == "hi, [1,2]"


async def test_boolean_args_use_the_falsy_set(h: Harness) -> None:
    assert await h.call("demo.is_even", n="4") is True


async def test_object_and_list_args_stay_strict(h: Harness) -> None:
    """§7.2：`object` / `list` 是嚴格宣告，要自動處理的參數應該宣告成 `json`。"""
    assert await h.call("demo.count_items", items=[1, 2, 3]) == 3
    with pytest.raises(ExtensionError, match="參數 items 需要清單，收到文字"):
        await h.call("demo.count_items", items="[1,2,3]")


async def test_missing_required_arg(h: Harness) -> None:
    with pytest.raises(ExtensionError, match="少了必填參數"):
        await h.call("demo.color_of")


async def test_default_fills_in_missing_arg(h: Harness) -> None:
    assert await h.call("demo.echo") == "hi, world"


async def test_unknown_arg_is_rejected(h: Harness) -> None:
    """manifest 沒宣告的參數送進來，代表兩邊漂移了——早點說。"""
    with pytest.raises(ExtensionError, match="沒有宣告的參數"):
        await h.call("demo.echo", text="x", nonsense=1)


# --------------------------------------------------------------------------
# 出：returns 驗證（§7.5）
# --------------------------------------------------------------------------


async def test_declared_return_type_is_enforced(h: Harness) -> None:
    with pytest.raises(ExtensionError, match="宣告回傳物件，實際回傳文字"):
        await h.call("demo.broken_returns")


async def test_return_error_names_the_extension(h: Harness) -> None:
    """訊息要指向積木包，因為使用者改不動它——這決定了他該去回報還是改流程。"""
    with pytest.raises(ExtensionError) as e:
        await h.call("demo.broken_returns")
    assert "demo.broken_returns" in str(e.value)
    assert "積木包的問題" in str(e.value)


async def test_command_must_not_return_a_value(h: Harness) -> None:
    assert await h.call("demo.announce", text="嗨") is None


async def test_return_must_be_json_serializable(h: Harness) -> None:
    """§7.5 的隱含約束，從第一天就強制——否則換 IPC 時才發現到處在傳 Python 物件。"""
    with pytest.raises(ExtensionError, match="不是可傳輸的值"):
        await h.call("demo.not_transportable")


async def test_extension_exception_is_wrapped(h: Harness) -> None:
    with pytest.raises(ExtensionError) as e:
        await h.call("demo.blow_up")
    assert "demo.blow_up" in str(e.value)


# --------------------------------------------------------------------------
# 反向通道與生命週期（§7.4）
# --------------------------------------------------------------------------


async def test_ctx_log_reaches_the_event_stream(h: Harness) -> None:
    await h.call("demo.echo", text="a")
    assert h.logs() == ["echo 第 1 次"]


async def test_ctx_state_survives_between_calls(h: Harness) -> None:
    """`on_load` 放進 ctx.state 的東西，後續每次呼叫都拿得到（§7.4）。"""
    await h.call("demo.echo", text="a")
    await h.call("demo.echo", text="b")
    assert h.logs() == ["echo 第 1 次", "echo 第 2 次"]


async def test_ctx_config_defaults_come_from_manifest(h: Harness) -> None:
    assert await h.call("demo.echo", text="x") == "hi, x"


async def test_dropdown_returns_label_value_pairs(h: Harness) -> None:
    options = await h.dropdown("demo", "list_fruits")
    assert {o["value"] for o in options} == {"apple", "banana", "grape"}
    assert all(isinstance(o["label"], str) for o in options)


async def test_dropdown_from_an_unloaded_package_is_rejected(h: Harness) -> None:
    with pytest.raises(ExtensionError, match="還沒載入"):
        await h.dropdown("nope", "whatever")


async def test_unknown_opcode_is_rejected(h: Harness) -> None:
    with pytest.raises(ExtensionError, match="沒有 demo.nope 這顆積木"):
        await h.call("demo.nope")


async def test_trigger_yields_reach_the_sink(h: Harness) -> None:
    """§7.3：trigger 是 async generator，每 yield 一次餵給 sink 一次。"""
    got: list[dict[str, Any]] = []

    async def sink(payload: dict[str, Any]) -> None:
        got.append(payload)

    handle = await h.host.start_trigger("demo.on_tick", sink)
    for _ in range(50):          # generator 每 yield 之間會讓出 event loop
        if len(got) == 3:
            break
        await asyncio.sleep(0)
    await handle.stop()
    assert got == [{"tick": 1}, {"tick": 2}, {"tick": 3}]

"""載入積木包時的 manifest ↔ main.py 一致性（§7.1、§7.3）。

manifest 是宣告、main.py 是實作，兩邊漂移的症狀是「工具箱裡有一顆按了沒反應
的積木」——而那要等到使用者真的拖出來用才會發現。所以載入期就對齊。
"""

from __future__ import annotations

import pytest

from blocky.errors import ExtensionError
from blocky.extensions import CallContexts, EventSinkChannel, InProcessHost, discover
from blocky.interpreter.events import EventSink

MANIFEST = """\
manifestVersion: 1
id: {id}
name: 測試包
version: 0.1.0
blocks:
{blocks}
"""

ONE_BLOCK = """\
  - opcode: go
    type: command
    text: "go"
"""


def write_pack(root, ext_id: str, *, blocks: str = ONE_BLOCK, main: str) -> None:
    d = root / ext_id
    d.mkdir()
    (d / "manifest.yaml").write_text(
        MANIFEST.format(id=ext_id, blocks=blocks), encoding="utf-8"
    )
    if main is not None:
        (d / "main.py").write_text(main, encoding="utf-8")


def make_host(root) -> InProcessHost:
    contexts = CallContexts()
    return InProcessHost(discover(root), EventSinkChannel(EventSink(), contexts), contexts)


async def test_declared_block_without_an_implementation(tmp_path) -> None:
    write_pack(tmp_path, "p1", main="")
    with pytest.raises(ExtensionError, match="manifest 宣告了 p1.go"):
        await make_host(tmp_path).load("p1")


async def test_implemented_block_without_a_declaration(tmp_path) -> None:
    """反向的漂移一樣要擋：它不會出現在工具箱裡，作者卻以為做完了。"""
    write_pack(
        tmp_path,
        "p2",
        main=(
            "from blocky import block\n"
            "@block('p2.go')\n"
            "async def go(ctx): pass\n"
            "@block('p2.ghost')\n"
            "async def ghost(ctx): pass\n"
        ),
    )
    with pytest.raises(ExtensionError, match="manifest 沒有宣告"):
        await make_host(tmp_path).load("p2")


async def test_hat_without_a_trigger(tmp_path) -> None:
    write_pack(
        tmp_path,
        "p3",
        blocks='  - opcode: on_thing\n    type: hat\n    text: "當..."\n',
        main="",
    )
    with pytest.raises(ExtensionError, match="沒有對應的 @trigger"):
        await make_host(tmp_path).load("p3")


async def test_dropdown_source_without_an_implementation(tmp_path) -> None:
    write_pack(
        tmp_path,
        "p4",
        blocks=(
            '  - opcode: go\n    type: command\n    text: "go %(x)"\n'
            "    args:\n      x: { type: dropdown, source: options }\n"
        ),
        main="from blocky import block\n@block('p4.go')\nasync def go(ctx, x): pass\n",
    )
    with pytest.raises(ExtensionError, match="沒有對應的 @dropdown"):
        await make_host(tmp_path).load("p4")


async def test_missing_entrypoint(tmp_path) -> None:
    d = tmp_path / "p5"
    d.mkdir()
    (d / "manifest.yaml").write_text(
        MANIFEST.format(id="p5", blocks=ONE_BLOCK), encoding="utf-8"
    )
    with pytest.raises(ExtensionError, match="缺少 main.py"):
        await make_host(tmp_path).load("p5")


async def test_import_error_names_the_file(tmp_path) -> None:
    write_pack(tmp_path, "p6", main="raise RuntimeError('壞了')\n")
    with pytest.raises(ExtensionError, match="main.py 失敗"):
        await make_host(tmp_path).load("p6")


async def test_on_load_and_on_unload_run(tmp_path) -> None:
    write_pack(
        tmp_path,
        "p7",
        main=(
            "from blocky import block, on_load, on_unload\n"
            "@on_load\n"
            "async def setup(ctx): ctx.state['n'] = 1\n"
            "@on_unload\n"
            "async def teardown(ctx): ctx.state['n'] = -1\n"
            "@block('p7.go')\n"
            "async def go(ctx): ctx.log(str(ctx.state['n']))\n"
        ),
    )
    contexts = CallContexts()
    sink = EventSink()
    host = InProcessHost(discover(tmp_path), EventSinkChannel(sink, contexts), contexts)
    await host.load("p7")
    ctx = contexts.open("p7")
    await host.call("p7.go", {}, ctx.token)
    await host.unload("p7")
    assert [e["text"] for e in sink.dicts() if e["op"] == "log"] == ["1"]


async def test_sync_implementations_are_allowed(tmp_path) -> None:
    """跨 process 之後 async 與同步沒有差別，現在也不該有。"""
    write_pack(
        tmp_path,
        "p8",
        blocks='  - opcode: go\n    type: reporter\n    returns: number\n    text: "go"\n',
        main="from blocky import block\n@block('p8.go')\ndef go(ctx): return 42\n",
    )
    contexts = CallContexts()
    host = InProcessHost(discover(tmp_path), EventSinkChannel(EventSink(), contexts), contexts)
    await host.load("p8")
    assert await host.call("p8.go", {}, contexts.open("p8").token) == 42

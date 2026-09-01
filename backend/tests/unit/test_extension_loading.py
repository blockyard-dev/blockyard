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
permissions: [{permissions}]
palette:
{blocks}
"""

ONE_BLOCK = """\
  - opcode: go
    type: command
    text: "go"
"""


def write_pack(
    root, ext_id: str, *, blocks: str = ONE_BLOCK, main: str, permissions: str = ""
) -> None:
    d = root / ext_id
    d.mkdir()
    (d / "manifest.yaml").write_text(
        MANIFEST.format(id=ext_id, blocks=blocks, permissions=permissions), encoding="utf-8"
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
        MANIFEST.format(id="p5", blocks=ONE_BLOCK, permissions=""), encoding="utf-8"
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


# ---- ctx.http（§7.4、§12.1）----

HTTP_BLOCK = '  - opcode: go\n    type: reporter\n    returns: number\n    text: "go"\n'
TOUCH_HTTP = (
    "from blocky import block\n"
    "@block('{id}.go')\n"
    "async def go(ctx): return id(ctx.http)\n"
)


async def test_ctx_http_needs_the_net_permission(tmp_path) -> None:
    """`permissions: [net]` 在這裡才第一次真的守得住（§12.1）。

    安裝畫面上那句「這個包會上網」，如果沒有任何地方檢查，使用者讀了也不能信。
    """
    write_pack(tmp_path, "p9", blocks=HTTP_BLOCK, main=TOUCH_HTTP.format(id="p9"))
    contexts = CallContexts()
    host = InProcessHost(discover(tmp_path), EventSinkChannel(EventSink(), contexts), contexts)
    await host.load("p9")

    ctx = contexts.open("p9")
    with pytest.raises(ExtensionError, match="沒有宣告 net 權限"):
        await host.call("p9.go", {}, ctx.token)


async def test_ctx_http_is_one_client_per_pack_and_host_closes_it(tmp_path) -> None:
    """一個包一份 client：連線池共用，而生命週期不是積木包的事。"""
    write_pack(
        tmp_path, "p10", blocks=HTTP_BLOCK, main=TOUCH_HTTP.format(id="p10"), permissions="net"
    )
    contexts = CallContexts()
    host = InProcessHost(discover(tmp_path), EventSinkChannel(EventSink(), contexts), contexts)
    await host.load("p10")

    ctx = contexts.open("p10")
    first = await host.call("p10.go", {}, ctx.token)
    second = await host.call("p10.go", {}, ctx.token)
    assert first == second

    client = host._loaded["p10"].http
    await host.unload("p10")
    # 開的人負責關——`on_unload` 沒有義務知道它存在。
    assert client.is_closed


async def test_no_client_until_someone_asks(tmp_path) -> None:
    """碰都沒碰過 ctx.http 的包不該有連線池（httpx 也不必被 import 進來）。"""
    write_pack(
        tmp_path,
        "p11",
        main="from blocky import block\n@block('p11.go')\nasync def go(ctx): pass\n",
    )
    contexts = CallContexts()
    host = InProcessHost(discover(tmp_path), EventSinkChannel(EventSink(), contexts), contexts)
    await host.load("p11")
    ctx = contexts.open("p11")
    await host.call("p11.go", {}, ctx.token)
    assert host._loaded["p11"].http is None


async def test_載到一半失敗時前面那幾個包要被卸載(tmp_path) -> None:
    """**這一題釘住的是一個不會在失敗那一次出現的症狀。**

    `open_registry` 一個一個載，而每個包是一個子行程（§7.6）。在它回傳之前，
    握得到那些子行程的**只有那個還沒交出去的 registry**——中途失敗不收的話，
    先載好的那幾個會活到後端關掉為止，而使用者看到的是**後來某一次無關的呼叫**
    拿到「子行程意外結束」。錯誤與症狀隔著好幾分鐘與好幾個動作，是最難查的那種。

    用 `InProcessHost` 驗（子行程數量在測試裡量不準）：`on_unload` 有沒有跑，
    就是「有沒有被收拾」這件事在這一層的樣子。
    """
    from blocky.extensions import open_registry

    marker = tmp_path / "unloaded.txt"

    good = tmp_path / "aaa"
    good.mkdir()
    (good / "manifest.yaml").write_text(
        MANIFEST.format(id="aaa", permissions="", blocks=ONE_BLOCK), encoding="utf-8"
    )
    (good / "main.py").write_text(
        "from blocky import block, on_unload\n\n"
        "@block('aaa.go')\n"
        "async def go(ctx):\n"
        "    return None\n\n"
        "@on_unload\n"
        "async def bye(ctx):\n"
        f"    open({str(marker)!r}, 'w').write('yes')\n",
        encoding="utf-8",
    )

    # 排在後面（`only` 的順序就是載入順序），而且它一定載不起來。
    broken = tmp_path / "zzz"
    broken.mkdir()
    (broken / "manifest.yaml").write_text(
        MANIFEST.format(id="zzz", permissions="", blocks=ONE_BLOCK), encoding="utf-8"
    )
    (broken / "main.py").write_text("this is not python\n", encoding="utf-8")

    with pytest.raises(ExtensionError):
        await open_registry(tmp_path, only=["aaa", "zzz"], host="inprocess")

    assert marker.exists(), "先載好的 aaa 沒有被卸載"

"""`SubprocessHost` 特有的行為（§7.6）。

`test_host_boundary.py` 的 24 題已經證明 in-process 與 subprocess 兩種實作
在 `ExtensionHost` 介面上行為一致。這份檔案測的是合約測試表達不出來的東西：
真的是一個獨立 OS process、併發呼叫不會互相干擾、生命週期不留殭屍、取消
真的推得過去——這些是「介面一樣」以外，subprocess 這個實作方式特有的承諾。
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

import pytest

from blockyard.errors import ExtensionError
from blockyard.extensions import (
    BUNDLED_ROOT,
    CallContexts,
    EventSinkChannel,
    SubprocessHost,
    discover,
)
from blockyard.extensions.rpc import JsonRpcPeer
from blockyard.extensions.subprocess_worker import Worker
from blockyard.interpreter.events import EventSink


def _make_host() -> tuple[SubprocessHost, CallContexts]:
    contexts = CallContexts()
    channel = EventSinkChannel(EventSink(), contexts)
    sources = discover(BUNDLED_ROOT)
    host = SubprocessHost(sources, channel, contexts, extensions_root=BUNDLED_ROOT)
    return host, contexts


# --------------------------------------------------------------------------
# 真的是一個獨立 process（不是換個殼子的假貨）
# --------------------------------------------------------------------------


async def test_child_process_is_a_real_os_process() -> None:
    host, _ = _make_host()
    await host.load("demo")
    try:
        worker = host._workers["demo"]
        assert worker.process.pid != os.getpid()
        assert worker.process.returncode is None
    finally:
        await host.unload("demo")


async def test_unload_terminates_the_process() -> None:
    host, _ = _make_host()
    await host.load("demo")
    worker = host._workers["demo"]
    await host.unload("demo")
    assert worker.process.returncode is not None


async def test_load_failure_does_not_leave_the_extension_registered(tmp_path: Path) -> None:
    """manifest 宣告了積木，`main.py` 沒有對應的 `@block`——載入期就該擋下來
    （`loading.check_coverage`），而且不能留下一個沒人管得到的子 process。"""
    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / "manifest.yaml").write_text(
        "manifestVersion: 1\n"
        "id: broken\n"
        "name: 壞掉的包\n"
        "version: 0.1.0\n"
        "permissions: []\n"
        "requirements: []\n"
        "palette:\n"
        "  - opcode: nope\n"
        "    type: command\n"
        "    text: 沒有實作\n",
        encoding="utf-8",
    )
    (broken / "main.py").write_text("", encoding="utf-8")

    contexts = CallContexts()
    channel = EventSinkChannel(EventSink(), contexts)
    sources = discover(tmp_path)
    host = SubprocessHost(sources, channel, contexts, extensions_root=tmp_path)

    with pytest.raises(ExtensionError, match="沒有對應的 @block"):
        await host.load("broken")

    assert "broken" not in host._workers


# --------------------------------------------------------------------------
# 併發呼叫同一個積木包
# --------------------------------------------------------------------------


async def test_concurrent_calls_do_not_cross_talk() -> None:
    """多個 Thread 同時打同一個積木包，各自的 request/response 要對得起來——
    RPC 的 id 相關、child 端不序列化執行，是這個保證的來源。"""
    host, contexts = _make_host()
    await host.load("demo")
    try:

        async def one(i: int) -> Any:
            ctx = contexts.open("demo", thread_id=f"t{i}", block_id=f"b{i}")
            try:
                return await host.call("demo.echo", {"text": str(i)}, ctx.token)
            finally:
                contexts.close(ctx.token)

        results = await asyncio.gather(*(one(i) for i in range(20)))
        assert results == [f"hi, {i}" for i in range(20)]
    finally:
        await host.unload("demo")


# --------------------------------------------------------------------------
# 取消推播（§7.6 的反向通道）
# --------------------------------------------------------------------------


async def test_cancel_thread_pushes_a_notification_to_the_child() -> None:
    """`CallContexts.cancel_thread` 翻旗標的同時，SubprocessHost 掛的
    `on_cancelled` 要真的送一個 `cancel` notification 給子 process——這是
    child 端 `ctx.cancelled` 讀得到最新值的唯一路徑（它讀的是本地快取）。"""
    host, contexts = _make_host()
    await host.load("demo")
    ctx = contexts.open("demo", thread_id="t1", block_id="b1")
    try:
        task = asyncio.create_task(host.call("demo.echo", {"text": "x"}, ctx.token))
        await asyncio.sleep(0)  # 讓 call() 跑到第一個 await，掛上 on_cancelled
        assert ctx.on_cancelled is not None

        worker = host._workers["demo"]
        sent: list[tuple[str, dict[str, Any]]] = []
        original = worker.peer.notify_nowait

        def spy(method: str, params: dict[str, Any]) -> None:
            sent.append((method, params))
            original(method, params)

        worker.peer.notify_nowait = spy  # type: ignore[method-assign]

        contexts.cancel_thread("t1")
        result = await task
        assert result == "hi, x"
        assert ("cancel", {"token": ctx.token}) in sent
    finally:
        contexts.close(ctx.token)
        await host.unload("demo")


# --------------------------------------------------------------------------
# child 端的反向通道實作（純單元測試，不需要真的 subprocess）
# --------------------------------------------------------------------------


class _FakeWriter:
    def __init__(self) -> None:
        self.lines: list[bytes] = []

    def write(self, data: bytes) -> None:
        self.lines.append(data)


async def test_worker_cancel_updates_the_local_cache() -> None:
    peer = JsonRpcPeer(None, _FakeWriter())  # type: ignore[arg-type]
    worker = Worker("demo", Path("/nonexistent"), peer)
    assert worker.channel.is_cancelled("tok1") is False
    await worker._on_cancel({"token": "tok1"})
    assert worker.channel.is_cancelled("tok1") is True


async def test_worker_log_is_synchronous_and_fire_and_forget() -> None:
    writer = _FakeWriter()
    peer = JsonRpcPeer(None, writer)  # type: ignore[arg-type]
    worker = Worker("demo", Path("/nonexistent"), peer)
    worker.channel.log("tok1", "info", "哈囉")  # 沒有 await 可以呼叫，本來就是重點
    assert len(writer.lines) == 1
    msg = json.loads(writer.lines[0])
    assert msg == {
        "method": "log",
        "params": {"token": "tok1", "level": "info", "message": "哈囉"},
    }

"""HTTP 積木包的測試（§7.1、§17.4）。

**跑的是本地起的假伺服器，不打真 API**（§15 的 P1 第 1 步明寫）。理由不只是
速度：一份會因為別人的服務掛掉而變紅的測試，紅的時候沒有人會相信它。

題目一律**透過 host 呼叫**而不是直接 import `main.py`。差別在於這樣連 §7.5 的
邊界一起驗到了——`headers` 宣告成 `json`，所以「使用者在積木裡打了一段 JSON
文字」與「接了一顆物件積木」在 `main.py` 裡必須長得一樣，而那是邊界的事。
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from blockyard.errors import ExtensionError
from blockyard.extensions import (
    DEFAULT_EXTENSIONS_ROOT,
    CallContexts,
    EventSinkChannel,
    InProcessHost,
    discover,
)
from blockyard.interpreter.events import EventSink

ROUTES: dict[str, tuple[int, str, Any]] = {
    "/json": (200, "application/json", {"items": [{"title": "一"}, {"title": "二"}]}),
    "/text": (200, "text/plain; charset=utf-8", "哈囉"),
    "/missing": (404, "application/json", {"error": "沒這個東西"}),
    "/lies": (200, "application/json", "{這不是 JSON"),
}


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: Any) -> None:  # 測試輸出裡不要一行行的存取紀錄
        pass

    def _write(self, status: int, ctype: str, payload: Any) -> None:
        body = (payload if isinstance(payload, str) else json.dumps(payload)).encode()
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path in ROUTES:
            self._write(*ROUTES[self.path])
        else:
            self._write(200, "application/json", {"path": self.path, "method": "GET"})

    def _echo(self, method: str) -> None:
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length).decode() if length else ""
        self._write(
            200,
            "application/json",
            {
                "method": method,
                "sent": json.loads(raw) if raw else None,
                "x_token": self.headers.get("x-token"),
                "user_agent": self.headers.get("user-agent"),
            },
        )

    def do_POST(self) -> None:
        self._echo("POST")

    def do_DELETE(self) -> None:
        self._echo("DELETE")


@pytest.fixture(scope="module")
def base() -> Any:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()


class Pack:
    """只透過 `ExtensionHost` 的介面跟積木包打交道（同 §17.4 的合約測試）。"""

    def __init__(self, host: InProcessHost, contexts: CallContexts) -> None:
        self.host = host
        self.contexts = contexts

    async def call(self, opcode: str, **args: Any) -> Any:
        ctx = self.contexts.open("http", thread_id="t_1", block_id="blk_1")
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


@pytest.fixture
async def pack() -> Any:
    contexts = CallContexts()
    sources = discover(DEFAULT_EXTENSIONS_ROOT)
    host = InProcessHost(sources, EventSinkChannel(EventSink(), contexts), contexts)
    await host.load("http")
    try:
        yield Pack(host, contexts)
    finally:
        await host.unload("http")


async def test_get_回一個物件而不是四顆積木(pack: Pack, base: str) -> None:
    r = await pack.call("http.get", url=f"{base}/json")

    assert r["status"] == 200
    assert r["ok"] is True
    assert r["url"] == f"{base}/json"
    # §4.7 的取值路徑：${r.body.items[1].title}
    assert r["body"]["items"][1]["title"] == "二"


async def test_標頭一律小寫(pack: Pack, base: str) -> None:
    r = await pack.call("http.get", url=f"{base}/json")
    assert r["headers"]["content-type"] == "application/json"


async def test_不是_json_就給原始文字(pack: Pack, base: str) -> None:
    r = await pack.call("http.get", url=f"{base}/text")
    assert r["body"] == "哈囉"


async def test_說了是_json_卻不是時把原文交出去(pack: Pack, base: str) -> None:
    # 伺服器說謊的時候，使用者要看得到它實際回了什麼——而不是一句 parse 失敗。
    r = await pack.call("http.get", url=f"{base}/lies")
    assert r["body"] == "{這不是 JSON"


async def test_404_不是積木錯誤(pack: Pack, base: str) -> None:
    # 它是伺服器的回答。變成例外就等於逼使用者用 try_catch 寫「找不到就算了」。
    r = await pack.call("http.get", url=f"{base}/missing")
    assert r["status"] == 404
    assert r["ok"] is False
    assert r["body"]["error"] == "沒這個東西"


async def test_post_送得出_json(pack: Pack, base: str) -> None:
    r = await pack.call("http.post", url=f"{base}/echo", body={"a": 1})
    assert r["body"]["method"] == "POST"
    assert r["body"]["sent"] == {"a": 1}


async def test_body_是文字時在邊界被_parse(pack: Pack, base: str) -> None:
    # `json` 型別的參數：使用者在積木裡打的是一段文字，main.py 拿到的是 dict
    # （§7.2）。這一題驗的是邊界，不是這個包。
    r = await pack.call("http.post", url=f"{base}/echo", body='{"a": 1}')
    assert r["body"]["sent"] == {"a": 1}


async def test_request_送得出標頭(pack: Pack, base: str) -> None:
    r = await pack.call(
        "http.request",
        method="POST",
        url=f"{base}/echo",
        headers={"x-token": "abc"},
        body={"ok": True},
    )
    assert r["body"]["x_token"] == "abc"
    assert r["body"]["sent"] == {"ok": True}


async def test_有預設的_user_agent(pack: Pack, base: str) -> None:
    # 逾時、重試、UA 都是 host 那份共用 client 的預設值（§7.4）。
    r = await pack.call("http.request", method="POST", url=f"{base}/echo", headers={}, body={})
    assert r["body"]["user_agent"].startswith("blockyard/")


async def test_get_不送內容(pack: Pack, base: str) -> None:
    r = await pack.call(
        "http.request", method="GET", url=f"{base}/json", headers={}, body={"x": 1}
    )
    assert r["status"] == 200


async def test_delete_送得出內容(pack: Pack, base: str) -> None:
    # 「空物件等於不送」那條規則會讓這件合法的事做不到，所以規則看的是 method。
    r = await pack.call(
        "http.request", method="delete", url=f"{base}/echo", headers={}, body={"why": "測試"}
    )
    assert r["body"]["method"] == "DELETE"
    assert r["body"]["sent"] == {"why": "測試"}


async def test_網址不合法時主詞是網址不是積木包(pack: Pack) -> None:
    with pytest.raises(ExtensionError) as e:
        await pack.call("http.get", url="ftp://example.com")
    assert "http://" in str(e.value)
    # 被 host 包過的訊息長「積木包「HTTP」的 http.get 執行時發生錯誤：…」，
    # 那句話說壞掉的是這個包——而使用者打錯網址不是包壞掉（`BlockError`）。
    assert "執行時發生錯誤" not in str(e.value)


async def test_不認得的方法(pack: Pack, base: str) -> None:
    with pytest.raises(ExtensionError) as e:
        await pack.call("http.request", method="FLY", url=f"{base}/json", headers={}, body={})
    assert "FLY" in str(e.value)


async def test_連不上時說得出是哪個網址(pack: Pack) -> None:
    # 127.0.0.1:1 沒有人在聽。連線階段的重試（§7.4）在這裡會用完再放棄。
    with pytest.raises(ExtensionError) as e:
        await pack.call("http.get", url="http://127.0.0.1:1/nope")
    assert "連不上" in str(e.value)
    assert "127.0.0.1:1" in str(e.value)


async def test_url_encode(pack: Pack) -> None:
    encoded = await pack.call("http.url_encode", text="你好 世界")
    assert encoded == "%E4%BD%A0%E5%A5%BD%20%E4%B8%96%E7%95%8C"


async def test_方法的下拉是動態的(pack: Pack) -> None:
    # 積木包不能宣告靜態 options（D22），所以封閉的一組選項也走 @dropdown。
    options = await pack.dropdown("http", "methods")
    assert [o["value"] for o in options] == ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]


# ---- P1 第 1 步的驗收：manifest → 積木 → 執行（§15）----


async def test_一份專案裡的積木真的跑得動(base: str) -> None:
    """走**引擎**而不是 host，因為前面那些題目跳過了整條路的前半段。

    這一題是 P1 第 1 步存在的理由本身：一個外部資料夾裡的 manifest，經過
    IR 載入期的形狀驗證（`http.get` 是 reporter，插得進 `debug.log` 的孔）、
    引擎的求值、§7.5 的邊界，最後打到一個真的 socket 上。中間任何一段沒接
    起來，這一題就會紅——而前面十六題都還是綠的。
    """
    from blockyard.extensions import DEFAULT_EXTENSIONS_ROOT, open_registry
    from blockyard.interpreter import builtins as _builtins  # noqa: F401  匯入即註冊
    from blockyard.interpreter.declarations import expression_fields
    from blockyard.interpreter.engine import Interpreter
    from blockyard.interpreter.events import EventSink
    from blockyard.interpreter.registry import resolve_shape, resolve_terminal
    from blockyard.ir.schema import load
    from blockyard.testing import Tpl, blk, build

    data = build(
        extensions=[("http", "0.1.0")],
        scripts=[[
            blk("event.when_flag_clicked"),
            blk(
                "data.set",
                fields={"name": "r"},
                value=blk("http.get", url=f"{base}/json"),
            ),
            # §4.7 的取值路徑走在積木包回來的物件上——這是「回一個物件」
            # 那個決定的整個重點。索引從 1 起算（§4.3），所以第二筆是 `[2]`。
            blk("debug.log", text=Tpl("第二筆是 ${r.body.items[2].title}，狀態 ${r.status}")),
        ]],
    )

    sink = EventSink()
    registry = await open_registry(DEFAULT_EXTENSIONS_ROOT, sink=sink, only=["http"])
    try:
        project = load(
            data,
            strict_refs=True,
            shapes=resolve_shape(registry),
            expressions=expression_fields,
            terminals=resolve_terminal(registry),
        )
        interp = Interpreter(project, sink=sink, extensions=registry)
        run = await interp.run()
    finally:
        await registry.unload_all()

    assert run.status == "ok"
    logs = [e["text"] for e in sink.dicts() if e["op"] == "log"]
    assert logs == ["第二筆是 二，狀態 200"]

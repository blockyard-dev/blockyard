"""OpenAI 積木包的測試（§7.1、§17.4）。

**跑的是本地起的假伺服器，不打真 API**——這裡比 `http` 那一步更硬性：打真的
`api.openai.com` 需要一把真金鑰，而一份要開發者先掏錢才會綠的測試等於沒有。
`base_url` 這個 config 存在的第一個理由就是這件事。

題目一律**透過 host 呼叫**而不是直接 import `main.py`，理由同 `http`：這樣連
§7.5 的邊界一起驗到了。
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from blocky.errors import ExtensionError, MissingSecretError
from blocky.extensions import (
    DEFAULT_EXTENSIONS_ROOT,
    CallContexts,
    EventSinkChannel,
    InProcessHost,
    discover,
)
from blocky.interpreter.events import EventSink

# 伺服器下一次要回什麼。每題自己設，不用為了一個變化多起一台伺服器。
NEXT: dict[str, Any] = {}
# 伺服器實際收到的最後一次請求，讓「有沒有把 instructions 送出去」這種題目
# 驗得到——那是這個包的責任，不是 SDK 的。
SEEN: dict[str, Any] = {}


def _response(text: str = "哈囉", **overrides: Any) -> dict[str, Any]:
    """一份最小但**通得過 SDK pydantic 驗證**的 Responses 物件。

    欄位不是憑印象寫的，是拿 `openai.types.responses.Response` 反覆餵出來的
    ——`input_tokens_details.cache_write_tokens` 這種必填欄位少一個就整份炸掉。
    """
    body: dict[str, Any] = {
        "id": "resp_test",
        "object": "response",
        "created_at": 1770000000,
        "model": "gpt-5.6-luna",
        "status": "completed",
        "error": None,
        "incomplete_details": None,
        "instructions": None,
        "metadata": {},
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
        "output": [
            {
                "id": "msg_test",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": text, "annotations": []}],
            }
        ],
        "usage": {
            "input_tokens": 11,
            "output_tokens": 4,
            "total_tokens": 15,
            "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0},
        },
    }
    body.update(overrides)
    return body


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: Any) -> None:
        pass

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        SEEN["path"] = self.path
        SEEN["authorization"] = self.headers.get("authorization")
        SEEN["body"] = json.loads(self.rfile.read(length).decode()) if length else None

        status = NEXT.get("status", 200)
        payload = NEXT.get("body", _response())
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


@pytest.fixture(scope="module")
def base() -> Any:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        # SDK 會在這後面自己接 `/responses`。
        yield f"http://127.0.0.1:{server.server_port}/v1"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture(autouse=True)
def _reset() -> Any:
    NEXT.clear()
    SEEN.clear()
    yield


class Pack:
    """只透過 `ExtensionHost` 的介面跟積木包打交道（同 §17.4 的合約測試）。"""

    def __init__(self, host: InProcessHost, contexts: CallContexts) -> None:
        self.host = host
        self.contexts = contexts

    async def call(self, opcode: str, **args: Any) -> Any:
        ctx = self.contexts.open("openai", thread_id="t_1", block_id="blk_1")
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


async def _pack_with(config: dict[str, Any]) -> Any:
    contexts = CallContexts()
    sources = discover(DEFAULT_EXTENSIONS_ROOT)
    host = InProcessHost(
        sources,
        EventSinkChannel(EventSink(), contexts),
        contexts,
        config={"openai": config},
    )
    await host.load("openai")
    try:
        yield Pack(host, contexts)
    finally:
        await host.unload("openai")


@pytest.fixture
async def pack(base: str) -> Any:
    async for p in _pack_with({"api_key": "sk-test", "base_url": base}):
        yield p


@pytest.fixture
async def pack_without_key(base: str) -> Any:
    # 金鑰沒設 = keyring 查不到那一把，`resolve_config` 會給 None。
    async for p in _pack_with({"api_key": None, "base_url": base}):
        yield p


async def test_chat_回一句文字而不是一個物件(pack: Pack) -> None:
    NEXT["body"] = _response("視覺化程式設計就是把程式寫成看得見的形狀")

    out = await pack.call("openai.chat", model="gpt-5.6-luna", prompt="解釋一下")

    assert out == "視覺化程式設計就是把程式寫成看得見的形狀"


async def test_chat_把金鑰送進_authorization(pack: Pack) -> None:
    await pack.call("openai.chat", model="gpt-5.6-luna", prompt="嗨")
    assert SEEN["authorization"] == "Bearer sk-test"


async def test_chat_不送_max_output_tokens(pack: Pack) -> None:
    # 最短路徑刻意不設上限：一顆會預設把答案砍斷的積木不是最短路徑。
    await pack.call("openai.chat", model="gpt-5.6-luna", prompt="嗨")
    assert "max_output_tokens" not in SEEN["body"]


async def test_chat_模型沒回文字時說出原因而不是回空字串(pack: Pack) -> None:
    # 空字串在畫布上長得像成功，接下來每一顆積木都拿到空的。
    NEXT["body"] = _response(
        status="incomplete",
        incomplete_details={"reason": "max_output_tokens"},
        output=[],
    )

    with pytest.raises(ExtensionError, match="max_output_tokens"):
        await pack.call("openai.chat", model="gpt-5.6-luna", prompt="嗨")


async def test_chat_full_回物件所以取得到_usage(pack: Pack) -> None:
    NEXT["body"] = _response("好")

    r = await pack.call(
        "openai.chat_full",
        model="gpt-5.6-luna",
        prompt="嗨",
        instructions="",
        max_output_tokens=2048,
    )

    assert r["text"] == "好"
    assert r["status"] == "completed"
    # §4.7 的取值路徑：${r.usage.total_tokens}
    assert r["usage"]["total_tokens"] == 15
    assert r["usage"]["input_tokens"] == 11
    assert r["incomplete_reason"] is None


async def test_chat_full_空的系統指示就不送(pack: Pack) -> None:
    await pack.call(
        "openai.chat_full", model="gpt-5.6-luna", prompt="嗨",
        instructions="   ", max_output_tokens=2048,
    )
    assert "instructions" not in SEEN["body"]


async def test_chat_full_有系統指示就送出去(pack: Pack) -> None:
    await pack.call(
        "openai.chat_full", model="gpt-5.6-luna", prompt="嗨",
        instructions="你是一隻貓", max_output_tokens=512,
    )
    assert SEEN["body"]["instructions"] == "你是一隻貓"
    assert SEEN["body"]["max_output_tokens"] == 512


async def test_chat_full_被砍斷時說得出理由(pack: Pack) -> None:
    # `text` 斷在半句，而 `incomplete_reason` 是使用者唯一看得出為什麼的地方。
    NEXT["body"] = _response(
        "視覺化程式設計就是",
        status="incomplete",
        incomplete_details={"reason": "max_output_tokens"},
    )

    r = await pack.call(
        "openai.chat_full", model="gpt-5.6-luna", prompt="嗨",
        instructions="", max_output_tokens=16,
    )

    assert r["status"] == "incomplete"
    assert r["incomplete_reason"] == "max_output_tokens"
    assert r["text"] == "視覺化程式設計就是"


async def test_金鑰沒設時說的是還沒設定而不是金鑰錯誤(pack_without_key: Pack) -> None:
    # 兩件事使用者要做的動作不同：一個是去設定，一個是去換一把。
    with pytest.raises(MissingSecretError, match="還沒設定"):
        await pack_without_key.call("openai.chat", model="gpt-5.6-luna", prompt="嗨")


async def test_金鑰沒設時錯誤帶得出前端點得下去的補救動作(pack_without_key: Pack) -> None:
    # 這一題驗的是「使用者接下來要做什麼」有沒有一路傳到 UI：訊息文字會因包而
    # 異，`action` 不會，而它必須帶著 envVar，前端才填得好那一格。
    with pytest.raises(MissingSecretError) as excinfo:
        await pack_without_key.call("openai.chat", model="gpt-5.6-luna", prompt="嗨")

    action = excinfo.value.action
    assert action == {
        "kind": "configure_secret",
        "extId": "openai",
        "extName": "OpenAI",
        "key": "api_key",
        "label": "API 金鑰",
        "envVar": "OPENAI_API_KEY",
    }
    # 值絕不在這條路上——它會一路傳到瀏覽器（§12.2）。
    assert "value" not in action


async def test_401_說的是金鑰不對(pack: Pack) -> None:
    NEXT["status"] = 401
    NEXT["body"] = {
        "error": {"message": "Incorrect API key provided", "type": "invalid_request_error"}
    }

    with pytest.raises(ExtensionError, match="金鑰不對或已經失效"):
        await pack.call("openai.chat", model="gpt-5.6-luna", prompt="嗨")


async def test_429_說的是被限流(pack: Pack) -> None:
    NEXT["status"] = 429
    NEXT["body"] = {"error": {"message": "Rate limit reached", "type": "rate_limit_error"}}

    with pytest.raises(ExtensionError, match="限流"):
        await pack.call("openai.chat", model="gpt-5.6-luna", prompt="嗨")


async def test_429_不重試(pack: Pack) -> None:
    # SDK 預設會退避重試兩次。§7.4：收到回應之後一律不重試——模型可能已經算完
    # 並且已經計費了。
    NEXT["status"] = 429
    NEXT["body"] = {"error": {"message": "Rate limit reached"}}
    hits = []

    original = _Handler.do_POST

    def counting(self: Any) -> None:
        hits.append(1)
        original(self)

    _Handler.do_POST = counting  # type: ignore[method-assign]
    try:
        with pytest.raises(ExtensionError):
            await pack.call("openai.chat", model="gpt-5.6-luna", prompt="嗨")
    finally:
        _Handler.do_POST = original  # type: ignore[method-assign]

    assert len(hits) == 1


async def test_其餘的錯誤把_api_自己那句話交出去(pack: Pack) -> None:
    # 模型名打錯、參數不合法——那句話裡通常寫著到底哪個參數不對，翻成一句
    # 籠統的中文只會把它弄丟。
    NEXT["status"] = 400
    NEXT["body"] = {
        "error": {"message": "Unknown parameter: 'foo'.", "type": "invalid_request_error"}
    }

    with pytest.raises(ExtensionError, match="Unknown parameter"):
        await pack.call("openai.chat", model="gpt-5.6-luna", prompt="嗨")


async def test_模型下拉是策展清單且預設值在裡面(pack: Pack) -> None:
    options = await pack.dropdown("openai", "models")
    values = [o["value"] for o in options]

    assert values == ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]
    # manifest 宣告的 default 必須真的是清單裡的一項，不然拖出來就是壞的。
    assert "gpt-5.6-luna" in values

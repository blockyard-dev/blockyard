"""Discord 積木包的測試（§7.1、§17.4）。

**跑本地假伺服器扮演 Discord 的 REST API，不打真的 discord.com。** 理由同
`openai` 那一份：一份要開發者先去申請一隻 bot、建一個伺服器、再邀請它進去
才會綠的測試等於沒有。

**但這裡沒有 `base_url` 那條乾淨的路。** `openai` 的端點是一個 config，因為
自架的相容端點是真的存在的東西，測試只是搭了順風車；Discord 沒有相容端點，
所以一個 `base_url` 設定會是**為了測試而長在使用者面板上的一格**——那比在測
試裡伸手進 SDK 更糟。`discord.http.Route.BASE` 是 ClassVar、在 `Route.__init__`
被讀（`http.py:318`），所以蓋掉它就夠了；代價是這一份測試綁著 SDK 的一個內部
名字，換大版本時要複驗（3.1.2 節已記）。

題目一律**透過 host 呼叫**而不是直接 import `main.py`：這樣連 §7.5 的邊界一起
驗到了。
"""

from __future__ import annotations

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

import discord
import pytest

from blockyard.errors import ExtensionError, InvalidSecretError, MissingSecretError
from blockyard.extensions import (
    BUNDLED_ROOT,
    CallContexts,
    EventSinkChannel,
    InProcessHost,
    discover,
)
from blockyard.interpreter.events import EventSink

GUILD = "111111111111111111"
CHANNEL = "222222222222222222"
# 真的 snowflake：Discord 的 ID **本身就編著時間**，而 `Message.created_at`
# 讀的是它而不是 payload 裡的 `timestamp` 欄位（`message.py:2618`）。隨手寫
# 一個 "333" 當 id 的話時間會變成 2015-01-01（snowflake 紀元），而那個日期
# 看起來只是「測試資料很怪」，不是「我們讀錯欄位了」。
MESSAGE = "1544315889254400000"   # → 2026-09-01T12:00:00+00:00

# 這一題要伺服器回什麼。每題自己設。
NEXT: dict[str, Any] = {}
# 伺服器實際收到的每一次請求。「有沒有真的打到那個頻道」是這個包的責任，
# 不是 SDK 的——所以要驗得到。
SEEN: list[dict[str, Any]] = []


def _user(uid: str = "999", name: str = "積木", bot: bool = False) -> dict[str, Any]:
    return {
        "id": uid,
        "username": name,
        "discriminator": "0",
        "global_name": name,
        "avatar": None,
        "bot": bot,
    }


def _message(mid: str = MESSAGE, content: str = "哈囉", **overrides: Any) -> dict[str, Any]:
    """一份最小但**建得出 `discord.Message`** 的 payload。

    欄位不是憑印象寫的，是餵給 `Message.__init__` 餵出來的——少一個必填欄位
    就是 KeyError，而那個例外會被 host 包成「這個積木包壞了」。
    """
    body: dict[str, Any] = {
        "id": mid,
        "type": 0,
        "content": content,
        "channel_id": CHANNEL,
        "author": _user(),
        "attachments": [],
        "embeds": [],
        "mentions": [],
        "mention_roles": [],
        "pinned": False,
        "mention_everyone": False,
        "tts": False,
        # discord.py 不讀這一欄（時間從 id 算），但少了它 `Message.__init__`
        # 會 KeyError。
        "timestamp": "2026-09-01T12:00:00+00:00",
        "edited_timestamp": None,
        "flags": 0,
    }
    body.update(overrides)
    return body


def _guild(gid: str = GUILD, name: str = "我的伺服器") -> dict[str, Any]:
    return {"id": gid, "name": name, "icon": None, "owner": True, "permissions": "8"}


def _text_channel(cid: str, name: str, *, position: int = 0, parent: str | None = None) -> dict:
    return {
        "id": cid,
        "type": 0,                       # GUILD_TEXT
        "name": name,
        "position": position,
        "parent_id": parent,
        "guild_id": GUILD,
        "permission_overwrites": [],
        "nsfw": False,
    }


def _category(cid: str, name: str, *, position: int = 0) -> dict:
    return {
        "id": cid,
        "type": 4,                       # GUILD_CATEGORY
        "name": name,
        "position": position,
        "parent_id": None,
        "guild_id": GUILD,
        "permission_overwrites": [],
    }


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: Any) -> None:
        pass

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        self._record(None)

        if path.endswith("/users/@me"):
            return self._json(NEXT.get("login_status", 200), _user("999", "測試 bot", bot=True))
        if path.endswith("/oauth2/applications/@me"):
            return self._json(200, self._appinfo())
        if path.endswith("/users/@me/guilds"):
            return self._json(200, NEXT.get("guilds", [_guild()]))
        if re.search(r"/guilds/\d+$", path):
            return self._json(200, _guild())
        if re.search(r"/guilds/\d+/channels$", path):
            return self._json(200, NEXT.get("channels", []))
        if re.search(r"/channels/\d+/messages$", path):
            if (status := NEXT.get("status", 200)) != 200:
                return self._json(status, {"message": NEXT.get("reason", "nope"), "code": 50001})
            limit = int(parse_qs(urlparse(self.path).query).get("limit", ["50"])[0])
            return self._json(200, NEXT.get("history", [_message(str(i)) for i in range(limit)]))
        return self._json(404, {"message": "unknown route", "code": 0})

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length).decode()) if length else None
        self._record(body)

        if (status := NEXT.get("status", 200)) != 200:
            return self._json(status, {"message": NEXT.get("reason", "nope"), "code": 50001})
        return self._json(200, _message(content=(body or {}).get("content", "")))

    # ---

    def _record(self, body: Any) -> None:
        SEEN.append(
            {
                "method": self.command,
                "path": urlparse(self.path).path,
                "query": parse_qs(urlparse(self.path).query),
                "authorization": self.headers.get("authorization"),
                "body": body,
            }
        )

    def _appinfo(self) -> dict[str, Any]:
        return {
            "id": "888",
            "name": "測試 App",
            "description": "",
            "icon": None,
            "bot_public": False,
            "bot_require_code_grant": False,
            "owner": _user("777", "擁有者"),
            "verify_key": "0" * 64,
            "flags": 0,
        }

    def _json(self, status: int, payload: Any) -> None:
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


@pytest.fixture(scope="module", autouse=True)
def fake_discord() -> Any:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    original = discord.http.Route.BASE
    discord.http.Route.BASE = f"http://127.0.0.1:{server.server_port}/api/v10"
    try:
        yield
    finally:
        discord.http.Route.BASE = original
        server.shutdown()
        server.server_close()


@pytest.fixture(autouse=True)
def _reset() -> Any:
    NEXT.clear()
    SEEN.clear()
    yield


class Pack:
    """只透過 `ExtensionHost` 的介面跟積木包打交道（同 §17.4 的合約測試）。

    `logs` 收 `ctx.log` 推出去的那些字。這個包的 `send_message` 是 command，
    沒有回傳值——執行紀錄那一行**就是**它唯一的產出，所以它要被測到。
    """

    def __init__(self, host: InProcessHost, contexts: CallContexts, logs: list[str]) -> None:
        self.host = host
        self.contexts = contexts
        self.logs = logs

    async def call(self, opcode: str, **args: Any) -> Any:
        ctx = self.contexts.open("discord", thread_id="t_1", block_id="blk_1")
        try:
            return await self.host.call(opcode, args, ctx.token)
        finally:
            self.contexts.close(ctx.token)

    async def dropdown(self, source: str, **args: Any) -> list[dict[str, Any]]:
        ctx = self.contexts.open("discord")
        try:
            return await self.host.dropdown("discord", source, ctx.token, args)
        finally:
            self.contexts.close(ctx.token)


async def _pack_with(config: dict[str, Any]) -> Any:
    contexts = CallContexts()
    logs: list[str] = []
    sink = EventSink(on_emit=lambda ev: logs.append(ev.data["text"]) if ev.op == "log" else None)
    host = InProcessHost(
        discover(BUNDLED_ROOT),
        EventSinkChannel(sink, contexts),
        contexts,
        config={"discord": config},
    )
    await host.load("discord")
    try:
        yield Pack(host, contexts, logs)
    finally:
        await host.unload("discord")


@pytest.fixture
async def pack() -> Any:
    async for p in _pack_with({"bot_token": "tok-test"}):
        yield p


@pytest.fixture
async def pack_without_token() -> Any:
    # 金鑰沒設 = keyring 查不到那一把，`resolve_config` 會給 None。
    async for p in _pack_with({"bot_token": None}):
        yield p


def _posts() -> list[dict[str, Any]]:
    return [r for r in SEEN if r["method"] == "POST"]


# --------------------------------------------------------------------------
# 發訊息
# --------------------------------------------------------------------------


async def test_send_message_打到指定的頻道(pack: Pack) -> None:
    await pack.call("discord.send_message", message="哈囉", server=GUILD, channel=CHANNEL)

    sent = _posts()[-1]
    assert sent["path"] == f"/api/v10/channels/{CHANNEL}/messages"
    assert sent["body"]["content"] == "哈囉"


async def test_send_message_用的是_bot_授權而不是_bearer(pack: Pack) -> None:
    # Discord 的 header 是 `Bot <token>`，不是 OAuth 的 `Bearer`。
    await pack.call("discord.send_message", message="嗨", server=GUILD, channel=CHANNEL)
    assert _posts()[-1]["authorization"] == "Bot tok-test"


async def test_send_message_不為了發一句話開_gateway(pack: Pack) -> None:
    """`login()` 是純 REST 的，`start()` 才連 WebSocket——這一題釘住那個差別。

    假伺服器根本沒有 gateway 端點，所以真的開了連線這題不只是斷言失敗，是整
    題掛住。反過來說，這也是它唯一測得到「沒有多開一條連線」的方式。
    """
    await pack.call("discord.send_message", message="嗨", server=GUILD, channel=CHANNEL)

    assert [r["path"] for r in SEEN if r["method"] == "GET"] == [
        "/api/v10/users/@me",
        "/api/v10/oauth2/applications/@me",
    ]


async def test_頻道可以貼整條網址而不是只有_ID(pack: Pack) -> None:
    await pack.call(
        "discord.send_message",
        message="嗨",
        server="",
        channel=f"https://discord.com/channels/{GUILD}/{CHANNEL}",
    )

    assert _posts()[-1]["path"] == f"/api/v10/channels/{CHANNEL}/messages"


async def test_貼網址時執行紀錄的連結帶得出伺服器(pack: Pack) -> None:
    """`Message.jump_url` 在這條路上一律吐 `@me`（沒有 gateway 就沒有 guild
    快取），而那條連結指向私訊——使用者點進去看不到訊息，會以為沒發成功。
    伺服器 ID 明明就在他剛剛貼的那條網址裡。"""
    await pack.call(
        "discord.send_message",
        message="嗨",
        server="",
        channel=f"https://discord.com/channels/{GUILD}/{CHANNEL}",
    )

    assert f"/channels/{GUILD}/{CHANNEL}/" in pack.logs[-1]


async def test_兩格都沒有伺服器時老實吐_at_me_而不是編一個(pack: Pack) -> None:
    await pack.call("discord.send_message", message="嗨", server="", channel=CHANNEL)
    assert f"/channels/@me/{CHANNEL}/" in pack.logs[-1]


async def test_頻道空白時說得出要貼什麼(pack: Pack) -> None:
    with pytest.raises(ExtensionError, match="先選伺服器"):
        await pack.call("discord.send_message", message="嗨", server=GUILD, channel="")


async def test_頻道看不懂時說得出要的是什麼(pack: Pack) -> None:
    with pytest.raises(ExtensionError, match="頻道 ID"):
        await pack.call("discord.send_message", message="嗨", server=GUILD, channel="#一般")


async def test_看不懂的頻道連線都不開(pack: Pack) -> None:
    """本地就判得出來的錯不該排在一次網路來回後面。"""
    with pytest.raises(ExtensionError):
        await pack.call("discord.send_message", message="嗨", server=GUILD, channel="#一般")

    assert SEEN == []


async def test_頻道錯的時候先講頻道而不是先講_token(pack_without_token: Pack) -> None:
    """兩件事都不對時，先講哪一件？

    先開連線的話，一個把「#一般」貼進頻道欄、token 也還沒設的人會先被送去設
    token——設完再跑一次，才輪到真正擋住他的那件事。他做錯的是兩件事，但我們
    一次只講得出一件，**那就先講本地確定知道的那一件**。
    """
    with pytest.raises(ExtensionError, match="頻道 ID"):
        await pack_without_token.call(
            "discord.send_message", message="嗨", server=GUILD, channel="#一般"
        )


# --------------------------------------------------------------------------
# 錯誤的主詞
# --------------------------------------------------------------------------


async def test_沒設_token_時給一顆點得下去的按鈕(pack_without_token: Pack) -> None:
    with pytest.raises(MissingSecretError) as e:
        await pack_without_token.call(
            "discord.send_message", message="嗨", server=GUILD, channel=CHANNEL
        )

    assert e.value.action == {
        "kind": "configure_secret",
        "extId": "discord",
        "extName": "Discord",
        "key": "bot_token",
        "label": "Bot Token",
        "envVar": "DISCORD_BOT_TOKEN",
    }


async def test_token_被拒時給的是同一顆按鈕(pack: Pack) -> None:
    """「還沒填」與「填了但對方說不對」對使用者的意思不同，要去的地方一樣。

    沒有這一條，包只能自己寫一句「請到右上角『金鑰』重新匯入 DISCORD_BOT_TOKEN」
    的純文字——那正是 D28 那顆按鈕想消滅的東西。
    """
    NEXT["login_status"] = 401

    with pytest.raises(InvalidSecretError) as e:
        await pack.call("discord.send_message", message="嗨", server=GUILD, channel=CHANNEL)

    assert e.value.action["kind"] == "configure_secret"
    assert e.value.action["key"] == "bot_token"
    assert "Reset" in e.value.message


async def test_token_被拒之後不留下一個沒登入的_client(pack: Pack) -> None:
    """失敗的 client 存進 `ctx.state` 的話，第二次呼叫的錯誤會變成別的樣子
    ——而使用者做的是同一件事。"""
    NEXT["login_status"] = 401
    with pytest.raises(InvalidSecretError):
        await pack.call("discord.send_message", message="嗨", server=GUILD, channel=CHANNEL)

    with pytest.raises(InvalidSecretError):
        await pack.call("discord.send_message", message="嗨", server=GUILD, channel=CHANNEL)


async def test_403_說的是權限不是_token(pack: Pack) -> None:
    NEXT["status"] = 403
    with pytest.raises(ExtensionError, match="權限"):
        await pack.call("discord.send_message", message="嗨", server=GUILD, channel=CHANNEL)


async def test_404_說的是找不到頻道(pack: Pack) -> None:
    NEXT["status"] = 404
    with pytest.raises(ExtensionError, match="找不到這個頻道"):
        await pack.call("discord.send_message", message="嗨", server=GUILD, channel=CHANNEL)


async def test_其餘的錯誤把_discord_那句原話交出去(pack: Pack) -> None:
    # 訊息超過 2000 字之類的：那句話裡通常寫著到底哪裡不合法。
    NEXT["status"] = 400
    NEXT["reason"] = "Must be 2000 or fewer in length."
    with pytest.raises(ExtensionError, match="2000 or fewer"):
        await pack.call("discord.send_message", message="嗨", server=GUILD, channel=CHANNEL)


# --------------------------------------------------------------------------
# 讀歷史
# --------------------------------------------------------------------------


async def test_歷史回的是_list_可以直接接對每一項(pack: Pack) -> None:
    NEXT["history"] = [_message("1", "第一則"), _message("2", "第二則")]

    out = await pack.call("discord.get_channel_history", server=GUILD, channel=CHANNEL, limit=2)

    assert [m["content"] for m in out] == ["第一則", "第二則"]


async def test_歷史的_author_是物件不是一個名字(pack: Pack) -> None:
    """`如果 ${m.author.bot}` 是這個包最常見的第一顆 if——不過濾掉 bot 自己說
    的話，「收到訊息就回一句」會變成無窮迴圈。名字黏成一句字串就問不出來。"""
    NEXT["history"] = [_message("1", "嗨", author=_user("42", "某人", bot=True))]

    out = await pack.call("discord.get_channel_history", server=GUILD, channel=CHANNEL, limit=1)

    assert out[0]["author"] == {
        "id": "42",
        "name": "某人",
        "display_name": "某人",
        "bot": True,
    }


async def test_歷史把_limit_送出去(pack: Pack) -> None:
    NEXT["history"] = []
    await pack.call("discord.get_channel_history", server=GUILD, channel=CHANNEL, limit=7)

    gets = [r for r in SEEN if r["method"] == "GET" and "/messages" in r["path"]]
    assert gets[-1]["query"]["limit"] == ["7"]


async def test_歷史的每一則都是可序列化的值(pack: Pack) -> None:
    """§7.5 的邊界只放行 §4.3 的六種值。`datetime` 漏出去的話，錯誤會在 host
    的邊界上以「回傳值不可序列化」出現，而不是在這裡。"""
    NEXT["history"] = [_message(content="嗨")]

    out = await pack.call("discord.get_channel_history", server=GUILD, channel=CHANNEL, limit=1)

    json.dumps(out)  # 炸了就是有東西不該在那裡
    assert out[0]["created_at"] == "2026-09-01T12:00:00+00:00"


# --------------------------------------------------------------------------
# 生命週期
# --------------------------------------------------------------------------


async def test_卸載時把_aiohttp_的_session_關掉() -> None:
    """`openai` 不必寫 `on_unload`，因為底下那條 httpx client 是 host 的；這裡
    那條 aiohttp session 是 discord.py 自己開的（`http.py:831`），沒有人會替它
    關。漏掉的症狀是子 process 每次卸載都留一條連線與一句
    `Unclosed client session`。"""
    contexts = CallContexts()
    host = InProcessHost(
        discover(BUNDLED_ROOT),
        EventSinkChannel(EventSink(), contexts),
        contexts,
        config={"discord": {"bot_token": "tok-test"}},
    )
    await host.load("discord")
    ctx = contexts.open("discord", thread_id="t_1", block_id="blk_1")
    args = {"message": "嗨", "server": GUILD, "channel": CHANNEL}
    await host.call("discord.send_message", args, ctx.token)
    client = host._loaded["discord"].state["rest"]
    contexts.close(ctx.token)

    await host.unload("discord")

    assert client.is_closed() or client.http._HTTPClient__session.closed


# --------------------------------------------------------------------------
# 動態下拉（P1 第 4 步：第一個吃「同積木其他已填參數」的下拉）
# --------------------------------------------------------------------------


async def test_伺服器下拉列出_bot_進得去的伺服器(pack: Pack) -> None:
    NEXT["guilds"] = [_guild("1", "A 伺服器"), _guild("2", "B 伺服器")]

    assert await pack.dropdown("servers") == [
        {"label": "A 伺服器", "value": "1"},
        {"label": "B 伺服器", "value": "2"},
    ]


async def test_伺服器下拉走_REST_而不是_gateway_的快取(pack: Pack) -> None:
    """`client.guilds` 讀的是 gateway 快取，而這個包從不 IDENTIFY——用錯的話
    症狀是一份**永遠空白**的下拉，而使用者的 bot 明明就在那些伺服器裡。"""
    await pack.dropdown("servers")

    assert any(r["path"].endswith("/users/@me/guilds") for r in SEEN)


async def test_還沒選伺服器時頻道下拉是空的而不是錯誤(pack: Pack) -> None:
    """使用者從左往右填，還沒選伺服器的那一刻本來就問不出頻道。一顆點開就跳
    紅字的下拉會讓人以為自己已經做錯了什麼。"""
    assert await pack.dropdown("channels", server="") == []
    assert SEEN == []          # 連線都不必開


async def test_頻道下拉只列送得進訊息的頻道(pack: Pack) -> None:
    """分類與論壇不是「可以發訊息的地方」。判準用 SDK 自己的
    `abc.Messageable`，不是一張自己列的型別名單——名單會在 Discord 下次多一種
    頻道時默默過期。"""
    NEXT["channels"] = [
        _text_channel("10", "一般", position=0),
        _category("20", "語音區", position=1),
    ]

    assert await pack.dropdown("channels", server=GUILD) == [
        {"label": "#一般", "value": "10"}
    ]


async def test_頻道下拉把分類名一起寫進去(pack: Pack) -> None:
    """這顆下拉存在的理由是「兩個伺服器裡都有 #一般」，而**同一個伺服器裡也
    常常有兩個 #一般**（不同分類底下）。只寫頻道名的話，它解決了跨伺服器那
    一半，留下伺服器內那一半。"""
    NEXT["channels"] = [
        _category("20", "公開", position=0),
        _category("21", "私密", position=1),
        _text_channel("10", "一般", position=0, parent="20"),
        _text_channel("11", "一般", position=0, parent="21"),
    ]

    assert await pack.dropdown("channels", server=GUILD) == [
        {"label": "公開 / #一般", "value": "10"},
        {"label": "私密 / #一般", "value": "11"},
    ]


async def test_沒宣告的_key_進不到積木包(pack: Pack) -> None:
    """端點的 body 來自瀏覽器，終點是積木包的一個 Python 函式。中間不過濾的話
    那條路就是「任意 kwargs 進到積木包」，而第一個症狀會是一句
    `TypeError: got an unexpected keyword argument`，主詞指著積木包。"""
    NEXT["channels"] = [_text_channel("10", "一般")]

    out = await pack.dropdown("channels", server=GUILD, 惡意="rm -rf")

    assert out == [{"label": "#一般", "value": "10"}]

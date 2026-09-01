"""Discord 積木包的實作（§15、P1 第 4 步）。

**REST 與 gateway 是兩條路，這個包只在需要時才走第二條。** 動手前照規矩把
discord.py 2.7.1 裝下來翻過原始碼，翻出來最重要的一件事是
`Client.login()` 不開 WebSocket——它只打 `GET /users/@me` 加一次
`application_info()`（`discord/client.py:647`），`Client.start()` 才是
`login()` + `connect()`。所以 `send_message` 這種一次性的動作用一個
login-only 的 client 就夠了：不必等 `on_ready`、不必要 privileged intent、
不必為了發一句話養一條長連線。這件事如果照訓練資料裡的印象寫成
「discord bot 就是 `client.run(token)`」，症狀會是「發一則訊息要先卡住五秒，
而且沒開 Message Content Intent 的人直接失敗」——**兩個症狀都不指向真正的
原因**。

**`ctx.http` 在這個包身上守不住**（§7.4、§12.1）：`HTTPClient.static_login()`
自己 `aiohttp.ClientSession(...)` 建下去（`discord/http.py:831`），沒有
`AsyncOpenAI(http_client=...)` 那種注入點。不硬塞——改 SDK 的連線層換來的是
一份得跟著上游版本走的補丁，而 `permissions: [net]` 的價值不值那個維護成本。
代價老實寫在 manifest 與 §12.1 上。

**所以 client 的生命週期是這個包自己的責任。** `openai` 不必寫 `on_unload`，
因為底下那條 httpx client 是 host 的；這裡那條 aiohttp session 是
discord.py 的，沒有人會替它關——漏掉就是子 process 每次卸載都留一條連線與
一句 `Unclosed client session` 的警告。
"""

from __future__ import annotations

import asyncio
import re

import discord

from blocky import BlockError, block, dropdown, on_unload, trigger

# `https://discord.com/channels/<guild>/<channel>` — 在 Discord 裡對頻道按
# 「複製連結」拿到的就是這個。ID 在最後一段。
_CHANNEL_URL = re.compile(r"^https?://(?:\w+\.)?discord(?:app)?\.com/channels/(\d+|@me)/(\d+)")
_SNOWFLAKE = re.compile(r"^\d{15,25}$")


@block("discord.send_message")
async def send_message(ctx, message, server, channel):
    # **先看得懂那兩格，再開連線。** 順序反過來的話，一個把「#一般」貼進頻道
    # 欄的人如果 token 也還沒設好，會先被告知 token 的事——修完 token 再跑一次
    # 才輪到真正擋住他的那件事。本地就判得出來的錯不該排在一次網路來回後面。
    guild_id, channel_id = _ids(server, channel)
    target = (await _rest(ctx)).get_partial_messageable(channel_id, guild_id=guild_id)
    sent = await _call(ctx, target.send(message), what="發送訊息")
    # 執行紀錄裡放一條點得到「我剛剛發的那則」的連結，比一個訊息 id 有用
    # ——id 要再貼回 Discord 才看得到東西。
    ctx.log(f"已發送到頻道 {target.id}：{_jump_url(target, sent.id)}")


@block("discord.get_channel_history")
async def get_channel_history(ctx, server, channel, limit):
    guild_id, channel_id = _ids(server, channel)
    target = (await _rest(ctx)).get_partial_messageable(channel_id, guild_id=guild_id)

    async def collect():
        return [_message(target, m) async for m in target.history(limit=int(limit))]

    return await _call(ctx, collect(), what="讀取頻道歷史")


@dropdown("discord.servers")
async def servers(ctx):
    """這隻 bot 被邀請進去的伺服器。

    走 `fetch_guilds()`（REST），不是 `client.guilds`——後者讀的是 gateway 的
    快取，而這個包的 REST client 從不 IDENTIFY，那份快取永遠是空的。症狀會是
    一份**永遠空白**的下拉，而使用者的 bot 明明就在三個伺服器裡。
    """
    client = await _rest(ctx)
    return [
        {"label": g.name, "value": str(g.id)}
        async for g in _iter(ctx, client.fetch_guilds(), what="讀取伺服器清單")
    ]


@dropdown("discord.channels")
async def channels(ctx, server):
    """那個伺服器裡，這隻 bot 送得出訊息的頻道。

    `server` 由 manifest 的 `depends: [server]` 帶進來。**空的是正常狀態**，
    不是錯誤：使用者從左往右填，還沒選伺服器的那一刻本來就問不出頻道。回一份
    空清單，不要丟例外——一顆點開就跳紅字的下拉會讓人以為自己已經做錯了什麼。
    """
    if not server.strip():
        return []

    client = await _rest(ctx)
    guild = await _call(ctx, client.fetch_guild(int(server)), what="讀取伺服器")
    found = await _call(ctx, guild.fetch_channels(), what="讀取頻道清單")

    # `abc.Messageable` 是 SDK 自己對「送得進訊息嗎」的定義（文字、語音內建的
    # 文字、舞台都算；分類與論壇不算）。用它而不是自己列一張型別名單——名單會
    # 在 Discord 下次多一種頻道時默默過期，而過期的症狀是「我明明看得到那個
    # 頻道，下拉裡卻沒有」。
    # **分類要自己接起來，不能用 `c.category`。** 那個屬性查的是
    # `guild.get_channel(category_id)`——gateway 的快取，而 `fetch_channels()`
    # 不會把結果放進去（它只是回一串物件）。所以在這條 REST 路徑上
    # `c.category` 永遠是 None，症狀是分類名默默不見，而不是報錯。
    categories = {c.id: c for c in found if isinstance(c, discord.CategoryChannel)}
    sendable = [c for c in found if isinstance(c, discord.abc.Messageable)]
    sendable.sort(key=lambda c: (_category_position(categories, c), c.position))
    return [
        {"label": _channel_label(categories, c), "value": str(c.id)} for c in sendable
    ]


@trigger("discord.on_message")
async def on_message(ctx):
    """gateway：這個包唯一一條長連線（§7.3、§9）。

    **跟 REST 那條完全分開，連 client 都不共用。** `_rest()` 那一支是 login-only
    的，intents 對它沒有意義；這一支要 IDENTIFY，而 IDENTIFY 帶的 intents 決定
    Discord 願意推什麼給我們。共用一支的話，每個只想發一則訊息的專案都要付一條
    WebSocket，而且會因為少了一個 privileged intent 而失敗。

    **discord.py 是 callback 導向的，`@trigger` 是 async generator**，所以中間要
    一個 queue：`on_message` 事件把訊息放進去，這裡拿出來 yield。

    `client.start()` 是一條**跑到連線斷掉才會回來**的協程，所以它自己一個 task。
    每一圈同時等「queue 有東西」與「那個 task 結束了」——只等 queue 的話，
    連線失敗（token 錯、Message Content Intent 沒開）會變成**永遠安靜地掛著**：
    使用者按了監聽、什麼也沒發生、也沒有任何錯誤。那是這一段最容易做錯的地方。
    """
    token = ctx.require_secret("bot_token")

    intents = discord.Intents.none()
    intents.guilds = True
    intents.guild_messages = True
    # privileged。沒開的話連得上、收得到事件，但 `content` 一律是空字串——
    # **比連不上更難查**，所以下面的 `_gateway_error` 會把它單獨講出來。
    intents.message_content = True

    client = discord.Client(intents=intents)
    inbox: asyncio.Queue = asyncio.Queue()

    @client.event
    async def on_message(msg):
        # **濾掉這隻 bot 自己說的話。** 這是唯一一條寫死的過濾，因為「收到訊息
        # 就回一句」是這顆 hat 最直覺的第一個用法，而它會讓 bot 對著自己講到
        # 被限流。別的 bot 不濾——`${author.bot}` 交給畫布判斷，那是使用者的
        # 決定。
        if client.user is not None and msg.author.id == client.user.id:
            return
        await inbox.put(msg)

    connection = asyncio.create_task(client.start(token))
    try:
        while True:
            incoming = asyncio.create_task(inbox.get())
            done, _ = await asyncio.wait(
                {incoming, connection}, return_when=asyncio.FIRST_COMPLETED
            )
            if connection in done:
                incoming.cancel()
                _raise_gateway_error(ctx, connection)
            yield _event(incoming.result())
    finally:
        connection.cancel()
        await client.close()


def _raise_gateway_error(ctx, connection) -> None:
    """連線那條 task 結束了——把它為什麼結束翻成一句人看得懂的話再丟出去。

    **這個函式一定會丟例外**，所以它 raise 而不是回傳一個例外給呼叫端丟：
    `raise X from e` 的 `from` 只跟 `raise` 走，回傳的寫法連語法都不合法。

    `PrivilegedIntentsRequired` 單獨列，是因為它是這顆 hat 最容易踩到的一個坑，
    而 Discord 給的英文訊息只說「你要的 intent 沒開」，不說要去哪裡開。
    """
    try:
        connection.result()
    except discord.PrivilegedIntentsRequired as e:
        raise BlockError(
            "Discord 拒絕連線：這隻 bot 沒有開 Message Content Intent。"
            "到 Developer Portal → 你的 App → Bot → Privileged Gateway Intents，"
            "打開 MESSAGE CONTENT INTENT 再按一次監聽"
        ) from e
    except discord.LoginFailure as e:
        raise ctx.invalid_secret(
            "bot_token", "Discord 說這個 Bot Token 不對或已經失效，連不上 gateway"
        ) from e
    except Exception as e:
        raise BlockError(f"Discord 的連線斷了：{type(e).__name__}: {e}") from e
    # 沒有例外——`client.close()` 之類的正常結束。
    raise BlockError("Discord 的連線結束了")


def _event(m) -> dict:
    """一則訊息在 hat 底下綁成的那幾個變數（manifest 的 `yields`）。"""
    return {
        "content": m.content,
        "author": {
            "id": str(m.author.id),
            "name": m.author.name,
            "display_name": m.author.display_name,
            "bot": m.author.bot,
        },
        "channel_id": str(m.channel.id),
        "message": {
            "id": str(m.id),
            "content": m.content,
            "channel_id": str(m.channel.id),
            "created_at": m.created_at.isoformat(),
            # 這裡的 `jump_url` 是對的，不必像 REST 那條路自己組：gateway 有
            # `intents.guilds`，所以 guild 快取是滿的（`_jump_url` 的註解說的
            # 就是**沒有**這條連線時的情況）。
            "url": m.jump_url,
        },
    }


@on_unload
async def teardown(ctx):
    client = ctx.state.pop("rest", None)
    if client is not None:
        await client.close()


# --------------------------------------------------------------------------


async def _rest(ctx):
    """login-only 的 client（不開 gateway）。第一次用到才建。

    `Intents.none()` 是誠實的：intent 只在 gateway 的 IDENTIFY 上有意義，這條
    路根本不 IDENTIFY。填 `Intents.default()` 會讓讀原始碼的人以為這裡跟
    privileged intent 有關係——`on_message` 那顆 hat 才有，而它會有自己的
    client。
    """
    client = ctx.state.get("rest")
    if client is not None:
        return client

    token = ctx.require_secret("bot_token")
    client = discord.Client(intents=discord.Intents.none())
    try:
        await client.login(token)
    except discord.LoginFailure as e:
        # 建到一半就失敗，session 已經開了（`static_login` 先建 session 才打
        # 第一個請求），所以這裡一定要收；而且**不能**存進 ctx.state，否則下
        # 一次呼叫會拿到一個沒 login 過的 client，錯誤會變成別的樣子。
        await client.close()
        raise ctx.invalid_secret(
            "bot_token",
            "Discord 說這個 Bot Token 不對或已經失效。Token 被 Reset 過的話舊的那把會立刻失效",
        ) from e
    except discord.HTTPException as e:
        await client.close()
        raise BlockError(f"連不上 Discord（{e.status}）：{_reason(e)}") from e

    ctx.state["rest"] = client
    return client


async def _call(ctx, coro, *, what: str):
    """把 discord.py 的例外翻成主詞正確的一句話（§7.3「誰做錯了」）。

    這裡的分界跟 `http` 包相反、跟 `openai` 同一邊：`http.get` 的 404 是伺服器
    對「使用者自己打的那個網址」的回答，所以它回 `ok: false` 的正常值；這裡的
    403 是「這隻 bot 沒被邀請進那個頻道」，沒有一個合理的工作流會想用
    `如果 ${r.ok}` 去接它。
    """
    try:
        return await coro
    except discord.Forbidden as e:
        raise BlockError(
            f"{what}失敗：這隻 bot 沒有權限。確認它已經被邀請進這個伺服器，"
            f"而且在該頻道有對應的權限（{_reason(e)}）"
        ) from e
    except discord.NotFound as e:
        raise BlockError(
            f"{what}失敗：找不到這個頻道。頻道被刪掉了，或這個 ID 屬於"
            f"另一個 bot 看不到的伺服器（{_reason(e)}）"
        ) from e
    except discord.HTTPException as e:
        # 其餘的 4xx／5xx：訊息超過 2000 字、附件太大、Discord 自己掛掉……。
        # 原句交出去比翻成一句籠統的中文有用——那句話裡通常寫著哪裡不合法。
        raise BlockError(f"{what}失敗，Discord 回了 {e.status}：{_reason(e)}") from e


def _ids(server, channel) -> tuple[int | None, int]:
    """把使用者填的那兩格變成 `(伺服器 ID, 頻道 ID)`。純本地，不碰網路。

    伺服器那一格**有值就用它**，沒有才退回頻道網址裡的那一段。兩者都沒有就是
    `None`，`_jump_url` 會誠實地吐 `@me` 版本。

    收頻道 ID，也收整條頻道網址——後者才是使用者剪貼簿裡真的有的東西：在
    Discord 裡對頻道按「複製連結」是一步，「複製頻道 ID」要先去設定裡開開發者
    模式。只認 ID 的話，貼上網址會得到一句「這不是數字」，而使用者手上並沒有
    第二個東西可以貼。

    **網址裡的伺服器 ID 順手留下**：`_jump_url` 靠它才組得出對的連結，而那個
    id 使用者剛剛已經給過我們了。只給頻道 ID 的人拿到 `None`——那是資訊真的
    不存在，不是我們沒去拿。
    """
    picked = str(server).strip()
    guild_id = int(picked) if _SNOWFLAKE.match(picked) else None

    text = str(channel).strip()
    if not text:
        raise BlockError("頻道還沒選。先選伺服器，頻道那一格才列得出東西")

    # 下拉送出的就是一個 ID，所以正常情況下面第二條就中了。網址那一條留著是
    # 因為 IR 存的是字串——手寫的 project.json、下拉還沒接上時存下的舊檔、
    # 從別人那裡複製過來的積木，值都可能長成別的樣子（§13.1：opcode 不變，
    # 但值的來路會變）。而使用者剪貼簿裡真的有的東西就是那條網址。
    if m := _CHANNEL_URL.match(text):
        from_url = m.group(1)
        return (guild_id or (None if from_url == "@me" else int(from_url))), int(m.group(2))
    if _SNOWFLAKE.match(text):
        return guild_id, int(text)

    raise BlockError(
        f"看不懂這個頻道：{text!r}。要的是頻道 ID（一串數字），"
        "或整條頻道網址（https://discord.com/channels/…）"
    )


def _category_position(categories, c) -> int:
    """沒有分類的頻道排在最上面，跟 Discord 側邊欄一樣。"""
    cat = categories.get(c.category_id)
    return cat.position if cat else -1


def _channel_label(categories, c) -> str:
    """分類名一起放進去。

    這顆下拉存在的理由就是「兩個伺服器裡都有 #一般」，而**同一個伺服器裡也
    常常有兩個 #一般**（不同分類底下）。只寫頻道名的話，下拉解決了跨伺服器
    那一半，留下伺服器內那一半。
    """
    name = f"#{c.name}" if isinstance(c, discord.TextChannel) else f"🔊 {c.name}"
    cat = categories.get(c.category_id)
    return f"{cat.name} / {name}" if cat else name


async def _iter(ctx, gen, *, what: str):
    """async generator 版的 `_call`：例外一樣要翻成主詞正確的一句話。"""
    try:
        async for item in gen:
            yield item
    except discord.HTTPException as e:
        raise BlockError(f"{what}失敗，Discord 回了 {e.status}：{_reason(e)}") from e


def _message(target, m) -> dict:
    """一則訊息在畫布上的樣子。

    只留在畫布上用得到的欄位。`author` 是**物件**而不是一個名字：`如果
    ${m.author.bot}` 是這個包最常見的第一顆 if——不過濾掉 bot 自己說的話，
    「收到訊息就回一句」會變成無窮迴圈。
    """
    return {
        "id": str(m.id),
        "content": m.content,
        "author": {
            "id": str(m.author.id),
            "name": m.author.name,
            "display_name": m.author.display_name,
            "bot": m.author.bot,
        },
        "channel_id": str(target.id),
        # ISO 8601、帶時區。§4.9 的日期時間積木吃得下，人也讀得懂。
        "created_at": m.created_at.isoformat(),
        "url": _jump_url(target, m.id),
    }


def _jump_url(target, message_id) -> str:
    """自己組，不用 `Message.jump_url`。

    SDK 那個屬性讀的是 `self.guild`，而 `Message.guild` 來自
    `channel.guild` → `ConnectionState._get_guild()`（`message.py:2233`）——
    那是 **gateway 的快取**。這個包的 REST 路徑從不 IDENTIFY，快取永遠是空的，
    所以 `sent.jump_url` 在這裡一律吐 `.../channels/@me/…`，而那條連結指的是
    私訊。使用者貼進瀏覽器會得到「找不到」，然後開始懷疑訊息沒發出去——
    但訊息其實發出去了。

    伺服器 ID 在使用者貼進來的那條網址裡就有（`_channel` 已經接住），所以這裡
    組得出對的。只給頻道 ID 的人仍然拿到 `@me` 版本：那是資訊真的不存在。
    """
    return f"https://discord.com/channels/{target.guild_id or '@me'}/{target.id}/{message_id}"


def _reason(e) -> str:
    """`HTTPException.text` 是 Discord 回的原文，`e.text` 空的時候退回 str(e)。"""
    return (getattr(e, "text", "") or "").strip() or str(e)

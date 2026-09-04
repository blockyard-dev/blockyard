"""`event.when_webhook`：路徑、token 與 `/hooks/…`（§9.1、§9.3，P2 第 2c 步）。"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from blockyard.api.app import create_app
from blockyard.errors import ValidationError
from blockyard.extensions import DEFAULT_EXTENSIONS_ROOT
from blockyard.webhook import WebhookSpec, parse


def hook_project(project_id: str = "p_hook", *, path: str = "github") -> dict[str, Any]:
    return {
        "formatVersion": 1,
        "meta": {"id": project_id, "name": "掛鉤"},
        "scripts": [{"id": "sc_1", "top": "hat"}],
        "blocks": {
            "hat": {"opcode": "event.when_webhook", "next": "say", "fields": {"path": path}},
            "say": {
                "opcode": "debug.log",
                "parent": "hat",
                "inputs": {"text": {"kind": "template", "value": "收到 ${body.who}"}},
            },
        },
    }


def app_for(tmp_path: Path) -> Any:
    return create_app(db_path=tmp_path / "blockyard.db", extensions_root=DEFAULT_EXTENSIONS_ROOT)


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with TestClient(app_for(tmp_path)) as c:
        yield c


def save(client: TestClient, project: dict[str, Any]) -> Any:
    return client.put(f"/api/projects/{project['meta']['id']}", json=project)


def activate(client: TestClient, project_id: str = "p_hook") -> dict[str, Any]:
    res = client.post("/api/triggers", json={"projectId": project_id})
    assert res.status_code == 201, res.text
    return res.json()


# --------------------------------------------------------------------------
# 1. 路徑解析
# --------------------------------------------------------------------------


@pytest.mark.parametrize("raw", ["github", "/github", "github/", " /github/ "])
def test_paths_are_normalised(raw: str) -> None:
    """使用者會打 `/hook`、`hook`、`/hook/`，心裡想的是同一件事。三種當成不同的
    路徑的話，他會盯著一個「明明設好了卻 404」的畫面。"""
    assert parse({"path": raw}) == WebhookSpec("github")


def test_nested_paths_are_allowed() -> None:
    assert parse({"path": "github/push"}).path == "github/push"


@pytest.mark.parametrize("raw", ["", "   ", None])
def test_an_empty_path_is_an_error(raw: Any) -> None:
    with pytest.raises(ValidationError):
        parse({"path": raw})


@pytest.mark.parametrize("raw", ["a//b", "a/../b", "./a"])
def test_dodgy_paths_are_rejected(raw: str) -> None:
    """它們不會造成路徑穿越（我們是在自己的 dict 裡查表），但會讓同一個 webhook
    有兩個網址寫法——而 §9.3 的安全模型建立在「這個網址猜不到」上。"""
    with pytest.raises(ValidationError):
        parse({"path": raw})


def test_non_ascii_paths_are_rejected() -> None:
    """這個網址要貼進別的系統的設定欄位，那些欄位對非 ASCII 的處理各家不同。"""
    with pytest.raises(ValidationError) as e:
        parse({"path": "推播"})
    assert "英數字" in str(e.value)


# --------------------------------------------------------------------------
# 2. 存檔期擋下
# --------------------------------------------------------------------------


def test_a_bad_path_is_rejected_at_save_time(client: TestClient) -> None:
    res = save(client, hook_project(path="a//b"))
    assert res.status_code == 422
    assert res.json()["detail"]["blockId"] == "hat"


def test_two_blocks_on_the_same_path_are_rejected(client: TestClient) -> None:
    """兩顆都存得進去、都掛得上，但請求只會餵到其中一顆——而畫面上兩顆長得
    一樣。這是一個看不出來的錯，所以擋在存檔。"""
    project = hook_project()
    project["scripts"].append({"id": "sc_2", "top": "hat2"})
    project["blocks"]["hat2"] = {"opcode": "event.when_webhook", "fields": {"path": "github"}}

    res = save(client, project)

    assert res.status_code == 422
    assert "兩顆" in res.json()["detail"]["message"]


def test_different_paths_are_fine(client: TestClient) -> None:
    project = hook_project()
    project["scripts"].append({"id": "sc_2", "top": "hat2"})
    project["blocks"]["hat2"] = {"opcode": "event.when_webhook", "fields": {"path": "stripe"}}

    assert save(client, project).status_code in (200, 201)


# --------------------------------------------------------------------------
# 3. token 與網址
# --------------------------------------------------------------------------


def test_activating_hands_back_the_url(client: TestClient) -> None:
    save(client, hook_project())

    body = activate(client)

    assert len(body["webhooks"]) == 1
    url = body["webhooks"][0]["url"]
    assert url.startswith("/hooks/")
    assert url.endswith("/github")
    assert len(url.split("/")[2]) == 32  # §9.3 的 32 位隨機


def test_the_token_is_one_per_project_not_one_per_block(client: TestClient) -> None:
    """使用者要複製的是一個基底網址。一顆積木一把的話，畫面上每顆 webhook 都是
    一串不一樣的亂碼，而它們保護的是同一份專案。"""
    project = hook_project()
    project["scripts"].append({"id": "sc_2", "top": "hat2"})
    project["blocks"]["hat2"] = {"opcode": "event.when_webhook", "fields": {"path": "stripe"}}
    save(client, project)

    hooks = activate(client)["webhooks"]

    tokens = {h["url"].split("/")[2] for h in hooks}
    assert len(hooks) == 2
    assert len(tokens) == 1


def test_two_projects_get_different_tokens(client: TestClient) -> None:
    save(client, hook_project("p_a"))
    save(client, hook_project("p_b"))

    a = activate(client, "p_a")["webhooks"][0]["url"]
    b = activate(client, "p_b")["webhooks"][0]["url"]

    assert a.split("/")[2] != b.split("/")[2]


def test_the_token_survives_a_restart(tmp_path: Path) -> None:
    """token 是使用者貼進 GitHub 設定頁的那串東西。每次重啟換一把等於每次重啟
    都讓外面所有的 webhook 失效，而失效的樣子是「對方一直收到 404」——沒有人
    會來告訴他。"""
    with TestClient(app_for(tmp_path)) as c:
        save(c, hook_project())
        before = activate(c)["webhooks"][0]["url"]

    with TestClient(app_for(tmp_path)) as c:
        assert c.get("/api/triggers/p_hook").json()["webhooks"][0]["url"] == before


# --------------------------------------------------------------------------
# 4. 真的打進來
# --------------------------------------------------------------------------


def wait_run(client: TestClient, tries: int = 200) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    for _ in range(tries):
        runs = [r for r in client.get("/api/runs").json() if r["trigger"] == "event.when_webhook"]
        if runs:
            return runs
        client.portal.call(asyncio.sleep, 0.02)  # type: ignore[attr-defined]
    return runs


def test_a_post_starts_a_run_and_binds_the_body(client: TestClient) -> None:
    save(client, hook_project())
    url = activate(client)["webhooks"][0]["url"]

    res = client.post(url, json={"who": "小明"})

    assert res.status_code == 202
    runs = wait_run(client)
    assert runs, "webhook 掛上了但沒有跑起來"

    for _ in range(200):
        events = client.get(f"/api/runs/{runs[0]['runId']}/events").json()["events"]
        if any(e["op"] == "run.end" for e in events):
            break
        client.portal.call(asyncio.sleep, 0.02)  # type: ignore[attr-defined]
    assert any(e["op"] == "log" and e["text"] == "收到 小明" for e in events)


def test_a_wrong_token_is_404(client: TestClient) -> None:
    save(client, hook_project())
    activate(client)

    assert client.post("/hooks/" + "0" * 32 + "/github", json={}).status_code == 404


def test_a_wrong_path_is_the_same_404_as_a_wrong_token(client: TestClient) -> None:
    """兩種分開回答等於告訴掃描的人「token 對了，繼續猜路徑」。"""
    save(client, hook_project())
    token = activate(client)["webhooks"][0]["url"].split("/")[2]

    bad_path = client.post(f"/hooks/{token}/nope", json={})
    bad_token = client.post("/hooks/" + "0" * 32 + "/github", json={})

    assert bad_path.status_code == bad_token.status_code == 404
    assert bad_path.json() == bad_token.json()


def test_deactivating_takes_the_url_down(client: TestClient) -> None:
    save(client, hook_project())
    url = activate(client)["webhooks"][0]["url"]

    client.delete("/api/triggers/p_hook")

    assert client.post(url, json={}).status_code == 404


def test_changing_the_path_moves_the_url(client: TestClient) -> None:
    save(client, hook_project())
    old = activate(client)["webhooks"][0]["url"]

    save(client, hook_project(path="stripe"))

    assert client.post(old, json={}).status_code == 404
    new = client.get("/api/triggers/p_hook").json()["webhooks"][0]["url"]
    assert new.endswith("/stripe")
    assert client.post(new, json={}).status_code == 202


def test_a_get_also_works(client: TestClient) -> None:
    """對面是誰決定用什麼方法：有些服務會先用 GET 打一次做驗證。"""
    save(client, hook_project())
    url = activate(client)["webhooks"][0]["url"]

    assert client.get(url).status_code == 202


def test_credentials_never_reach_the_payload(client: TestClient) -> None:
    """`authorization` 進了 payload 就會沿著事件流廣播出去（§8.5 的 `block.enter`
    帶展開後的字串），而 §12.2 的遮蔽只認得「這次 Run 用到的 secret」——它不
    認識別人送來的 token。"""
    from blockyard.api.hooks import _STRIPPED_HEADERS

    assert {"authorization", "cookie"} <= _STRIPPED_HEADERS

    save(client, hook_project())
    url = activate(client)["webhooks"][0]["url"]
    seen: dict[str, Any] = {}

    manager = client.app.state.triggers  # type: ignore[attr-defined]
    original = manager.deliver

    async def spy(token: str, path: str, payload: dict[str, Any], **kw: Any) -> str:
        seen.update(payload)
        return await original(token, path, payload, **kw)

    manager.deliver = spy
    client.post(url, json={}, headers={"Authorization": "Bearer s3cret", "X-Hub": "github"})

    assert "authorization" not in seen["headers"]
    assert seen["headers"]["x-hub"] == "github"


def test_query_and_method_are_in_the_payload(client: TestClient) -> None:
    save(client, hook_project())
    url = activate(client)["webhooks"][0]["url"]
    seen: dict[str, Any] = {}

    manager = client.app.state.triggers  # type: ignore[attr-defined]
    original = manager.deliver

    async def spy(token: str, path: str, payload: dict[str, Any], **kw: Any) -> str:
        seen.update(payload)
        return await original(token, path, payload, **kw)

    manager.deliver = spy
    client.post(f"{url}?a=1&b=2", json={"x": 1})

    assert seen["query"] == {"a": "1", "b": "2"}
    assert seen["method"] == "POST"


def test_a_non_json_body_stays_text(client: TestClient) -> None:
    """D10「parse 不自動」：一個送 `text/plain` 但內容剛好長得像 JSON 的請求，
    解開之後積木上拿到的型別會跟它宣告的不一樣。"""
    from blockyard.api.hooks import _parse_body

    assert _parse_body(b'{"a": 1}', "text/plain") == '{"a": 1}'
    assert _parse_body(b'{"a": 1}', "application/json") == {"a": 1}
    assert _parse_body("壞掉的".encode(), "application/json") == "壞掉的"
    assert _parse_body(b"", "application/json") is None


def test_an_oversized_body_is_413(client: TestClient) -> None:
    """沒有上限的話，任何人都能拿這條路徑把記憶體吃光。"""
    from blockyard.api.hooks import MAX_BODY_BYTES

    save(client, hook_project())
    url = activate(client)["webhooks"][0]["url"]

    res = client.post(url, content=b"x" * (MAX_BODY_BYTES + 1))

    assert res.status_code == 413


def test_deleting_the_project_drops_the_token(client: TestClient) -> None:
    """留著的話，下一個剛好同名的專案會繼承一個外面可能還有人在打的網址。"""
    save(client, hook_project())
    activate(client)

    client.delete("/api/projects/p_hook")

    assert client.app.state.webhook_tokens.get("p_hook") is None  # type: ignore[attr-defined]


# --------------------------------------------------------------------------
# 5. 簽章驗證（§9.3、§16 Q22 決議 (a)）
# --------------------------------------------------------------------------


def signed_project(
    project_id: str = "p_hook",
    *,
    verify: str = "hmac_sha256",
    header: str = "X-Hub-Signature-256",
) -> dict[str, Any]:
    p = hook_project(project_id)
    p["blocks"]["hat"]["fields"].update({"verify": verify, "signature_header": header})
    return p


def set_secret(client: TestClient, block_id: str, secret: str) -> Any:
    """**blockId 走 body，不走網址路徑。** Blockly 的 id 大約五分之一含 `/`，
    而伺服器在路由之前就把 `%2F` 解回 `/`——路徑參數因此比對不上，回 404。"""
    return client.put(
        "/api/triggers/p_hook/secret",
        json={"blockId": block_id, "secret": secret},
    )


def sign(secret: str, body: bytes, algorithm: str = "sha256") -> str:
    import hmac

    return hmac.new(secret.encode(), body, algorithm).hexdigest()


def test_the_secret_never_appears_in_the_ir(client: TestClient) -> None:
    """D28：Key 不能存進專案檔——分享專案會變成分享明文金鑰。積木上只有三格
    **不是秘密**的東西：要不要驗、簽章在哪個 header、用哪個雜湊。"""
    save(client, signed_project())
    set_secret(client, "hat", "s3cret")

    stored = client.get("/api/projects/p_hook").json()
    assert "s3cret" not in str(stored)


def test_a_correct_signature_is_accepted(client: TestClient) -> None:
    save(client, signed_project())
    set_secret(client, "hat", "s3cret")
    url = activate(client)["webhooks"][0]["url"]

    body = b'{"who": "GitHub"}'
    res = client.post(
        url,
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Hub-Signature-256": "sha256=" + sign("s3cret", body),
        },
    )

    assert res.status_code == 202


def test_a_bare_hex_signature_also_works(client: TestClient) -> None:
    """`sha256=<hex>` 是 GitHub 的格式，裸 hex 是自己寫 webhook 的人最常送的。"""
    save(client, signed_project())
    set_secret(client, "hat", "s3cret")
    url = activate(client)["webhooks"][0]["url"]

    body = b"{}"
    res = client.post(
        url,
        content=body,
        headers={"Content-Type": "application/json", "X-Hub-Signature-256": sign("s3cret", body)},
    )

    assert res.status_code == 202


def test_a_wrong_signature_is_401_and_starts_no_run(client: TestClient) -> None:
    """401 而不是 404：對方已經知道網址了，而「你少了什麼」正是設定 webhook
    的人需要看到的。"""
    save(client, signed_project())
    set_secret(client, "hat", "s3cret")
    url = activate(client)["webhooks"][0]["url"]

    res = client.post(url, content=b"{}", headers={"X-Hub-Signature-256": "sha256=deadbeef"})

    assert res.status_code == 401
    assert client.get("/api/runs").json() == []


def test_a_missing_signature_header_is_401(client: TestClient) -> None:
    save(client, signed_project())
    set_secret(client, "hat", "s3cret")
    url = activate(client)["webhooks"][0]["url"]

    assert client.post(url, content=b"{}").status_code == 401


def test_no_secret_blocks_everything_it_does_not_fall_back_to_unverified(
    client: TestClient,
) -> None:
    """**這是這一整塊最要緊的一題。**

    「宣告要驗但驗不了」的正確答案不是放行——那會讓一份分享來的專案（密鑰沒
    跟著走，D28）安靜地退回不驗，而畫面上那顆積木還寫著「驗證簽章：
    HMAC-SHA256」。形狀不能說謊。
    """
    save(client, signed_project())
    url = activate(client)["webhooks"][0]["url"]  # 沒設密鑰

    body = b"{}"
    res = client.post(url, content=body, headers={"X-Hub-Signature-256": sign("", body)})

    assert res.status_code == 401
    assert client.get("/api/runs").json() == []


def test_the_state_says_whether_the_secret_is_set(client: TestClient) -> None:
    """沒設的話那顆積木現在擋掉每一則請求，而使用者要看得到這件事。"""
    save(client, signed_project())
    before = activate(client)["webhooks"][0]
    assert before["verify"] == "hmac_sha256"
    assert before["secretSet"] is False

    set_secret(client, "hat", "s3cret")
    assert activate(client)["webhooks"][0]["secretSet"] is True


def test_an_unverified_hook_has_no_secret_flag(client: TestClient) -> None:
    save(client, hook_project())
    entry = activate(client)["webhooks"][0]

    assert entry["verify"] == "none"
    assert "secretSet" not in entry


def test_clearing_the_secret_goes_back_to_blocking(client: TestClient) -> None:
    save(client, signed_project())
    set_secret(client, "hat", "s3cret")
    url = activate(client)["webhooks"][0]["url"]

    res = client.delete("/api/triggers/p_hook/secret", params={"blockId": "hat"})
    assert res.status_code == 204

    body = b"{}"
    res = client.post(url, content=body, headers={"X-Hub-Signature-256": sign("s3cret", body)})
    assert res.status_code == 401


def test_an_empty_secret_is_422_not_a_silent_clear(client: TestClient) -> None:
    save(client, signed_project())
    res = set_secret(client, "hat", "  ")

    assert res.status_code == 422


def test_verify_without_a_header_is_rejected_at_save_time(client: TestClient) -> None:
    res = save(client, signed_project(header=""))

    assert res.status_code == 422
    assert "header" in res.json()["detail"]["message"]


def test_an_unknown_verify_mode_is_rejected(client: TestClient) -> None:
    assert save(client, signed_project(verify="rot13")).status_code == 422


def test_sha1_works_too(client: TestClient) -> None:
    save(client, signed_project(verify="hmac_sha1", header="X-Signature"))
    set_secret(client, "hat", "s3cret")
    url = activate(client)["webhooks"][0]["url"]

    body = b"{}"
    res = client.post(
        url, content=body, headers={"X-Signature": "sha1=" + sign("s3cret", body, "sha1")}
    )

    assert res.status_code == 202


def test_the_signature_covers_the_raw_body_not_the_parsed_one(client: TestClient) -> None:
    """簽的是原始位元組。解析過再簽的話，一個多空白或不同 key 順序的 JSON 就
    會算出不同的簽章——而對面簽的是它送出去的那串。"""
    save(client, signed_project())
    set_secret(client, "hat", "s3cret")
    url = activate(client)["webhooks"][0]["url"]

    body = b'{"a":  1}'  # 刻意多一個空白
    res = client.post(
        url,
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Hub-Signature-256": "sha256=" + sign("s3cret", body),
        },
    )

    assert res.status_code == 202


def test_changing_the_secret_does_not_remount_the_route(client: TestClient) -> None:
    """密鑰不在 §9.2 的 spec 裡——驗證是每次請求進來時才做的事，路由沒有變。"""
    save(client, signed_project())
    set_secret(client, "hat", "one")
    url = activate(client)["webhooks"][0]["url"]

    set_secret(client, "hat", "two")

    body = b"{}"
    assert (
        client.post(
            url, content=body, headers={"X-Hub-Signature-256": "sha256=" + sign("two", body)}
        ).status_code
        == 202
    )


def test_a_block_id_with_a_slash_still_works(client: TestClient) -> None:
    """**這一題釘的是一個實測抓到的 bug。**

    Blockly 產生的 id 是從一鍋含 `!#$%()*+,-./:;=?@[]^_` 的字元裡抽出來的，
    **大約五分之一含有 `/`**。它原本在網址路徑上（`/secret/{block_id}`），而
    ASGI 伺服器會在路由**之前**就把 `%2F` 解碼回 `/`——那一格於是看到多出來的
    一段路徑，比對不上，回 404。

    症狀特別難查：使用者按了「設定密鑰」、畫面回到清單，而那一列仍然寫著
    「還沒設密鑰」——看起來像「存了但沒生效」，其實根本沒存進去。而且它**只有
    五分之一的積木會發生**，換一顆試就好了，於是更像是隨機的鬼。
    """
    tricky = ".@`7$@{)sHdd-l+HOP2/"
    project = signed_project()
    project["blocks"][tricky] = project["blocks"].pop("hat")
    project["blocks"]["say"]["parent"] = tricky
    project["scripts"][0]["top"] = tricky
    save(client, project)

    assert set_secret(client, tricky, "s3cret").status_code == 204

    entry = activate(client)["webhooks"][0]
    assert entry["blockId"] == tricky
    assert entry["secretSet"] is True

    body = b"{}"
    res = client.post(
        entry["url"],
        content=body,
        headers={"X-Hub-Signature-256": "sha256=" + sign("s3cret", body)},
    )
    assert res.status_code == 202


def test_reveal_hands_the_secret_back_for_the_clipboard(client: TestClient) -> None:
    """D28：「不顯示明文」擋的是**畫面上一直躺著一串密鑰**，而複製按鈕不違反
    它——值只進剪貼簿，而且要打一個**指名到這一顆**的端點才拿得到。"""
    save(client, signed_project())
    set_secret(client, "hat", "s3cret")

    res = client.get("/api/triggers/p_hook/secret/reveal", params={"blockId": "hat"})

    assert res.status_code == 200
    assert res.json()["value"] == "s3cret"
    # GET 預設可被快取，而這一份不該留在任何一層快取裡。
    assert res.headers["cache-control"] == "no-store"


def test_reveal_of_an_unset_secret_is_404(client: TestClient) -> None:
    save(client, signed_project())
    res = client.get("/api/triggers/p_hook/secret/reveal", params={"blockId": "hat"})
    assert res.status_code == 404


def test_the_secret_is_not_in_the_list_response(client: TestClient) -> None:
    """列表每開一次面板就打一次。把明文掛在上面等於讓它跟著每一次輪詢多走
    一趟，而 99% 的呼叫根本不需要它。"""
    save(client, signed_project())
    set_secret(client, "hat", "s3cret")

    assert "s3cret" not in str(activate(client))

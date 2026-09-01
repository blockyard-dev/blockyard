"""`event.when_webhook`：路徑、token 與 `/hooks/…`（§9.1、§9.3，P2 第 2c 步）。"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from blocky.api.app import create_app
from blocky.errors import ValidationError
from blocky.extensions import DEFAULT_EXTENSIONS_ROOT
from blocky.webhook import WebhookSpec, parse


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
    return create_app(db_path=tmp_path / "blocky.db", extensions_root=DEFAULT_EXTENSIONS_ROOT)


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
    from blocky.api.hooks import _STRIPPED_HEADERS

    assert {"authorization", "cookie"} <= _STRIPPED_HEADERS

    save(client, hook_project())
    url = activate(client)["webhooks"][0]["url"]
    seen: dict[str, Any] = {}

    manager = client.app.state.triggers  # type: ignore[attr-defined]
    original = manager.deliver

    async def spy(token: str, path: str, payload: dict[str, Any]) -> bool:
        seen.update(payload)
        return await original(token, path, payload)

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

    async def spy(token: str, path: str, payload: dict[str, Any]) -> bool:
        seen.update(payload)
        return await original(token, path, payload)

    manager.deliver = spy
    client.post(f"{url}?a=1&b=2", json={"x": 1})

    assert seen["query"] == {"a": "1", "b": "2"}
    assert seen["method"] == "POST"


def test_a_non_json_body_stays_text(client: TestClient) -> None:
    """D10「parse 不自動」：一個送 `text/plain` 但內容剛好長得像 JSON 的請求，
    解開之後積木上拿到的型別會跟它宣告的不一樣。"""
    from blocky.api.hooks import _parse_body

    assert _parse_body(b'{"a": 1}', "text/plain") == '{"a": 1}'
    assert _parse_body(b'{"a": 1}', "application/json") == {"a": 1}
    assert _parse_body("壞掉的".encode(), "application/json") == "壞掉的"
    assert _parse_body(b"", "application/json") is None


def test_an_oversized_body_is_413(client: TestClient) -> None:
    """沒有上限的話，任何人都能拿這條路徑把記憶體吃光。"""
    from blocky.api.hooks import MAX_BODY_BYTES

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

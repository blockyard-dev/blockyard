"""`/api/triggers`：專案的 active 狀態與它的 hat（§9、P2 第 2 步）。

這個檔案原本叫 `test_listeners.py`，守的是 P1 那條「把畫布上的 hat 接到真的
事件來源上」的縫：yield 出來的東西怎麼變成一次 Run、hat 的 `yields` 有沒有
真的綁進去、停掉之後那條連線是不是真的斷了。那些題目原樣留著——換掉的只有
端點，因為 P1 的 `/api/triggers`（這個 process 有沒有在聽）已經被 §9.2 的
active（這個專案是不是該跑，寫在 SQLite 上）取代。

新增的是 §9.2 另外三格：active 狀態、後端重啟恢復、**diff 新舊 hat 集合只重啟
有變動的**。最後一格的用處全在「不要無謂斷開」上——使用者改一顆 log 的文字然後
存檔，Discord 的 gateway 不該斷線重連。

題材用 `demo.on_tick`：它跳三拍就自己結束，不打網路、不需要金鑰，所以「三拍
= 三個 Run」是一個數得出來的斷言。`discord.on_message` 走的是同一條路，差別
只在事件從哪裡來。
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from blockyard.api.app import create_app
from blockyard.extensions import DEFAULT_EXTENSIONS_ROOT


def tick_project(project_id: str = "p_tick") -> dict[str, Any]:
    """一顆 `demo.on_tick` 的 hat，底下記一筆帶著 `${tick}` 的 log。

    `tick` 是 hat 的 `yields`（§5.4 第 2 層的 thread-local）。它出現在 log 裡
    才證明 payload 真的一路從 `@trigger` 的 yield 綁到了腳本裡——只數 Run 的
    數量的話，一個把 payload 丟掉的實作也會綠。
    """
    return {
        "formatVersion": 1,
        "meta": {"id": project_id, "name": "每一拍"},
        "extensions": [{"id": "demo", "version": "0.1.0"}],
        "scripts": [{"id": "sc_1", "top": "hat"}],
        "blocks": {
            "hat": {"opcode": "demo.on_tick", "next": "say"},
            "say": {
                "opcode": "debug.log",
                "inputs": {"text": {"kind": "template", "value": "tick=${tick}"}},
            },
        },
    }


def flag_project(project_id: str = "p_flag") -> dict[str, Any]:
    """沒有任何 hat（只有綠旗）。綠旗不是要接的東西。"""
    return {
        "formatVersion": 1,
        "meta": {"id": project_id, "name": "綠旗"},
        "scripts": [{"id": "sc_1", "top": "hat"}],
        "blocks": {
            "hat": {"opcode": "event.when_flag_clicked", "next": "say"},
            "say": {
                "opcode": "debug.log",
                "inputs": {"text": {"kind": "literal", "value": "hi"}},
            },
        },
    }


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    app = create_app(db_path=tmp_path / "blockyard.db", extensions_root=DEFAULT_EXTENSIONS_ROOT)
    with TestClient(app) as client:
        yield client


def save(client: TestClient, project: dict[str, Any]) -> str:
    pid = project["meta"]["id"]
    res = client.put(f"/api/projects/{pid}", json=project)
    assert res.status_code in (200, 201), res.text
    return pid


def runs_of(client: TestClient, trigger: str) -> list[dict[str, Any]]:
    return [r for r in client.get("/api/runs").json() if r["trigger"] == trigger]


def settle(client: TestClient, *, trigger: str, want: int, tries: int = 50) -> list[dict[str, Any]]:
    """等到 Run 的數量到齊。

    **不用 sleep 一個固定秒數**：那在慢的 CI 上會 flaky，然後被人把秒數調大，
    然後就沒有人知道它到底在等什麼了（同 `test_runs.py` 開頭的理由）。這裡等
    的是一個看得懂的條件。
    """
    for _ in range(tries):
        found = runs_of(client, trigger)
        if len(found) >= want:
            return found
        client.portal.call(asyncio.sleep, 0.02)  # type: ignore[attr-defined]
    return runs_of(client, trigger)


# --------------------------------------------------------------------------


def test_一顆_hat_都沒有不是錯誤(client: TestClient) -> None:
    """畫布上沒有 hat 時按啟用，使用者要看到的是「目前沒有東西要聽」，
    不是一句失敗。"""
    pid = save(client, flag_project())

    res = client.post("/api/triggers", json={"projectId": pid})

    assert res.status_code == 201
    assert res.json()["hats"] == []


def test_接上_hat_之後每一次_yield_都是一個_Run(client: TestClient) -> None:
    pid = save(client, tick_project())

    res = client.post("/api/triggers", json={"projectId": pid})
    assert res.json()["hats"] == ["demo.on_tick"]

    # on_tick 跳三拍就結束。
    assert len(settle(client, trigger="demo.on_tick", want=3)) == 3


def test_hat_的_yields_綁進腳本裡(client: TestClient) -> None:
    """只數 Run 的數量的話，一個把 payload 丟掉的實作也會綠。"""
    pid = save(client, tick_project())
    client.post("/api/triggers", json={"projectId": pid})
    runs = settle(client, trigger="demo.on_tick", want=3)

    # 每個 Run 的事件流裡那句 log 應該帶著自己那一拍的號碼。
    ticks = set()
    for run in runs:
        with client.websocket_connect(f"/ws/run/{run['runId']}") as ws:
            for _ in range(20):
                frame = ws.receive_json()
                for ev in frame.get("events", []):
                    if ev["op"] == "log":
                        ticks.add(ev["text"])
                    if ev["op"] == "run.end":
                        break
                else:
                    continue
                break

    assert ticks == {"tick=1", "tick=2", "tick=3"}


def test_重複啟用不是錯誤(client: TestClient) -> None:
    """前端的「執行」會順手打這一條，所以「已經開著」是最常見的情況。

    `activatedAt` 不刷新：每次都刷的話，「它從什麼時候開始跑」這個問題永遠
    答不出來。
    """
    pid = save(client, tick_project())

    first = client.post("/api/triggers", json={"projectId": pid}).json()
    second = client.post("/api/triggers", json={"projectId": pid}).json()

    assert first["activatedAt"] == second["activatedAt"]


def test_active_的專案列得出來(client: TestClient) -> None:
    pid = save(client, tick_project())
    client.post("/api/triggers", json={"projectId": pid})

    listed = client.get("/api/triggers").json()

    assert [x["projectId"] for x in listed] == [pid]
    assert listed[0]["hats"] == ["demo.on_tick"]


def test_停掉之後就不在清單裡了(client: TestClient) -> None:
    pid = save(client, tick_project())
    client.post("/api/triggers", json={"projectId": pid})

    assert client.delete(f"/api/triggers/{pid}").status_code == 204
    assert client.get("/api/triggers").json() == []


def test_沒在跑的時候停掉也是_204(client: TestClient) -> None:
    """使用者要的結果是「現在沒在跑」，而那已經成立。"""
    pid = save(client, tick_project())
    assert client.delete(f"/api/triggers/{pid}").status_code == 204


def test_停掉之後可以再啟用一次(client: TestClient) -> None:
    """開了又關、關了又開是使用者一定會做的事，而它會走到「那條連線真的關掉
    了嗎」——沒關乾淨的話第二次會拿到一個已經死掉的 client。"""
    pid = save(client, tick_project())
    client.post("/api/triggers", json={"projectId": pid})
    client.delete(f"/api/triggers/{pid}")

    res = client.post("/api/triggers", json={"projectId": pid})

    assert res.status_code == 201
    assert res.json()["hats"] == ["demo.on_tick"]


def test_沒存過的專案是_404_不是_422(client: TestClient) -> None:
    res = client.post("/api/triggers", json={"projectId": "p_nope"})

    assert res.status_code == 404
    assert "先存檔" in res.json()["detail"]["hint"]


def test_沒有_hat_的專案不開任何子行程(client: TestClient, monkeypatch: Any) -> None:
    """**這一題釘住的是成本，不是行為。**

    `open_project` 會替每個宣告過的積木包各起一個子行程（§7.6），而前端的「執行」
    會順手打這條路——一個畫布上沒有 hat、卻宣告了三個包的專案，每按一次執行就
    是三個子行程開起來只為了立刻被關掉。判斷「有沒有 hat」只需要磁碟上的
    manifest（資料），不需要 `main.py`（程式碼），所以這個成本是可以整個省掉的。
    """
    from blockyard.runs import triggers as mod

    opened = 0

    async def spy(*args: Any, **kwargs: Any) -> Any:
        nonlocal opened
        opened += 1
        raise AssertionError("不該為了一個沒有 hat 的專案載入積木包")

    monkeypatch.setattr(mod, "open_project", spy)

    # `demo` 有宣告，但畫布上那顆 hat 是內建的綠旗。
    project = flag_project("p_no_hat")
    project["extensions"] = [{"id": "demo", "version": "0.1.0"}]
    pid = save(client, project)

    res = client.post("/api/triggers", json={"projectId": pid})

    assert res.status_code == 201
    assert res.json()["hats"] == []
    assert opened == 0


# --------------------------------------------------------------------------
# §9.2：active 狀態、重啟恢復、diff
# --------------------------------------------------------------------------


def app_for(tmp_path: Path) -> Any:
    return create_app(db_path=tmp_path / "blockyard.db", extensions_root=DEFAULT_EXTENSIONS_ROOT)


def test_沒在跑的專案問得到答案而不是_404(client: TestClient) -> None:
    """「它是不是 active」對任何存在的專案都有答案，而那個答案是 false。"""
    pid = save(client, tick_project())

    body = client.get(f"/api/triggers/{pid}").json()

    assert body == {
        "projectId": pid,
        "active": False,
        "hats": [],
        "errors": [],
        "webhooks": [],
    }


def test_active_跨後端重啟存活(tmp_path: Path) -> None:
    """§9.2 最後一句。**這是「關掉瀏覽器仍會準時執行」（§1.3）的前半段**——
    沒有它，使用者設好的流程活不過一次 `blockyard serve` 的重開。"""
    with TestClient(app_for(tmp_path)) as c:
        pid = save(c, tick_project())
        assert c.post("/api/triggers", json={"projectId": pid}).status_code == 201

    with TestClient(app_for(tmp_path)) as c:  # 新的 process，同一個檔案
        listed = c.get("/api/triggers").json()
        assert [x["projectId"] for x in listed] == [pid]
        assert listed[0]["hats"] == ["demo.on_tick"]


def test_重啟之後_trigger_真的在跑而不只是列得出來(tmp_path: Path) -> None:
    """列得出來只證明那張表讀回來了。**要證明的是連線真的接上了**——
    `on_tick` 跳三拍，所以重啟之後應該又有三個 Run。"""
    with TestClient(app_for(tmp_path)) as c:
        pid = save(c, tick_project())
        c.post("/api/triggers", json={"projectId": pid})
        settle(c, trigger="demo.on_tick", want=3)

    with TestClient(app_for(tmp_path)) as c:
        assert len(settle(c, trigger="demo.on_tick", want=6)) == 6


def test_停掉之後重啟就不再跑了(tmp_path: Path) -> None:
    """反面：active 是被寫掉的，不是只從記憶體移除。"""
    with TestClient(app_for(tmp_path)) as c:
        pid = save(c, tick_project())
        c.post("/api/triggers", json={"projectId": pid})
        c.delete(f"/api/triggers/{pid}")

    with TestClient(app_for(tmp_path)) as c:
        assert c.get("/api/triggers").json() == []


def test_專案在後端沒開的時候被刪掉_啟動不會炸(tmp_path: Path) -> None:
    """啟動路徑上一個壞掉的 active 紀錄不該擋住整個後端起來。"""
    from blockyard.storage import ActiveStore

    ActiveStore(tmp_path / "blockyard.db").activate("p_ghost")

    with TestClient(app_for(tmp_path)) as c:
        assert c.get("/api/triggers").json() == []
        # 順手清掉，不留一筆永遠恢復不了的紀錄
        assert ActiveStore(tmp_path / "blockyard.db").list() == []


def test_刪掉專案會一起停掉它的_trigger(client: TestClient) -> None:
    pid = save(client, tick_project())
    client.post("/api/triggers", json={"projectId": pid})

    assert client.delete(f"/api/projects/{pid}").status_code == 204
    assert client.get("/api/triggers").json() == []


def test_存檔會重新對齊_active_專案(client: TestClient) -> None:
    """§9.2「專案編輯後」。把 hat 拿掉再存檔，那條 trigger 就該斷了。"""
    pid = save(client, tick_project())
    client.post("/api/triggers", json={"projectId": pid})
    assert client.get(f"/api/triggers/{pid}").json()["hats"] == ["demo.on_tick"]

    without = flag_project(pid)
    without["meta"]["id"] = pid
    save(client, without)

    assert client.get(f"/api/triggers/{pid}").json()["hats"] == []


def test_存檔不會把關著的專案打開(client: TestClient) -> None:
    pid = save(client, tick_project())
    save(client, tick_project())

    assert client.get("/api/triggers").json() == []
    assert client.get(f"/api/triggers/{pid}").json()["active"] is False


def test_改一顆無關的積木不會重接那條連線(client: TestClient, monkeypatch: Any) -> None:
    """**§9.2 的 diff 就是為了這一題。**

    使用者改一句 log 的文字然後存檔，Discord 的 gateway 不該斷線重連——那會掉
    訊息，而且要花好幾秒。沒有 diff 的話「重新對齊」就等於「全部重來」，而那在
    畫面上跟壞掉沒有兩樣。
    """
    from blockyard.extensions.registry import ExtensionRegistry

    starts = 0
    original = ExtensionRegistry.start_trigger

    async def spy(self: Any, opcode: str, sink: Any) -> Any:
        nonlocal starts
        starts += 1
        return await original(self, opcode, sink)

    monkeypatch.setattr(ExtensionRegistry, "start_trigger", spy)

    pid = save(client, tick_project())
    client.post("/api/triggers", json={"projectId": pid})
    assert starts == 1

    edited = tick_project(pid)
    edited["blocks"]["say"]["inputs"]["text"] = {"kind": "literal", "value": "改過了"}
    save(client, edited)

    assert starts == 1  # hat 沒變 → 那條連線原封不動
    assert client.get(f"/api/triggers/{pid}").json()["hats"] == ["demo.on_tick"]

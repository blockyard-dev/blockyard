"""`/api/listeners`：把畫布上的 hat 接到真的事件來源上（§9、P1 第 4 步第 3 段）。

**`start_trigger` 在這一步之前，生產路徑上一個呼叫者都沒有**（唯一的呼叫者是
`tests/contract/test_host_boundary.py`）。所以這裡驗的不是「trigger 能不能
yield」——那個合約測試已經守著——而是**中間那條沒有人負責的縫**：yield 出來
的東西怎麼變成一次 Run、hat 的 `yields` 有沒有真的綁進去、監聽停掉之後那條連
線是不是真的斷了。PROGRESS 那六條的第 5 條講的就是這種縫。

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

from blocky.api.app import create_app
from blocky.extensions import DEFAULT_EXTENSIONS_ROOT


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
    app = create_app(db_path=tmp_path / "blocky.db", extensions_root=DEFAULT_EXTENSIONS_ROOT)
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
    """畫布上沒有 hat 時按監聽，使用者要看到的是「目前沒有東西要聽」，
    不是一句失敗。"""
    pid = save(client, flag_project())

    res = client.post("/api/listeners", json={"projectId": pid})

    assert res.status_code == 201
    assert res.json()["hats"] == []


def test_接上_hat_之後每一次_yield_都是一個_Run(client: TestClient) -> None:
    pid = save(client, tick_project())

    res = client.post("/api/listeners", json={"projectId": pid})
    assert res.json()["hats"] == ["demo.on_tick"]

    # on_tick 跳三拍就結束。
    assert len(settle(client, trigger="demo.on_tick", want=3)) == 3


def test_hat_的_yields_綁進腳本裡(client: TestClient) -> None:
    """只數 Run 的數量的話，一個把 payload 丟掉的實作也會綠。"""
    pid = save(client, tick_project())
    client.post("/api/listeners", json={"projectId": pid})
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


def test_重複按監聽不是錯誤(client: TestClient) -> None:
    """前端的「執行」會順手打這一條，所以「已經開著」是最常見的情況。"""
    pid = save(client, tick_project())

    first = client.post("/api/listeners", json={"projectId": pid}).json()
    second = client.post("/api/listeners", json={"projectId": pid}).json()

    assert first["startedAt"] == second["startedAt"]


def test_監聽中的專案列得出來(client: TestClient) -> None:
    pid = save(client, tick_project())
    client.post("/api/listeners", json={"projectId": pid})

    listed = client.get("/api/listeners").json()

    assert [x["projectId"] for x in listed] == [pid]
    assert listed[0]["hats"] == ["demo.on_tick"]


def test_斷開之後就不在清單裡了(client: TestClient) -> None:
    pid = save(client, tick_project())
    client.post("/api/listeners", json={"projectId": pid})

    assert client.delete(f"/api/listeners/{pid}").status_code == 204
    assert client.get("/api/listeners").json() == []


def test_沒在聽的時候斷開也是_204(client: TestClient) -> None:
    """使用者要的結果是「現在沒在聽」，而那已經成立。"""
    pid = save(client, tick_project())
    assert client.delete(f"/api/listeners/{pid}").status_code == 204


def test_斷開之後可以再接一次(client: TestClient) -> None:
    """接了又斷、斷了又接是使用者一定會做的事，而它會走到「那條連線真的關掉
    了嗎」——沒關乾淨的話第二次會拿到一個已經死掉的 client。"""
    pid = save(client, tick_project())
    client.post("/api/listeners", json={"projectId": pid})
    client.delete(f"/api/listeners/{pid}")

    res = client.post("/api/listeners", json={"projectId": pid})

    assert res.status_code == 201
    assert res.json()["hats"] == ["demo.on_tick"]


def test_沒存過的專案是_404_不是_422(client: TestClient) -> None:
    res = client.post("/api/listeners", json={"projectId": "p_nope"})

    assert res.status_code == 404
    assert "先存檔" in res.json()["detail"]["hint"]


def test_沒有_hat_的專案不開任何子行程(client: TestClient, monkeypatch: Any) -> None:
    """**這一題釘住的是成本，不是行為。**

    `open_project` 會替每個宣告過的積木包各起一個子行程（§7.6），而前端的「執行」
    會順手打這條路——一個畫布上沒有 hat、卻宣告了三個包的專案，每按一次執行就
    是三個子行程開起來只為了立刻被關掉。判斷「有沒有 hat」只需要磁碟上的
    manifest（資料），不需要 `main.py`（程式碼），所以這個成本是可以整個省掉的。
    """
    from blocky.runs import listeners as mod

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

    res = client.post("/api/listeners", json={"projectId": pid})

    assert res.status_code == 201
    assert res.json()["hats"] == []
    assert opened == 0

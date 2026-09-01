"""執行歷史端到端（§6.3 的落地，P2 第 1 步）。

P2 的驗收句是「設定每天 09:00 的流程，**關掉瀏覽器**，隔天檢查執行歷史有紀錄」。
排程那半是第 2 步（Trigger Manager），這裡守的是**另一半**：跑過的東西在後端
重啟之後還在。落地之前它必然失敗——那時執行歷史是 `RunManager` 裡的一個 dict。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from blocky.api.app import create_app
from blocky.extensions import DEFAULT_EXTENSIONS_ROOT
from blocky.storage import INTERRUPTED, RunStore


def app_for(tmp_path: Path) -> Any:
    return create_app(db_path=tmp_path / "blocky.db", extensions_root=DEFAULT_EXTENSIONS_ROOT)


@pytest.fixture
def client(tmp_path: Path) -> Any:
    with TestClient(app_for(tmp_path)) as c:
        yield c


def project(*, log_texts: list[str] | None = None) -> dict[str, Any]:
    """一顆綠旗 hat 底下接幾顆 `log`。"""
    texts = log_texts if log_texts is not None else ["哈囉"]
    blocks: dict[str, Any] = {
        "hat": {"opcode": "event.when_flag_clicked", "next": "log_0" if texts else None}
    }
    for i, text in enumerate(texts):
        blocks[f"log_{i}"] = {
            "opcode": "debug.log",
            "parent": f"log_{i - 1}" if i else "hat",
            "next": f"log_{i + 1}" if i + 1 < len(texts) else None,
            "inputs": {"text": {"kind": "literal", "value": text}},
        }
    return {
        "formatVersion": 1,
        "meta": {"id": "p1", "name": "測試"},
        "scripts": [{"id": "sc_1", "top": "hat"}],
        "blocks": blocks,
    }


def save_and_run(client: TestClient, data: dict[str, Any] | None = None) -> str:
    data = data or project()
    pid = data["meta"]["id"]
    assert client.put(f"/api/projects/{pid}", json=data).status_code in (200, 201)
    r = client.post("/api/runs", json={"projectId": pid})
    assert r.status_code == 201, r.text
    return r.json()["runId"]


def wait_done(client: TestClient, run_id: str) -> dict[str, Any]:
    for _ in range(200):
        body = client.get(f"/api/runs/{run_id}").json()
        if body["status"] != "running":
            return body
        client.get("/api/health")  # 讓 event loop 轉一圈
    raise AssertionError(f"{run_id} 沒有結束")


# --------------------------------------------------------------------------
# 1. 跨後端重啟
# --------------------------------------------------------------------------


def test_history_survives_a_restart(tmp_path: Path) -> None:
    """P2 驗收句的那一半：關掉後端，回來還在。"""
    with TestClient(app_for(tmp_path)) as c:
        run_id = save_and_run(c)
        wait_done(c, run_id)

    with TestClient(app_for(tmp_path)) as c:  # 新的 process，同一個檔案
        listed = c.get("/api/runs").json()
        assert [r["runId"] for r in listed] == [run_id]
        assert listed[0]["status"] == "ok"
        assert c.get(f"/api/runs/{run_id}").json()["runId"] == run_id


def test_run_ids_do_not_repeat_after_a_restart(tmp_path: Path) -> None:
    """落地之前 `r_{self._seq}` 每次重啟都從 1 開始——那時無所謂，因為重啟就
    沒有歷史了。現在有了，`r_1` 會直接覆蓋昨天那一筆。"""
    with TestClient(app_for(tmp_path)) as c:
        first = save_and_run(c)
        wait_done(c, first)

    with TestClient(app_for(tmp_path)) as c:
        second = save_and_run(c)
        wait_done(c, second)
        assert second != first
        assert {r["runId"] for r in c.get("/api/runs").json()} == {first, second}


def test_a_killed_run_is_marked_interrupted_not_cancelled(tmp_path: Path) -> None:
    """後端被砍時還在跑的 Run。`cancelled` 是使用者按了停止，是一個有人做過
    的決定；這個是沒有人知道它跑到哪裡。"""
    store = RunStore(tmp_path / "blocky.db")
    store.start("r_1", seq=1, project_id="p1", trigger="flag", started_at="2026-09-01T00:00:00Z")

    with TestClient(app_for(tmp_path)) as c:
        assert c.get("/api/runs/r_1").json()["status"] == INTERRUPTED


# --------------------------------------------------------------------------
# 2. GET /api/runs/{id}/events
# --------------------------------------------------------------------------


def test_events_endpoint_returns_the_skeleton_and_the_logs(client: TestClient) -> None:
    run_id = save_and_run(client, project(log_texts=["一", "二"]))
    wait_done(client, run_id)

    body = client.get(f"/api/runs/{run_id}/events").json()
    ops = [e["op"] for e in body["events"]]
    assert ops[0] == "run.start"
    assert ops[-1] == "run.end"
    assert [e["text"] for e in body["events"] if e["op"] == "log"] == ["一", "二"]
    assert [e["seq"] for e in body["events"]] == sorted(e["seq"] for e in body["events"])


def test_events_endpoint_never_returns_debug_signals(client: TestClient) -> None:
    """§6.3：`block.enter/exit` 是除錯用的即時訊號，不是稽核紀錄。查不到是
    規格，不是缺陷——沒有這條規則，一個掛著跑三天的迴圈會寫進幾億列。"""
    run_id = save_and_run(client, project(log_texts=["一", "二", "三"]))
    wait_done(client, run_id)

    ops = {e["op"] for e in client.get(f"/api/runs/{run_id}/events").json()["events"]}
    assert ops.isdisjoint({"block.enter", "block.exit", "var.set", "block.hot"})


def test_events_of_an_unknown_run_is_404(client: TestClient) -> None:
    assert client.get("/api/runs/沒這個/events").status_code == 404


def test_events_paginate_by_seq(client: TestClient) -> None:
    run_id = save_and_run(client, project(log_texts=[str(i) for i in range(6)]))
    wait_done(client, run_id)

    first = client.get(f"/api/runs/{run_id}/events?limit=3").json()
    assert len(first["events"]) == 3
    assert first["nextAfter"] == first["events"][-1]["seq"]

    rest = client.get(f"/api/runs/{run_id}/events?after={first['nextAfter']}").json()
    assert rest["events"][0]["seq"] > first["nextAfter"]
    assert rest["nextAfter"] is None  # 沒滿一頁 = 沒有下一頁


def test_events_survive_a_restart(tmp_path: Path) -> None:
    with TestClient(app_for(tmp_path)) as c:
        run_id = save_and_run(c, project(log_texts=["記得我"]))
        wait_done(c, run_id)

    with TestClient(app_for(tmp_path)) as c:
        events = c.get(f"/api/runs/{run_id}/events").json()["events"]
        assert [e["text"] for e in events if e["op"] == "log"] == ["記得我"]


# --------------------------------------------------------------------------
# 3. 清單
# --------------------------------------------------------------------------


def test_list_is_newest_first_and_filterable_by_project(client: TestClient) -> None:
    a = save_and_run(client)
    wait_done(client, a)
    other = project()
    other["meta"]["id"] = "p2"
    b = save_and_run(client, other)
    wait_done(client, b)

    assert [r["runId"] for r in client.get("/api/runs").json()] == [b, a]
    assert [r["runId"] for r in client.get("/api/runs?projectId=p1").json()] == [a]


def test_deleting_a_project_takes_its_history_with_it(client: TestClient) -> None:
    """歷史指向一份不存在的專案是沒有用的紀錄——點進去看不到任何積木。"""
    run_id = save_and_run(client)
    wait_done(client, run_id)

    assert client.delete("/api/projects/p1").status_code == 204
    assert client.get("/api/runs").json() == []
    assert client.get(f"/api/runs/{run_id}").status_code == 404


def test_stopping_an_already_finished_run_is_still_202(client: TestClient) -> None:
    """使用者按下停止與 Run 自己結束是一場競賽，而「你按晚了」不是錯誤。"""
    run_id = save_and_run(client)
    wait_done(client, run_id)

    r = client.delete(f"/api/runs/{run_id}")
    assert r.status_code == 202
    assert r.json()["status"] == "ok"


# --------------------------------------------------------------------------
# 4. §5.4 第 4 層
# --------------------------------------------------------------------------


def persist_project() -> dict[str, Any]:
    """`記住 [count] 為 (記住的 count，沒有時 0) + 1`。"""
    return {
        "formatVersion": 1,
        "meta": {"id": "p1", "name": "計數"},
        "scripts": [{"id": "sc_1", "top": "hat"}],
        "blocks": {
            "hat": {"opcode": "event.when_flag_clicked", "next": "set"},
            "set": {
                "opcode": "data.persist_set",
                "parent": "hat",
                "fields": {"name": "count"},
                "inputs": {"value": {"kind": "block", "id": "add"}},
            },
            "add": {
                "opcode": "operator.add",
                "parent": "set",
                "inputs": {
                    "a": {"kind": "block", "id": "get"},
                    "b": {"kind": "literal", "value": 1},
                },
            },
            "get": {
                "opcode": "data.persist_get",
                "parent": "add",
                "fields": {"name": "count"},
                "inputs": {"default": {"kind": "literal", "value": 0}},
            },
        },
    }


def test_persist_survives_a_restart(tmp_path: Path) -> None:
    """D12 承諾的「跨 Run、跨後端重啟」——落地之前只兌現了前一半，而
    `manager.py` 的註解自己也承認了。"""
    with TestClient(app_for(tmp_path)) as c:
        for _ in range(2):
            wait_done(c, save_and_run(c, persist_project()))

    with TestClient(app_for(tmp_path)) as c:
        wait_done(c, save_and_run(c, persist_project()))
        assert RunStore(tmp_path / "blocky.db").persist_snapshot("p1") == {"count": 3}

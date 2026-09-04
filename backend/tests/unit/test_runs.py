"""`/api/runs`、WebSocket 事件流、§6.2 的批次與聚合、§5.5 的外部停止。

分成三層，愈上面的愈不需要時序：

  1. `collapse()`  §6.2 的**規則**。純函數，一個 event loop 都不用起。
  2. RunManager     Run 的生命週期。要 event loop，但不要 HTTP。
  3. TestClient     整條路：POST → WS → 事件 → DELETE。

規則寫在第 1 層是刻意的：「20 次以上聚合」「var.set 收斂」這些是協定，必須
用讀得懂的方式斷言，而不是靠「跑一個迴圈然後數 frame」——後者會在慢的 CI 上
變成 flaky，然後被人加上 sleep，然後就沒有人知道它到底在測什麼了。
"""

from __future__ import annotations

import asyncio
import json
from collections import Counter
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from blockyard.api.app import create_app
from blockyard.extensions import DEFAULT_EXTENSIONS_ROOT
from blockyard.runs.broker import HOT_THRESHOLD, ProjectHub, RunBroker, collapse

# --------------------------------------------------------------------------
# 題材：§15 驗收 1 的那份專案
# --------------------------------------------------------------------------


def counting_project(times: int = 10, project_id: str = "p_run") -> dict[str, Any]:
    """「重複 N 次 → 改變 count 增加 1」＋收尾 log。§15 P0b 驗收 1 的本體。"""
    return {
        "formatVersion": 1,
        "meta": {"id": project_id, "name": "計數"},
        "scripts": [{"id": "sc_1", "top": "hat"}],
        "blocks": {
            "hat": {"opcode": "event.when_flag_clicked", "next": "init"},
            "init": {
                "opcode": "data.set",
                "fields": {"name": "count"},
                "inputs": {"value": {"kind": "literal", "value": 0}},
                "next": "loop",
            },
            "loop": {
                "opcode": "control.repeat",
                "inputs": {
                    "times": {"kind": "literal", "value": times},
                    "body": {"kind": "stack", "id": "bump"},
                },
                "next": "say",
            },
            "bump": {
                "opcode": "data.change",
                "fields": {"name": "count"},
                "inputs": {"value": {"kind": "literal", "value": 1}},
            },
            "say": {
                "opcode": "debug.log",
                "inputs": {"text": {"kind": "template", "value": "count=${count}"}},
            },
        },
    }


def forever_project(project_id: str = "p_forever") -> dict[str, Any]:
    """永遠不會自己結束。只有 §5.5 的外部停止能讓它停下來。"""
    return {
        "formatVersion": 1,
        "meta": {"id": project_id, "name": "無限"},
        "scripts": [{"id": "sc_1", "top": "hat"}],
        "blocks": {
            "hat": {"opcode": "event.when_flag_clicked", "next": "loop"},
            "loop": {
                "opcode": "control.forever",
                "inputs": {"body": {"kind": "stack", "id": "bump"}},
            },
            "bump": {
                "opcode": "data.set",
                "fields": {"name": "n"},
                "inputs": {"value": {"kind": "literal", "value": 1}},
            },
        },
    }


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    """**一定要用 context manager**。

    `TestClient` 不進 `with` 的話，每個 request 各起一個 event loop 再關掉——
    `POST /api/runs` 建立的 Run task 會在回應送出的同一刻被那個 loop 收走，
    於是「執行」變成「執行然後立刻被取消」。這是這一步唯一一個會讓人以為
    產品碼壞掉的測試環境陷阱，所以寫在這裡而不是各個測試裡。

    進 `with` 也順便跑到 lifespan，也就是關機時 `RunManager.shutdown()` 那條路。
    """
    app = create_app(db_path=tmp_path / "blockyard.db", extensions_root=DEFAULT_EXTENSIONS_ROOT)
    with TestClient(app) as client:
        yield client


def save(client: TestClient, project: dict[str, Any]) -> str:
    pid = project["meta"]["id"]
    res = client.put(f"/api/projects/{pid}", json=project)
    assert res.status_code in (200, 201), res.text
    return pid


def drain(ws: Any, *, limit: int = 400) -> list[dict[str, Any]]:
    """讀到 `run.end` 為止，攤平成事件序列。

    §6.2 的 frame 是 `{"runId":…, "events":[…]}`，所以「收到幾個 frame」是時序
    的產物、不是規格；測試一律看攤平之後的事件。
    """
    events: list[dict[str, Any]] = []
    for _ in range(limit):
        frame = ws.receive_json()
        events.extend(frame["events"])
        if any(e["op"] == "run.end" for e in frame["events"]):
            return events
    raise AssertionError(f"收了 {limit} 個 frame 還沒等到 run.end：{events[-5:]}")


# --------------------------------------------------------------------------
# 1. §6.2 的規則（純函數）
# --------------------------------------------------------------------------


def _enter(bid: str, thread: str = "t_1") -> dict[str, Any]:
    return {"op": "block.enter", "threadId": thread, "blockId": bid}


def _exit(bid: str, value: Any = None, thread: str = "t_1") -> dict[str, Any]:
    ev: dict[str, Any] = {"op": "block.exit", "threadId": thread, "blockId": bid}
    if value is not None:
        ev["value"] = value
    return ev


def test_collapse_leaves_cold_blocks_alone() -> None:
    """驗收 1 的「逐顆積木高亮」：重複 10 次不該被聚合掉。"""
    events = [x for i in range(10) for x in (_enter("bump"), _exit("bump"))]
    out = collapse(events, Counter())
    assert out == events
    assert not any(e["op"] == "block.hot" for e in out)


def test_collapse_aggregates_hot_block() -> None:
    n = HOT_THRESHOLD + 1
    events = [x for i in range(n) for x in (_enter("bump"), _exit("bump", value=i))]
    out = collapse(events, Counter())

    assert out == [{"op": "block.hot", "blockId": "bump", "count": n, "lastValue": n - 1}]


def test_hot_count_is_cumulative_across_windows() -> None:
    """`count` 是這個 Run 至今的總數，不是這個窗口的——UI 顯示的是「×4210」。"""
    totals: Counter[str] = Counter()
    window = [_enter("bump") for _ in range(HOT_THRESHOLD + 1)]

    first = collapse(list(window), totals)
    second = collapse(list(window), totals)

    assert first[-1]["count"] == HOT_THRESHOLD + 1
    assert second[-1]["count"] == 2 * (HOT_THRESHOLD + 1)


def test_collapse_keeps_logs_and_errors_verbatim() -> None:
    """§6.3 要落地的那半永遠不聚合、不收斂：它們是紀錄，不是即時訊號。"""
    hot = [_enter("bump") for _ in range(HOT_THRESHOLD + 1)]
    logs = [{"op": "log", "level": "info", "text": f"#{i}"} for i in range(30)]
    err = {"op": "block.error", "threadId": "t_1", "blockId": "bump", "error": {"code": "type"}}

    out = collapse([*hot, *logs, err], Counter())

    assert [e for e in out if e["op"] == "log"] == logs
    assert err in out


def test_collapse_coalesces_var_set_by_name() -> None:
    """同一個名稱只留最後一次；不同名稱各留各的，且保持原本的相對位置。"""
    events = [
        {"op": "var.set", "name": "count", "value": 1},
        {"op": "var.set", "name": "other", "value": "a"},
        {"op": "var.set", "name": "count", "value": 2},
        {"op": "var.set", "name": "count", "value": 3},
    ]
    out = collapse(events, Counter())

    assert out == [
        {"op": "var.set", "name": "count", "value": 3},
        {"op": "var.set", "name": "other", "value": "a"},
    ]






def test_collapse_marks_truncated_last_value() -> None:
    """§6.2 的 4KB 上限由引擎標記，聚合事件要把它帶下去——不然前端會以為
    `lastValue` 是完整的值。"""
    events = [_enter("big") for _ in range(HOT_THRESHOLD + 1)]
    events.append({"op": "block.exit", "blockId": "big", "value": "…", "truncated": True})

    (hot,) = [e for e in collapse(events, Counter()) if e["op"] == "block.hot"]
    assert hot["truncated"] is True


# --------------------------------------------------------------------------
# 2. Broker 的時序：backlog
# --------------------------------------------------------------------------


async def test_broker_holds_backlog_until_first_subscriber() -> None:
    """`POST` 與 WebSocket 之間的空窗不能吃掉 `run.start`。"""
    broker = RunBroker("r_1", window_s=0.001)
    broker.start()
    broker.publish({"op": "run.start", "runId": "r_1"})
    await asyncio.sleep(0.01)

    async with broker.subscribe() as frames:
        broker.publish({"op": "run.end", "runId": "r_1", "status": "ok"})
        broker.close()
        got = [e for frame in [f async for f in frames] for e in frame["events"]]

    assert [e["op"] for e in got] == ["run.start", "run.end"]


async def test_broker_second_subscriber_gets_no_backlog() -> None:
    """§6.3：`block.enter` 不落地，錯過就是錯過。第二個訂閱者不該看到歷史。"""
    broker = RunBroker("r_1", window_s=0.001)
    broker.start()
    broker.publish({"op": "run.start", "runId": "r_1"})
    await asyncio.sleep(0.01)

    async with broker.subscribe() as first:
        assert [e["op"] for e in (await anext(first))["events"]] == ["run.start"]
        async with broker.subscribe() as second:
            broker.close()
            assert [f async for f in second] == []


async def test_broker_drops_oldest_for_slow_subscriber() -> None:
    """慢客戶端不能把後端拖垮。丟掉可以，但下一個 frame 要說丟了幾筆。"""
    broker = RunBroker("r_1", window_s=0.001, queue_limit=2)
    broker.start()
    async with broker.subscribe() as frames:
        for i in range(6):
            broker.publish({"op": "log", "level": "info", "text": str(i)})
            await asyncio.sleep(0.005)
        broker.close()

        received = [f async for f in frames]

    assert sum(f.get("dropped", 0) for f in received) > 0
    assert sum(len(f["events"]) for f in received) < 6


async def test_project_hub_fans_out_every_run_of_that_project() -> None:
    """專案通道拿的是**每一個** Run 的 frame，而且不必有人訂閱那個 Run。

    這正是它存在的理由：hat 觸發的 Run 只有零點幾毫秒，沒有人來得及訂閱它。
    """
    hub = ProjectHub("p_1")
    async with hub.subscribe() as frames:
        broker = RunBroker("r_1", window_s=0.001, on_frame=lambda b: hub.publish("r_1", b))
        broker.start()
        broker.publish({"op": "run.start", "runId": "r_1"})
        await asyncio.sleep(0.01)
        broker.close()

        first = await anext(frames)
        assert first["runId"] == "r_1"
        assert [e["op"] for e in first["events"]] == ["run.start"]

        # 下一個 Run 走同一條通道——**它不會結束**，等的就是下一個。
        second_broker = RunBroker(
            "r_2", window_s=0.001, on_frame=lambda b: hub.publish("r_2", b)
        )
        second_broker.start()
        second_broker.publish({"op": "run.start", "runId": "r_2"})
        await asyncio.sleep(0.01)
        second_broker.close()

        assert (await anext(frames))["runId"] == "r_2"


async def test_project_hub_does_not_steal_the_run_backlog() -> None:
    """接了專案通道之後，`/ws/run` 的第一個訂閱者仍然拿得到 backlog。

    做成 `on_frame` 而不是讓 hub 去 `subscribe()` 就是為了這件事：那個介面的
    第一個訂閱者會把積壓的事件領走，而 backlog 是留給「POST 回來到 WS 接上」
    那幾毫秒的——被領走的話，手動執行會固定看不到 `run.start`。
    """
    hub = ProjectHub("p_1")
    broker = RunBroker("r_1", window_s=0.001, on_frame=lambda b: hub.publish("r_1", b))
    broker.start()
    async with hub.subscribe() as project_frames:
        broker.publish({"op": "run.start", "runId": "r_1"})
        await asyncio.sleep(0.01)
        assert [e["op"] for e in (await anext(project_frames))["events"]] == ["run.start"]

        async with broker.subscribe() as run_frames:
            broker.close()
            assert [e["op"] for e in (await anext(run_frames))["events"]] == ["run.start"]


async def test_project_hub_drops_oldest_for_a_slow_subscriber() -> None:
    """與 `RunBroker` 同一條丟棄策略——慢客戶端不能把後端拖垮。"""
    hub = ProjectHub("p_1", queue_limit=2)
    async with hub.subscribe() as frames:
        for i in range(6):
            hub.publish("r_1", [{"op": "log", "level": "info", "text": str(i)}])
        received = [await anext(frames) for _ in range(2)]

    assert sum(f.get("dropped", 0) for f in received) > 0


def test_project_socket_sees_a_run_it_never_asked_for(client: TestClient) -> None:
    """整條路：先接上通道，再從別的地方起一個 Run。

    模擬的是 hat 觸發——前端沒有那個 runId，也沒有機會去要。
    """
    pid = save(client, counting_project(times=3, project_id="p_hub"))
    with client.websocket_connect(f"/ws/project/{pid}") as ws:
        run_id = client.post("/api/runs", json={"projectId": pid}).json()["runId"]

        events: list[dict[str, Any]] = []
        for _ in range(400):
            frame = ws.receive_json()
            assert frame["runId"] == run_id
            events.extend(frame["events"])
            if any(e["op"] == "run.end" for e in frame["events"]):
                break
        else:
            raise AssertionError("等不到 run.end")

    ops = [e["op"] for e in events]
    assert ops[0] == "run.start" and ops[-1] == "run.end"
    # 這條通道上的東西與 `/ws/run` 完全一樣——變數與高亮都在，這正是「跑完才
    # 讀落地事件」那條路給不出來的（§6.3：var.set 與 block.enter/exit 不落地）。
    assert any(e["op"] == "var.set" and e["name"] == "count" for e in events)
    assert any(e["op"] == "block.enter" for e in events)


def test_project_socket_rejects_an_unknown_project(client: TestClient) -> None:
    """打錯 id 的話，那條 socket 會安靜地永遠等不到任何東西。"""
    with pytest.raises(Exception):  # noqa: B017  starlette 把 close code 包成自己的例外
        with client.websocket_connect("/ws/project/nope") as ws:
            ws.receive_json()


# --------------------------------------------------------------------------
# 3. 整條路：POST → WS → DELETE
# --------------------------------------------------------------------------


def test_run_emits_the_acceptance_sequence(client: TestClient) -> None:
    """§15 P0b 驗收 1：逐顆積木高亮、變數面板即時變動。"""
    pid = save(client, counting_project(times=10))
    run = client.post("/api/runs", json={"projectId": pid})
    assert run.status_code == 201, run.text
    run_id = run.json()["runId"]

    with client.websocket_connect(f"/ws/run/{run_id}") as ws:
        events = drain(ws)

    ops = [e["op"] for e in events]
    assert ops[0] == "run.start"
    assert ops[-1] == "run.end"
    assert events[-1]["status"] == "ok"
    assert "thread.start" in ops and "thread.end" in ops

    # 逐顆高亮：10 圈的 data.change 各自有 enter，沒有被聚合成 block.hot
    assert sum(1 for e in events if e["op"] == "block.enter" and e["blockId"] == "bump") == 10
    assert not any(e["op"] == "block.hot" for e in events)

    # 變數面板：set 一次 + change 十次；50ms 窗口內會收斂，但最後的值必須對
    sets = [e for e in events if e["op"] == "var.set" and e["name"] == "count"]
    assert sets and sets[-1]["value"] == 10

    assert [e["text"] for e in events if e["op"] == "log"] == ["count=10"]


def test_hot_loop_is_aggregated(client: TestClient) -> None:
    """`forever` 打爆 WebSocket 的那條路：跑得夠快就會收到 `block.hot`。"""
    pid = save(client, counting_project(times=2000, project_id="p_hot"))
    run_id = client.post("/api/runs", json={"projectId": pid}).json()["runId"]

    with client.websocket_connect(f"/ws/run/{run_id}") as ws:
        events = drain(ws)

    hot = [e for e in events if e["op"] == "block.hot"]
    assert hot, "2000 圈應該至少有一個窗口超過 20 次"
    assert all(h["count"] > HOT_THRESHOLD for h in hot)
    # 聚合的重點：送出去的事件數遠少於實際執行的積木數
    assert sum(1 for e in events if e["op"] == "block.enter") < 2000


def test_delete_stops_a_forever_loop(client: TestClient) -> None:
    """§15 的「按停止能立即中斷」。緊迴圈也要停得下來（§5.2 的讓出點）。"""
    pid = save(client, forever_project())
    run_id = client.post("/api/runs", json={"projectId": pid}).json()["runId"]

    with client.websocket_connect(f"/ws/run/{run_id}") as ws:
        ws.receive_json()  # 先確定它真的跑起來了
        assert client.get(f"/api/runs/{run_id}").json()["status"] == "running"

        assert client.delete(f"/api/runs/{run_id}").status_code == 202
        events = drain(ws, limit=2000)

    (end,) = [e for e in events if e["op"] == "run.end"]
    assert end["status"] == "cancelled"
    assert client.get(f"/api/runs/{run_id}").json()["status"] == "cancelled"


def test_ws_stop_message_stops_the_run(client: TestClient) -> None:
    """§6.1：前端 → 後端只有 `stop` / `stop_thread`，走同一條 WebSocket。"""
    pid = save(client, forever_project(project_id="p_forever_ws"))
    run_id = client.post("/api/runs", json={"projectId": pid}).json()["runId"]

    with client.websocket_connect(f"/ws/run/{run_id}") as ws:
        ws.receive_json()
        ws.send_text(json.dumps({"op": "stop"}))
        events = drain(ws, limit=2000)

    assert events[-1]["status"] == "cancelled"


def test_block_error_reaches_the_client(client: TestClient) -> None:
    """§5.6 → §8.3：錯誤要帶 blockId，前端才標得了紅框。"""
    project = counting_project(project_id="p_err")
    project["blocks"]["init"]["opcode"] = "data.change"  # 對不存在的變數 change（§4.5）
    pid = save(client, project)
    run_id = client.post("/api/runs", json={"projectId": pid}).json()["runId"]

    with client.websocket_connect(f"/ws/run/{run_id}") as ws:
        events = drain(ws)

    (err,) = [e for e in events if e["op"] == "block.error"]
    assert err["blockId"] == "init"
    assert err["error"]["code"] == "undefined_variable"
    assert events[-1]["status"] == "error"


# --------------------------------------------------------------------------
# 4. 點一下就跑（§5.1）
#
# 語意（從哪裡起跑、reporter 只求值一顆）由題庫守（conformance/control/click_*）。
# 這裡守的是 HTTP 那一段：blockId 進得去、summary 說得出點了什麼、指到不存在的
# 積木是 422 而不是一個開始了又立刻死掉的 Run。
# --------------------------------------------------------------------------


def draft_project(project_id: str = "p_click") -> dict[str, Any]:
    """一份「寫到一半」的專案：一條有 hat 的腳本，加一條落單的堆疊（§4.1）。"""
    return {
        "formatVersion": 1,
        "meta": {"id": project_id, "name": "草稿"},
        "scripts": [{"id": "sc_1", "top": "hat"}, {"id": "sc_2", "top": "lone"}],
        "blocks": {
            "hat": {"opcode": "event.when_flag_clicked", "next": "flag_says"},
            "flag_says": {
                "opcode": "debug.log",
                "parent": "hat",
                "inputs": {"text": {"kind": "literal", "value": "旗子"}},
            },
            "lone": {
                "opcode": "debug.log",
                "inputs": {"text": {"kind": "literal", "value": "落單"}},
            },
        },
    }


def test_click_runs_only_that_stack(client: TestClient) -> None:
    """§5.1：同一個端點、同一份事件，只是起點從 trigger 換成 blockId。"""
    pid = save(client, draft_project())
    run = client.post("/api/runs", json={"projectId": pid, "blockId": "lone"})
    assert run.status_code == 201, run.text

    summary = run.json()
    assert summary["blockId"] == "lone"
    assert summary["trigger"] == "manual"

    with client.websocket_connect(f"/ws/run/{summary['runId']}") as ws:
        events = drain(ws)

    assert [e["text"] for e in events if e["op"] == "log"] == ["落單"]
    assert events[-1]["status"] == "ok"


def test_green_flag_still_skips_the_lone_stack(client: TestClient) -> None:
    """同一份專案按綠旗：落單堆疊選不中——它不等於任何 trigger。"""
    pid = save(client, draft_project(project_id="p_click_flag"))
    run_id = client.post("/api/runs", json={"projectId": pid}).json()["runId"]

    with client.websocket_connect(f"/ws/run/{run_id}") as ws:
        events = drain(ws)

    assert [e["text"] for e in events if e["op"] == "log"] == ["旗子"]


def test_click_on_a_block_that_is_not_in_the_saved_project_is_422(client: TestClient) -> None:
    """畫布改了沒存就點：起點在**建立 Run 之前**解析，所以這是 422。

    回 201 再讓那個 Run 立刻死掉的話，執行歷史會多一格什麼都沒做的紀錄，而
    使用者要到 WebSocket 接上之後才知道自己點的東西根本不存在。
    """
    pid = save(client, draft_project(project_id="p_click_missing"))
    res = client.post("/api/runs", json={"projectId": pid, "blockId": "blk_nope"})

    assert res.status_code == 422, res.text
    assert res.json()["detail"]["blockId"] == "blk_nope"
    assert client.get("/api/runs").json() == []


def test_run_of_unsaved_project_is_404(client: TestClient) -> None:
    """跑的是**已存檔**的專案，所以「沒存過」是找不到，不是驗證失敗。"""
    res = client.post("/api/runs", json={"projectId": "prj_never_saved"})
    assert res.status_code == 404
    assert "先存檔" in res.json()["detail"]["hint"]


def test_unknown_run_id_closes_the_socket(client: TestClient) -> None:
    from starlette.websockets import WebSocketDisconnect

    from blockyard.api.runs import WS_RUN_NOT_FOUND

    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect("/ws/run/r_nope") as ws:
            ws.receive_json()
    assert excinfo.value.code == WS_RUN_NOT_FOUND


def test_late_subscriber_still_sees_a_finished_run(client: TestClient) -> None:
    """跑得比 WebSocket 接上還快的 Run（很常見）不能變成一片空白。"""
    pid = save(client, counting_project(times=1, project_id="p_fast"))
    run_id = client.post("/api/runs", json={"projectId": pid}).json()["runId"]

    deadline = 200
    while client.get(f"/api/runs/{run_id}").json()["status"] == "running" and deadline:
        deadline -= 1
    assert client.get(f"/api/runs/{run_id}").json()["status"] == "ok"

    with client.websocket_connect(f"/ws/run/{run_id}") as ws:
        events = drain(ws)
    assert [e["op"] for e in events][0] == "run.start"
    assert events[-1]["status"] == "ok"


def test_runs_are_listed_newest_first(client: TestClient) -> None:
    pid = save(client, counting_project(times=1, project_id="p_list"))
    first = client.post("/api/runs", json={"projectId": pid}).json()["runId"]
    second = client.post("/api/runs", json={"projectId": pid}).json()["runId"]

    assert [r["runId"] for r in client.get("/api/runs").json()] == [second, first]


# --------------------------------------------------------------------------
# 5. 工具箱裡點一下（§5.1 的 `scratch`）
#
# 那顆積木還沒有被拉出來，存檔裡沒有它——所以它自己那一小段 IR 跟著請求走，
# 由 `runs/scratch.py` 併進載入用的那一份。這一節守的是那個併法的四件事：
# 跑得動、**存檔沒被動到**、id 撞了要說話、積木包的宣告要跟著補上。
# --------------------------------------------------------------------------


def echo_scratch(block_id: str = "sk_1") -> dict[str, Any]:
    """工具箱裡的 `回聲 (world)`：一顆 reporter，帶著它自己的腳本與宣告。"""
    return {
        "blocks": {
            block_id: {
                "opcode": "demo.echo",
                "inputs": {"text": {"kind": "literal", "value": "hi"}},
            }
        },
        "scripts": [{"id": "sc_scratch", "top": block_id}],
        "extensions": [{"id": "demo", "version": "0.1.0"}],
    }


def test_scratch_block_runs_without_touching_the_saved_project(client: TestClient) -> None:
    """點工具箱裡那一顆：跑得動，而且硬碟上那份專案一個字都沒有變。

    後者才是這條路存在的理由——「試一顆積木」不該在使用者的專案裡留下東西。
    """
    project = draft_project(project_id="p_scratch")
    pid = save(client, project)
    before = client.get(f"/api/projects/{pid}").json()

    run = client.post(
        "/api/runs",
        json={"projectId": pid, "blockId": "sk_1", "scratch": echo_scratch()},
    )
    assert run.status_code == 201, run.text
    summary = run.json()
    assert summary["blockId"] == "sk_1"
    assert summary["trigger"] == "manual"

    with client.websocket_connect(f"/ws/run/{summary['runId']}") as ws:
        events = drain(ws)

    # reporter 的值由 `block.exit` 帶出去（§5.1），前端的值氣泡讀的就是這一筆。
    exits = [e for e in events if e["op"] == "block.exit" and e["blockId"] == "sk_1"]
    # `demo.echo` 回的是 `{greeting}, {text}`（見 `extensions/demo/main.py`）。
    assert [e["value"] for e in exits] == ["hi, hi"]
    assert events[-1]["status"] == "ok"

    assert client.get(f"/api/projects/{pid}").json() == before


def test_scratch_declares_an_extension_the_project_never_used(client: TestClient) -> None:
    """§13.3：執行只載入**宣告過**的積木包，而畫布上從來沒有用過 demo。

    宣告不跟著補上的話，點一顆 `demo.echo` 換來的是 `unknown_block`——使用者
    做對了每一步，錯誤卻指著積木（P1 第一天撞到的那件事）。
    """
    project = draft_project(project_id="p_scratch_ext")
    assert "extensions" not in project
    pid = save(client, project)

    run = client.post(
        "/api/runs",
        json={"projectId": pid, "blockId": "sk_1", "scratch": echo_scratch()},
    )
    with client.websocket_connect(f"/ws/run/{run.json()['runId']}") as ws:
        events = drain(ws)

    assert [e["op"] for e in events if e["op"] == "block.error"] == []
    assert events[-1]["status"] == "ok"


def test_scratch_that_reuses_a_saved_block_id_is_422(client: TestClient) -> None:
    """id 撞了就報錯，不是覆蓋：執行紀錄、事件流與畫面上的高亮全部照 blockId
    認人，讓兩顆積木共用一個 id 等於讓那三樣東西同時指錯人。"""
    pid = save(client, draft_project(project_id="p_scratch_clash"))
    res = client.post(
        "/api/runs",
        json={"projectId": pid, "blockId": "lone", "scratch": echo_scratch(block_id="lone")},
    )

    assert res.status_code == 422, res.text
    assert res.json()["detail"]["blockId"] == "lone"
    assert client.get("/api/runs").json() == []


def test_scratch_without_a_block_id_is_422(client: TestClient) -> None:
    """`scratch` 的意思是「跑**這一顆**」。沒有 blockId 就沒有那一顆。"""
    pid = save(client, draft_project(project_id="p_scratch_headless"))
    res = client.post("/api/runs", json={"projectId": pid, "scratch": echo_scratch()})

    assert res.status_code == 422, res.text
    assert "blockId" in res.json()["detail"]["message"]


def test_scratch_cannot_rewrite_the_projects_declarations(client: TestClient) -> None:
    """只收得下 blocks／scripts／extensions。工具箱裡的一顆積木沒有資格改
    專案的 `procedures`——安靜忽略的話，那條界線哪天會在沒有人發現時消失。"""
    pid = save(client, draft_project(project_id="p_scratch_keys"))
    scratch = {**echo_scratch(), "procedures": {}}
    res = client.post("/api/runs", json={"projectId": pid, "blockId": "sk_1", "scratch": scratch})

    assert res.status_code == 422, res.text
    assert "procedures" in res.json()["detail"]["message"]


# --------------------------------------------------------------------------
# §5.6：handler 自己爆掉時，事件流不能說謊
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_crashing_handler_reports_the_thread_as_error() -> None:
    """handler 丟出非 `BlockyardError` 的例外時（那是 runtime 的 bug，不是積木層級
    的錯誤），`finally` 仍然會發 `thread.end`。

    **它不能說 `ok`。** 說了的話，畫面上那條腳本會顯示成順利跑完，而它其實中途
    就死了——這是這個專案最不想要的一種 bug：兩邊都對，中間那句話沒有人負責。

    `control.throw` 的第一版正是這樣被抓到的：它拿了一個不存在的
    `Block.id`，於是 `AttributeError` 一路穿出去，而事件流說那條 thread 沒事。
    """
    from blockyard.interpreter.engine import Interpreter
    from blockyard.interpreter.events import EventSink
    from blockyard.interpreter.registry import COMMANDS
    from blockyard.ir.schema import load
    from blockyard.testing import blk, build

    async def boom(t: object, b: object) -> None:
        raise AttributeError("runtime 的 bug")

    COMMANDS["debug.boom"] = boom
    try:
        project = build(scripts=[[blk("event.when_flag_clicked"), blk("debug.boom")]])
        sink = EventSink()
        interp = Interpreter(load(project), sink=sink)
        result = await interp.run(run_id="r1", trigger="event.when_flag_clicked")
    finally:
        COMMANDS.pop("debug.boom", None)

    assert result.status == "error"
    ends = [e for e in sink.dicts() if e["op"] == "thread.end"]
    assert [e["status"] for e in ends] == ["error"]

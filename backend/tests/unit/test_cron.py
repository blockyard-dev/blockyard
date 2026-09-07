"""`event.when_cron`：排程、時區與存檔期驗證（§9.1、§4.9，P2 第 2b 步）。

**P2 的驗收句就是這顆積木**：「設定每天 09:00 的流程，關掉瀏覽器，隔天檢查
執行歷史有紀錄」。這裡沒辦法真的等到明天，所以拆成三段各自可驗的東西：
排程排得進去（且時區是對的）、後端重啟之後那份排程還在、以及**時間到了真的
會跑**——最後一段用一個「每一秒」的 cron 換取一個等得起的斷言。
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from blockyard.api.app import create_app
from blockyard.cron import CronSpec, parse
from blockyard.errors import ValidationError
from blockyard.extensions import BUNDLED_ROOT


def cron_project(
    project_id: str = "p_cron",
    *,
    expression: str = "0 9 * * *",
    timezone: str = "Asia/Taipei",
) -> dict[str, Any]:
    return {
        "formatVersion": 1,
        "meta": {"id": project_id, "name": "排程"},
        "scripts": [{"id": "sc_1", "top": "hat"}],
        "blocks": {
            "hat": {
                "opcode": "event.when_cron",
                "next": "say",
                "fields": {"cron": expression, "timezone": timezone},
            },
            "say": {
                "opcode": "debug.log",
                "parent": "hat",
                "inputs": {"text": {"kind": "literal", "value": "到點了"}},
            },
        },
    }


def app_for(tmp_path: Path) -> Any:
    return create_app(db_path=tmp_path / "blockyard.db", extensions_root=BUNDLED_ROOT)


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with TestClient(app_for(tmp_path)) as c:
        yield c


def save(client: TestClient, project: dict[str, Any]) -> Any:
    return client.put(f"/api/projects/{project['meta']['id']}", json=project)


# --------------------------------------------------------------------------
# 1. 解析：一份實作，兩個呼叫端
# --------------------------------------------------------------------------


def test_parse_accepts_a_five_field_crontab() -> None:
    spec = parse({"cron": "0 9 * * *", "timezone": "Asia/Taipei"})
    assert spec == CronSpec("0 9 * * *", "Asia/Taipei")
    assert spec.spec == ("0 9 * * *", "Asia/Taipei")


def test_parse_trims_whitespace() -> None:
    assert parse({"cron": " 0 9 * * * ", "timezone": " UTC "}) == CronSpec("0 9 * * *", "UTC")


@pytest.mark.parametrize(
    "fields",
    [
        {"cron": "", "timezone": "UTC"},
        {"cron": "   ", "timezone": "UTC"},
        {"timezone": "UTC"},
        {"cron": None, "timezone": "UTC"},
    ],
)
def test_an_empty_expression_is_an_error(fields: dict[str, Any]) -> None:
    with pytest.raises(ValidationError) as e:
        parse(fields, block_id="hat")
    assert e.value.block_id == "hat"


@pytest.mark.parametrize("timezone", ["", "   ", None])
def test_an_empty_timezone_is_an_error(timezone: Any) -> None:
    """§4.9：**沒有它，同一份專案在不同機器上會在不同時刻觸發。** 這裡不做
    「沒填就用系統時區」的退讓——退讓的代價是使用者把專案分享出去，對方跑起來
    的時間跟他看到的不一樣，而兩邊的畫面長得一模一樣。"""
    with pytest.raises(ValidationError) as e:
        parse({"cron": "0 9 * * *", "timezone": timezone})
    assert "時區" in str(e.value)


def test_a_bad_expression_says_what_cron_looks_like() -> None:
    """APScheduler 的原句是「Wrong number of fields」——那說的是實作細節。"""
    with pytest.raises(ValidationError) as e:
        parse({"cron": "每天九點", "timezone": "UTC"})
    assert "分 時 日 月 星期" in str(e.value)


def test_an_unknown_timezone_says_use_iana() -> None:
    with pytest.raises(ValidationError) as e:
        parse({"cron": "0 9 * * *", "timezone": "台北"})
    assert "Asia/Taipei" in str(e.value)


# --------------------------------------------------------------------------
# 2. 存檔期擋下
# --------------------------------------------------------------------------


def test_a_bad_cron_is_rejected_at_save_time(client: TestClient) -> None:
    """留到執行期的話，一顆設錯的 cron 可以安靜地不觸發好幾個月（同 §4.7b 的
    運算式）。422 要帶 blockId，前端才標得回那顆積木。"""
    res = save(client, cron_project(expression="每天九點"))

    assert res.status_code == 422
    assert res.json()["detail"]["blockId"] == "hat"


def test_a_bad_timezone_is_rejected_at_save_time(client: TestClient) -> None:
    res = save(client, cron_project(timezone="Mars/Olympus"))

    assert res.status_code == 422
    assert res.json()["detail"]["blockId"] == "hat"


def test_a_structural_error_wins_over_a_cron_error(client: TestClient) -> None:
    """結構錯誤比一顆設錯的 cron 更根本，所以先報那個。"""
    broken = cron_project(expression="壞的")
    broken["blocks"]["hat"]["next"] = "不存在的積木"

    res = save(client, broken)

    assert res.status_code == 422
    assert "next" in res.json()["detail"]["message"]


def test_a_good_cron_saves(client: TestClient) -> None:
    assert save(client, cron_project()).status_code in (200, 201)


# --------------------------------------------------------------------------
# 3. 排程
# --------------------------------------------------------------------------


def test_activating_schedules_the_job(client: TestClient) -> None:
    save(client, cron_project())

    res = client.post("/api/triggers", json={"projectId": "p_cron"})

    assert res.status_code == 201
    assert res.json()["hats"] == ["event.when_cron"]
    jobs = client.app.state.triggers._sched.get_jobs()  # type: ignore[attr-defined]
    assert len(jobs) == 1


def test_the_job_uses_the_declared_timezone_not_the_machines(client: TestClient) -> None:
    """§4.9 的整個重點。排程器本身跑在 UTC，那顆 job 必須帶著自己的時區。"""
    save(client, cron_project(timezone="Asia/Taipei"))
    client.post("/api/triggers", json={"projectId": "p_cron"})

    job = client.app.state.triggers._sched.get_jobs()[0]  # type: ignore[attr-defined]
    assert str(job.trigger.timezone) == "Asia/Taipei"


def test_two_cron_blocks_are_two_jobs(client: TestClient) -> None:
    """key 含 blockId，因為兩顆積木是兩份排程。"""
    project = cron_project()
    project["scripts"].append({"id": "sc_2", "top": "hat2"})
    project["blocks"]["hat2"] = {
        "opcode": "event.when_cron",
        "fields": {"cron": "30 18 * * *", "timezone": "UTC"},
    }
    save(client, project)
    client.post("/api/triggers", json={"projectId": "p_cron"})

    assert len(client.app.state.triggers._sched.get_jobs()) == 2  # type: ignore[attr-defined]


def test_two_projects_with_the_same_block_id_do_not_collide(client: TestClient) -> None:
    """複製貼上一份專案就會這樣。job id 沒有 project 前綴的話，後排進去的會蓋掉
    前一顆——而使用者只會看到「其中一個流程不跑了」。"""
    save(client, cron_project("p_a"))
    save(client, cron_project("p_b"))
    client.post("/api/triggers", json={"projectId": "p_a"})
    client.post("/api/triggers", json={"projectId": "p_b"})

    assert len(client.app.state.triggers._sched.get_jobs()) == 2  # type: ignore[attr-defined]


def test_changing_the_time_reschedules(client: TestClient) -> None:
    save(client, cron_project())
    client.post("/api/triggers", json={"projectId": "p_cron"})

    save(client, cron_project(expression="30 18 * * *"))

    job = client.app.state.triggers._sched.get_jobs()[0]  # type: ignore[attr-defined]
    assert "minute='30'" in str(job.trigger)


def test_editing_an_unrelated_block_keeps_the_same_job(client: TestClient) -> None:
    """§9.2 的 diff：spec 沒變就別動。重排會讓「下一次什麼時候跑」跳掉。"""
    save(client, cron_project())
    client.post("/api/triggers", json={"projectId": "p_cron"})
    before = client.app.state.triggers._sched.get_jobs()[0]  # type: ignore[attr-defined]

    edited = cron_project()
    edited["blocks"]["say"]["inputs"]["text"] = {"kind": "literal", "value": "改過了"}
    save(client, edited)

    after = client.app.state.triggers._sched.get_jobs()[0]  # type: ignore[attr-defined]
    assert after.next_run_time == before.next_run_time


def test_deactivating_removes_the_job(client: TestClient) -> None:
    save(client, cron_project())
    client.post("/api/triggers", json={"projectId": "p_cron"})

    client.delete("/api/triggers/p_cron")

    assert client.app.state.triggers._sched.get_jobs() == []  # type: ignore[attr-defined]


def test_removing_the_cron_block_removes_the_job(client: TestClient) -> None:
    save(client, cron_project())
    client.post("/api/triggers", json={"projectId": "p_cron"})

    without = cron_project()
    without["scripts"] = []
    without["blocks"].pop("hat")
    without["blocks"]["say"].pop("parent")
    save(client, without)

    assert client.app.state.triggers._sched.get_jobs() == []  # type: ignore[attr-defined]


# --------------------------------------------------------------------------
# 4. P2 的驗收句：關掉後端，排程還在
# --------------------------------------------------------------------------


def test_the_schedule_survives_a_restart(tmp_path: Path) -> None:
    """**這是 §1.3「關掉瀏覽器仍會準時執行」的整句話。** active 存在 SQLite，
    排程從 IR 重建——所以那份排程本身不必存，它是 IR 的衍生物。"""
    with TestClient(app_for(tmp_path)) as c:
        save(c, cron_project())
        c.post("/api/triggers", json={"projectId": "p_cron"})

    with TestClient(app_for(tmp_path)) as c:  # 新的 process
        jobs = c.app.state.triggers._sched.get_jobs()  # type: ignore[attr-defined]
        assert len(jobs) == 1
        assert str(jobs[0].trigger.timezone) == "Asia/Taipei"


def test_a_cron_that_fires_really_runs(tmp_path: Path) -> None:
    """前面幾題證明的都是「排進去了」，這一題證明**時間到了真的會跑**。

    cron 的最小粒度是一分鐘（`from_crontab` 只吃五欄），所以不能真的等——改成
    把排好的那顆 job 的下次執行時間提前。**測的仍然是真的那條線**：排程器 →
    `tick()` → `_forward` → `RunManager.start`，只有「什麼時候」被換掉了。
    """
    import asyncio
    from datetime import UTC, datetime

    with TestClient(app_for(tmp_path)) as c:
        save(c, cron_project())
        c.post("/api/triggers", json={"projectId": "p_cron"})

        sched = c.app.state.triggers._sched  # type: ignore[attr-defined]
        sched.get_jobs()[0].modify(next_run_time=datetime.now(UTC))

        runs: list[Any] = []
        for _ in range(150):
            runs = [r for r in c.get("/api/runs").json() if r["trigger"] == "event.when_cron"]
            if runs:
                break
            c.portal.call(asyncio.sleep, 0.02)  # type: ignore[attr-defined]

        assert runs, "cron 排進去了但沒有跑起來"
        for _ in range(150):
            events = c.get(f"/api/runs/{runs[0]['runId']}/events").json()["events"]
            if any(e["op"] == "run.end" for e in events):
                break
            c.portal.call(asyncio.sleep, 0.02)  # type: ignore[attr-defined]
        assert any(e["op"] == "log" and e["text"] == "到點了" for e in events)


def test_the_payload_carries_scheduled_at_in_the_declared_timezone(tmp_path: Path) -> None:
    """`when_cron` 的 `yields` 是 `scheduled_at`（§4.9 的時間戳是 object，不是
    number）。用**排程的那個時區**算，不是 UTC——使用者設的是「早上九點」，
    那句話只在他的時區裡成立。"""
    from blockyard.cron import CronSpec
    from blockyard.runs.triggers import _cron_payload

    payload = _cron_payload(CronSpec("0 9 * * *", "Asia/Taipei"))

    assert payload["scheduled_at"]["timezone"] == "Asia/Taipei"
    assert "+08:00" in payload["scheduled_at"]["iso"]
    assert isinstance(payload["scheduled_at"]["epoch"], float)


def test_a_freshly_dragged_block_cannot_be_saved_until_the_zone_is_chosen(
    client: TestClient,
) -> None:
    """宣告刻意沒有 default（§9.1 的「必填」）。

    給 `UTC` 的話，一個台北的使用者設「早上九點」會在下午五點觸發，而積木上
    只寫著一個他沒讀的字——可攜性守住了，但意思錯了。空的則存不進去，而那句
    話他一定看得到。
    """
    from blockyard.interpreter import declarations

    spec = declarations.block("event.when_cron")
    assert spec is not None
    assert spec.args["timezone"].default == ""

    res = save(client, cron_project(timezone=""))
    assert res.status_code == 422
    assert "時區" in res.json()["detail"]["message"]


def test_concurrency_drop_skips_while_the_previous_run_is_alive(tmp_path: Path) -> None:
    """`when_cron` 宣告的是 `drop`（§5.1），而它是真的需要——一個十二點的排程
    如果自己跑兩小時，沒有這條規則就會愈疊愈多。

    **`queue` 與 `restart` 還沒實作**，目前與 `parallel` 同行為。
    """
    from blockyard.runs.triggers import _forward

    with TestClient(app_for(tmp_path)) as c:
        save(c, cron_project())
        c.post("/api/triggers", json={"projectId": "p_cron"})
        manager = c.app.state.triggers  # type: ignore[attr-defined]

        started = 0

        class FakeRuns:
            def has_running(self, project_id: str, trigger: str) -> bool:
                return started > 0

            async def start(self, project_id: str, **kw: Any) -> None:
                nonlocal started
                started += 1

        manager._runs = FakeRuns()
        fire = _forward(manager, "p_cron", "event.when_cron", "drop")

        c.portal.call(fire, {})  # type: ignore[attr-defined]
        c.portal.call(fire, {})  # type: ignore[attr-defined]

        assert started == 1
        assert any("跳過" in e for e in manager.get("p_cron").errors)

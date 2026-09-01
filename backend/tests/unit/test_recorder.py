"""§6.3 的落地篩選與批次 writer（P2 第 1 步）。"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from blocky.runs.recorder import STORED_OPS, RunRecorder
from blocky.storage import RunStore


def store(tmp_path: Path) -> RunStore:
    s = RunStore(tmp_path / "blocky.db")
    s.start("r_1", seq=1, project_id="p1", trigger="flag", started_at="2026-09-01T00:00:00.000Z")
    return s


def recorder(s: RunStore, **kw: object) -> RunRecorder:
    return RunRecorder(s, **kw)  # type: ignore[arg-type]


# ---- §6.3 的那張表 ----


def test_the_whitelist_is_exactly_what_6_3_says() -> None:
    """白名單，不是黑名單：新增一種事件時預設**不**落地，要有人來這裡加一行。

    這一題釘的是那張表本身。§6.3 說骨架與 `block.error`、`log` 一律存，而
    `block.enter` / `block.exit` / `var.set` / `block.hot` 一律不存。
    """
    assert STORED_OPS == {
        "run.start",
        "run.end",
        "thread.start",
        "thread.end",
        "block.error",
        "log",
    }


def test_trigger_yield_is_not_a_run_event() -> None:
    """`trigger.yield` 在 §6.3 那張表上找不到，因為那張表寫在監聽存在之前。

    它掛在**監聽自己那條 sink** 上（`extensions/host.py`），沒有 `runId`——
    一次 yield 是「一個 Run 被起了」的原因，不是那個 Run 裡發生的事。它的家
    在 P2 第 2 步的 Trigger Manager，不是 `run_events`。
    """
    assert "trigger.yield" not in STORED_OPS


@pytest.mark.parametrize("op", ["block.enter", "block.exit", "var.set", "block.hot"])
def test_debug_signals_never_land(tmp_path: Path, op: str) -> None:
    """`block.enter/exit` 是除錯用的即時訊號，不是稽核紀錄——一個掛著跑三天的
    `forever` 迴圈會寫進幾億列。"""
    s = store(tmp_path)
    r = recorder(s)
    for _ in range(100):
        r.record("r_1", {"op": op, "blockId": "blk_1"})
    r.flush()

    assert s.events("r_1") == []


def test_the_skeleton_lands(tmp_path: Path) -> None:
    s = store(tmp_path)
    r = recorder(s)
    for op in ("run.start", "thread.start", "log", "block.error", "thread.end", "run.end"):
        r.record("r_1", {"op": op})
    r.flush()

    assert [e["op"] for e in s.events("r_1")] == [
        "run.start",
        "thread.start",
        "log",
        "block.error",
        "thread.end",
        "run.end",
    ]


def test_the_op_key_is_not_duplicated_into_data(tmp_path: Path) -> None:
    s = store(tmp_path)
    r = recorder(s)
    r.record("r_1", {"op": "log", "text": "哈囉", "blockId": "blk_1"})
    r.flush()

    assert s.events("r_1") == [{"seq": 1, "op": "log", "text": "哈囉", "blockId": "blk_1"}]


def test_seq_is_per_run(tmp_path: Path) -> None:
    s = store(tmp_path)
    s.start("r_2", seq=2, project_id="p1", trigger="flag", started_at="t")
    r = recorder(s)
    r.record("r_1", {"op": "log", "n": 1})
    r.record("r_2", {"op": "log", "n": 1})
    r.record("r_1", {"op": "log", "n": 2})
    r.flush()

    assert [e["seq"] for e in s.events("r_1")] == [1, 2]
    assert [e["seq"] for e in s.events("r_2")] == [1]


# ---- log 上限 ----


def test_log_limit_is_enforced_on_flush(tmp_path: Path) -> None:
    s = store(tmp_path)
    r = recorder(s, log_limit=3)
    for i in range(10):
        r.record("r_1", {"op": "log", "n": i})
    r.flush()

    assert [e["n"] for e in s.events("r_1")] == [7, 8, 9]
    assert s.get("r_1").logs_truncated is True  # type: ignore[union-attr]


def test_log_limit_does_not_touch_the_skeleton(tmp_path: Path) -> None:
    s = store(tmp_path)
    r = recorder(s, log_limit=1)
    r.record("r_1", {"op": "run.start"})
    for i in range(5):
        r.record("r_1", {"op": "log", "n": i})
    r.record("r_1", {"op": "run.end"})
    r.flush()

    assert [e["op"] for e in s.events("r_1")] == ["run.start", "log", "run.end"]


def test_a_quiet_run_is_never_marked_truncated(tmp_path: Path) -> None:
    s = store(tmp_path)
    r = recorder(s, log_limit=10)
    r.record("r_1", {"op": "log"})
    r.flush()

    assert s.get("r_1").logs_truncated is False  # type: ignore[union-attr]


# ---- 緩衝區上限 ----


def test_buffer_overflow_drops_logs_not_the_skeleton(tmp_path: Path) -> None:
    """SQLite 一旦變慢，緩衝區就成了那個掛三天的迴圈的新家。到頂時丟最舊的
    `log`——與 §6.3 的規則同一條，只是提早在記憶體裡發生。"""
    s = store(tmp_path)
    r = recorder(s, buffer_limit=10, batch=10_000, log_limit=10_000)
    r.record("r_1", {"op": "run.start"})
    for i in range(30):
        r.record("r_1", {"op": "log", "n": i})
    r.flush()

    landed = s.events("r_1")
    assert landed[0]["op"] == "run.start"  # 骨架一筆都沒掉
    assert r.dropped > 0
    assert len(landed) < 31


def test_dropping_in_the_buffer_marks_the_run(tmp_path: Path) -> None:
    """掉在記憶體裡跟掉在 SQLite 裡，對使用者是同一件事：這個 Run 的 log
    不完整。標記必須一樣。"""
    s = store(tmp_path)
    r = recorder(s, buffer_limit=4, batch=10_000, log_limit=10_000)
    for i in range(20):
        r.record("r_1", {"op": "log", "n": i})
    r.flush()

    assert s.get("r_1").logs_truncated is True  # type: ignore[union-attr]


# ---- 背景 task ----


@pytest.mark.asyncio
async def test_the_background_task_flushes_without_being_asked(tmp_path: Path) -> None:
    s = store(tmp_path)
    r = recorder(s, flush_interval_s=0.01)
    r.start()
    r.record("r_1", {"op": "log", "n": 1})

    for _ in range(50):
        await asyncio.sleep(0.01)
        if s.events("r_1"):
            break
    assert [e["n"] for e in s.events("r_1")] == [1]
    await r.close()


@pytest.mark.asyncio
async def test_close_writes_the_last_batch(tmp_path: Path) -> None:
    """關機時緩衝區裡那幾筆是 Run 的結尾（thread.end、run.end）——正是使用者
    明天回來要看的那幾筆。"""
    s = store(tmp_path)
    r = recorder(s, flush_interval_s=10)
    r.start()
    r.record("r_1", {"op": "run.end", "status": "ok"})

    await r.close()
    assert [e["op"] for e in s.events("r_1")] == ["run.end"]


@pytest.mark.asyncio
async def test_a_broken_write_does_not_kill_the_loop(tmp_path: Path) -> None:
    """寫不進去不該讓 Run 跟著死。歷史掉一批比流程停掉便宜得多。"""
    s = store(tmp_path)
    r = recorder(s, flush_interval_s=0.01)

    boom = {"n": 0}

    def explode(run_id: str, rows: object) -> None:
        boom["n"] += 1
        raise sqlite_error()

    def sqlite_error() -> Exception:
        return RuntimeError("disk I/O error")

    r._store.append_events = explode  # type: ignore[method-assign]
    r.start()
    r.record("r_1", {"op": "log"})
    for _ in range(50):
        await asyncio.sleep(0.01)
        if boom["n"]:
            break
    assert boom["n"] >= 1
    assert not r._task.done()  # type: ignore[union-attr]
    await r.close()


def test_forget_drops_the_counters(tmp_path: Path) -> None:
    """一個開著三天的後端會為每一個跑過的 Run 各留一個整數——那正是這次落地
    要拿掉的那種東西。"""
    s = store(tmp_path)
    r = recorder(s)
    r.record("r_1", {"op": "log"})
    r.flush()
    r.forget("r_1")

    assert r._seq == {}
    assert r._logs == {}

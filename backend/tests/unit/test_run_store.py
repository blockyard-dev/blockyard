"""執行歷史與持久值的 SQLite 落地（§6.3、§5.4 第 4 層，P2 第 1 步）。"""

from __future__ import annotations

from pathlib import Path

from blockyard.storage import INTERRUPTED, RunStore, SqlitePersistStore


def store(tmp_path: Path) -> RunStore:
    return RunStore(tmp_path / "blockyard.db")


def start(s: RunStore, run_id: str, *, seq: int, project: str = "p1", **kw: object) -> None:
    s.start(
        run_id,
        seq=seq,
        project_id=project,
        trigger=kw.pop("trigger", "flag"),  # type: ignore[arg-type]
        started_at=kw.pop("started_at", "2026-09-01T00:00:00.000Z"),  # type: ignore[arg-type]
        **kw,  # type: ignore[arg-type]
    )


# ---- Run ----


def test_seq_survives_a_restart(tmp_path: Path) -> None:
    """落地之前 `r_{self._seq}` 每次重啟都從 1 開始——那時無所謂，因為重啟就
    沒有歷史了。現在有了，`r_1` 會直接撞上昨天那一筆。"""
    s = store(tmp_path)
    assert s.next_seq() == 1
    start(s, "r_1", seq=1)
    assert s.next_seq() == 2

    again = store(tmp_path)  # 同一個檔案，新的 process
    assert again.next_seq() == 2


def test_finish_records_status_and_end_time(tmp_path: Path) -> None:
    s = store(tmp_path)
    start(s, "r_1", seq=1)
    assert s.get("r_1").status == "running"  # type: ignore[union-attr]

    s.finish("r_1", status="ok", ended_at="2026-09-01T00:00:01.000Z")
    got = s.get("r_1")
    assert got is not None
    assert (got.status, got.ended_at) == ("ok", "2026-09-01T00:00:01.000Z")


def test_list_is_newest_first_by_seq_not_by_time(tmp_path: Path) -> None:
    """同一毫秒內連按兩次執行是完全正常的操作。用時間戳排序，那兩筆的順序
    就不再穩定。"""
    s = store(tmp_path)
    same = "2026-09-01T00:00:00.000Z"
    start(s, "r_1", seq=1, started_at=same)
    start(s, "r_2", seq=2, started_at=same)
    start(s, "r_3", seq=3, started_at=same)

    assert [r.id for r in s.list()] == ["r_3", "r_2", "r_1"]


def test_list_filters_by_project(tmp_path: Path) -> None:
    s = store(tmp_path)
    start(s, "r_1", seq=1, project="p1")
    start(s, "r_2", seq=2, project="p2")

    assert [r.id for r in s.list(project_id="p1")] == ["r_1"]


def test_summary_carries_block_id_only_when_it_is_a_click(tmp_path: Path) -> None:
    """與 `RunHandle.summary()` 同一份形狀——前端不該分得出這一筆是從記憶體
    還是從 SQLite 來的。"""
    s = store(tmp_path)
    start(s, "r_1", seq=1, trigger="manual", block_id="blk_7")
    start(s, "r_2", seq=2)

    assert s.get("r_1").summary()["blockId"] == "blk_7"  # type: ignore[union-attr]
    assert "blockId" not in s.get("r_2").summary()  # type: ignore[union-attr]
    assert "endedAt" not in s.get("r_2").summary()  # type: ignore[union-attr]


def test_restart_marks_unfinished_runs_interrupted(tmp_path: Path) -> None:
    """被 kill -9 的 Run 會永遠停在 `running`，而一排跑不完的紀錄比沒有紀錄
    更難讀——使用者會以為它們還在跑。"""
    s = store(tmp_path)
    start(s, "r_1", seq=1)
    start(s, "r_2", seq=2)
    s.finish("r_2", status="ok", ended_at="2026-09-01T00:00:01.000Z")

    assert store(tmp_path).reconcile_interrupted(now="2026-09-02T00:00:00.000Z") == 1

    after = store(tmp_path)
    assert after.get("r_1").status == INTERRUPTED  # type: ignore[union-attr]
    assert after.get("r_1").ended_at == "2026-09-02T00:00:00.000Z"  # type: ignore[union-attr]
    assert after.get("r_2").status == "ok"  # type: ignore[union-attr]


def test_interrupted_is_not_cancelled(tmp_path: Path) -> None:
    """`cancelled` 是使用者按了停止，是一個有人做過的決定；`interrupted` 是
    沒有人知道它跑到哪裡。"""
    assert INTERRUPTED != "cancelled"


# ---- 事件 ----


def test_events_round_trip_in_seq_order(tmp_path: Path) -> None:
    s = store(tmp_path)
    start(s, "r_1", seq=1)
    s.append_events(
        "r_1",
        [
            (1, "run.start", {"runId": "r_1"}),
            (2, "log", {"text": "哈囉", "blockId": "blk_1"}),
            (3, "run.end", {"status": "ok"}),
        ],
    )

    got = s.events("r_1")
    assert [e["op"] for e in got] == ["run.start", "log", "run.end"]
    assert got[1] == {"seq": 2, "op": "log", "text": "哈囉", "blockId": "blk_1"}


def test_events_paginate_by_seq_not_offset(tmp_path: Path) -> None:
    """`after` 是上一頁最後一筆的 seq。用 offset 的話，分頁期間有新事件寫進來
    就會漏掉或重複。"""
    s = store(tmp_path)
    start(s, "r_1", seq=1)
    s.append_events("r_1", [(i, "log", {"n": i}) for i in range(1, 6)])

    page = s.events("r_1", limit=2)
    assert [e["n"] for e in page] == [1, 2]
    assert [e["n"] for e in s.events("r_1", after=page[-1]["seq"], limit=2)] == [3, 4]


def test_append_events_is_a_noop_when_empty(tmp_path: Path) -> None:
    store(tmp_path).append_events("r_1", [])  # 不該開連線、不該爆


def test_log_limit_drops_oldest_and_marks_the_run(tmp_path: Path) -> None:
    """§6.3：`log` 每個 Run 上限 N 筆，超過丟棄最舊者並標記。"""
    s = store(tmp_path)
    start(s, "r_1", seq=1)
    s.append_events("r_1", [(i, "log", {"n": i}) for i in range(1, 11)])

    assert s.enforce_log_limit("r_1", limit=4) == 6
    assert [e["n"] for e in s.events("r_1")] == [7, 8, 9, 10]
    assert s.get("r_1").logs_truncated is True  # type: ignore[union-attr]
    assert s.get("r_1").summary()["logsTruncated"] is True  # type: ignore[union-attr]


def test_log_limit_never_touches_the_skeleton(tmp_path: Path) -> None:
    """骨架事件不在那條規則裡——它們是執行歷史之所以存在的東西，而且數量由
    腳本結構決定，不會被一個迴圈灌爆。"""
    s = store(tmp_path)
    start(s, "r_1", seq=1)
    s.append_events(
        "r_1",
        [(1, "run.start", {}), (2, "thread.start", {}), (3, "block.error", {})]
        + [(i, "log", {"n": i}) for i in range(4, 10)],
    )

    s.enforce_log_limit("r_1", limit=1)
    assert [e["op"] for e in s.events("r_1")] == [
        "run.start",
        "thread.start",
        "block.error",
        "log",
    ]


def test_log_limit_under_the_cap_changes_nothing(tmp_path: Path) -> None:
    s = store(tmp_path)
    start(s, "r_1", seq=1)
    s.append_events("r_1", [(1, "log", {})])

    assert s.enforce_log_limit("r_1", limit=10) == 0
    assert s.get("r_1").logs_truncated is False  # type: ignore[union-attr]


# ---- 剪枝 ----


def test_prune_keeps_the_newest_n_per_project(tmp_path: Path) -> None:
    s = store(tmp_path)
    for i in range(1, 6):
        start(s, f"r_{i}", seq=i)
        s.finish(f"r_{i}", status="ok", ended_at="2026-09-01T00:00:01.000Z")

    assert s.prune("p1", keep=2) == 3
    assert [r.id for r in s.list()] == ["r_5", "r_4"]


def test_prune_is_scoped_to_one_project(tmp_path: Path) -> None:
    """上限是「每個專案 N 次」，不是「全部 N 次」——不然一個高頻的 cron 會把
    別的流程的歷史整個擠掉。"""
    s = store(tmp_path)
    for i in range(1, 4):
        start(s, f"a{i}", seq=i, project="p1")
        s.finish(f"a{i}", status="ok", ended_at="x")
    start(s, "b1", seq=9, project="p2")
    s.finish("b1", status="ok", ended_at="x")

    s.prune("p1", keep=1)
    assert {r.id for r in s.list()} == {"a3", "b1"}


def test_prune_never_deletes_a_running_run(tmp_path: Path) -> None:
    """一個掛著跑的監聽 Run 可能比 200 次手動執行都舊。刪掉它，等於在它結束時
    把 `finish()` 寫進一列不存在的紀錄。"""
    s = store(tmp_path)
    start(s, "老的但還在跑", seq=1)
    for i in range(2, 5):
        start(s, f"r_{i}", seq=i)
        s.finish(f"r_{i}", status="ok", ended_at="x")

    s.prune("p1", keep=1)
    assert {r.id for r in s.list()} == {"老的但還在跑", "r_4"}


def test_prune_deletes_the_events_too(tmp_path: Path) -> None:
    s = store(tmp_path)
    start(s, "r_1", seq=1)
    s.finish("r_1", status="ok", ended_at="x")
    s.append_events("r_1", [(1, "log", {})])
    start(s, "r_2", seq=2)

    s.prune("p1", keep=1)
    assert s.events("r_1") == []


def test_deleting_a_project_clears_its_history_and_persist(tmp_path: Path) -> None:
    """歷史指向一份不存在的專案是沒有用的紀錄。"""
    s = store(tmp_path)
    start(s, "r_1", seq=1, project="p1")
    s.append_events("r_1", [(1, "log", {})])
    s.persist_set("p1", "count", 3)
    start(s, "r_2", seq=2, project="p2")

    s.delete_project_history("p1")
    assert [r.id for r in s.list()] == ["r_2"]
    assert s.events("r_1") == []
    assert s.persist_snapshot("p1") == {}


# ---- §5.4 第 4 層 ----


def test_persist_survives_a_restart(tmp_path: Path) -> None:
    """D12 承諾的「跨 Run、跨後端重啟」——落地之前只兌現了前一半。"""
    s = store(tmp_path)
    p = SqlitePersistStore(s, "p1")
    p.set("count", 7)
    p.set("名字", {"a": [1, 2]})

    after = SqlitePersistStore(store(tmp_path), "p1")
    assert after.get("count") == 7
    assert after.get("名字") == {"a": [1, 2]}


def test_persist_writes_land_immediately(tmp_path: Path) -> None:
    """攢著等 Run 結束再寫，被 kill -9 的那次就白記了——而「跨後端重啟存活」
    就是這一層存在的全部理由。"""
    s = store(tmp_path)
    SqlitePersistStore(s, "p1").set("count", 1)
    assert store(tmp_path).persist_snapshot("p1") == {"count": 1}


def test_persist_is_scoped_by_project(tmp_path: Path) -> None:
    s = store(tmp_path)
    SqlitePersistStore(s, "p1").set("count", 1)
    assert SqlitePersistStore(s, "p2").has("count") is False


def test_persist_delete_and_has(tmp_path: Path) -> None:
    s = store(tmp_path)
    p = SqlitePersistStore(s, "p1")
    p.set("count", 1)
    assert p.has("count") is True

    p.delete("count")
    assert p.has("count") is False
    assert store(tmp_path).persist_snapshot("p1") == {}


def test_persist_delete_of_a_missing_key_is_quiet(tmp_path: Path) -> None:
    """同 `InMemoryPersistStore`：`忘記` 一個沒記過的東西不是錯誤。"""
    SqlitePersistStore(store(tmp_path), "p1").delete("nope")

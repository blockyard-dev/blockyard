"""專案的 active 狀態（§9.2，P2 第 2 步）。"""

from __future__ import annotations

from pathlib import Path

from blockyard.storage import ActiveStore


def store(tmp_path: Path) -> ActiveStore:
    return ActiveStore(tmp_path / "blockyard.db")


def test_activate_then_survives_a_restart(tmp_path: Path) -> None:
    """§9.2 最後一句要的就是這件事。"""
    store(tmp_path).activate("p1", now="2026-09-01T00:00:00Z")

    again = store(tmp_path)
    assert [a.project_id for a in again.list()] == ["p1"]
    assert again.is_active("p1") is True


def test_reactivating_keeps_the_original_timestamp(tmp_path: Path) -> None:
    """重複啟用是最常見的情況（前端的「執行」會順手打開）。每次都刷新時間戳
    等於讓「它從什麼時候開始跑」這個問題永遠答不出來。"""
    s = store(tmp_path)
    s.activate("p1", now="2026-09-01T00:00:00Z")
    s.activate("p1", now="2026-09-02T00:00:00Z")

    assert s.list()[0].activated_at == "2026-09-01T00:00:00Z"


def test_deactivate_reports_whether_it_was_active(tmp_path: Path) -> None:
    s = store(tmp_path)
    assert s.deactivate("p1") is False

    s.activate("p1")
    assert s.deactivate("p1") is True
    assert s.is_active("p1") is False


def test_list_is_oldest_first(tmp_path: Path) -> None:
    """啟動時照這個順序恢復——重啟前後的日誌長得一樣，查起來省事。"""
    s = store(tmp_path)
    s.activate("b", now="2026-09-02T00:00:00Z")
    s.activate("a", now="2026-09-01T00:00:00Z")

    assert [x.project_id for x in s.list()] == ["a", "b"]


def test_active_is_not_part_of_the_project_json(tmp_path: Path) -> None:
    """塞進 IR 的話，匯出一份專案再匯入到別人的機器上會連同「開著」一起搬
    過去——而那台機器並沒有同意跑任何東西。這裡確認它是自己一張表。"""
    from blockyard.storage import ProjectStore

    p = ProjectStore(tmp_path / "blockyard.db")
    p.put("p1", {"meta": {"name": "x"}})
    store(tmp_path).activate("p1")

    assert p.get("p1").data == {"meta": {"name": "x"}}  # type: ignore[union-attr]

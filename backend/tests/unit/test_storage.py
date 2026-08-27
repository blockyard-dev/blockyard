"""SQLite 專案表（§15 P0b 第 1 步）。"""

from __future__ import annotations

from pathlib import Path

from blocky.storage import LOCAL_OWNER, ProjectStore


def store(tmp_path: Path) -> ProjectStore:
    return ProjectStore(tmp_path / "blocky.db")


def test_put_then_get_returns_the_same_json(tmp_path: Path) -> None:
    """存的是原文，不是模型重新序列化的結果——否則存讀檔會無聲地漂移。"""
    s = store(tmp_path)
    data = {"formatVersion": 1, "meta": {"name": "測試", "自訂欄位": [1, 2]}, "blocks": {}}
    s.put("p1", data)
    got = s.get("p1")
    assert got is not None
    assert got.data == data


def test_put_is_an_upsert_and_keeps_created_at(tmp_path: Path) -> None:
    s = store(tmp_path)
    first = s.put("p1", {"meta": {"name": "一"}}, now="2026-01-01T00:00:00Z")
    second = s.put("p1", {"meta": {"name": "二"}}, now="2026-02-02T00:00:00Z")
    assert second.created_at == first.created_at
    assert second.updated_at == "2026-02-02T00:00:00Z"
    assert second.name == "二"
    assert len(s.list()) == 1


def test_projects_are_scoped_by_owner(tmp_path: Path) -> None:
    """§16 Q1 的暫定結論：單機固定 `local`，但欄位從第一天就在。"""
    s = store(tmp_path)
    s.put("p1", {"meta": {"name": "我的"}})
    s.put("p1", {"meta": {"name": "別人的"}}, owner_id="someone")

    assert s.get("p1").name == "我的"
    assert s.get("p1", owner_id="someone").name == "別人的"
    assert [p.id for p in s.list(owner_id=LOCAL_OWNER)] == ["p1"]


def test_missing_project_is_none_and_delete_reports_it(tmp_path: Path) -> None:
    s = store(tmp_path)
    assert s.get("nope") is None
    assert s.delete("nope") is False
    s.put("p1", {})
    assert s.delete("p1") is True
    assert s.list() == []


def test_store_creates_its_directory(tmp_path: Path) -> None:
    """`blocky serve` 第一次跑時 `~/.blocky/` 還不存在。"""
    ProjectStore(tmp_path / "a" / "b" / "blocky.db")
    assert (tmp_path / "a" / "b" / "blocky.db").exists()

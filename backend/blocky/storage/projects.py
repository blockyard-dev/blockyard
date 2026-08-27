"""專案的 SQLite 落地（§15 P0b 第 1 步）。

**存的是 PUT 進來的那份 JSON 原文**，不是 pydantic 模型重新序列化的結果。
理由是 round-trip：`Project` 是 `extra="forbid"`，但 `meta` 是 `extra="allow"`，
而且 IR 有一堆有預設值的欄位。只要經過模型再吐出來，「使用者存進去的東西」
與「拿回來的東西」就不再是同一份——前端存檔／讀檔會開始無聲地漂移。

驗證仍然照做（`api/projects.py` 在寫入前跑 §4 的載入期驗證），只是驗證的
產物不覆蓋原文：**驗證是門檻，不是轉換**。

`owner_id` 從第一天就在（§16 Q1 的暫定結論）。單機模式固定 `local`，事後要
長出多使用者時不必動 schema——加欄位到既有的表比一開始就加貴得多。
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

LOCAL_OWNER = "local"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id          TEXT NOT NULL,
    owner_id    TEXT NOT NULL DEFAULT 'local',
    name        TEXT NOT NULL,
    data        TEXT NOT NULL,          -- project.json 原文
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (owner_id, id)
);
"""


@dataclass(frozen=True)
class StoredProject:
    id: str
    owner_id: str
    name: str
    data: dict[str, Any]
    created_at: str
    updated_at: str

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


def default_db_path() -> Path:
    """`~/.blocky/blocky.db`，可用 `BLOCKY_HOME` 覆寫。"""
    import os

    home = os.environ.get("BLOCKY_HOME")
    root = Path(home) if home else Path.home() / ".blocky"
    return root / "blocky.db"


class ProjectStore:
    """單機模式的專案表。

    連線每次操作開一條。P0b 的寫入頻率是「使用者按存檔」，連線成本可以忽略，
    而共用連線會逼出 `check_same_thread` 那類與 asyncio 攪在一起的問題。
    """

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    # ---- 讀 ----

    def list(self, *, owner_id: str = LOCAL_OWNER) -> list[StoredProject]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM projects WHERE owner_id = ? ORDER BY updated_at DESC, id",
                (owner_id,),
            ).fetchall()
        return [_row_to_project(r) for r in rows]

    def get(self, project_id: str, *, owner_id: str = LOCAL_OWNER) -> StoredProject | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM projects WHERE owner_id = ? AND id = ?", (owner_id, project_id)
            ).fetchone()
        return _row_to_project(row) if row is not None else None

    # ---- 寫 ----

    def put(
        self,
        project_id: str,
        data: dict[str, Any],
        *,
        owner_id: str = LOCAL_OWNER,
        now: str | None = None,
    ) -> StoredProject:
        """新增或覆寫。`created_at` 只在第一次寫入時決定。"""
        ts = now or _now()
        name = str((data.get("meta") or {}).get("name") or project_id)
        blob = json.dumps(data, ensure_ascii=False, sort_keys=False)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO projects (id, owner_id, name, data, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (owner_id, id) DO UPDATE SET
                    name = excluded.name,
                    data = excluded.data,
                    updated_at = excluded.updated_at
                """,
                (project_id, owner_id, name, blob, ts, ts),
            )
        stored = self.get(project_id, owner_id=owner_id)
        assert stored is not None
        return stored

    def delete(self, project_id: str, *, owner_id: str = LOCAL_OWNER) -> bool:
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM projects WHERE owner_id = ? AND id = ?", (owner_id, project_id)
            )
        return cur.rowcount > 0


def _row_to_project(row: sqlite3.Row) -> StoredProject:
    return StoredProject(
        id=row["id"],
        owner_id=row["owner_id"],
        name=row["name"],
        data=json.loads(row["data"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


__all__ = ["LOCAL_OWNER", "ProjectStore", "StoredProject", "default_db_path"]

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
import re
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from blockyard.home import blockyard_home

LOCAL_OWNER = "local"

#: **專案的身分是一個 opaque id，永遠不是它的位置**（`docs/project-storage-design.md`
#: §3）。這一行是那條規則在程式碼裡的樣子。
#:
#: 已經有四樣東西拿專案當 key：執行歷史、trigger 的 active 狀態、webhook 簽章
#: 密鑰、以及每個專案自己的金鑰。**後兩個住在 OS 鑰匙圈裡，而鑰匙圈不會跟著
#: 資料夾搬家**——所以只要身分裡摻進任何一點「它現在在哪、它現在叫什麼」，
#: 改名或搬家就等於把使用者的金鑰弄丟，而症狀是「我什麼都沒改，它說沒設定」。
#:
#: 這不是假想：改名 Blockyard 那一次把 keyring 的服務名從 `blocky` 改成
#: `blockyard`，金鑰一把都沒掉，但畫面上全部變成「未設定」。
#:
#: 所以 id **產生一次就不變**：改名不動它、匯出再匯入回來也不動它（那份 bundle
#: 帶著同一個 id 回來，見 `blockyard/bundle.py`）。以後真要變成「一個資料夾就是
#: 一個專案」，那也只是多一個 `path` 欄位指向它——上面那四張表一個字都不用改。
ID_PREFIX = "prj_"

#: 一個字串**可不可以被當成專案 id 用**。它會被接成 keyring 的 username、檔名與
#: localStorage 的 key，所以每一條吃 `{project_id}` 的路由都得先問這一句——
#: `../../etc` 是一個看起來很無辜的字串。
#:
#: 比 `new_id()` 產生的形狀寬：`prj_local`（P0b 那個寫死的 id）與使用者從別台
#: 機器帶回來的 bundle 都要進得來。
PROJECT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def new_id() -> str:
    """開一個新的專案 id。

    亂數而不是流水號或名字的 slug：**流水號洩漏「這是我的第幾個專案」，而 slug
    會讓人以為改名應該跟著改 id**——後者正是這整條規則要擋的事。48 bit 對一台
    機器上的幾十個專案遠遠夠用，而且短到可以整個唸出來（除錯時要跟 keyring 裡
    那一行對得起來）。
    """
    return f"{ID_PREFIX}{secrets.token_hex(6)}"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id          TEXT NOT NULL,
    owner_id    TEXT NOT NULL DEFAULT 'local',
    name        TEXT NOT NULL,
    data        TEXT NOT NULL,          -- project.json 原文
    preview     BLOB,                   -- 最近一次由編輯器存檔時截下的 WebP
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
    preview: bytes | None = None

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "preview": (
                f"/api/projects/{self.id}/preview?v={self.updated_at}" if self.preview else None
            ),
        }


def default_db_path() -> Path:
    """`~/.blockyard/blockyard.db`，可用 `BLOCKYARD_HOME` 覆寫。"""
    return blockyard_home() / "blockyard.db"


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
            # 已經存在的資料庫也要就地長出預覽欄位；SQLite 沒有
            # `ADD COLUMN IF NOT EXISTS`，先看 table_info 才不會每次啟動都報錯。
            columns = {row[1] for row in conn.execute("PRAGMA table_info(projects)")}
            if "preview" not in columns:
                conn.execute("ALTER TABLE projects ADD COLUMN preview BLOB")

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

    def rename(
        self, project_id: str, name: str, *, owner_id: str = LOCAL_OWNER
    ) -> StoredProject | None:
        """改名。**id 一個字都不動**（見 `PROJECT_ID` 那一段）。

        名字同時住在兩個地方：`name` 欄位（列表用）與 `data` 裡的 `meta.name`
        （那份 IR 的原文）。兩邊一起改，不然列表上是新名字、打開來是舊的——
        而那種不一致要等到匯出的時候才會有人發現。
        """
        stored = self.get(project_id, owner_id=owner_id)
        if stored is None:
            return None
        data = dict(stored.data)
        meta = dict(data.get("meta") or {})
        meta["name"] = name
        data["meta"] = meta
        return self.put(project_id, data, owner_id=owner_id)

    def delete(self, project_id: str, *, owner_id: str = LOCAL_OWNER) -> bool:
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM projects WHERE owner_id = ? AND id = ?", (owner_id, project_id)
            )
        return cur.rowcount > 0

    def set_preview(
        self, project_id: str, preview: bytes, *, owner_id: str = LOCAL_OWNER
    ) -> bool:
        """換掉卡片預覽，不另算一次專案內容的修改時間。"""
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE projects SET preview = ? WHERE owner_id = ? AND id = ?",
                (preview, owner_id, project_id),
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
        preview=row["preview"],
    )


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


__all__ = [
    "ID_PREFIX",
    "LOCAL_OWNER",
    "PROJECT_ID",
    "ProjectStore",
    "StoredProject",
    "default_db_path",
    "new_id",
]

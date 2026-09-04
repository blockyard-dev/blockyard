"""專案的 active 狀態與 webhook token（§9.2、§9.3，P2 第 2 步）。

§9.2 的第一句是「專案標記為 **active** 時，Trigger Manager 依據 IR 中的 hat
積木註冊所有 trigger」，第四句是「後端重啟時從 SQLite 恢復所有 active 專案的
trigger」。這張表就是那兩句話中間的東西。

**為什麼是一張表而不是 `projects` 的一個欄位。** `projects.data` 存的是 PUT
進來的那份 JSON 原文（見 `projects.py`），而 active 不是專案內容的一部分——
它是「這台後端現在有沒有在跑它」。塞進 IR 的話，匯出一份專案再匯入到別人的
機器上，會連同「開著」一起搬過去，而那台機器並沒有同意跑任何東西。

P1 的監聽（`runs/listeners.py`）沒有這一層，所以它是 process 記憶體、重啟就
沒了——那也正是它的檔頭把自己叫做「Trigger Manager 的前身」的原因。
"""

from __future__ import annotations

import secrets
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from blockyard.storage.projects import LOCAL_OWNER
from blockyard.webhook import TOKEN_CHARS

#: `secrets.token_hex` 吃的是位元組數，吐的是兩倍長度的 hex。
TOKEN_BYTES = TOKEN_CHARS // 2

_SCHEMA = """
CREATE TABLE IF NOT EXISTS active_projects (
    owner_id      TEXT NOT NULL DEFAULT 'local',
    project_id    TEXT NOT NULL,
    activated_at  TEXT NOT NULL,
    PRIMARY KEY (owner_id, project_id)
);

CREATE TABLE IF NOT EXISTS webhook_tokens (
    owner_id    TEXT NOT NULL DEFAULT 'local',
    project_id  TEXT NOT NULL,
    token       TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (owner_id, project_id)
);
"""


@dataclass(frozen=True)
class ActiveProject:
    project_id: str
    activated_at: str


class ActiveStore:
    """哪些專案是 active 的。連線每次操作開一條，同 `ProjectStore`。"""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def list(self, *, owner_id: str = LOCAL_OWNER) -> list[ActiveProject]:
        """啟動時照這個順序恢復。用 `activated_at` 排序而不是插入順序，是為了
        讓「先開的先恢復」——沒有語意上的必要，但重啟前後的日誌長得一樣，
        查起來省事。"""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT project_id, activated_at FROM active_projects "
                "WHERE owner_id = ? ORDER BY activated_at, project_id",
                (owner_id,),
            ).fetchall()
        return [ActiveProject(r["project_id"], r["activated_at"]) for r in rows]

    def is_active(self, project_id: str, *, owner_id: str = LOCAL_OWNER) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM active_projects WHERE owner_id = ? AND project_id = ?",
                (owner_id, project_id),
            ).fetchone()
        return row is not None

    def activate(
        self, project_id: str, *, owner_id: str = LOCAL_OWNER, now: str | None = None
    ) -> None:
        """**保留原本的 `activated_at`。** 重複啟用是最常見的情況（前端的
        「執行」會順手打開），而每次都刷新時間戳等於讓「它從什麼時候開始跑」
        這個問題永遠答不出來。"""
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO active_projects (owner_id, project_id, activated_at) "
                "VALUES (?, ?, ?) ON CONFLICT (owner_id, project_id) DO NOTHING",
                (owner_id, project_id, now or _now()),
            )

    def deactivate(self, project_id: str, *, owner_id: str = LOCAL_OWNER) -> bool:
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM active_projects WHERE owner_id = ? AND project_id = ?",
                (owner_id, project_id),
            )
        return cur.rowcount > 0


class WebhookTokenStore:
    """每個專案一把 §9.3 的隨機 token。

    **一把一個專案，不是一顆積木一把。** 使用者要複製的是一個基底網址，而路徑
    那半寫在積木上——一顆積木一把的話，畫面上每顆 webhook 都是一串不一樣的
    亂碼，而它們保護的是同一份專案。

    **必須落地。** token 是使用者貼進 GitHub 設定頁的那串東西；每次重啟換一把
    等於每次重啟都讓外面所有的 webhook 失效，而失效的樣子是「對方一直收到
    404」——沒有人會來告訴他。

    這裡不用 `secrets.token_hex` 以外的東西：它不是密碼，是一個「猜不到」的
    位址（§9.3 的原話是「避免被掃描」）。
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

    def ensure(self, project_id: str, *, owner_id: str = LOCAL_OWNER) -> str:
        """拿這個專案的 token，沒有就發一把。"""
        if (existing := self.get(project_id, owner_id=owner_id)) is not None:
            return existing
        token = secrets.token_hex(TOKEN_BYTES)
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO webhook_tokens (owner_id, project_id, token, created_at) "
                "VALUES (?, ?, ?, ?) ON CONFLICT (owner_id, project_id) DO NOTHING",
                (owner_id, project_id, token, _now()),
            )
        # ON CONFLICT 代表剛剛有人搶先發過了——回它那一把，不是我這把。
        got = self.get(project_id, owner_id=owner_id)
        assert got is not None
        return got

    def get(self, project_id: str, *, owner_id: str = LOCAL_OWNER) -> str | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT token FROM webhook_tokens WHERE owner_id = ? AND project_id = ?",
                (owner_id, project_id),
            ).fetchone()
        return row["token"] if row is not None else None

    def delete(self, project_id: str, *, owner_id: str = LOCAL_OWNER) -> None:
        """專案被刪掉時一起清。留著的話，下一個剛好同名的專案會繼承一個外面
        可能還有人在打的網址。"""
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM webhook_tokens WHERE owner_id = ? AND project_id = ?",
                (owner_id, project_id),
            )


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


__all__ = ["ActiveProject", "ActiveStore", "WebhookTokenStore"]

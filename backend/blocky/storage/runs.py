"""執行歷史與持久值的 SQLite 落地（§6.3、§5.4 第 4 層）。

在這個檔案存在之前，執行歷史是 `RunManager` 裡的一個 dict、上限 50 筆、重啟
就沒了，而 `persist_*` 是 process 記憶體——D12 承諾的「跨 Run、跨後端重啟」
只兌現了前一半。P2 的驗收句（「關掉瀏覽器，**隔天**檢查執行歷史有紀錄」）
直接踩在這裡。

三張表，一個檔案，理由是它們同生共死：刪掉一個 Run 就該刪掉它的事件，而
持久值與 Run 都以專案為範圍。

**§6.3 的篩選不在這一層。** 這裡是「叫我存什麼就存什麼」，哪些 op 該落地由
`runs/recorder.py` 決定。分開的理由與 `storage/projects.py` 一樣：這一層不知道
事件的語意，所以測得動——給它一列 `block.enter` 它也會乖乖存下去，那是呼叫端
的錯，不是這裡的。
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from blocky.storage.projects import LOCAL_OWNER

#: §6.3：單一 Run 的 `log` 上限。超過丟棄最舊者並在 Run 上標記。
LOG_LIMIT = 10_000

#: 每個專案保留幾次執行（v0.24 的決定，§6.3）。
#:
#: 選「每個專案 N 次」而不是「N 天」：後者的上限不可推理——一個每分鐘跑一次
#: 的 cron，30 天就是 43,200 個 Run，資料庫大小完全取決於使用者設了什麼排程。
#: 「每個流程留最近 200 次」是一句講得完、也想像得出來的話。
RUN_LIMIT_PER_PROJECT = 200

#: 後端被砍掉時還在跑的 Run。不是 `cancelled`——那是使用者按了停止，
#: 是一個有人做過的決定；這個是「沒有人知道它跑到哪裡」。
INTERRUPTED = "interrupted"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id          TEXT NOT NULL,
    owner_id    TEXT NOT NULL DEFAULT 'local',
    seq         INTEGER NOT NULL,
    project_id  TEXT NOT NULL,
    trigger     TEXT NOT NULL,
    block_id    TEXT,
    status      TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    ended_at    TEXT,
    logs_truncated INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, id)
);

CREATE INDEX IF NOT EXISTS runs_by_project
    ON runs (owner_id, project_id, seq DESC);

CREATE TABLE IF NOT EXISTS run_events (
    owner_id  TEXT NOT NULL DEFAULT 'local',
    run_id    TEXT NOT NULL,
    seq       INTEGER NOT NULL,
    op        TEXT NOT NULL,
    data      TEXT NOT NULL,          -- 事件的其餘欄位，JSON
    PRIMARY KEY (owner_id, run_id, seq)
);

CREATE TABLE IF NOT EXISTS persist_values (
    owner_id    TEXT NOT NULL DEFAULT 'local',
    project_id  TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,        -- JSON，與 §7.5 同一條可序列化約束
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (owner_id, project_id, key)
);
"""


@dataclass(frozen=True)
class StoredRun:
    id: str
    project_id: str
    trigger: str
    status: str
    started_at: str
    ended_at: str | None = None
    block_id: str | None = None
    logs_truncated: bool = False

    def summary(self) -> dict[str, Any]:
        """與 `RunHandle.summary()` 同一份形狀——前端分不出這一筆是從記憶體
        還是從 SQLite 來的，也不該分得出來。"""
        d: dict[str, Any] = {
            "runId": self.id,
            "projectId": self.project_id,
            "trigger": self.trigger,
            "status": self.status,
            "startedAt": self.started_at,
        }
        if self.block_id is not None:
            d["blockId"] = self.block_id
        if self.ended_at is not None:
            d["endedAt"] = self.ended_at
        if self.logs_truncated:
            d["logsTruncated"] = True
        return d


class RunStore:
    """執行歷史 + 持久值。連線每次操作開一條，同 `ProjectStore`。"""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    # ---- Run ----

    def next_seq(self, *, owner_id: str = LOCAL_OWNER) -> int:
        """下一個 Run 的流水號。

        **必須從資料庫拿，不能從 process 的計數器拿。** 落地之前 `RunManager`
        的 `r_{self._seq}` 每次重啟都從 1 開始，那時無所謂——重啟就沒有歷史了。
        現在有了，`r_1` 會直接撞上昨天那一筆。
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT MAX(seq) AS m FROM runs WHERE owner_id = ?", (owner_id,)
            ).fetchone()
        return int(row["m"] or 0) + 1

    def start(
        self,
        run_id: str,
        *,
        seq: int,
        project_id: str,
        trigger: str,
        started_at: str,
        block_id: str | None = None,
        owner_id: str = LOCAL_OWNER,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO runs
                    (id, owner_id, seq, project_id, trigger, block_id,
                     status, started_at, ended_at, logs_truncated)
                VALUES (?, ?, ?, ?, ?, ?, 'running', ?, NULL, 0)
                """,
                (run_id, owner_id, seq, project_id, trigger, block_id, started_at),
            )

    def finish(
        self,
        run_id: str,
        *,
        status: str,
        ended_at: str,
        owner_id: str = LOCAL_OWNER,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE runs SET status = ?, ended_at = ? WHERE owner_id = ? AND id = ?",
                (status, ended_at, owner_id, run_id),
            )

    def reconcile_interrupted(self, *, owner_id: str = LOCAL_OWNER, now: str | None = None) -> int:
        """啟動時把上次沒收尾的 Run 標成 `interrupted`。回傳筆數。

        沒有這一步，被 kill -9 的那些 Run 會**永遠**停在 `running`，而執行歷史
        上一排跑不完的紀錄比沒有紀錄更難讀——使用者會以為它們還在跑。
        """
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE runs SET status = ?, ended_at = COALESCE(ended_at, ?) "
                "WHERE owner_id = ? AND status = 'running'",
                (INTERRUPTED, now or _now(), owner_id),
            )
        return cur.rowcount

    def get(self, run_id: str, *, owner_id: str = LOCAL_OWNER) -> StoredRun | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM runs WHERE owner_id = ? AND id = ?", (owner_id, run_id)
            ).fetchone()
        return _row_to_run(row) if row is not None else None

    def list(
        self,
        *,
        project_id: str | None = None,
        limit: int = 100,
        owner_id: str = LOCAL_OWNER,
    ) -> list[StoredRun]:
        """新的在前。排序用 `seq` 而不是 `started_at`——同一毫秒內連按兩次
        執行是完全正常的操作，時間戳撞在一起時順序就不再穩定（同
        `RunManager.list()` 原本用插入順序的理由）。"""
        sql = "SELECT * FROM runs WHERE owner_id = ?"
        args: list[Any] = [owner_id]
        if project_id is not None:
            sql += " AND project_id = ?"
            args.append(project_id)
        sql += " ORDER BY seq DESC LIMIT ?"
        args.append(limit)
        with self._connect() as conn:
            rows = conn.execute(sql, args).fetchall()
        return [_row_to_run(r) for r in rows]

    # ---- 事件 ----

    def append_events(
        self,
        run_id: str,
        events: list[tuple[int, str, dict[str, Any]]],
        *,
        owner_id: str = LOCAL_OWNER,
    ) -> None:
        """`events` 是 (seq, op, data) 的串。seq 由呼叫端給——它才知道這個 Run
        寫到第幾筆了，而每筆都回資料庫問一次 MAX 是白花的。"""
        if not events:
            return
        with self._connect() as conn:
            conn.executemany(
                "INSERT OR REPLACE INTO run_events (owner_id, run_id, seq, op, data) "
                "VALUES (?, ?, ?, ?, ?)",
                [
                    (owner_id, run_id, seq, op, json.dumps(data, ensure_ascii=False))
                    for seq, op, data in events
                ],
            )

    def events(
        self,
        run_id: str,
        *,
        after: int = 0,
        limit: int = 5000,
        owner_id: str = LOCAL_OWNER,
    ) -> list[dict[str, Any]]:
        """依 seq 由小到大。`after` 是**上一頁最後一筆的 seq**，不是 offset：
        分頁期間有新事件寫進來時 offset 會漏掉或重複，seq 不會。"""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT seq, op, data FROM run_events "
                "WHERE owner_id = ? AND run_id = ? AND seq > ? ORDER BY seq LIMIT ?",
                (owner_id, run_id, after, limit),
            ).fetchall()
        return [{"seq": r["seq"], "op": r["op"], **json.loads(r["data"])} for r in rows]

    def mark_logs_truncated(self, run_id: str, *, owner_id: str = LOCAL_OWNER) -> None:
        """標記「這個 Run 的 log 不完整」，不做任何刪除。

        丟棄有兩條路：`enforce_log_limit()` 是資料庫裡超過上限，這個是事件
        **根本沒走到資料庫**（writer 的緩衝區到頂就先丟了）。對使用者是同一
        件事，所以標記必須是同一個；但判斷條件完全不同，所以是兩個方法。
        """
        with self._connect() as conn:
            conn.execute(
                "UPDATE runs SET logs_truncated = 1 WHERE owner_id = ? AND id = ?",
                (owner_id, run_id),
            )

    def enforce_log_limit(
        self,
        run_id: str,
        *,
        limit: int = LOG_LIMIT,
        owner_id: str = LOCAL_OWNER,
    ) -> int:
        """§6.3：`log` 超過上限就丟棄最舊者並標記。回傳丟了幾筆。

        只砍 `log`。骨架事件（`run.*` / `thread.*` / `block.error`）不在這條
        規則裡——它們是執行歷史之所以存在的東西，而且數量由腳本結構決定，
        不會被一個迴圈灌爆。
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM run_events "
                "WHERE owner_id = ? AND run_id = ? AND op = 'log'",
                (owner_id, run_id),
            ).fetchone()
            excess = int(row["n"]) - limit
            if excess <= 0:
                return 0
            conn.execute(
                "DELETE FROM run_events WHERE owner_id = ? AND run_id = ? AND op = 'log' "
                "AND seq IN (SELECT seq FROM run_events WHERE owner_id = ? AND run_id = ? "
                "AND op = 'log' ORDER BY seq LIMIT ?)",
                (owner_id, run_id, owner_id, run_id, excess),
            )
            conn.execute(
                "UPDATE runs SET logs_truncated = 1 WHERE owner_id = ? AND id = ?",
                (owner_id, run_id),
            )
        return excess

    # ---- 剪枝 ----

    def prune(
        self,
        project_id: str,
        *,
        keep: int = RUN_LIMIT_PER_PROJECT,
        owner_id: str = LOCAL_OWNER,
    ) -> int:
        """只留這個專案最近 `keep` 次執行。回傳刪了幾個 Run。

        **配額算所有的 Run，但只刪跑完的。** 兩件事分開：`keep` 是使用者在
        歷史清單上看得到的筆數，所以還在跑的那些也佔位（不然「留最近 200 次」
        在有監聽掛著時就變成 201 筆，那句話開始說謊）；而排在配額外面的若還在
        跑就跳過——一個掛著跑的監聽 Run 可能比 200 次手動執行都舊，刪掉它等於
        在它結束時把 `finish()` 寫進一列不存在的紀錄。
        """
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id FROM runs WHERE owner_id = ? AND project_id = ? "
                "AND status != 'running' AND seq NOT IN ("
                "  SELECT seq FROM runs WHERE owner_id = ? AND project_id = ?"
                "  ORDER BY seq DESC LIMIT ?"
                ")",
                (owner_id, project_id, owner_id, project_id, keep),
            ).fetchall()
            victims = [r["id"] for r in rows]
            if not victims:
                return 0
            marks = ",".join("?" * len(victims))
            conn.execute(
                f"DELETE FROM run_events WHERE owner_id = ? AND run_id IN ({marks})",
                (owner_id, *victims),
            )
            conn.execute(
                f"DELETE FROM runs WHERE owner_id = ? AND id IN ({marks})",
                (owner_id, *victims),
            )
        return len(victims)

    def delete_project_history(self, project_id: str, *, owner_id: str = LOCAL_OWNER) -> None:
        """專案被刪掉時一起清。歷史指向一份不存在的專案是沒有用的紀錄。"""
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM run_events WHERE owner_id = ? AND run_id IN "
                "(SELECT id FROM runs WHERE owner_id = ? AND project_id = ?)",
                (owner_id, owner_id, project_id),
            )
            conn.execute(
                "DELETE FROM runs WHERE owner_id = ? AND project_id = ?",
                (owner_id, project_id),
            )
            conn.execute(
                "DELETE FROM persist_values WHERE owner_id = ? AND project_id = ?",
                (owner_id, project_id),
            )

    # ---- §5.4 第 4 層 ----

    def persist_snapshot(
        self, project_id: str, *, owner_id: str = LOCAL_OWNER
    ) -> dict[str, Any]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT key, value FROM persist_values WHERE owner_id = ? AND project_id = ?",
                (owner_id, project_id),
            ).fetchall()
        return {r["key"]: json.loads(r["value"]) for r in rows}

    def persist_set(
        self,
        project_id: str,
        key: str,
        value: Any,
        *,
        owner_id: str = LOCAL_OWNER,
        now: str | None = None,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO persist_values (owner_id, project_id, key, value, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (owner_id, project_id, key) DO UPDATE SET
                    value = excluded.value, updated_at = excluded.updated_at
                """,
                (
                    owner_id,
                    project_id,
                    key,
                    json.dumps(value, ensure_ascii=False),
                    now or _now(),
                ),
            )

    def persist_delete(
        self, project_id: str, key: str, *, owner_id: str = LOCAL_OWNER
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM persist_values WHERE owner_id = ? AND project_id = ? AND key = ?",
                (owner_id, project_id, key),
            )


class SqlitePersistStore:
    """§5.4 第 4 層的真實後端。實作 `interpreter.scope.PersistStore`。

    **讀走記憶體快取，寫直接落地。** 一次 Run 內同一個 key 被讀幾百次是正常的
    （迴圈裡的計數器），每次開一條 SQLite 連線太貴；而寫必須立刻落地，因為
    「跨後端重啟存活」就是這一層存在的全部理由——攢著等 Run 結束再寫，被
    kill -9 的那次就白記了。

    快取在**這個 Run 開始時**載入一次。同一個專案的兩個 Run 併發跑時各有一份
    快取，互相看不到對方的寫入——這與 §5.4 說的「不保證跨 Run 的原子性」是
    同一條已知限制（§16 Q11），不是新的洞。
    """

    def __init__(self, store: RunStore, project_id: str, *, owner_id: str = LOCAL_OWNER) -> None:
        self._store = store
        self._project_id = project_id
        self._owner_id = owner_id
        self._cache: dict[str, Any] = store.persist_snapshot(project_id, owner_id=owner_id)

    def get(self, key: str) -> Any:
        return self._cache[key]

    def has(self, key: str) -> bool:
        return key in self._cache

    def set(self, key: str, value: Any) -> None:
        self._cache[key] = value
        self._store.persist_set(self._project_id, key, value, owner_id=self._owner_id)

    def delete(self, key: str) -> None:
        self._cache.pop(key, None)
        self._store.persist_delete(self._project_id, key, owner_id=self._owner_id)

    def snapshot(self) -> dict[str, Any]:
        return dict(self._cache)


def _row_to_run(row: sqlite3.Row) -> StoredRun:
    return StoredRun(
        id=row["id"],
        project_id=row["project_id"],
        trigger=row["trigger"],
        status=row["status"],
        started_at=row["started_at"],
        ended_at=row["ended_at"],
        block_id=row["block_id"],
        logs_truncated=bool(row["logs_truncated"]),
    )


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


__all__ = [
    "INTERRUPTED",
    "LOG_LIMIT",
    "RUN_LIMIT_PER_PROJECT",
    "RunStore",
    "SqlitePersistStore",
    "StoredRun",
]

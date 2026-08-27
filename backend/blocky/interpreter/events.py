"""執行事件（§6.1）與其正規化（§17.1）。

事件有兩個消費者，規則不同：
  - 前端：§6.2 的批次與聚合
  - 題庫：§17.1 的正規化比對
兩者共用同一份原始事件，差別只在後處理。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

# §6.2：value 欄位序列化上限 4KB，超過則截斷並標記 truncated
VALUE_LIMIT_BYTES = 4096


@dataclass
class Event:
    op: str
    data: dict[str, Any] = field(default_factory=dict)
    ts: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"op": self.op, **self.data}


class EventSink:
    """收集事件。真實後端會換成 WebSocket broadcaster，題庫用這個。"""

    def __init__(self) -> None:
        self.events: list[Event] = []

    def emit(self, op: str, **data: Any) -> None:
        self.events.append(Event(op=op, data=data))

    def dicts(self) -> list[dict[str, Any]]:
        return [e.to_dict() for e in self.events]


def clip_value(v: Any) -> tuple[Any, bool]:
    """§6.2 的 4KB 上限。回 (值, 是否截斷)。"""
    try:
        s = json.dumps(v, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return repr(v)[:VALUE_LIMIT_BYTES], True
    if len(s.encode("utf-8")) <= VALUE_LIMIT_BYTES:
        return v, False
    return s[: VALUE_LIMIT_BYTES // 4] + "…", True


# --------------------------------------------------------------------------
# §17.1 正規化：讓比對穩定
# --------------------------------------------------------------------------

# 移除的欄位——它們每次執行都不同，比對它們只會製造 flaky test
_VOLATILE = ("ts", "durationMs")


def normalize(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """依 §17.1 的表格正規化事件序列。

    blockId **保留原值**——它是題目的一部分，錯了就是定位錯了。
    """
    run_ids: dict[str, str] = {}
    thread_ids: dict[str, str] = {}
    out: list[dict[str, Any]] = []

    for ev in events:
        e = {k: v for k, v in ev.items() if k not in _VOLATILE}

        if (rid := e.get("runId")) is not None:
            e["runId"] = run_ids.setdefault(rid, f"r{len(run_ids) + 1}")
        if (tid := e.get("threadId")) is not None:
            e["threadId"] = thread_ids.setdefault(tid, f"t{len(thread_ids) + 1}")

        if isinstance(err := e.get("error"), dict):
            # 只保留例外型別與訊息首行；traceback 每個 Python 版本都不同
            e["error"] = {
                k: err[k] for k in ("type", "code", "message", "blockId", "hint") if k in err
            }

        out.append(e)

    return out


def split_by_thread(events: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """§17.3：跨 thread 的交錯順序不確定，各 thread 分開驗證。"""
    per: dict[str, list[dict[str, Any]]] = {}
    for e in events:
        tid = e.get("threadId")
        if tid is not None:
            per.setdefault(tid, []).append(e)
    return per

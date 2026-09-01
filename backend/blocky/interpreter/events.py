"""執行事件（§6.1）與其正規化（§17.1）。

事件有兩個消費者，規則不同：
  - 前端：§6.2 的批次與聚合
  - 題庫：§17.1 的正規化比對
兩者共用同一份原始事件，差別只在後處理。
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any, Callable

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
    """收集事件。

    兩種用法共用同一個類別，差別只在建構參數：

      題庫    `EventSink()`——全部留著，跑完一次拿 `dicts()` 比對。
      實際跑  `EventSink(on_emit=broker.publish, retain=False)`——即時轉給
              §6.2 的批次器，**不累積**。留著的話一個掛三天的 `forever`
              迴圈會把幾億筆事件放在記憶體裡，而那些事件早就送出去了。

    `on_emit` 是同步呼叫的：引擎在 event loop 上跑，publish 只是塞進一個
    list，不能 await——否則 emit 會變成 yield 點，改變 §5.2 的讓出時機。
    """

    def __init__(
        self,
        *,
        on_emit: Callable[[Event], None] | None = None,
        retain: bool = True,
        secrets: Iterable[str] = (),
    ) -> None:
        self.events: list[Event] = []
        self._on_emit = on_emit
        self._retain = retain
        self._secrets: set[str] = {s for s in secrets if s}

    def register_secrets(self, values: Iterable[str | None]) -> None:
        """§12.2：把這次 Run 用到的 secret 明文值加進遮蔽名單。

        呼叫端（`api/validation.py::open_project`）在解出 config 之後才知道
        有哪些值，所以是後補而不是建構子一次給——建構子的 `secrets` 是給
        已經知道全部名單的呼叫端（例如測試）用的捷徑。
        """
        self._secrets.update(v for v in values if v)

    def emit(self, op: str, **data: Any) -> None:
        if self._secrets:
            data = _redact(data, self._secrets)
        ev = Event(op=op, data=data)
        if self._retain:
            self.events.append(ev)
        if self._on_emit is not None:
            self._on_emit(ev)

    def dicts(self) -> list[dict[str, Any]]:
        return [e.to_dict() for e in self.events]


def _redact(v: Any, secrets: set[str]) -> Any:
    """§12.2 的值遮蔽：子字串比對，命中換成 `***`。

    粗暴但有效——完整方案需要污點追蹤，成本遠超 v1 的預算（§12.2 的已知
    限制：擋不住編碼過或被切割的 secret）。只走 `dict`／`list`／`str`：
    事件的 `data` 不會有別的容器型別。
    """
    if isinstance(v, str):
        for s in secrets:
            if s in v:
                v = v.replace(s, "***")
        return v
    if isinstance(v, dict):
        return {k: _redact(item, secrets) for k, item in v.items()}
    if isinstance(v, list):
        return [_redact(item, secrets) for item in v]
    return v


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

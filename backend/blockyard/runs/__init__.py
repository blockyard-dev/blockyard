"""Run 的執行、事件出口與流量控制（§5、§6）。

    broker.py    §6.2：50ms 批次、`block.hot` 聚合、慢客戶端的丟棄
    recorder.py  §6.3：哪些事件進 SQLite，以及怎麼批次進
    manager.py   §5.1／§5.5：Run 的生命週期與外部停止
    scratch.py   §5.1：工具箱裡那一顆積木帶進來的一小段 IR（不落地）
    triggers.py  §9：active 狀態、hat 的 diff 與重啟恢復

路由在 `api/runs.py`。切開的理由與 `storage/` 一樣：這一層不知道 HTTP 存在，
所以測得動——`test_runs.py` 大半的題目不需要起一個 app。
"""

from __future__ import annotations

from blockyard.runs.broker import HOT_THRESHOLD, WINDOW_S, RunBroker, collapse
from blockyard.runs.manager import (
    DEFAULT_TRIGGER,
    HANDOFF_LIMIT,
    MANUAL_TRIGGER,
    ProjectNotFound,
    RunHandle,
    RunManager,
)
from blockyard.runs.recorder import STORED_OPS, RunRecorder
from blockyard.runs.scratch import merge as merge_scratch
from blockyard.runs.triggers import ProjectTriggers, TriggerManager

__all__ = [
    "DEFAULT_TRIGGER",
    "HANDOFF_LIMIT",
    "HOT_THRESHOLD",
    "MANUAL_TRIGGER",
    "STORED_OPS",
    "WINDOW_S",
    "ProjectNotFound",
    "RunBroker",
    "RunHandle",
    "RunManager",
    "ProjectTriggers",
    "RunRecorder",
    "TriggerManager",
    "collapse",
    "merge_scratch",
]

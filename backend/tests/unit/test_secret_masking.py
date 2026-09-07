"""§12.2 值遮蔽：secret 明文不能沿著事件流跑出去。

`_redact`／`redact_url` 本身是純函數，直接測；這裡另外補一條端到端——
一個宣告了 `secret` config 的積木包，把那個值 log 出去，WS 事件流裡不能
看到明文。只測這一條路徑（不是每個事件型別各測一次）：`emit()` 是唯一的
出口，能證明它接住，其餘事件型別走的是同一個函式。
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from blockyard.api.app import create_app
from blockyard.extensions import secret_store
from blockyard.extensions.httpclient import redact_url
from blockyard.interpreter.events import EventSink, _redact

LEAKY_TOKEN = "sk-super-secret-value"  # pragma: allowlist secret


def leaky_project(project_id: str = "p_leak") -> dict[str, Any]:
    return {
        "formatVersion": 1,
        "meta": {"id": project_id, "name": "洩漏測試"},
        "extensions": [{"id": "leaky", "version": "0.1.0"}],
        "scripts": [{"id": "sc_1", "top": "hat"}],
        "blocks": {
            "hat": {"opcode": "event.when_flag_clicked", "next": "spill"},
            "spill": {"opcode": "leaky.spill"},
        },
    }


def _write_leaky_extension(root: Path) -> None:
    pkg = root / "leaky"
    pkg.mkdir(parents=True)
    (pkg / "manifest.yaml").write_text(
        "manifestVersion: 1\n"
        "id: leaky\n"
        "name: 洩漏測試\n"
        "version: 0.1.0\n"
        "permissions: []\n"
        "requirements: []\n"
        "config:\n"
        "  - key: token\n"
        "    type: secret\n"
        "    label: Token\n"
        "    envVar: LEAKY_TOKEN\n"
        "palette:\n"
        "  - opcode: spill\n"
        "    type: command\n"
        "    text: 洩漏 token\n"
        "    args: {}\n",
        encoding="utf-8",
    )
    (pkg / "main.py").write_text(
        "from blockyard import block\n\n"
        "@block('leaky.spill')\n"
        "async def spill(ctx) -> None:\n"
        "    ctx.log(f'token is {ctx.config[\"token\"]}')\n",
        encoding="utf-8",
    )


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    ext_root = tmp_path / "extensions"
    _write_leaky_extension(ext_root)
    app = create_app(db_path=tmp_path / "blockyard.db", extensions_root=ext_root)
    with TestClient(app) as c:
        yield c


def save(client: TestClient, project: dict[str, Any]) -> str:
    pid = project["meta"]["id"]
    res = client.put(f"/api/projects/{pid}", json=project)
    assert res.status_code in (200, 201), res.text
    return pid


def drain(ws: Any, *, limit: int = 400) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for _ in range(limit):
        frame = ws.receive_json()
        events.extend(frame["events"])
        if any(e["op"] == "run.end" for e in frame["events"]):
            return events
    raise AssertionError(f"收了 {limit} 個 frame 還沒等到 run.end：{events[-5:]}")


# --------------------------------------------------------------------------
# 端到端：Run 一個會把 secret log 出來的積木包
# --------------------------------------------------------------------------


def test_run_masks_secret_values_in_the_event_stream(client: TestClient) -> None:
    # 金鑰掛在**這個專案**的 `leaky` 底下（§16 Q23）——執行時 `open_project`
    # 從 IR 的 `meta.id` 讀出同一個主詞。
    secret_store.set(secret_store.owner_of("p_leak", "leaky"), "token", LEAKY_TOKEN)
    pid = save(client, leaky_project())

    run = client.post("/api/runs", json={"projectId": pid})
    assert run.status_code == 201, run.text
    run_id = run.json()["runId"]

    with client.websocket_connect(f"/ws/run/{run_id}") as ws:
        events = drain(ws)

    raw = json.dumps(events, ensure_ascii=False)
    assert LEAKY_TOKEN not in raw

    logs = [e for e in events if e["op"] == "log"]
    assert logs, events
    assert "***" in logs[0]["text"]


def test_run_without_the_secret_configured_does_not_crash(client: TestClient) -> None:
    """沒有設定金鑰時 `ctx.config['token']` 是 `None`——log 出來就是空遮蔽
    集合（沒有東西可比對），不該讓遮蔽機制本身炸掉。"""
    pid = save(client, leaky_project(project_id="p_leak_unset"))

    run = client.post("/api/runs", json={"projectId": pid})
    assert run.status_code == 201, run.text
    with client.websocket_connect(f"/ws/run/{run.json()['runId']}") as ws:
        events = drain(ws)

    assert events[-1]["status"] == "ok"


# --------------------------------------------------------------------------
# 單元：_redact / register_secrets（純函數）
# --------------------------------------------------------------------------


def test_redact_replaces_the_secret_in_nested_structures() -> None:
    secrets = {"sk-abc123"}
    data = {
        "a": "token=sk-abc123",
        "b": ["ok", "sk-abc123 again"],
        "c": {"d": "sk-abc123"},
        "e": 42,
        "f": None,
    }
    out = _redact(data, secrets)
    assert out == {
        "a": "token=***",
        "b": ["ok", "*** again"],
        "c": {"d": "***"},
        "e": 42,
        "f": None,
    }


def test_redact_ignores_empty_secret_values() -> None:
    # 空字串一旦進了遮蔽集合，`"" in v` 對任何字串都是 True——會把每個字串
    # 都換成 `***`。空值必須在進集合之前就被濾掉。
    out = _redact({"a": "hello"}, set())
    assert out == {"a": "hello"}


def test_event_sink_register_secrets_filters_falsy_values() -> None:
    sink = EventSink(retain=True)
    sink.register_secrets(["sk-real", None, "", "sk-real"])
    assert sink._secrets == {"sk-real"}

    sink.emit("log", text="value is sk-real")
    assert sink.events[0].data["text"] == "value is ***"


def test_redact_url_masks_sensitive_query_params_only() -> None:
    url = "https://api.example.com/v1/things?api_key=sk-abc&page=2&access_token=tok-xyz"
    out = redact_url(url)
    assert "sk-abc" not in out
    assert "tok-xyz" not in out
    assert "page=2" in out
    assert out.startswith("https://api.example.com/v1/things?")
    # `***` 要原樣讀得出來——不能被 urlencode 自己 percent-encode 成
    # `%2A%2A%2A`，那樣讀起來比明文還難懂，違背遮蔽的用意。
    assert "api_key=***" in out
    assert "access_token=***" in out


def test_redact_url_leaves_urls_without_query_untouched() -> None:
    url = "https://api.example.com/v1/things"
    assert redact_url(url) == url

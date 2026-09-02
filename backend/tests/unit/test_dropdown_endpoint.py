"""`POST /api/extensions/{ext_id}/dropdown/{source}`（附錄 A、D22）。

`http.methods` 是設計文件自己點名的第一個測試對象：選項封閉、答案不會變，
錯了一眼看得出來。另外用一個會讀 `ctx.config` 的合成積木包，證明這條路
真的把（可能含 secret 的）config 接進去了，不是只轉發一個空殼。
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from blocky.api.app import create_app
from blocky.extensions import DEFAULT_EXTENSIONS_ROOT, secret_store


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    app = create_app(db_path=tmp_path / "blocky.db", extensions_root=DEFAULT_EXTENSIONS_ROOT)
    with TestClient(app) as c:
        yield c


def test_http_methods_is_the_reference_target(client: TestClient) -> None:
    res = client.post("/api/extensions/http/dropdown/methods")
    assert res.status_code == 200, res.text
    options = res.json()
    assert {o["value"] for o in options} == {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"}
    assert all(isinstance(o["label"], str) for o in options)


def test_unknown_extension_is_404(client: TestClient) -> None:
    res = client.post("/api/extensions/nope/dropdown/whatever")
    assert res.status_code == 404


def test_unknown_source_on_a_real_extension_is_422(client: TestClient) -> None:
    res = client.post("/api/extensions/http/dropdown/nope")
    assert res.status_code == 422
    assert "http" in res.json()["detail"]["message"]


# --------------------------------------------------------------------------
# 合成積木包：證明 config（含 secret）真的接進來了
# --------------------------------------------------------------------------


def _write_labeled_extension(root: Path) -> None:
    pkg = root / "labeled"
    pkg.mkdir(parents=True)
    (pkg / "manifest.yaml").write_text(
        "manifestVersion: 1\n"
        "id: labeled\n"
        "name: 標籤\n"
        "version: 0.1.0\n"
        "permissions: []\n"
        "requirements: []\n"
        "config:\n"
        "  - key: token\n"
        "    type: secret\n"
        "    label: Token\n"
        "    envVar: LABELED_TOKEN\n"
        "palette: []\n",
        encoding="utf-8",
    )
    (pkg / "main.py").write_text(
        "from blocky import dropdown\n\n"
        "@dropdown('labeled.options')\n"
        "async def options(ctx):\n"
        "    return [{'label': ctx.config.get('token') or '（沒有金鑰）', 'value': 'x'}]\n",
        encoding="utf-8",
    )


@pytest.fixture
def labeled_client(tmp_path: Path) -> Iterator[TestClient]:
    ext_root = tmp_path / "extensions"
    _write_labeled_extension(ext_root)
    app = create_app(db_path=tmp_path / "blocky.db", extensions_root=ext_root)
    with TestClient(app) as c:
        yield c


def test_dropdown_source_sees_the_resolved_secret(labeled_client: TestClient) -> None:
    secret_store.set("labeled", "token", "sk-dropdown-secret")
    res = labeled_client.post("/api/extensions/labeled/dropdown/options")
    assert res.status_code == 200, res.text
    assert res.json() == [{"label": "sk-dropdown-secret", "value": "x"}]


def test_dropdown_source_without_the_secret_gets_the_fallback(labeled_client: TestClient) -> None:
    res = labeled_client.post("/api/extensions/labeled/dropdown/options")
    assert res.status_code == 200, res.text
    assert res.json() == [{"label": "（沒有金鑰）", "value": "x"}]


def test_require_secret_reaches_the_browser_as_a_readable_sentence(tmp_path: Path) -> None:
    """`ctx.require_secret` 的那句話要原封不動走到 `detail.message`。

    **前端直接顯示它**：下拉抓不到選項時，選單裡頂著的就是這一句
    （`FieldDynamicDropdown::notice`）。這是 `discord.servers` 在 token 還沒設定
    時唯一會發生的事，而它原本畫出來是一格空白——空白說不出 token 沒設定，
    使用者只會覺得那顆積木壞了。

    所以這一題釘住的不是狀態碼，是**那句話到得了瀏覽器**。
    """
    root = tmp_path / "extensions"
    pkg = root / "needy"
    pkg.mkdir(parents=True)
    (pkg / "manifest.yaml").write_text(
        "manifestVersion: 1\n"
        "id: needy\n"
        "name: 需要金鑰的包\n"
        "version: 0.1.0\n"
        "permissions: []\n"
        "requirements: []\n"
        "config:\n"
        "  - key: token\n"
        "    type: secret\n"
        "    label: Bot Token\n"
        "palette: []\n",
        encoding="utf-8",
    )
    (pkg / "main.py").write_text(
        "from blocky import dropdown\n\n"
        "@dropdown('needy.things')\n"
        "async def things(ctx):\n"
        "    ctx.require_secret('token')\n"
        "    return []\n",
        encoding="utf-8",
    )
    app = create_app(db_path=tmp_path / "blocky.db", extensions_root=root)
    with TestClient(app) as client:
        res = client.post("/api/extensions/needy/dropdown/things")

    assert res.status_code == 422, res.text
    message = res.json()["detail"]["message"]
    assert "需要金鑰的包" in message and "Bot Token" in message

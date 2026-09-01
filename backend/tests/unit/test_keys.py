"""`/api/keys`（D28）：清單、逐筆寫入／刪除、匯入 `.env`。

列表只給末四碼、寫入回的是狀態、匯入回的是變數名——這幾條路上都順手斷言
一次 response body 裡沒有那串值。完整明文只有 `/reveal` 給得出來，而它是
唯一一個該出現明文的地方。
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from blocky.api.app import create_app
from blocky.extensions import secret_store

SECRET_VALUE = "sk-imported-value"  # pragma: allowlist secret


def _write_vault_extension(root: Path) -> None:
    pkg = root / "vault"
    pkg.mkdir(parents=True)
    (pkg / "manifest.yaml").write_text(
        "manifestVersion: 1\n"
        "id: vault\n"
        "name: 金庫\n"
        "version: 0.1.0\n"
        "permissions: []\n"
        "requirements: []\n"
        "config:\n"
        "  - key: api_key\n"
        "    type: secret\n"
        "    label: API Key\n"
        "    envVar: VAULT_API_KEY\n"
        "palette: []\n",
        encoding="utf-8",
    )
    (pkg / "main.py").write_text("", encoding="utf-8")


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    ext_root = tmp_path / "extensions"
    _write_vault_extension(ext_root)
    app = create_app(db_path=tmp_path / "blocky.db", extensions_root=ext_root)
    with TestClient(app) as c:
        yield c


def test_list_keys_reports_configured_state_without_leaking_the_value(client: TestClient) -> None:
    res = client.get("/api/keys")
    assert res.status_code == 200
    entries = res.json()
    (vault_entry,) = [e for e in entries if e["extId"] == "vault"]
    assert vault_entry == {
        "extId": "vault",
        "extName": "金庫",
        "key": "api_key",
        "label": "API Key",
        "envVar": "VAULT_API_KEY",
        "configured": False,
        "suffix": None,
    }

    secret_store.set("vault", "api_key", SECRET_VALUE)
    res = client.get("/api/keys")
    (vault_entry,) = [e for e in res.json() if e["extId"] == "vault"]
    assert vault_entry["configured"] is True
    # 末四碼是刻意的例外，讓使用者分得出裝著的是哪一把；完整明文仍然不回來。
    assert vault_entry["suffix"] == SECRET_VALUE[-4:]
    assert SECRET_VALUE not in res.text


def test_import_env_writes_matched_lines_and_lists_unmatched_names_only(client: TestClient) -> None:
    env_text = "\n".join(
        [
            "# a comment",
            "",
            f'VAULT_API_KEY="{SECRET_VALUE}"',
            "SOME_OTHER_KEY=whatever-nobody-declared",
        ]
    )
    res = client.post("/api/keys/import-env", json={"text": env_text})
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["written"] == [{"extId": "vault", "key": "api_key", "envVar": "VAULT_API_KEY"}]
    assert body["unmatched"] == ["SOME_OTHER_KEY"]
    assert SECRET_VALUE not in res.text
    assert "whatever-nobody-declared" not in res.text

    assert secret_store.get("vault", "api_key") == SECRET_VALUE

    listed = client.get("/api/keys").json()
    (vault_entry,) = [e for e in listed if e["extId"] == "vault"]
    assert vault_entry["configured"] is True


def test_import_env_does_not_write_when_nothing_matches(client: TestClient) -> None:
    res = client.post("/api/keys/import-env", json={"text": "RANDOM=1\n"})
    assert res.status_code == 200
    body = res.json()
    assert body["written"] == []
    assert body["unmatched"] == ["RANDOM"]
    assert secret_store.get("vault", "api_key") is None


def test_短的金鑰整個不給末四碼(client: TestClient) -> None:
    # 末四碼對一把 6 個字元的密鑰來說不是遮蔽，是洩漏。
    secret_store.set("vault", "api_key", "abc123")
    (entry,) = [e for e in client.get("/api/keys").json() if e["extId"] == "vault"]
    assert entry["configured"] is True
    assert entry["suffix"] is None


def test_put_寫得進去而且回的是狀態不是值(client: TestClient) -> None:
    res = client.put("/api/keys/vault/api_key", json={"value": SECRET_VALUE})
    assert res.status_code == 200, res.text
    assert res.json() == {
        "extId": "vault",
        "key": "api_key",
        "configured": True,
        "suffix": SECRET_VALUE[-4:],
    }
    assert SECRET_VALUE not in res.text
    assert secret_store.get("vault", "api_key") == SECRET_VALUE


def test_put_直接覆寫既有的那一把(client: TestClient) -> None:
    # 「換一把」跟「第一次填」在使用者眼裡是同一個動作。
    client.put("/api/keys/vault/api_key", json={"value": "sk-old-value-aaaa"})
    client.put("/api/keys/vault/api_key", json={"value": "sk-new-value-bbbb"})
    assert secret_store.get("vault", "api_key") == "sk-new-value-bbbb"


def test_put_不收沒有被宣告過的金鑰(client: TestClient) -> None:
    # 沒有這道檢查，這個端點就是一個「從瀏覽器往 OS 鑰匙圈塞任意鍵值」的入口。
    res = client.put("/api/keys/vault/not_declared", json={"value": "x" * 20})
    assert res.status_code == 404
    res = client.put("/api/keys/no_such_pack/api_key", json={"value": "x" * 20})
    assert res.status_code == 404


def test_put_不收空值(client: TestClient) -> None:
    assert client.put("/api/keys/vault/api_key", json={"value": "   "}).status_code == 400
    assert secret_store.get("vault", "api_key") is None


def test_delete_拿得掉而且連按兩下不會噴錯(client: TestClient) -> None:
    secret_store.set("vault", "api_key", SECRET_VALUE)

    res = client.delete("/api/keys/vault/api_key")
    assert res.status_code == 200, res.text
    assert res.json()["removed"] is True
    assert secret_store.get("vault", "api_key") is None

    # 端點描述的是「結束狀態」：本來就沒有也是 200。
    again = client.delete("/api/keys/vault/api_key")
    assert again.status_code == 200
    assert again.json()["removed"] is False


def test_delete_一樣要對得上宣告(client: TestClient) -> None:
    assert client.delete("/api/keys/vault/not_declared").status_code == 404


def test_reveal_是唯一一個給得出完整明文的地方(client: TestClient) -> None:
    secret_store.set("vault", "api_key", SECRET_VALUE)

    res = client.get("/api/keys/vault/api_key/reveal")
    assert res.status_code == 200, res.text
    assert res.json() == {"value": SECRET_VALUE}
    # 這一份不該留在任何一層快取裡。
    assert res.headers["cache-control"] == "no-store"

    # 而列表那條路仍然只給末四碼——明文沒有因為開了 /reveal 就滲進去。
    assert SECRET_VALUE not in client.get("/api/keys").text


def test_reveal_沒設定的那一把是_404(client: TestClient) -> None:
    assert client.get("/api/keys/vault/api_key/reveal").status_code == 404


def test_reveal_一樣要對得上宣告(client: TestClient) -> None:
    assert client.get("/api/keys/vault/not_declared/reveal").status_code == 404
    assert client.get("/api/keys/no_such_pack/api_key/reveal").status_code == 404

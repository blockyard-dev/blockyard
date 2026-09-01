"""測試全域治具。

**沒有測試該碰真的 OS keyring**（macOS 鑰匙圈／Windows Credential Manager／
Secret Service）——不然每次跑測試都在開發者機器上寫真的憑證，而且測試之間
會互相汙染。`autouse` 讓這件事不必每個測試檔自己記得掛。
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest


@pytest.fixture(autouse=True)
def _fake_keyring(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    import keyring
    import keyring.errors

    store: dict[tuple[str, str], str] = {}

    def fake_get(service: str, username: str) -> str | None:
        return store.get((service, username))

    def fake_set(service: str, username: str, password: str) -> None:
        store[(service, username)] = password

    def fake_delete(service: str, username: str) -> None:
        if (service, username) not in store:
            raise keyring.errors.PasswordDeleteError(username)
        del store[(service, username)]

    monkeypatch.setattr(keyring, "get_password", fake_get)
    monkeypatch.setattr(keyring, "set_password", fake_set)
    monkeypatch.setattr(keyring, "delete_password", fake_delete)
    yield

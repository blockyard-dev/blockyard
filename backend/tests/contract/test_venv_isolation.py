"""uv venv 依賴隔離（D13、§7.6 第 3 步、P1 第 3 步 Phase 1）。

`http` 的 `requirements: []` 沒有東西要裝，所以「一個包一個 venv」這件事
一路以來沒有真的被走過。這裡用一個宣告了真實 `requirements` 的合成積木包，
證明兩件事：子 process 裡 import 得到那個套件、backend 自己的環境沒有被
悄悄裝進東西（證明真的隔離，不是碰巧兩邊都有）。
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

from blockyard.errors import ExtensionError
from blockyard.extensions import CallContexts, EventSinkChannel, SubprocessHost, discover
from blockyard.extensions import venv as venv_mod
from blockyard.interpreter.events import EventSink

_REQUIREMENT = "tomli-w>=1.0,<2"
_IMPORT_NAME = "tomli_w"


def _write_extension(root: Path) -> None:
    pkg = root / "needs_deps"
    pkg.mkdir()
    (pkg / "manifest.yaml").write_text(
        "manifestVersion: 1\n"
        "id: needs_deps\n"
        "name: 需要依賴的包\n"
        "version: 0.1.0\n"
        "permissions: []\n"
        f"requirements: [\"{_REQUIREMENT}\"]\n"
        "palette:\n"
        "  - opcode: dumps\n"
        "    type: reporter\n"
        "    returns: string\n"
        "    text: 把東西 dump 成 toml\n"
        "    args: {}\n",
        encoding="utf-8",
    )
    (pkg / "main.py").write_text(
        "from blockyard import block\n\n"
        "@block('needs_deps.dumps')\n"
        "async def dumps(ctx):\n"
        f"    import {_IMPORT_NAME}\n"
        f"    return {_IMPORT_NAME}.dumps({{'a': 1}})\n",
        encoding="utf-8",
    )


@pytest.fixture(autouse=True)
def _isolated_blockyard_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """每個測試自己的 `~/.blockyard`，不動到使用者真正的 venv 快取，也不讓測試
    之間互相汙染 `.requirements.lock`。"""
    monkeypatch.setenv("BLOCKYARD_HOME", str(tmp_path / "home"))
    venv_mod._locks.clear()


async def test_declared_requirements_are_installed_in_an_isolated_venv(tmp_path: Path) -> None:
    _write_extension(tmp_path)
    contexts = CallContexts()
    channel = EventSinkChannel(EventSink(), contexts)
    sources = discover(tmp_path)
    host = SubprocessHost(sources, channel, contexts, extensions_root=tmp_path)

    await host.load("needs_deps")
    try:
        ctx = contexts.open("needs_deps", thread_id="t1", block_id="b1")
        try:
            result = await host.call("needs_deps.dumps", {}, ctx.token)
        finally:
            contexts.close(ctx.token)
        assert result.strip() == 'a = 1'
    finally:
        await host.unload("needs_deps")

    # backend 自己的直譯器沒有被悄悄裝進這個套件——證明剛剛那次呼叫是真的
    # 跑在另一個環境，不是碰巧本來就裝著。
    import subprocess

    probe = subprocess.run(
        [sys.executable, "-c", f"import {_IMPORT_NAME}"],
        capture_output=True,
    )
    assert probe.returncode != 0


async def test_second_load_does_not_reinstall_when_requirements_are_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[list[str]] = []
    original_run = venv_mod._run

    async def spy(cmd: list[str], *, ext_id: str) -> None:
        calls.append(cmd)
        await original_run(cmd, ext_id=ext_id)

    monkeypatch.setattr(venv_mod, "_run", spy)

    interpreter1 = await venv_mod.ensure_interpreter("needs_deps", [_REQUIREMENT])
    installs_after_first = sum(1 for c in calls if "install" in c)
    assert installs_after_first == 1

    interpreter2 = await venv_mod.ensure_interpreter("needs_deps", [_REQUIREMENT])
    installs_after_second = sum(1 for c in calls if "install" in c)

    assert interpreter1 == interpreter2
    assert installs_after_second == installs_after_first  # 沒有再跑一次 uv pip install


async def test_empty_requirements_use_the_backend_interpreter() -> None:
    interpreter = await venv_mod.ensure_interpreter("http", [])
    assert interpreter == Path(sys.executable)


async def test_missing_uv_raises_a_clear_error(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_exec(*args: Any, **kwargs: Any) -> Any:
        raise FileNotFoundError()

    monkeypatch.setattr(venv_mod.asyncio, "create_subprocess_exec", fake_exec)

    with pytest.raises(ExtensionError, match="沒裝 `uv`"):
        await venv_mod.ensure_interpreter("needs_deps", [_REQUIREMENT])

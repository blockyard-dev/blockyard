"""Trusted front-end packs share installation, discovery and static assets with Python packs."""

import tarfile
from io import BytesIO
from unittest.mock import AsyncMock
from zipfile import ZipFile

import pytest
import yaml
from fastapi.testclient import TestClient

from blockyard.api.app import create_app
from blockyard.errors import ExtensionError
from blockyard.extensions import github
from blockyard.extensions.install import stage
from blockyard.extensions.manifest import discover, parse_manifest, read_pack
from blockyard.extensions.receipt import Origin
from blockyard.extensions.registry import open_registry

MANIFEST = {
    "id": "editor_demo",
    "name": "Editor Demo",
    "version": "1.0.0",
    "editor": {"entry": "ui/editor.js", "apiVersion": 1},
}
FILES = {
    "manifest.yaml": yaml.safe_dump(MANIFEST),
    "ui/editor.js": "export function activate(editor) {}",
}


def archive(files=FILES, tar=False):
    out = BytesIO()
    if tar:
        with tarfile.open(fileobj=out, mode="w:gz") as bundle:
            for name, value in files.items():
                data = value.encode()
                info = tarfile.TarInfo("repo-main/" + name)
                info.size = len(data)
                bundle.addfile(info, BytesIO(data))
    else:
        with ZipFile(out, "w") as bundle:
            for name, value in files.items():
                bundle.writestr(name, value)
    return out.getvalue()


@pytest.mark.parametrize("source", ["zip", "github"])
def test_frontend_only_install_update_assets(tmp_path, monkeypatch, source):
    root = tmp_path / "extensions"
    root.mkdir()
    ensure = AsyncMock(side_effect=AssertionError("JS packs must not create a venv"))
    monkeypatch.setattr("blockyard.extensions.install.ensure_interpreter", ensure)
    monkeypatch.setattr(github, "_download", AsyncMock(return_value=archive(tar=True)))
    app = create_app(
        db_path=tmp_path / "db.sqlite", extensions_root=root, staging_root=tmp_path / "stage"
    )
    with TestClient(app) as client:
        for _ in range(2):
            result = (
                client.post("/api/extensions/import", content=archive())
                if source == "zip"
                else client.post(
                    "/api/extensions/import/github", json={"url": "https://github.com/test/editor"}
                )
            )
            assert result.status_code == 200, result.text
            summary = result.json()
            assert summary["editor"] == MANIFEST["editor"]
            assert not {"sources", "files", "findings", "permissions"} & summary.keys()
            installed = client.post(f"/api/extensions/import/{summary['token']}")
            assert installed.status_code == 200, installed.text
        asset = client.get("/api/extensions/editor_demo/asset/ui/editor.js")
        assert asset.status_code == 200
        assert "javascript" in asset.headers["content-type"]
        assert "content-security-policy" not in asset.headers
        assert client.get("/api/extensions/editor_demo/asset/manifest.yaml").status_code == 404
    ensure.assert_not_called()
    assert discover(root)["editor_demo"].has_python is False
    assert not (root / "editor_demo" / "main.py").exists()


async def test_manual_frontend_pack_never_loads_python(tmp_path, monkeypatch):
    pack = tmp_path / "editor_demo"
    for name, value in FILES.items():
        target = pack / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value)
    load = AsyncMock(side_effect=AssertionError("Must not start Python"))
    monkeypatch.setattr("blockyard.extensions.subprocess_host.SubprocessHost.load", load)
    registry = await open_registry(tmp_path)
    try:
        assert "editor_demo" in registry.sources
        assert not registry.is_loaded("editor_demo")
    finally:
        await registry.unload_all()
    load.assert_not_called()


@pytest.mark.parametrize(
    "entry", ["../outside.js", "/outside.js", "https://example.com/code.js", "ui/index.html"]
)
def test_editor_entry_must_be_pack_js(entry):
    with pytest.raises(ExtensionError):
        parse_manifest({**MANIFEST, "editor": {"entry": entry, "apiVersion": 1}}, where="test")


def test_missing_editor_entry_and_missing_python(tmp_path):
    origin = Origin("zip", "example.zip")
    with pytest.raises(ExtensionError, match="找不到"):
        stage(
            archive({"manifest.yaml": yaml.safe_dump(MANIFEST)}),
            tmp_path,
            token="a" * 20,
            origin=origin,
        )
    for extra in [
        {"requirements": ["httpx"]},
        {"palette": [{"button": "ping", "label": "Ping", "action": "call", "handler": "ping"}]},
    ]:
        with pytest.raises(ExtensionError, match="main.py"):
            stage(
                archive({**FILES, "manifest.yaml": yaml.safe_dump({**MANIFEST, **extra})}),
                tmp_path,
                token="b" * 20,
                origin=origin,
            )


def test_editor_symlink_cannot_escape_pack(tmp_path):
    pack = tmp_path / "pack"
    pack.mkdir()
    (pack / "manifest.yaml").write_text(yaml.safe_dump(MANIFEST))
    (pack / "ui").mkdir()
    outside = tmp_path / "outside.js"
    outside.write_text("export function activate() {}")
    (pack / "ui/editor.js").symlink_to(outside)
    with pytest.raises(ExtensionError, match="不在積木包"):
        read_pack(pack)


def test_legacy_permissions_ignored_and_future_api_exposed():
    mf = parse_manifest(
        {
            **MANIFEST,
            "permissions": ["net", "unrecognized"],
            "editor": {"entry": "ui/editor.js", "apiVersion": 2},
        },
        where="test",
    )
    assert "permissions" not in mf.model_dump()
    assert mf.editor.apiVersion == 2


def test_validation_does_not_save_or_resync(tmp_path, monkeypatch):
    root = tmp_path / "extensions"
    root.mkdir()
    app = create_app(db_path=tmp_path / "db.sqlite", extensions_root=root)
    with TestClient(app) as client:
        resync = AsyncMock()
        monkeypatch.setattr(app.state.triggers, "resync", resync)
        project = {
            "formatVersion": 1,
            "meta": {"id": "prj_test", "name": "Test"},
            "scripts": [],
            "blocks": {},
        }
        result = client.post("/api/projects/prj_test/validate", json=project)
        assert result.status_code == 204, result.text
        assert client.get("/api/projects/prj_test").status_code == 404
        invalid = client.post(
            "/api/projects/prj_test/validate",
            json={**project, "scripts": [{"id": "s", "top": "missing"}]},
        )
        assert invalid.status_code == 422
        invalid_meta = client.post(
            "/api/projects/prj_test/validate", json={**project, "meta": "invalid"}
        )
        assert invalid_meta.status_code == 422
        resync.assert_not_called()

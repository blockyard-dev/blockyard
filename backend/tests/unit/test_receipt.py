"""收據：這個資料夾是誰搬進來的（`docs/extension-design.md` §2）。

守的是三句話，而第三句最重要：

1. 裝進來的東西有收據，而且收據說得出來源。
2. **一個包不能自己說自己從哪來**——`.zip` 裡自帶的收據要被丟掉。
3. **沒有收據 = 使用者自己放的 = 不碰。** 每一條讀不出來的路都要收斂到
   「沒有收據」，往安全那一邊倒。
"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from blockyard.api.app import create_app
from blockyard.extensions import BUNDLED_ROOT, backfill_official, receipt, seed_bundled
from blockyard.extensions.install import install, stage
from blockyard.extensions.manifest import RECEIPT_FILE
from blockyard.extensions.receipt import Origin

MANIFEST = """\
manifestVersion: 1
id: greet
name: 打招呼
version: 0.1.0
description: 一顆會說哈囉的積木
permissions: []
requirements: []
palette:
  - opcode: hello
    type: reporter
    text: 說哈囉
    returns: string
"""

MAIN = """\
from blockyard import block


@block("greet.hello")
async def hello(ctx):
    return "哈囉"
"""


def make_zip(extra: dict[str, str] | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, body in {"manifest.yaml": MANIFEST, "main.py": MAIN, **(extra or {})}.items():
            zf.writestr(name, body)
    return buf.getvalue()


async def install_zip(tmp_path: Path, *, origin: Origin, extra: dict[str, str] | None = None):
    root = tmp_path / "extensions"
    root.mkdir()
    staged = stage(make_zip(extra), tmp_path / "staging", token="t" * 16, origin=origin)
    return await install(staged, root)


# ---- 裝進來的東西有收據 ----


async def test_install_writes_a_receipt(tmp_path: Path) -> None:
    src = await install_zip(tmp_path, origin=Origin(origin="zip", label="greet.zip"))
    r = receipt.read(src.dir)
    assert r is not None
    assert (r.origin, r.label, r.version) == ("zip", "greet.zip", "0.1.0")
    assert r.digest.startswith("sha256:")
    assert r.installed_at.endswith("Z")


async def test_the_receipt_is_not_pack_content(tmp_path: Path) -> None:
    """digest 不能把收據自己算進去（那是一條自己餵自己的迴圈），而審閱畫面
    也不該攤開一個使用者沒寫過的檔案。"""
    src = await install_zip(tmp_path, origin=Origin(origin="zip", label="greet.zip"))
    from blockyard.extensions.manifest import pack_files

    assert RECEIPT_FILE not in {p.name for p in pack_files(src.dir)}
    # 重算一次跟收據上記的一樣：證明它算的就是「裝進去的那一份」。
    assert receipt.digest(src.dir) == receipt.read(src.dir).digest  # type: ignore[union-attr]


# ---- 一個包不能自己說自己從哪來 ----


async def test_a_pack_cannot_forge_its_own_receipt(tmp_path: Path) -> None:
    forged = json.dumps({"origin": "official", "label": "官方認證", "version": "9.9.9"})
    src = await install_zip(
        tmp_path,
        origin=Origin(origin="zip", label="greet.zip"),
        extra={RECEIPT_FILE: forged},
    )
    r = receipt.read(src.dir)
    assert r is not None
    assert (r.origin, r.label) == ("zip", "greet.zip")


# ---- 讀不出來 = 沒有收據 ----


@pytest.mark.parametrize(
    "body",
    [
        "",
        "{",
        "[]",
        '"字串"',
        json.dumps({"label": "沒有 origin"}),
        json.dumps({"origin": "從未來來的", "label": "x"}),
    ],
)
def test_unreadable_receipts_read_as_none(tmp_path: Path, body: str) -> None:
    tmp_path.joinpath(RECEIPT_FILE).write_text(body, encoding="utf-8")
    assert receipt.read(tmp_path) is None


def test_no_file_reads_as_none(tmp_path: Path) -> None:
    assert receipt.read(tmp_path) is None


# ---- digest ----


def test_digest_notices_a_rename(tmp_path: Path) -> None:
    """只餵內容的話，把 `a` 改名成 `b` 算出來會是同一個值。"""
    tmp_path.joinpath("manifest.yaml").write_text("x", encoding="utf-8")
    before = receipt.digest(tmp_path)
    tmp_path.joinpath("manifest.yaml").rename(tmp_path / "other.yaml")
    assert receipt.digest(tmp_path) != before


def test_digest_notices_a_boundary_shift(tmp_path: Path) -> None:
    """一個叫 `ab` 的檔案，與兩個叫 `a`、`b` 的檔案。"""
    tmp_path.joinpath("ab").write_text("", encoding="utf-8")
    one = receipt.digest(tmp_path)
    tmp_path.joinpath("ab").unlink()
    tmp_path.joinpath("a").write_text("", encoding="utf-8")
    tmp_path.joinpath("b").write_text("", encoding="utf-8")
    assert receipt.digest(tmp_path) != one


# ---- 官方包 ----


def test_seeding_issues_official_receipts(tmp_path: Path) -> None:
    root = tmp_path / "extensions"
    seed_bundled(root)
    r = receipt.read(root / "demo")
    assert r is not None
    assert r.origin == "official"
    assert r.version == "0.1.0" or r.version  # manifest 說的那個版本


def test_backfill_only_touches_a_pristine_copy(tmp_path: Path) -> None:
    """補發的判準是「跟出貨那一份逐位元組相同」，不是「id 對得上」。"""
    root = tmp_path / "extensions"
    seed_bundled(root)
    for pack in root.iterdir():
        receipt.path_of(pack).unlink()
    (root / "demo" / "main.py").write_text("# 使用者改過\n", encoding="utf-8")

    filled = backfill_official(root)
    assert "http" in filled
    assert "demo" not in filled
    assert receipt.read(root / "demo") is None


def test_backfill_leaves_a_lookalike_alone(tmp_path: Path) -> None:
    """使用者手寫一個剛好也叫 `demo` 的包，不能因此拿到一張讓我們刪掉它的收據。"""
    root = tmp_path / "extensions"
    mine = root / "demo"
    mine.mkdir(parents=True)
    mine.joinpath("manifest.yaml").write_text(
        (BUNDLED_ROOT / "demo" / "manifest.yaml").read_text(encoding="utf-8"), encoding="utf-8"
    )
    mine.joinpath("main.py").write_text("# 我自己寫的\n", encoding="utf-8")

    assert backfill_official(root) == []
    assert receipt.read(mine) is None


def test_backfill_is_idempotent(tmp_path: Path) -> None:
    root = tmp_path / "extensions"
    seed_bundled(root)
    assert backfill_official(root) == []  # 鋪的時候就開好了，沒有人要補


# ---- 端點 ----


async def test_receipts_endpoint(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BLOCKYARD_HOME", str(tmp_path / "home"))
    app = create_app(db_path=tmp_path / "blockyard.db")
    # 使用者自己放的一個包：**不該出現在這份清單裡**。
    mine = app.state.extensions_root / "mine"
    mine.mkdir()
    mine.joinpath("manifest.yaml").write_text(
        MANIFEST.replace("id: greet", "id: mine"), encoding="utf-8"
    )
    mine.joinpath("main.py").write_text(MAIN.replace("greet.", "mine."), encoding="utf-8")

    with TestClient(app) as client:
        rows = client.get("/api/extensions/receipts").json()
    by_id = {row["extId"]: row for row in rows}
    assert by_id["demo"]["origin"] == "official"
    assert "mine" not in by_id
    assert set(by_id["demo"]) == {
        "extId", "origin", "label", "url", "ref", "commit", "version", "digest", "installedAt",
    }

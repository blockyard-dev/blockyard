"""一個積木包的一生：換一版、離開、再回來（`docs/extension-design.md` §4、§5）。

這裡守的是三句話：

1. **只解除安裝我們裝的。** 沒有收據 = 使用者自己放的 = 不碰，而更新（它會把
   舊的那份整個搬走）受同一條規則管。
2. **不刪東西，只搬。** 移除是搬進垃圾桶，更新是「舊的先進垃圾桶」——而任何
   一步失敗都要搬得回來。
3. **拔掉的不會自己長回來。** 官方包的資料夾一旦不在，「只鋪不存在的」看它跟
   看一台全新的機器一模一樣；分辨兩者的是墓碑。
"""

from __future__ import annotations

import asyncio
import io
import zipfile
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from blockyard.api.app import create_app
from blockyard.errors import ExtensionError
from blockyard.extensions import bundled, discover, receipt, trash
from blockyard.extensions.diff import diff
from blockyard.extensions.install import install, stage, uninstall, update
from blockyard.extensions.manifest import parse_manifest
from blockyard.extensions.receipt import Origin

MANIFEST = """\
manifestVersion: 1
id: greet
name: 打招呼
version: {version}
description: 一顆會說哈囉的積木
permissions: []
requirements: []
palette:
  - opcode: hello
    type: reporter
    text: 對 %(who) 說哈囉
    args:
      who:
        type: string
        default: 世界
    returns: string
"""

MAIN = """\
from blockyard import block


@block("greet.hello")
async def hello(ctx, who):
    return f"哈囉，{who}"
"""

ORIGIN = Origin(origin="zip", label="greet.zip")
TOKEN = "aaaaaaaaaaaaaaaa"


def zip_of(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, body in files.items():
            zf.writestr(name, body)
    return buf.getvalue()


def pack(version: str = "0.1.0", *, main: str = MAIN) -> bytes:
    return zip_of({"manifest.yaml": MANIFEST.format(version=version), "main.py": main})


def install_pack(root: Path, staging: Path, *, version: str = "0.1.0", token: str = TOKEN) -> None:
    staged = stage(pack(version), staging, token=token, origin=ORIGIN)
    asyncio.run(install(staged, root))


@pytest.fixture
def roots(tmp_path: Path) -> tuple[Path, Path]:
    """`(extensions_root, staging_root)`。

    extensions root **刻意有一層父目錄**：垃圾桶在它旁邊（`trash.root_for`），
    所以一個直接指到 tmp_path 的測試會把垃圾桶跟暫存區攪在一起。
    """
    root = tmp_path / "home" / "extensions"
    root.mkdir(parents=True)
    return root, tmp_path / "staging"


# --------------------------------------------------------------------------
# 差集（§4）：這一版跟那一版差在哪
# --------------------------------------------------------------------------


def mf(text: str):  # noqa: ANN201 - 測試用的小工具
    return parse_manifest(yaml.safe_load(text), where="test")


BASE = mf(MANIFEST.format(version="0.1.0"))


def test_a_dropped_block_is_gone() -> None:
    after = mf(
        """\
manifestVersion: 1
id: greet
name: 打招呼
version: 0.2.0
palette:
  - opcode: bye
    type: reporter
    text: 說再見
    returns: string
"""
    )
    d = diff(BASE, after)
    assert d["gone"] == [{"opcode": "greet.hello", "text": "對 %(who) 說哈囉", "why": "missing"}]
    assert d["added"] == [{"opcode": "greet.bye", "text": "說再見"}]
    assert d["version"] == {"from": "0.1.0", "to": "0.2.0"}


def test_a_reshaped_block_counts_as_gone() -> None:
    """`reporter` 變成 `command`：積木還在，但畫布上插在別人孔裡的那幾顆插不
    回去了。使用者看到的是「積木還在，整段程式卻壞了」，比消失更難懂。"""
    after = mf(
        """\
manifestVersion: 1
id: greet
name: 打招呼
version: 0.2.0
palette:
  - opcode: hello
    type: command
    text: 對 %(who) 說哈囉
    args:
      who:
        type: string
        default: 世界
"""
    )
    assert [g["why"] for g in diff(BASE, after)["gone"]] == ["shape"]


def test_a_new_required_arg_is_marked_required() -> None:
    """多一格**必填**的參數，畫布上那幾顆會多出填不了東西的空孔（§16 Q21）
    ——而那份專案從此存不起來。多一格選填的只是多一個孔。"""
    after = mf(
        """\
manifestVersion: 1
id: greet
name: 打招呼
version: 0.2.0
palette:
  - opcode: hello
    type: reporter
    text: 對 %(who) 用 %(tone) 說哈囉
    args:
      who:
        type: string
        default: 世界
      tone:
        type: string
    returns: string
"""
    )
    changed = diff(BASE, after)["changed"]
    assert changed[0]["argsAdded"] == [{"name": "tone", "required": True}]
    assert changed[0]["textChanged"] is True


def test_the_same_manifest_has_no_diff() -> None:
    d = diff(BASE, BASE)
    assert d["gone"] == [] and d["changed"] == [] and d["added"] == []


def test_legacy_permissions_are_ignored() -> None:
    """一個本來只算數學的包，新版開始連網路了。**這是差集裡最該被看見的東西**，
    而它跟積木無關。"""
    after = mf(
        """\
manifestVersion: 1
id: greet
name: 打招呼
version: 0.2.0
permissions: [net]
palette:
  - opcode: hello
    type: reporter
    text: 對 %(who) 說哈囉
    args:
      who:
        type: string
        default: 世界
    returns: string
"""
    )
    assert "permissionsAdded" not in diff(BASE, after)
    assert "permissions" not in after.model_dump()


# --------------------------------------------------------------------------
# 解除安裝（§5）
# --------------------------------------------------------------------------


def test_uninstall_moves_it_to_the_trash(roots: tuple[Path, Path]) -> None:
    """**不是 `rm -rf`。** 移除一個包就是把它搬進垃圾桶。"""
    root, staging = roots
    install_pack(root, staging)

    stashed = uninstall("greet", root)

    assert "greet" not in discover(root)
    assert not (root / "greet").exists()
    assert (stashed.dir / "main.py").is_file()
    assert stashed.dir.parent == trash.root_for(root)


def test_uninstall_refuses_a_pack_without_a_receipt(roots: tuple[Path, Path]) -> None:
    """**核心規則。** 沒有收據的資料夾是使用者自己放的——很可能就是他正在
    編輯的那一個，而替他刪掉它是這整份設計裡唯一一件真的會弄丟東西的事。"""
    root, _ = roots
    mine = root / "mine"
    mine.mkdir()
    (mine / "manifest.yaml").write_text(
        MANIFEST.format(version="0.1.0").replace("id: greet", "id: mine"), encoding="utf-8"
    )
    (mine / "main.py").write_text(MAIN.replace("greet.", "mine."), encoding="utf-8")

    with pytest.raises(ExtensionError, match="你自己放"):
        uninstall("mine", root)
    assert (mine / "main.py").is_file()


def test_uninstall_will_not_walk_out_of_the_extensions_root(roots: tuple[Path, Path]) -> None:
    """這個字串從 URL 路徑來，而接下來那幾行做的事是「把這個目錄搬到垃圾桶」。"""
    root, _ = roots
    for bad in ("../../Documents", "..", "greet/../..", "Greet"):
        with pytest.raises(ExtensionError, match="不是一個合法"):
            uninstall(bad, root)


def test_an_uninstalled_official_pack_stays_gone(tmp_path: Path) -> None:
    """§8 的那個缺口，反過來寫：拔掉就是拔掉。

    （這個測試的前身是 `test_bundled.py::test_uninstalled_packs_grow_back_for_now`
    ——那時候它守的是「已知缺口」。）
    """
    root = tmp_path / "home" / "extensions"
    bundled.seed_bundled(root)
    assert "demo" in discover(root)

    uninstall("demo", root)
    assert bundled.seed_bundled(root) == []
    assert "demo" not in discover(root)
    assert bundled.tombstoned(root) == {"demo"}


def test_installing_the_same_id_again_clears_the_tombstone(roots: tuple[Path, Path]) -> None:
    """墓碑說的是「我現在不要這個 id」，而他剛剛親手裝了一個同名的包。"""
    root, staging = roots
    install_pack(root, staging)
    uninstall("greet", root)
    assert bundled.tombstoned(root) == {"greet"}

    install_pack(root, staging, token="bbbbbbbbbbbbbbbb")
    assert bundled.tombstoned(root) == set()


# --------------------------------------------------------------------------
# 更新（§4）
# --------------------------------------------------------------------------


def test_update_swaps_the_pack_and_keeps_the_old_one(roots: tuple[Path, Path]) -> None:
    root, staging = roots
    install_pack(root, staging)

    staged = stage(pack("0.2.0"), staging, token="bbbbbbbbbbbbbbbb", origin=ORIGIN)
    source, stashed = asyncio.run(update(staged, root))

    assert source.manifest.version == "0.2.0"
    assert discover(root)["greet"].manifest.version == "0.2.0"
    # 舊的那一份還在，而且**還讀得出來**——「更新完發現更糟」的退路是它。
    assert "0.1.0" in (stashed.dir / "manifest.yaml").read_text(encoding="utf-8")


def test_update_writes_a_fresh_receipt(roots: tuple[Path, Path]) -> None:
    """收據記的是**現在磁碟上那一份**：版本、digest、以及裝它的那個時間。"""
    root, staging = roots
    install_pack(root, staging)
    before = receipt.read(root / "greet")

    staged = stage(
        pack("0.2.0", main=MAIN + "\n# 換了一版\n"),
        staging,
        token="bbbbbbbbbbbbbbbb",
        origin=Origin(origin="github", label="github.com/someone/greet", commit="a" * 40),
    )
    asyncio.run(update(staged, root))

    after = receipt.read(root / "greet")
    assert after is not None and before is not None
    assert after.version == "0.2.0"
    assert after.origin == "github" and after.commit == "a" * 40
    assert after.digest != before.digest


def test_update_refuses_a_pack_without_a_receipt(roots: tuple[Path, Path]) -> None:
    """不解除安裝與不更新是同一條規則的兩面：兩者都會把那個資料夾整個搬走。"""
    root, staging = roots
    install_pack(root, staging)
    receipt.path_of(root / "greet").unlink()

    staged = stage(pack("0.2.0"), staging, token="bbbbbbbbbbbbbbbb", origin=ORIGIN)
    with pytest.raises(ExtensionError, match="你自己放"):
        asyncio.run(update(staged, root))
    # 一個字都沒動。
    assert discover(root)["greet"].manifest.version == "0.1.0"


def test_update_puts_the_old_one_back_when_it_fails(
    roots: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """任何一步失敗就搬回來。**留下半個包**的症狀是工具箱上那一格在下一次
    重新整理時消失，而使用者做的事只是按了一下更新。"""
    root, staging = roots
    install_pack(root, staging)

    import blockyard.extensions.install as install_mod

    def boom(staged, target):  # noqa: ANN001, ANN202
        raise ExtensionError("搬到一半炸了")

    monkeypatch.setattr(install_mod, "_finish", boom)

    staged = stage(pack("0.2.0"), staging, token="bbbbbbbbbbbbbbbb", origin=ORIGIN)
    with pytest.raises(ExtensionError, match="搬到一半"):
        asyncio.run(update(staged, root))

    assert discover(root)["greet"].manifest.version == "0.1.0"
    assert receipt.read(root / "greet") is not None


def test_installing_over_an_existing_pack_is_refused(roots: tuple[Path, Path]) -> None:
    """`install()` 不偷偷變成一次更新——那條路要先有一段差集。"""
    root, staging = roots
    install_pack(root, staging)

    staged = stage(pack("0.2.0"), staging, token="bbbbbbbbbbbbbbbb", origin=ORIGIN)
    with pytest.raises(ExtensionError, match="已經裝過"):
        asyncio.run(install(staged, root))


# --------------------------------------------------------------------------
# 端點
# --------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    root = tmp_path / "home" / "extensions"
    root.mkdir(parents=True)
    app = create_app(
        db_path=tmp_path / "blockyard.db",
        extensions_root=root,
        staging_root=tmp_path / "staging",
    )
    return TestClient(app)


def installed_via_api(client: TestClient, data: bytes) -> dict:
    token = client.post("/api/extensions/import", content=data).json()["token"]
    res = client.post(f"/api/extensions/import/{token}")
    assert res.status_code == 200, res.text
    return res.json()


def test_the_whole_update_path_over_http(client: TestClient) -> None:
    installed_via_api(client, pack("0.1.0"))

    review = client.post("/api/extensions/import", content=pack("0.2.0")).json()
    assert review["installed"]["version"] == "0.1.0"
    assert review["installed"]["diff"]["version"] == {"from": "0.1.0", "to": "0.2.0"}

    done = client.post(f"/api/extensions/import/{review['token']}").json()
    assert done["version"] == "0.2.0"
    assert done["replaced"]["version"] == "0.1.0"
    # 舊的那一份去了哪裡要說出去：那是「更新完發現更糟」唯一的線索。
    assert Path(done["replaced"]["trash"]).is_dir()


def test_delete_uninstalls(client: TestClient) -> None:
    installed_via_api(client, pack("0.1.0"))
    res = client.delete("/api/extensions/greet")
    assert res.status_code == 200, res.text
    assert res.json()["id"] == "greet"
    assert Path(res.json()["trash"]).is_dir()
    assert [m["id"] for m in client.get("/api/extensions").json() if m["id"] == "greet"] == []


def test_deleting_something_that_is_not_there_is_404(client: TestClient) -> None:
    assert client.delete("/api/extensions/nope").status_code == 404


def test_deleting_a_pack_you_put_there_yourself_is_422(client: TestClient, tmp_path: Path) -> None:
    """404 與 422 分得開：「沒有這個包」是前者，「有，但那是你自己放的」是
    後者——後面那句話使用者做得了事。"""
    installed_via_api(client, pack("0.1.0"))
    receipt.path_of(tmp_path / "home" / "extensions" / "greet").unlink()

    res = client.delete("/api/extensions/greet")
    assert res.status_code == 422
    assert "你自己放" in res.json()["detail"]["message"]


def test_an_uninstalled_official_pack_can_be_put_back(tmp_path: Path) -> None:
    """P3 的驗收句是「全程不碰檔案總管」，而拔掉一個官方包之後那張卡就從面板上
    消失了——它的出貨來源在 site-packages 底下，使用者沒有別的路。"""
    root = tmp_path / "home" / "extensions"
    app = create_app(db_path=tmp_path / "blockyard.db", extensions_root=root)
    root.mkdir(parents=True, exist_ok=True)
    bundled.seed_bundled(root)
    client = TestClient(app)

    client.delete("/api/extensions/demo")
    assert client.get("/api/extensions/uninstalled").json()[0]["id"] == "demo"

    assert client.post("/api/extensions/demo/reinstall").status_code == 200
    assert "demo" in discover(root)
    assert client.get("/api/extensions/uninstalled").json() == []


def test_only_shipped_packs_can_be_put_back(client: TestClient) -> None:
    """墓碑對非官方的 id 也會立，但我們手上沒有第二份——說「可以裝回來」是騙人的。"""
    installed_via_api(client, pack("0.1.0"))
    client.delete("/api/extensions/greet")

    assert client.get("/api/extensions/uninstalled").json() == []
    assert client.post("/api/extensions/greet/reinstall").status_code == 404

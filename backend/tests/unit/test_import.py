"""從電腦匯入 `.zip` 積木包（§15 P3 第 2 步、§12.1）。

三塊分開測：**解壓那一關**（`install.py`，它是唯一一個「外面的東西進到磁碟上」
的地方）、**靜態掃描**（`codescan.py`）、以及**兩段式那條路真的走得完**
（三個端點串起來）。

解壓那一關的每一題都是一個具體的惡意或手滑：`..`、絕對路徑、symlink、zip bomb、
macOS 的 `__MACOSX/`、對著資料夾按右鍵壓縮多出來的那一層。它們沒有一題是「規則
對不對」——規則就寫在那裡；它們問的是**那條規則有沒有真的接在路上**。
"""

from __future__ import annotations

import io
import zipfile
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from blockyard.api.app import create_app
from blockyard.errors import ExtensionError
from blockyard.extensions import discover, scan
from blockyard.extensions import install as install_mod
from blockyard.extensions.install import install
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


#: 這些題目問的是解壓那一關，不是來源怎麼記的（那在 `test_receipt.py`）。
#: 真的那支 `stage()` 要求呼叫者說出 bytes 從哪來——**那是刻意的**，見
#: `extensions/receipt.py`——所以這裡包一層，把那個答案填成同一個。
ZIP_ORIGIN = Origin(origin="zip", label="greet.zip")


def stage(data: bytes, staging_root: Path, *, token: str) -> install_mod.Staged:
    return install_mod.stage(data, staging_root, token=token, origin=ZIP_ORIGIN)


def make_zip(files: dict[str, str | bytes], *, prefix: str = "") -> bytes:
    # **壓縮是必要的**：`ZIP_STORED` 的話 zip bomb 那一題會先撞到
    # `MAX_ZIP_BYTES`，而那條擋的是別的東西。
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, body in files.items():
            zf.writestr(prefix + name, body)
    return buf.getvalue()


def good_zip(*, prefix: str = "", **extra: str) -> bytes:
    return make_zip({"manifest.yaml": MANIFEST, "main.py": MAIN, **extra}, prefix=prefix)


TOKEN = "aaaaaaaaaaaaaaaa"


# --------------------------------------------------------------------------
# 解壓：外面的東西進到磁碟上的那一步
# --------------------------------------------------------------------------


def test_a_plain_pack_stages(tmp_path: Path) -> None:
    staged = stage(good_zip(), tmp_path, token=TOKEN)
    assert staged.source.id == "greet"
    assert (staged.dir / "main.py").is_file()


def test_the_wrapping_folder_is_stripped(tmp_path: Path) -> None:
    """對著資料夾按右鍵壓縮 = `greet/manifest.yaml`。**這是使用者最可能做的動作**，
    所以它要成立，而不是回一句「找不到 manifest.yaml」。"""
    staged = stage(good_zip(prefix="greet/"), tmp_path, token=TOKEN)
    assert (staged.dir / "manifest.yaml").is_file()
    assert staged.source.id == "greet"


def test_the_wrapping_folder_name_need_not_match_the_id(tmp_path: Path) -> None:
    """砍掉的是「最外層那一層」，不是「叫這個名字的那一層」——使用者按下壓縮
    之前把資料夾改名叫 `greet 複本` 是很平常的事。"""
    staged = stage(good_zip(prefix="greet 複本/"), tmp_path, token=TOKEN)
    assert staged.source.id == "greet"


def test_macos_junk_is_skipped_not_rejected(tmp_path: Path) -> None:
    """Finder 的「壓縮」會多出 `__MACOSX/` 與 `.DS_Store`。為了兩個使用者看不見
    的檔案說「這個 zip 有問題」，等於要求他去學 `zip -x`。"""
    data = make_zip(
        {
            "greet/manifest.yaml": MANIFEST,
            "greet/main.py": MAIN,
            "greet/.DS_Store": "x",
            "__MACOSX/greet/._main.py": "x",
        }
    )
    staged = stage(data, tmp_path, token=TOKEN)
    # `__MACOSX/` 被跳過之後，剩下的條目才共用 `greet/` 那一層——先跳過再算
    # 字首，順序反過來就砍不掉了。
    assert (staged.dir / "manifest.yaml").is_file()
    assert not (staged.dir / ".DS_Store").exists()


@pytest.mark.parametrize(
    "name",
    ["../evil.py", "greet/../../evil.py", "/etc/evil.py", "C:/evil.py"],
)
def test_paths_that_escape_are_refused(tmp_path: Path, name: str) -> None:
    data = make_zip({"manifest.yaml": MANIFEST, "main.py": MAIN, name: "x"})
    with pytest.raises(ExtensionError):
        stage(data, tmp_path, token=TOKEN)
    assert not (tmp_path / TOKEN).exists(), "失敗要清掉暫存目錄"
    assert not (tmp_path.parent / "evil.py").exists()


def test_symlinks_are_refused(tmp_path: Path) -> None:
    """zip 存得下 symlink，而一條指向 `~/.ssh/id_rsa` 的連結每個字元都合法——
    `panel_asset()` 比對 `resolve()` 正是為了它，但那一關在解壓之後。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.yaml", MANIFEST)
        zf.writestr("main.py", MAIN)
        info = zipfile.ZipInfo("ui/index.html")
        info.external_attr = (0o120777 << 16)
        zf.writestr(info, "/etc/passwd")
    with pytest.raises(ExtensionError, match="符號連結"):
        stage(buf.getvalue(), tmp_path, token=TOKEN)


def test_a_zip_bomb_is_refused(tmp_path: Path) -> None:
    """`MAX_ZIP_BYTES` 看到的永遠是壓縮後的大小，所以擋 bomb 的是解開之後那條。"""
    data = make_zip({"manifest.yaml": MANIFEST, "main.py": MAIN, "big.txt": "0" * 200_000_000})
    with pytest.raises(ExtensionError, match="解開之後"):
        stage(data, tmp_path, token=TOKEN)
    assert not (tmp_path / TOKEN).exists()


def test_not_an_archive(tmp_path: Path) -> None:
    """格式靠開頭那幾個位元組認（`_archive`），所以一段文字連「壞掉的 zip」
    都不是——它是一個我們認不得的東西。"""
    with pytest.raises(ExtensionError, match="認不得這個檔案"):
        stage("這只是一段文字".encode(), tmp_path, token=TOKEN)


def test_a_broken_zip_says_it_is_broken(tmp_path: Path) -> None:
    """開頭是 `PK` 但後面是垃圾：這一份的確想當一個 zip，只是壞了。"""
    with pytest.raises(ExtensionError, match="壞了"):
        stage("PK\x03\x04 然後就沒有然後了".encode(), tmp_path, token=TOKEN)


def test_missing_manifest_says_so(tmp_path: Path) -> None:
    with pytest.raises(ExtensionError, match="manifest.yaml"):
        stage(make_zip({"main.py": MAIN}), tmp_path, token=TOKEN)


def test_missing_main_says_so(tmp_path: Path) -> None:
    with pytest.raises(ExtensionError, match="main.py"):
        stage(make_zip({"manifest.yaml": MANIFEST}), tmp_path, token=TOKEN)


def test_a_broken_manifest_names_the_problem(tmp_path: Path) -> None:
    """壞掉的 manifest 在**這一刻**就要說，而且要說得出哪一格——這是使用者拿到
    的唯一一次修正機會。"""
    bad = MANIFEST.replace("type: reporter", "type: 三角形")
    with pytest.raises(ExtensionError) as e:
        stage(make_zip({"manifest.yaml": bad, "main.py": MAIN}), tmp_path, token=TOKEN)
    assert "palette.0.block.type" in str(e.value)


def test_a_pack_calling_itself_builtin_is_refused(tmp_path: Path) -> None:
    """`read_pack()` 與 `scan()` 共用同一份規則，所以這條在匯入那一側免費成立。"""
    bad = MANIFEST.replace("id: greet", "id: greet\nbuiltin: true")
    with pytest.raises(ExtensionError, match="builtin"):
        stage(make_zip({"manifest.yaml": bad, "main.py": MAIN}), tmp_path, token=TOKEN)


def test_a_bad_token_never_becomes_a_path(tmp_path: Path) -> None:
    with pytest.raises(ExtensionError, match="匯入編號"):
        stage(good_zip(), tmp_path, token="../../etc")


async def test_install_moves_it_and_rereads_from_the_new_home(tmp_path: Path) -> None:
    root = tmp_path / "extensions"
    root.mkdir()
    staged = stage(good_zip(), tmp_path / "staging", token=TOKEN)
    source = await install(staged, root)
    assert source.dir == root / "greet"
    assert not staged.dir.exists()
    assert discover(root)["greet"].manifest.name == "打招呼"


async def test_installing_over_an_existing_id_is_refused(tmp_path: Path) -> None:
    """§16 Q24 還沒答。訊息要說得出「它不是壞了，是還沒接上」。"""
    root = tmp_path / "extensions"
    root.mkdir()
    await install(stage(good_zip(), tmp_path / "s1", token=TOKEN), root)
    with pytest.raises(ExtensionError, match="已經裝過"):
        await install(stage(good_zip(), tmp_path / "s2", token=TOKEN), root)


# --------------------------------------------------------------------------
# 一個包壞掉，其他包不跟著消失
# --------------------------------------------------------------------------


def test_one_broken_pack_does_not_take_the_others_with_it(tmp_path: Path) -> None:
    """原本 `discover()` 是整批拋，於是一份手滑的 manifest 就讓
    `GET /api/extensions` 回 500、編輯器畫出「連不上後端」——那句話指錯主詞，
    而且它把使用者手上**全部**的積木一起帶走。"""
    root = tmp_path / "extensions"
    (root / "greet").mkdir(parents=True)
    (root / "greet" / "manifest.yaml").write_text(MANIFEST, encoding="utf-8")
    (root / "greet" / "main.py").write_text(MAIN, encoding="utf-8")
    (root / "broken").mkdir()
    (root / "broken" / "manifest.yaml").write_text("id: broken\n{{{", encoding="utf-8")

    found = scan(root)
    assert set(found.sources) == {"greet"}
    assert [p.dir for p in found.problems] == ["broken"]
    # 跳過的代價是一個包安靜地消失，所以錯誤不能被丟掉。
    assert "broken" in found.problems[0].message


async def test_the_venv_is_built_before_the_pack_moves_in(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """宣告了 `requirements` 的包**自己會長出一支獨立環境**，而且是**在搬進去
    之前**（`install.py` 的模組 docstring）。

    `uv pip install` 是這條路上唯一真的會失敗的一步（網路、沒裝 `uv`、版本解不
    開）。先搬再建的話，失敗留下的是一個裝在那裡、拉出來卻跑不動的包；先建再搬，
    失敗留下的是什麼都沒有。

    這裡把那一步換掉：**真的下載那一段已經有它自己的合約測試**
    （`tests/contract/test_venv_isolation.py` 真的裝一個套件進去、再證明
    backend 自己的環境沒有被汙染）。這一題問的是**接線**——它有沒有被叫到、
    帶著什麼、在哪個時間點。
    """
    root = tmp_path / "extensions"
    root.mkdir()
    seen: list[tuple[str, list[str], bool]] = []

    async def fake_ensure(ext_id: str, requirements: list[str]) -> Path:
        # 第三格是重點：這一刻那個目錄**還不該存在**。
        seen.append((ext_id, requirements, (root / ext_id).exists()))
        return Path("/nonexistent/python")

    monkeypatch.setattr(install_mod, "ensure_interpreter", fake_ensure)

    manifest = MANIFEST.replace("requirements: []", 'requirements: ["tomli-w>=1.0,<2"]')
    staged = stage(
        make_zip({"manifest.yaml": manifest, "main.py": MAIN}), tmp_path / "staging", token=TOKEN
    )
    await install(staged, root)

    assert seen == [("greet", ["tomli-w>=1.0,<2"], False)]
    assert (root / "greet" / "main.py").is_file()


@pytest.mark.parametrize("ext_id", ("demo", "discord", "http", "openai", "panel"))
def test_a_real_pack_survives_the_review_page(ext_id: str, tmp_path: Path) -> None:
    """**把真的包送進審閱畫面走一遍**（`demo` 與 `panel` 宣告了面板，`openai`
    宣告了金鑰，`discord` 有 `open_url` 的按鈕）。

    這一題是補回來的：`review()` 那幾行是一串把 manifest 折成畫面資料的
    comprehension，而每一格都是「那個欄位真的叫這個名字嗎」的一次賭。原本**沒有
    任何測試餵過一個宣告了面板的包**——測試用的 `greet` 只有一顆積木——所以
    `p.title`（`PanelSpec` 上沒有這個欄位）活到了使用者按下匯入的那一刻，
    而症狀是 500。

    直接拿出貨目錄當暫存目錄：`review()` 只需要 `Staged` 的那三格，而它不會
    寫任何東西。這裡不經過 `stage()` 是刻意的——這一題問的是**折資料那一段**，
    而解壓那一關已經有它自己的十幾題了。
    """
    from blockyard.extensions import BUNDLED_ROOT
    from blockyard.extensions.receipt import Origin
    from blockyard.extensions.review import review

    src = install_mod.read_pack(BUNDLED_ROOT / ext_id, expect_id=ext_id)
    staged = install_mod.Staged(
        token=TOKEN,
        dir=src.dir,
        source=src,
        origin=Origin(origin="zip", label=f"{ext_id}.zip"),
    )

    page = review(staged, installed=None)

    assert page["id"] == ext_id
    # 宣告的那幾段都折得出來，而且用的是 manifest 自己的字彙。
    assert [p["id"] for p in page["panels"]] == [p.id for p in src.manifest.panels]
    assert [p["name"] for p in page["panels"]] == [p.name for p in src.manifest.panels]
    assert [c["key"] for c in page["config"]] == [c.key for c in src.manifest.config]
    assert len(page["blocks"]) == len(src.manifest.blocks)
    # `main.py` 一定攤得開——§12.1 那句「不可略過」講的就是它。
    assert "sources" not in page and "findings" not in page and "permissions" not in page


def _bundled_manifest(ext_id: str):  # noqa: ANN202
    from blockyard.extensions import BUNDLED_ROOT

    return install_mod.read_pack(BUNDLED_ROOT / ext_id, expect_id=ext_id).manifest


def test_the_review_page_of_a_pack_with_panels_is_200(client: TestClient) -> None:
    """同一件事，走完整條 HTTP：**一個宣告了面板的 `.zip` 不該是 500。**"""
    from blockyard.extensions import BUNDLED_ROOT

    src = BUNDLED_ROOT / "panel"
    files: dict[str, str | bytes] = {
        p.relative_to(src).as_posix(): p.read_bytes()
        for p in src.rglob("*")
        if p.is_file() and "__pycache__" not in p.parts and "tests" not in p.parts
    }
    res = client.post("/api/extensions/import", content=make_zip(files))

    assert res.status_code == 200, res.text
    panels = res.json()["panels"]
    assert [p["name"] for p in panels] == [p.name for p in _bundled_manifest("panel").panels]


# --------------------------------------------------------------------------
# 三個端點串起來
# --------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    root = tmp_path / "extensions"
    root.mkdir()
    app = create_app(
        db_path=tmp_path / "blockyard.db",
        extensions_root=root,
        staging_root=tmp_path / "staging",
    )
    with TestClient(app) as c:
        yield c


def test_the_whole_path(client: TestClient, tmp_path: Path) -> None:
    res = client.post("/api/extensions/import", content=good_zip())
    assert res.status_code == 200, res.text
    body = res.json()

    # 審閱畫面要有的東西（§12.1）：宣告的摘要 + 完整原始碼。
    assert body["id"] == "greet" and body["version"] == "0.1.0"
    assert body["blocks"] == [{"opcode": "greet.hello", "text": "對 %(who) 說哈囉"}]
    assert body["installed"] is None
    assert "sources" not in body
    assert body["origin"]["origin"] == "zip"

    # 還沒裝。
    assert client.get("/api/extensions").status_code == 200
    assert "greet" not in {m["id"] for m in client.get("/api/extensions").json()}

    done = client.post(f"/api/extensions/import/{body['token']}")
    assert done.status_code == 200, done.text
    assert done.json()["name"] == "打招呼"

    # 裝好了，而且走的是同一個 `GET /api/extensions`——前端不必為匯入多一條註冊路。
    ids = {m["id"] for m in client.get("/api/extensions").json()}
    assert "greet" in ids


def test_cancel_removes_the_staged_copy(client: TestClient, tmp_path: Path) -> None:
    token = client.post("/api/extensions/import", content=good_zip()).json()["token"]
    assert (tmp_path / "staging" / token).is_dir()
    assert client.delete(f"/api/extensions/import/{token}").status_code == 204
    assert not (tmp_path / "staging" / token).exists()
    # 取消之後那個 token 就不是一份匯入了。
    assert client.post(f"/api/extensions/import/{token}").status_code == 404


def test_cancelling_twice_is_still_success(client: TestClient) -> None:
    token = client.post("/api/extensions/import", content=good_zip()).json()["token"]
    client.delete(f"/api/extensions/import/{token}")
    assert client.delete(f"/api/extensions/import/{token}").status_code == 204


def test_a_broken_zip_is_422_with_the_reason(client: TestClient) -> None:
    """**422 不是 500**：一份壞掉的 `.zip` 是使用者送進來的東西，不是後端出事。"""
    res = client.post("/api/extensions/import", content=b"not a zip")
    assert res.status_code == 422
    assert "zip" in res.json()["detail"]["message"]


def test_an_empty_body_is_400(client: TestClient) -> None:
    assert client.post("/api/extensions/import", content=b"").status_code == 400


def test_an_already_installed_id_is_said_before_reading_the_code(client: TestClient) -> None:
    """使用者讀完幾百行原始碼才知道自己按下去會發生什麼，那幾分鐘是白花的
    ——所以「這是一次更新」在審閱那一步就說，連差集一起（§4）。

    更新本身在 `test_lifecycle.py`；這裡只確認那句話有說出口。"""
    first = client.post("/api/extensions/import", content=good_zip()).json()
    client.post(f"/api/extensions/import/{first['token']}")

    again = client.post("/api/extensions/import", content=good_zip()).json()
    assert again["installed"]["version"] == "0.1.0"
    # 同一份 `.zip` 裝第二次：差集是空的，而空的差集也是一份差集——前端要靠它
    # 說「這一版跟你手上那一版一模一樣」。
    assert again["installed"]["diff"]["gone"] == []
    assert again["installed"]["diff"]["changed"] == []


def test_an_unknown_token_is_404(client: TestClient) -> None:
    assert client.post("/api/extensions/import/aaaaaaaaaaaaaaaaaa").status_code == 404


def test_a_traversal_token_is_404_not_a_path(client: TestClient) -> None:
    # **不用 `%2F`**：ASGI 伺服器在路由之前就把它解回 `/`（同 v0.30 的 webhook
    # blockId），所以那個請求根本走不到這條路由——回的是 405，而一個 405 什麼
    # 都沒有證明。`nope` 是一個真的會走到 `staged_dir()` 的不合法 token。
    assert client.post("/api/extensions/import/nope").status_code == 404


def test_problems_lists_the_pack_that_could_not_be_read(client: TestClient, tmp_path: Path) -> None:
    assert client.get("/api/extensions/problems").json() == []
    broken = tmp_path / "extensions" / "broken"
    broken.mkdir()
    (broken / "manifest.yaml").write_text("id: broken\n{{{", encoding="utf-8")

    problems = client.get("/api/extensions/problems").json()
    assert [p["dir"] for p in problems] == ["broken"]
    # 而清單那一邊仍然是 200——這才是這條路真正要守的事。
    assert client.get("/api/extensions").status_code == 200

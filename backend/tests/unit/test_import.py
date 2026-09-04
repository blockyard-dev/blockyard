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
from blockyard.extensions.codescan import scan_pack
from blockyard.extensions.install import install, stage
from blockyard.extensions.manifest import parse_manifest

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


def test_not_a_zip(tmp_path: Path) -> None:
    with pytest.raises(ExtensionError, match="不是一個 .zip"):
        stage("這只是一段文字".encode(), tmp_path, token=TOKEN)


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


# --------------------------------------------------------------------------
# 靜態掃描（§12.1）
# --------------------------------------------------------------------------


def _scan(tmp_path: Path, code: str, *, permissions: str = "[]") -> list:
    (tmp_path / "main.py").write_text(code, encoding="utf-8")
    mf = parse_manifest(
        {
            "id": "x",
            "name": "x",
            "version": "0.1.0",
            "permissions": [] if permissions == "[]" else eval(permissions),
            "palette": [],
        },
        where="test",
    )
    return scan_pack(tmp_path, mf)


def test_scan_points_at_the_line(tmp_path: Path) -> None:
    findings = _scan(tmp_path, "import os\n\nos.system('rm -rf /')\n")
    hit = next(f for f in findings if "os.system" in f.message)
    assert hit.line == 3
    assert hit.permission == "subprocess"


def test_scan_flags_what_the_manifest_did_not_declare(tmp_path: Path) -> None:
    """§12.1 表格裡的「與宣告不符時警告」。一個包 `import httpx` 卻沒宣告
    `net`，最無害的解釋是作者忘了寫——而那件事本身就值得使用者知道，因為
    `permissions` 是他唯一拿到的摘要。"""
    undeclared = _scan(tmp_path, "import httpx\n")[0]
    assert undeclared.permission == "net" and not undeclared.declared

    declared = _scan(tmp_path, "import httpx\n", permissions="['net']")[0]
    assert declared.declared


def test_eval_is_always_worth_saying_and_never_a_mismatch(tmp_path: Path) -> None:
    """`eval` 不對應任何一項 `permissions`，所以它永遠只是「說一聲」——把它算成
    「宣告不符」會讓那個標記失去意思（沒有一種宣告能讓它變成相符）。"""
    hit = _scan(tmp_path, "eval('1+1')\n")[0]
    assert hit.permission is None and hit.declared


def test_the_same_thing_on_one_line_is_said_once(tmp_path: Path) -> None:
    """`os.environ.get(...)` 同時命中呼叫表與屬性表。重複的條目會讓這份清單
    看起來比實際嚴重。"""
    findings = _scan(tmp_path, "import os\nos.environ.get('X')\n")
    env = [f for f in findings if f.line == 2]
    assert len(env) == 1
    assert "os.environ.get()" in env[0].message


def test_a_syntax_error_is_a_finding_not_a_crash(tmp_path: Path) -> None:
    """不說的話，症狀是工具箱裡一顆按了才報「載入 main.py 失敗」的積木——而那要
    等到使用者真的拖出來按下去才會發生。"""
    hit = _scan(tmp_path, "def broken(\n")[0]
    assert "語法" in hit.message


#: 隨附的那幾個包。**釘死一份清單，不是掃整個目錄**——使用者裝進來的包也住在
#: `extensions/` 底下，而檢查別人的包不是這一題的工作（他的包亮紅燈是**對的**，
#: 那正是審閱畫面要說的話）。這條界線在「擴充功能的家搬出 repo」之後會自己消失。
OFFICIAL_PACKS = ("demo", "discord", "http", "openai", "panel")


def test_the_official_packs_do_not_light_up_undeclared() -> None:
    """校準用：`http` 真的 `import httpx`，而它宣告了 `net`。這一題紅掉的意思是
    掃描表變吵了——而一份會對每個正常的包都亮紅燈的清單，使用者三次之後就不看了。"""
    from blockyard.extensions import DEFAULT_EXTENSIONS_ROOT

    found = discover(DEFAULT_EXTENSIONS_ROOT)
    for ext_id in OFFICIAL_PACKS:
        src = found[ext_id]
        bad = [f for f in scan_pack(src.dir, src.manifest) if not f.declared]
        assert bad == [], f"{src.id}：{[f.message for f in bad]}"


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
    main = next(s for s in body["sources"] if s["path"] == "main.py")
    assert main["text"] == MAIN, "原始碼要完整，不是摘要（§12.1「不可略過」）"

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
    """使用者讀完幾百行原始碼再被拒絕，那幾分鐘是白花的——所以「已經裝過了」
    在審閱那一步就說。"""
    first = client.post("/api/extensions/import", content=good_zip()).json()
    client.post(f"/api/extensions/import/{first['token']}")

    again = client.post("/api/extensions/import", content=good_zip()).json()
    assert again["installed"] == {"version": "0.1.0"}
    # 而且真的裝不進去。
    res = client.post(f"/api/extensions/import/{again['token']}")
    assert res.status_code == 422
    assert "已經裝過" in res.json()["detail"]["message"]


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

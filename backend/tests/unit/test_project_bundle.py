"""專案的一生（`docs/project-storage-design.md`）：開一個、改名、帶出門、
在別的地方展開。

四件事分開測，而它們是這份設計裡真正會壞的那幾條線：

* **id 是 opaque 的、產生一次就不變**（§3）。改名不動它——那是這整份設計裡
  唯一有時效的一項，因為 keyring 裡的金鑰掛在它身上。
* **儲存是參照，運輸是打包**（§2）：活著的專案只記 id，bundle 帶原始碼。
* **匯入 = 開一個新專案 + 走 N 次已經蓋好的安裝管線**（§7），而 digest 一樣的
  包**完全不出現**。
* **金鑰是第二個檔案**（§6）：`.blockyard` 裡永遠沒有金鑰。
"""

from __future__ import annotations

import json
import zipfile
from collections.abc import Iterator
from io import BytesIO
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from blockyard import bundle as bundle_fmt
from blockyard.api.app import create_app
from blockyard.extensions import discover, secret_store

MANIFEST = """\
manifestVersion: 1
id: greet
name: 打招呼
version: 0.1.0
permissions: []
requirements: []
config:
  - key: api_key
    type: secret
    label: API Key
    envVar: GREET_API_KEY
palette:
  - opcode: hello
    type: command
    text: 說哈囉
"""

MAIN = """\
from blockyard import block


@block('greet.hello')
async def hello(ctx) -> None:
    ctx.log('hi')
"""


def _write_greet(root: Path) -> Path:
    pkg = root / "greet"
    pkg.mkdir(parents=True)
    (pkg / "manifest.yaml").write_text(MANIFEST, encoding="utf-8")
    (pkg / "main.py").write_text(MAIN, encoding="utf-8")
    # 沒有收據 = 使用者自己放的。匯出不管收據（它讀的是檔案），而匯入那一端
    # 會自己開一張新的（`origin: "bundle"`）。
    return pkg


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    ext_root = tmp_path / "extensions"
    _write_greet(ext_root)
    app = create_app(
        db_path=tmp_path / "blockyard.db",
        extensions_root=ext_root,
        project_staging_root=tmp_path / "project-staging",
    )
    # **`client=` 指的是「請求從哪台機器來」**：那顆「瀏覽…」與寫檔那條路只在
    # 迴圈位址上給（`api/files.py::require_local`），而 TestClient 的預設是
    # `testclient`——不指定的話，這裡測到的會是那道門，不是門後面的東西。
    with TestClient(app, client=("127.0.0.1", 5000)) as c:
        yield c


def _project(project_id: str, name: str = "我的專案") -> dict:
    return {
        "formatVersion": 1,
        "meta": {"id": project_id, "name": name},
        "extensions": [{"id": "greet", "version": "0.1.0"}],
        "scripts": [{"id": "sc_1", "top": "hat"}],
        "blocks": {
            "hat": {"opcode": "event.when_flag_clicked", "next": "hi"},
            "hi": {"opcode": "greet.hello"},
        },
    }


# --------------------------------------------------------------------------
# §3：身分
# --------------------------------------------------------------------------


def test_create_gives_an_opaque_id_that_rename_does_not_touch(client: TestClient) -> None:
    """**這是這份設計裡唯一有時效的一項。**

    id 是 opaque 的、跟名字無關、改名一個字都不動它——因為 keyring 裡那幾把
    金鑰掛在它身上，而「改一個字串就是搬一次使用者資料」已經在這個專案身上
    證明過自己一次了（§3）。
    """
    created = client.post("/api/projects", json={"name": "抓寶日報"}).json()
    assert created["id"].startswith("prj_")
    # 名字一個字都沒漏進 id 裡：改名不該讓人以為 id 也要跟著改。
    assert "抓寶" not in created["id"]

    renamed = client.patch(f"/api/projects/{created['id']}", json={"name": "改過的名字"})
    assert renamed.status_code == 200
    assert renamed.json()["id"] == created["id"]
    assert renamed.json()["name"] == "改過的名字"
    # 兩個地方一起改：列表看 name 欄位，打開來看的是 IR 裡的 meta.name。
    assert client.get(f"/api/projects/{created['id']}").json()["meta"]["name"] == "改過的名字"


def test_two_new_projects_do_not_collide(client: TestClient) -> None:
    a = client.post("/api/projects", json={"name": "同一個名字"}).json()
    b = client.post("/api/projects", json={"name": "同一個名字"}).json()
    assert a["id"] != b["id"]
    assert len(client.get("/api/projects").json()) == 2


def test_a_path_shaped_id_is_not_a_project(client: TestClient) -> None:
    """`{project_id}` 會被接成 keyring 的 username 與檔名，所以形狀要驗。"""
    assert client.get("/api/projects/..%2F..%2Fetc").status_code == 404
    assert client.delete("/api/projects/a:b").status_code == 404


# --------------------------------------------------------------------------
# §5：匯出
# --------------------------------------------------------------------------


def test_export_carries_the_source_of_the_packs_it_uses(client: TestClient) -> None:
    """**儲存是參照，運輸是打包**（§2）：IR 只記 id，bundle 帶原始碼。"""
    client.put("/api/projects/prj_x", json=_project("prj_x"))
    res = client.get("/api/projects/prj_x/export")
    assert res.status_code == 200

    with zipfile.ZipFile(BytesIO(res.content)) as zf:
        names = set(zf.namelist())
        meta = json.loads(zf.read(bundle_fmt.MANIFEST_NAME))
        project = json.loads(zf.read(bundle_fmt.PROJECT_NAME))

    assert "extensions/greet/main.py" in names
    assert "extensions/greet/manifest.yaml" in names
    assert [p["id"] for p in meta["extensions"]] == ["greet"]
    assert meta["extensions"][0]["digest"].startswith("sha256:")
    # IR 原文，一個欄位不多一個不少（`storage/projects.py` 的 round-trip 規則）。
    assert project == _project("prj_x")


def test_export_never_carries_a_secret(client: TestClient) -> None:
    """D28 被說得更準了，不是被放寬：**一份專案不能夾帶金鑰**（§6）。

    帶金鑰的那一份是**另一個檔案**，因為一份帶金鑰的 bundle 與一份不帶的如果
    長得一樣，它就會被轉寄、被丟上 GitHub——而那一刻沒有人記得三天前勾過什麼。
    """
    client.put("/api/projects/prj_x", json=_project("prj_x"))
    client.put("/api/keys/greet/api_key?project=prj_x", json={"value": "sk-secret-value-1234"})

    data = client.get("/api/projects/prj_x/export").content
    assert b"sk-secret-value-1234" not in data

    env = client.get("/api/projects/prj_x/export/env")
    assert "GREET_API_KEY=sk-secret-value-1234" in env.text
    assert env.headers["cache-control"] == "no-store"


def test_secrets_listing_says_which_keys_would_walk_out(client: TestClient) -> None:
    """那個勾選框旁邊要列出**這次會走出去哪幾把**（§6）。

    沒有這份清單，那個勾選框是在要求使用者對一件他看不見的事負責。只給末四碼。
    """
    client.put("/api/projects/prj_x", json=_project("prj_x"))
    client.put("/api/keys/greet/api_key?project=prj_x", json={"value": "sk-secret-value-1234"})

    plan = client.get("/api/projects/prj_x/export-plan").json()
    # 「這份 bundle 會帶 N 個積木包的原始碼」那一句從這裡來。
    assert [p["id"] for p in plan["packs"]] == ["greet"]
    (entry,) = plan["secrets"]
    assert entry["extId"] == "greet"
    assert entry["configured"] is True
    assert entry["suffix"] == "1234"
    assert entry["exportable"] is True
    assert "sk-secret-value" not in json.dumps(entry)


def test_export_of_a_missing_project_is_404(client: TestClient) -> None:
    assert client.get("/api/projects/prj_nope/export").status_code == 404


# --------------------------------------------------------------------------
# §7：匯入
# --------------------------------------------------------------------------


def _fresh_client(tmp_path: Path, name: str) -> TestClient:
    """一台**乾淨的機器**：沒有任何積木包，也沒有任何專案。"""
    root = tmp_path / name / "extensions"
    root.mkdir(parents=True)
    app = create_app(
        db_path=tmp_path / name / "blockyard.db",
        extensions_root=root,
        project_staging_root=tmp_path / name / "staging",
    )
    return TestClient(app, client=("127.0.0.1", 5000))


def test_a_bundle_opens_on_a_machine_that_has_nothing(
    client: TestClient, tmp_path: Path
) -> None:
    """**收一份 bundle = 開一個新專案 + 走 N 次安裝管線**（§7）。

    沒裝過的包進審閱（`status: "new"`，帶著整份原始碼），而那份審閱資料就是
    `.zip` 那條路上的同一份——一條管線，三個入口。
    """
    client.put("/api/projects/prj_x", json=_project("prj_x"))
    data = client.get("/api/projects/prj_x/export").content

    with _fresh_client(tmp_path, "other") as other:
        res = other.post(
            "/api/projects/import",
            content=data,
            # header 的值只能是 latin-1，所以前端送的是 `encodeURIComponent`
            # 過的（檔名可以是「我的專案.blockyard」）。
            headers={"X-Blockyard-Filename": quote("我的專案.blockyard")},
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["name"] == "我的專案"
        (pack,) = body["packs"]
        assert pack["status"] == "new"
        # 審閱資料**是整份原始碼**（§12.1「不可略過」）。
        assert "sources" not in pack["review"]
        assert pack["review"]["blocks"]

        token = body["token"]
        installed = other.post(f"/api/projects/import/{token}/extensions/greet")
        assert installed.status_code == 200, installed.text

        done = other.post(f"/api/projects/import/{token}")
        assert done.status_code == 201, done.text
        # **id 沿用 bundle 裡那一個**（§3：匯出再匯入回來不動它），因為這台
        # 機器上還沒有人占用它。
        assert done.json()["id"] == "prj_x"
        assert done.json()["reusedId"] is True

        opened = other.get("/api/projects/prj_x").json()
        assert opened["blocks"]["hi"]["opcode"] == "greet.hello"

        # 收據寫的是「這個包是跟著哪一份專案進來的」（§7）。
        receipts = {r["extId"]: r for r in other.get("/api/extensions/receipts").json()}
        assert receipts["greet"]["origin"] == "bundle"
        assert receipts["greet"]["label"] == "我的專案.blockyard"


def test_a_pack_that_is_already_here_and_identical_never_shows_up(client: TestClient) -> None:
    """digest 一樣 = **完全不出現**（§7 那張表的第一列）。

    這一列讓最常見的路完全沒有摩擦：一份只用官方包的 demo，收的人一個審閱畫面
    都不會看到。
    """
    client.put("/api/projects/prj_x", json=_project("prj_x"))
    data = client.get("/api/projects/prj_x/export").content

    body = client.post("/api/projects/import", content=data).json()
    (pack,) = body["packs"]
    assert pack["status"] == "same"
    assert "review" not in pack


def test_a_different_version_of_the_same_pack_is_skipped_and_said_out_loud(
    client: TestClient, tmp_path: Path
) -> None:
    """裝過了、但 digest 不一樣 → **預設跳過，並且說出來**（§7）。

    覆蓋是更新，而更新那條路上有一段差集要看。讓它從匯入偷渡進去，等於一個
    使用者按著「下一個」就把手上正在用的包換掉了。
    """
    client.put("/api/projects/prj_x", json=_project("prj_x"))
    data = client.get("/api/projects/prj_x/export").content

    with _fresh_client(tmp_path, "other2") as other:
        # 這台機器上有一個同 id、但內容不一樣的 `greet`。
        pkg = _write_greet(Path(other.app.state.extensions_root))
        (pkg / "main.py").write_text(MAIN + "\n# 我自己改過的\n", encoding="utf-8")

        body = other.post("/api/projects/import", content=data).json()
        (pack,) = body["packs"]
        assert pack["status"] == "different"
        assert "review" not in pack

        # 而且那條路真的走不通——它不是一句提示，是一道門。
        blocked = other.post(f"/api/projects/import/{body['token']}/extensions/greet")
        assert blocked.status_code == 409

        # 專案照樣開得出來：沒裝的包只是佔位符（§13.3），不是「這份專案打不開」。
        done = other.post(f"/api/projects/import/{body['token']}")
        assert done.status_code == 201, done.text


def test_importing_twice_keeps_both(client: TestClient) -> None:
    """同一份 bundle 匯入兩次 → 兩個專案並存（§10）。

    id 是 opaque 的，所以第二次一定拿到一個新的——`prj_x` 已經有人了。
    """
    client.put("/api/projects/prj_x", json=_project("prj_x"))
    data = client.get("/api/projects/prj_x/export").content

    body = client.post("/api/projects/import", content=data).json()
    # 已經有一個同名的，畫面上要說得出來（§10：技術上一定並存）。
    assert [p["id"] for p in body["sameName"]] == ["prj_x"]
    done = client.post(f"/api/projects/import/{body['token']}").json()
    assert done["id"] != "prj_x"
    assert done["reusedId"] is False
    assert len(client.get("/api/projects").json()) == 2


def test_a_zip_that_is_not_a_bundle_is_a_sentence_not_a_500(client: TestClient) -> None:
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("hello.txt", "我不是一份專案")
    res = client.post("/api/projects/import", content=buf.getvalue())
    assert res.status_code == 422
    assert "專案" in res.json()["detail"]["message"]


def test_cancelling_an_import_leaves_nothing_behind(client: TestClient, tmp_path: Path) -> None:
    client.put("/api/projects/prj_x", json=_project("prj_x"))
    data = client.get("/api/projects/prj_x/export").content
    token = client.post("/api/projects/import", content=data).json()["token"]

    staging = Path(client.app.state.project_staging_root)
    assert (staging / token).is_dir()
    assert client.delete(f"/api/projects/import/{token}").status_code == 204
    assert not (staging / token).exists()
    # 按第二次也算成功——這個端點描述的是結束狀態。
    assert client.delete(f"/api/projects/import/{token}").status_code == 204


# --------------------------------------------------------------------------
# §9：那顆「瀏覽…」
# --------------------------------------------------------------------------


def test_the_export_path_can_only_come_from_a_dialog_token(
    client: TestClient, tmp_path: Path
) -> None:
    """**後端寫的位置只能來自它自己剛剛開的那個對話框**（§9）。

    body 裡沒有 `path` 這個欄位，所以這條路不可能是一個從瀏覽器打得到的任意
    寫入端點。一張認不得的 token 只換得到一句「請再按一次瀏覽…」。
    """
    client.put("/api/projects/prj_x", json=_project("prj_x"))
    res = client.post(
        "/api/projects/prj_x/export",
        json={"path": str(tmp_path / "偷寫的.txt"), "token": "nope"},
    )
    assert res.status_code == 400
    assert not (tmp_path / "偷寫的.txt").exists()


def test_a_dialog_token_is_one_shot(client: TestClient, tmp_path: Path) -> None:
    """token 一次性、用掉就作廢——它換的是「一次寫入」，不是一張長期通行證。"""
    client.put("/api/projects/prj_x", json=_project("prj_x"))
    target = tmp_path / "我的專案.blockyard"
    token = client.app.state.save_targets.issue(target)

    first = client.post("/api/projects/prj_x/export", json={"token": token})
    assert first.status_code == 200, first.text
    assert target.is_file()
    assert zipfile.ZipFile(target).read(bundle_fmt.PROJECT_NAME)

    assert client.post("/api/projects/prj_x/export", json={"token": token}).status_code == 400


def test_exporting_secrets_writes_a_second_file(client: TestClient, tmp_path: Path) -> None:
    """**兩個檔案，不是一個檔案裡的一個旗標**（§6）。

    轉寄「那個專案」自然只會帶到第一個，而 `.env` 這個副檔名本身就是一句警告。
    """
    client.put("/api/projects/prj_x", json=_project("prj_x"))
    client.put("/api/keys/greet/api_key?project=prj_x", json={"value": "sk-secret-value-1234"})

    target = tmp_path / "我的專案.blockyard"
    token = client.app.state.save_targets.issue(target)
    res = client.post("/api/projects/prj_x/export", json={"token": token, "secrets": True})
    assert res.status_code == 200, res.text

    env = tmp_path / "我的專案.env"
    assert res.json()["envPath"] == str(env)
    assert "GREET_API_KEY=sk-secret-value-1234" in env.read_text(encoding="utf-8")
    # 而 bundle 本身仍然一個字都沒有。
    assert b"sk-secret-value-1234" not in target.read_bytes()


# --------------------------------------------------------------------------
# 每個專案一份金鑰（§16 Q23）
# --------------------------------------------------------------------------


def test_the_env_file_of_one_project_does_not_carry_another_projects_key(
    client: TestClient,
) -> None:
    client.put("/api/projects/prj_a", json=_project("prj_a", name="A"))
    client.put("/api/projects/prj_b", json=_project("prj_b", name="B"))
    client.put("/api/keys/greet/api_key?project=prj_a", json={"value": "sk-only-in-a-1111"})

    assert "sk-only-in-a-1111" in client.get("/api/projects/prj_a/export/env").text
    assert "sk-only-in-a-1111" not in client.get("/api/projects/prj_b/export/env").text


def test_deleted_pack_is_skipped_by_export(client: TestClient, tmp_path: Path) -> None:
    """宣告了、但這台機器上沒有的包**跳過，不是錯誤**（§13.3 的同一條線）。

    硬要在匯出這一步失敗，等於讓一個早就壞了的專案連備份都做不出來。
    """
    project = _project("prj_x")
    project["extensions"].append({"id": "not_here", "version": "1.0.0"})
    client.put("/api/projects/prj_x", json=project)

    res = client.get("/api/projects/prj_x/export")
    assert res.status_code == 200
    with zipfile.ZipFile(BytesIO(res.content)) as zf:
        meta = json.loads(zf.read(bundle_fmt.MANIFEST_NAME))
    assert [p["id"] for p in meta["extensions"]] == ["greet"]
    assert discover(Path(client.app.state.extensions_root)).keys() == {"greet"}


def test_legacy_keys_land_on_prj_local_and_nowhere_else(tmp_path: Path) -> None:
    """P0b 存下來的金鑰沒有專案這個維度。**搬進 `prj_local`，而且只搬進它**（§3）。

    收件人是寫死的，因為它有一個確定的答案：舊格式只可能是 P0b 留下來的，而 P0b
    的世界裡專案 id 只有一個字串。

    **第一版是猜的，而它當場就錯了**：那一版對每一個專案試一輪、第一個沒有同名
    金鑰的就收下——而列表是照 `updated_at` 由新到舊排的，於是使用者剛開來測試的
    那個空專案先接走了它們，`prj_local` 上一整排變成「未設定」。這個測試的第二段
    就是那件事。
    """
    ext_root = tmp_path / "legacy" / "extensions"
    _write_greet(ext_root)
    db = tmp_path / "legacy" / "blockyard.db"
    app = create_app(db_path=db, extensions_root=ext_root)
    with TestClient(app, client=("127.0.0.1", 5000)) as c:
        c.put("/api/projects/prj_local", json=_project("prj_local"))
        # 剛剛才開來測試的一個空專案——**它比 `prj_local` 新**。
        c.put("/api/projects/prj_probe", json=_project("prj_probe", name="probe"))
    # 舊格式：擁有者只有 ext_id，沒有專案。
    secret_store.set("greet", "api_key", "sk-legacy-value-9999")

    app2 = create_app(db_path=db, extensions_root=ext_root)
    with TestClient(app2, client=("127.0.0.1", 5000)) as c:
        (mine,) = [
            e for e in c.get("/api/keys?project=prj_local").json() if e["extId"] == "greet"
        ]
        assert mine["configured"] is True
        assert mine["suffix"] == "9999"

        # 那個新開的專案**一把都沒有**。它拿到的話，`prj_local` 就是一整排
        # 「未設定」——而使用者什麼都沒改。
        (theirs,) = [
            e for e in c.get("/api/keys?project=prj_probe").json() if e["extId"] == "greet"
        ]
        assert theirs["configured"] is False

    # 搬走了，不是複製一份——留著的話，使用者刪掉新的那一把之後它會復活。
    assert secret_store.get("greet", "api_key") is None


def test_a_key_set_before_any_block_is_placed_still_gets_exported(client: TestClient) -> None:
    """**「這個專案的金鑰」的範圍是它的鑰匙圈，不是它的畫布。**

    使用者把一個包加進工具箱、填好金鑰、還沒拉出任何一顆積木——那時候 IR 的
    `extensions` 是空的（它是從畫布算出來的，§13.3）。第一版把清單收窄到「畫布
    用到的包」，於是面板上寫著「這個專案沒有設定過任何金鑰」，而那句話是假的。

    per-project 的 keyring 本來就已經把別的專案擋在外面了，收窄第二次買到的只有
    這個 bug。
    """
    # 一份**空的**專案：沒有宣告任何積木包。
    client.put(
        "/api/projects/prj_empty",
        json={
            "formatVersion": 1,
            "meta": {"id": "prj_empty", "name": "還沒開始"},
            "extensions": [],
            "scripts": [],
            "blocks": {},
        },
    )
    client.put("/api/keys/greet/api_key?project=prj_empty", json={"value": "sk-filled-early-77"})

    plan = client.get("/api/projects/prj_empty/export-plan").json()
    assert plan["packs"] == []
    (entry,) = [s for s in plan["secrets"] if s["configured"]]
    assert entry["extId"] == "greet"
    assert "GREET_API_KEY=sk-filled-early-77" in client.get(
        "/api/projects/prj_empty/export/env"
    ).text


def test_the_dialog_is_not_offered_to_another_machine(tmp_path: Path) -> None:
    """**只在後端跟瀏覽器是同一台機器時給**（§9 第 2 條）。

    對話框開在**後端**那台的螢幕上。少了這條，症狀是一個沒有人在看的螢幕上
    開了一個視窗，而那個 HTTP 請求永遠不回來。判準用「這個請求來自 loopback」，
    不是設定值——`blockyard serve --host` 已經允許別的綁法。
    """
    ext_root = tmp_path / "remote" / "extensions"
    _write_greet(ext_root)
    app = create_app(db_path=tmp_path / "remote" / "blockyard.db", extensions_root=ext_root)
    with TestClient(app, client=("192.168.1.20", 5000)) as c:
        c.put("/api/projects/prj_x", json=_project("prj_x"))
        assert c.post("/api/files/save-dialog", json={}).status_code == 403
        assert c.get("/api/files/dialog-available").json()["available"] is False
        # 但**下載那條路照樣成立**：它不需要對話框，也不需要同一台機器。
        assert c.get("/api/projects/prj_x/export").status_code == 200


def test_deleting_a_project_takes_its_keys_with_it(client: TestClient) -> None:
    """刪掉專案 = 連它自己那幾把金鑰一起（§16 Q23）。

    留著的話那幾行永遠不會再被任何一條路讀到（專案 id 是 opaque 的），是純粹的
    垃圾——而且是明文的垃圾。這件事寫在刪除的確認對話框上，所以它不是一個副作用。
    """
    client.put("/api/projects/prj_x", json=_project("prj_x"))
    client.put("/api/keys/greet/api_key?project=prj_x", json={"value": "sk-secret-value-1234"})
    assert secret_store.get(secret_store.owner_of("prj_x", "greet"), "api_key")

    assert client.delete("/api/projects/prj_x").status_code == 204
    assert secret_store.get(secret_store.owner_of("prj_x", "greet"), "api_key") is None


# --------------------------------------------------------------------------
# 網址：`/projects` 與 `/p/<id>` 是真的路徑
# --------------------------------------------------------------------------


def test_the_editor_paths_survive_a_refresh(tmp_path: Path) -> None:
    """前端的網址是真的路徑，而磁碟上沒有那幾個檔案。

    少了那條 SPA fallback，**重新整理一次就白畫面**——而它在 dev 是好的（Vite
    自己有這條），所以那個 bug 只會在打包之後出現，那時候最像「打包壞了」。
    """
    static = tmp_path / "dist"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html><div id=root>", encoding="utf-8")
    (static / "app.js").write_text("console.log(1)", encoding="utf-8")

    app = create_app(db_path=tmp_path / "blockyard.db", static_root=static)
    with TestClient(app) as c:
        for path in ("/", "/projects", "/p/prj_ab12cd34"):
            res = c.get(path)
            assert res.status_code == 200, path
            assert "id=root" in res.text, path
        # 真的存在的檔案照舊。
        assert c.get("/app.js").text == "console.log(1)"

        # **看起來像檔案的不吃 fallback**，即使它在一條前端的路徑底下。
        #
        # 回一份 200 的 HTML 的話，瀏覽器會把它當圖片解，畫出來是一個破圖圖示
        # ——而那個症狀離原因（某個地方寫了相對路徑）非常遠。這件事已經發生過
        # 一次：Blockly 的 `media: 'media/'` 在編輯器搬到 `/p/<id>` 之後，右下角
        # 的垃圾桶與放大縮小全變成破圖。
        assert c.get("/p/media/sprites.png").status_code == 404


def test_a_missing_api_path_is_still_a_404(tmp_path: Path) -> None:
    """**`/api` 底下的 404 是真的 404。**

    回一份 HTML 的話，前端會把首頁當成 JSON 去 parse，而那個錯誤訊息離原因有
    十萬八千里。`api/client.ts` 甚至靠這個 catch-all 的 405 認出「後端改了沒
    重啟」——所以這條 fallback 要窄。
    """
    static = tmp_path / "dist"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html><div id=root>", encoding="utf-8")

    app = create_app(db_path=tmp_path / "blockyard.db", static_root=static)
    with TestClient(app) as c:
        assert c.get("/api/no-such-thing").status_code == 404
        assert c.get("/hooks/nope").status_code == 404
        # 「後端沒重啟」那條線：打不中任何路由的 POST 落在 StaticFiles 上 → 405。
        assert c.post("/api/no-such-thing").status_code == 405

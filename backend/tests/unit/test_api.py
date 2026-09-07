"""`/api/projects` 與 `/api/extensions`（§15 P0b 第 1、2 步的驗收）。

三條驗收線：

  1. app 起得來（`blockyard serve` 的實質內容）
  2. 題庫的 `project.json` PUT 進去再 GET 回來**內容等價**——不掉欄位、不改 blockId
  3. 壞的 IR 回 422 且訊息指名 blockId——也就是存檔時就跑 §4 的載入期驗證

第 3 條是重點：驗證邏輯早就寫好了，這一步只是把它接到 HTTP 上。所以這裡也
有一個測試專門確認 API 層**沒有**重寫一份驗證。
"""

from __future__ import annotations

import json
import zipfile
from io import BytesIO
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from blockyard.api.app import create_app
from blockyard.extensions import BUNDLED_ROOT

CORPUS = Path(__file__).parents[1] / "conformance"


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    app = create_app(db_path=tmp_path / "blockyard.db", extensions_root=BUNDLED_ROOT)
    return TestClient(app)


def _loadable_corpus() -> list[Path]:
    """題庫裡**應該載得起來**的那些題目。

    `expect.load_error` 的題目本身就是「這份 IR 必須被擋下」，拿它們測
    round-trip 是搞錯對象——它們是下面 422 那條線的證人。
    """
    out = []
    for meta_path in sorted(CORPUS.rglob("meta.yaml")):
        meta = yaml.safe_load(meta_path.read_text(encoding="utf-8"))
        if "load_error" not in (meta.get("expect") or {}):
            out.append(meta_path.parent)
    return out


def _declared_id(data: dict) -> str:
    """專案自己說它的 id 是什麼。網址與 `meta.id` 不一致是 422（見下面的測試）。"""
    return (data.get("meta") or {}).get("id", "p1")


CORPUS_CASES = _loadable_corpus()
BAD_CASES = [
    d for d in sorted(CORPUS.rglob("meta.yaml")) if d not in {p / "meta.yaml" for p in CORPUS_CASES}
]


# --------------------------------------------------------------------------
# 1. 起得來
# --------------------------------------------------------------------------


def test_health(client: TestClient) -> None:
    assert client.get("/api/health").json()["status"] == "ok"


def test_root_serves_something_before_the_editor_exists(client: TestClient) -> None:
    assert client.get("/").status_code == 200


def test_empty_project_list(client: TestClient) -> None:
    assert client.get("/api/projects").json() == []


# --------------------------------------------------------------------------
# 2. round-trip
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "case_dir", CORPUS_CASES, ids=lambda p: str(p.relative_to(CORPUS))
)
def test_corpus_project_round_trips(client: TestClient, case_dir: Path) -> None:
    """63 份題庫的 `project.json` 是現成的測資，一份都不必另寫。"""
    data = json.loads((case_dir / "project.json").read_text(encoding="utf-8"))
    pid = _declared_id(data)

    put = client.put(f"/api/projects/{pid}", json=data)
    assert put.status_code in (200, 201), put.text

    got = client.get(f"/api/projects/{pid}")
    assert got.status_code == 200
    assert got.json() == data


def test_round_trip_keeps_unknown_meta_fields(client: TestClient) -> None:
    """`meta` 是 extra="allow"（§4.1）。存檔不該把不認得的欄位吃掉。"""
    data = {
        "formatVersion": 1,
        "meta": {"name": "測試", "editorNote": "前端自己加的東西"},
        "blocks": {},
    }
    client.put("/api/projects/p1", json=data)
    assert client.get("/api/projects/p1").json() == data


def test_put_creates_then_updates(client: TestClient) -> None:
    assert client.put("/api/projects/p1", json={"meta": {"name": "一"}}).status_code == 201
    r = client.put("/api/projects/p1", json={"meta": {"name": "二"}})
    assert r.status_code == 200
    assert r.json()["name"] == "二"
    assert [p["id"] for p in client.get("/api/projects").json()] == ["p1"]


def test_saved_preview_appears_in_project_list_and_can_be_read(client: TestClient) -> None:
    client.put("/api/projects/p1", json={"meta": {"name": "預覽"}})
    image = b"RIFF\x00\x00\x00\x00WEBPfake"
    saved = client.put(
        "/api/projects/p1/preview", content=image, headers={"Content-Type": "image/webp"}
    )
    assert saved.status_code == 204

    summary = client.get("/api/projects").json()[0]
    assert summary["preview"].startswith("/api/projects/p1/preview?")
    preview = client.get(summary["preview"])
    assert preview.status_code == 200
    assert preview.headers["content-type"] == "image/webp"
    assert preview.content == image
    # 圖是衍生資料，GET 專案仍只回原本 PUT 的 JSON。
    assert "preview" not in client.get("/api/projects/p1").json()


def test_preview_rejects_wrong_type_and_missing_project(client: TestClient) -> None:
    client.put("/api/projects/p1", json={})
    assert client.put("/api/projects/p1/preview", content=b"png").status_code == 415
    assert (
        client.put(
            "/api/projects/missing/preview",
            content=b"webp",
            headers={"Content-Type": "image/webp"},
        ).status_code
        == 404
    )


def test_missing_project_is_404(client: TestClient) -> None:
    assert client.get("/api/projects/nope").status_code == 404


def test_copy_keeps_the_canvas_and_takes_a_new_id(client: TestClient) -> None:
    """複製一份：積木一模一樣，但 id 是新的，而 `meta.id` 跟著換。"""
    data = {
        "formatVersion": 1,
        "meta": {"id": "p1", "name": "我的流程"},
        "scripts": [{"id": "s1", "top": "hat"}],
        "blocks": {"hat": {"opcode": "event.when_flag_clicked"}},
    }
    client.put("/api/projects/p1", json=data)
    image = b"RIFF\x00\x00\x00\x00WEBPfake"
    client.put("/api/projects/p1/preview", content=image, headers={"Content-Type": "image/webp"})

    r = client.post("/api/projects/p1/copy")
    assert r.status_code == 201, r.text
    copy_id = r.json()["id"]
    assert copy_id != "p1"
    assert r.json()["name"] == "我的流程 的副本"

    copied = client.get(f"/api/projects/{copy_id}").json()
    assert copied["blocks"] == data["blocks"]
    assert copied["scripts"] == data["scripts"]
    # `meta.id` 沒換的話，副本第一次存檔就是 422。
    assert copied["meta"]["id"] == copy_id
    assert copied["meta"]["name"] == "我的流程 的副本"
    # 卡片上那張圖也跟著，否則列表上兩張同一份東西的卡長得不一樣。
    assert client.get(f"/api/projects/{copy_id}/preview").content == image
    # 原本那一份一個字都沒動。
    assert client.get("/api/projects/p1").json() == data


def test_copying_twice_gives_names_that_can_be_told_apart(client: TestClient) -> None:
    client.put("/api/projects/p1", json={"meta": {"name": "流程"}})
    first = client.post("/api/projects/p1/copy").json()["name"]
    second = client.post("/api/projects/p1/copy").json()["name"]
    assert first == "流程 的副本"
    assert second == "流程 的副本 2"
    assert len(client.get("/api/projects").json()) == 3


def test_copying_a_missing_project_is_404(client: TestClient) -> None:
    assert client.post("/api/projects/nope/copy").status_code == 404


# --------------------------------------------------------------------------
# 3. 壞的 IR 回 422，且指名 blockId
# --------------------------------------------------------------------------


def test_reporter_on_a_stack_is_rejected_with_the_block_id(client: TestClient) -> None:
    """D20 的形狀驗證，接到 HTTP 上。"""
    bad = {
        "formatVersion": 1,
        "scripts": [{"id": "s1", "top": "hat"}],
        "blocks": {
            "hat": {"opcode": "event.when_flag_clicked", "next": "adder"},
            "adder": {"opcode": "operator.add", "parent": "hat"},
        },
    }
    r = client.put("/api/projects/p1", json=bad)
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["blockId"] == "adder"
    assert "回報型積木" in detail["message"]

    # 沒進資料庫——壞掉的專案不該在磁碟上存活到下一次開檔
    assert client.get("/api/projects/p1").status_code == 404


def test_bad_expression_is_rejected_with_the_block_id(client: TestClient) -> None:
    """§4.7b：運算式的語法錯誤是**存檔期**的 422，而且標得回那顆積木。

    前端靠 `detail.blockId` 把警告掛在積木上（`App.tsx` 的 save 那段）。沒有
    這個欄位，使用者只會看到一行紅字，得自己在畫布上找是哪一顆。
    """
    bad = {
        "formatVersion": 1,
        "scripts": [{"id": "s1", "top": "hat"}],
        "blocks": {
            "hat": {"opcode": "event.when_flag_clicked", "next": "logit"},
            "logit": {
                "opcode": "debug.log",
                "parent": "hat",
                "inputs": {"text": {"kind": "block", "id": "calc"}},
            },
            "calc": {"opcode": "operator.expr", "parent": "logit", "fields": {"expr": "1 + max(2)"}},
        },
    }
    r = client.put("/api/projects/p1", json=bad)
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["blockId"] == "calc"
    assert "函式" in detail["message"]


def test_a_valid_expression_saves(client: TestClient) -> None:
    """反面：合法的運算式存得進去，欄位原樣回來（運算式是 field，不是輸入孔）。"""
    good = {
        "formatVersion": 1,
        "scripts": [{"id": "s1", "top": "calc"}],
        "blocks": {"calc": {"opcode": "operator.expr", "fields": {"expr": "(1 + 2) * 3"}}},
    }
    assert client.put("/api/projects/p1", json=good).status_code in (200, 201)
    back = client.get("/api/projects/p1").json()
    assert back["blocks"]["calc"]["fields"] == {"expr": "(1 + 2) * 3"}


def test_a_stack_without_a_hat_saves(client: TestClient) -> None:
    """§4.1：寫到一半的積木不該擋住存檔。

    這曾經是 422（「腳本最上面必須是事件積木」），而它擋的是使用者天天在做的
    事——先拉幾顆試試看。落單堆疊是合法 IR，只是永遠不會被 trigger 選中。
    """
    draft = {
        "formatVersion": 1,
        "scripts": [{"id": "s1", "top": "orphan"}, {"id": "s2", "top": "lonely"}],
        "blocks": {
            # 沒有 hat 的 command 堆疊
            "orphan": {"opcode": "debug.log", "next": "more"},
            "more": {"opcode": "debug.log", "parent": "orphan"},
            # 第三種頂層堆疊：落單的 reporter（§4.1）。它是「點一下就跑」的對象
            "lonely": {"opcode": "operator.add"},
        },
    }
    assert client.put("/api/projects/p_draft", json=draft).status_code in (200, 201)
    assert client.get("/api/projects/p_draft").json()["scripts"][0]["top"] == "orphan"


def test_a_hat_in_the_middle_of_a_stack_is_still_rejected(client: TestClient) -> None:
    """刪掉上面那條檢查**不影響**這一條：它們本來就是兩條獨立的規則。

    hat 放在堆疊中間由「`next` 接的積木必須是 command」擋下（`_require_shape`），
    訊息還更準確——它說的是 hat 不能接在別人下面，與 top 是什麼形狀無關。
    """
    bad = {
        "formatVersion": 1,
        "scripts": [{"id": "s1", "top": "hat"}],
        "blocks": {
            "hat": {"opcode": "event.when_flag_clicked", "next": "hat2"},
            "hat2": {"opcode": "event.when_flag_clicked", "parent": "hat"},
        },
    }
    r = client.put("/api/projects/p1", json=bad)
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["blockId"] == "hat2"
    assert "只能放在腳本最上面" in r.json()["detail"]["message"]


@pytest.mark.parametrize(
    "case_dir",
    [p.parent for p in BAD_CASES],
    ids=lambda p: str(p.relative_to(CORPUS)),
)
def test_corpus_load_error_cases_are_422(client: TestClient, case_dir: Path) -> None:
    """§4 的載入期驗證**只有一份**。題庫說該擋的，HTTP 上也要擋。

    這條就是「不要在 API 層重寫一份驗證」的守衛：真的重寫了，兩邊會在這裡分岔。
    """
    data = json.loads((case_dir / "project.json").read_text(encoding="utf-8"))
    meta = yaml.safe_load((case_dir / "meta.yaml").read_text(encoding="utf-8"))

    r = client.put(f"/api/projects/{_declared_id(data)}", json=data)
    assert r.status_code == 422, r.text
    fragment = meta["expect"]["load_error"]
    if fragment:
        assert fragment in r.json()["detail"]["message"]


def test_return_outside_a_function_is_rejected(client: TestClient) -> None:
    """§4.6 的 return 位置，同樣是存檔時擋，不是執行期。"""
    bad = {
        "formatVersion": 1,
        "scripts": [{"id": "s1", "top": "hat"}],
        "blocks": {
            "hat": {"opcode": "event.when_flag_clicked", "next": "ret"},
            "ret": {"opcode": "procedure.return", "parent": "hat"},
        },
    }
    r = client.put("/api/projects/p1", json=bad)
    assert r.status_code == 422
    assert r.json()["detail"]["blockId"] == "ret"


def test_meta_id_must_agree_with_the_url(client: TestClient) -> None:
    r = client.put("/api/projects/p1", json={"meta": {"id": "p2"}})
    assert r.status_code == 422
    assert "meta.id" in r.json()["detail"]["path"]


def test_garbage_body_is_422_not_500(client: TestClient) -> None:
    assert client.put("/api/projects/p1", json=["不是物件"]).status_code == 422
    assert client.put("/api/projects/p1", json={"blocks": "不是 dict"}).status_code == 422


# --------------------------------------------------------------------------
# `/api/extensions`（§8.1）
# --------------------------------------------------------------------------


def test_extensions_include_builtins_marked_as_such(client: TestClient) -> None:
    """D21：內建與積木包從同一個端點吐出，格式一模一樣。"""
    from blockyard.interpreter import declarations

    body = client.get("/api/extensions").json()
    by_id = {m["id"]: m for m in body}

    assert set(declarations.manifests()) <= set(by_id)
    assert all(by_id[ns]["builtin"] is True for ns in declarations.manifests())
    assert by_id["demo"].get("builtin", False) is False


def block_of(manifest: dict, opcode: str) -> dict:
    """從 wire 上的 `palette` 撈一顆積木。

    前端拿到的是**一份 palette**（積木、按鈕、分段照工具箱的順序，§7.2），
    導出 `blocks` 那件事在後端是 property、在前端是 `define.ts::blocksOf`——
    JSON 上只有 palette 一份。
    """
    return next(e for e in manifest["palette"] if e.get("opcode") == opcode)


def test_extension_payload_is_enough_to_draw_a_block(client: TestClient) -> None:
    """§8.1 第 2 步：manifest → Blockly block definition 要有的東西都在。"""
    by_id = {m["id"]: m for m in client.get("/api/extensions").json()}
    repeat = block_of(by_id["control"], "repeat")

    assert repeat["type"] == "command"
    assert "%(times)" in repeat["text"]
    assert repeat["args"]["times"]["type"] == "number"
    assert repeat["args"]["body"]["type"] == "stack"
    assert by_id["control"]["color"].startswith("#")


def test_static_dropdown_options_are_declared(client: TestClient) -> None:
    """內建的下拉是靜態的（選項就是宣告的一部分），積木包的是動態的。"""
    by_id = {m["id"]: m for m in client.get("/api/extensions").json()}
    stop = block_of(by_id["control"], "stop")
    values = [o["value"] for o in stop["args"]["scope"]["options"]]
    assert values == ["this_script", "all"]
    assert stop["args"]["scope"]["field"] is True

    color_of = block_of(by_id["demo"], "color_of")
    assert color_of["args"]["fruit"]["source"] == "list_fruits"
    assert "options" not in color_of["args"]["fruit"]


# --------------------------------------------------------------------------
# 面板的靜態檔（§8.3、§16 Q17 的 B 路線）
#
# 這個端點是「積木包可以把 bytes 交給瀏覽器」的唯一入口，所以它的守衛就是那件
# 事的全部守衛。每一條都值一題。
# --------------------------------------------------------------------------


def test_面板的_entry_送得出來(client: TestClient) -> None:
    r = client.get("/api/extensions/demo/asset/ui/index.html")

    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    # 從內容猜型別是這條路上最容易被繞過的一格。
    assert r.headers["x-content-type-options"] == "nosniff"


def test_子資源也送得出來(client: TestClient) -> None:
    """sandbox 的 opaque origin 底下，相對路徑的 <link> 與 <script> 仍然要載得起來
    ——不然多檔案的面板（vendored three.js 之類）整條不成立。"""
    assert client.get("/api/extensions/demo/asset/ui/panel.css").status_code == 200
    assert client.get("/api/extensions/demo/asset/ui/panel.js").status_code == 200


def test_content_type_只認白名單(client: TestClient) -> None:
    """副檔名認不得就 404，不猜一個型別送出去。"""
    r = client.get("/api/extensions/demo/asset/main.py")

    assert r.status_code == 404
    assert "不能載" in r.json()["detail"]["message"]
    assert r.json()["detail"]["code"] == "http.not_found"
    assert r.json()["detail"]["params"] == {}


def test_跳不出積木包的資料夾(client: TestClient) -> None:
    """字串規則在 manifest 那層擋過，這裡擋的是 HTTP 來的路徑——面板的子資源
    是瀏覽器自己去要的，不經過任何宣告。"""
    r = client.get("/api/extensions/demo/asset/../../http/main.py")

    # 有些 client 會先正規化掉 `..`，所以兩種結局都算擋住了（重點是拿不到檔案）。
    assert r.status_code == 404


def test_沒宣告面板的包沒有這條路(client: TestClient) -> None:
    """端點的開關就是 `panels` 宣告。沒宣告面板的包不該有一條把檔案送出去的
    路——那是「哪些包可以送 bytes」唯一說得出口的地方。"""
    r = client.get("/api/extensions/http/asset/main.py")

    assert r.status_code == 404
    assert "沒有前端入口" in r.json()["detail"]["message"]


# --------------------------------------------------------------------------
# 封面（§8.1、D31）
#
# 它刻意不共用上面那條 `/asset/{path}`：那個端點只開給宣告過 `panels` 的包，而
# 封面是每個包都該有的東西。這裡的題目就是「多開一條路沒有把上面那道門打開」。
# --------------------------------------------------------------------------


def test_封面送得出來(client: TestClient) -> None:
    r = client.get("/api/extensions/demo/cover")

    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.headers["x-content-type-options"] == "nosniff"


def test_封面留得住(client: TestClient) -> None:
    """`no-cache` 而不是 `no-store`。

    差別是「留著、用之前先問一下」與「不准留」——後者的症狀是每次打開擴充功能
    面板都把每張封面重抓一次，而且第十次跟第一次一樣慢。ETag 一起送，所以那一
    句「問一下」的答案是 304。
    """
    r = client.get("/api/extensions/demo/cover")

    assert r.headers["cache-control"] == "no-cache"
    assert r.headers.get("etag")

    again = client.get("/api/extensions/demo/cover", headers={"If-None-Match": r.headers["etag"]})
    assert again.status_code == 304


def test_沒有面板的包也有封面(client: TestClient) -> None:
    """封面與 `panels` 無關——`http` 沒有面板，但它在擴充功能面板上一樣有一張卡。"""
    assert client.get("/api/extensions/http/cover").status_code == 200
    # 而那道門沒有因此被打開：它仍然拿不到自己的任何一個檔案。
    assert client.get("/api/extensions/http/asset/main.py").status_code == 404


def test_封面端點不吃路徑(client: TestClient) -> None:
    """路徑由 manifest 決定，request 一個字都不帶——所以這裡沒有可以被塞
    `../` 的地方，多出來的那一段只會變成一條不存在的 route。"""
    assert client.get("/api/extensions/demo/cover/../main.py").status_code == 404


def test_沒宣告封面就是_404(client: TestClient) -> None:
    r = client.get("/api/extensions/沒這個包/cover")

    assert r.status_code == 404
    assert "沒有封面" in r.json()["detail"]["message"]


def test_封面宣告出現在_api_extensions_上(client: TestClient) -> None:
    """前端靠它決定那格畫圖還是畫名字的第一個字。"""
    demo = next(g for g in client.get("/api/extensions").json() if g["id"] == "demo")

    assert demo["cover"] == "preview.png"


def test_積木包可匯出成能重新安裝的_zip(client: TestClient) -> None:
    r = client.get("/api/extensions/demo/export")

    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    assert "demo-0.1.0.zip" in r.headers["content-disposition"]
    with zipfile.ZipFile(BytesIO(r.content)) as zf:
        names = set(zf.namelist())
        assert {"manifest.yaml", "main.py", "preview.png"} <= names
        assert ".blockyard-source.json" not in names
        assert ".DS_Store" not in names
        assert not any(".venv/" in name or "__pycache__/" in name for name in names)


def test_面板宣告出現在_api_extensions_上(client: TestClient) -> None:
    """前端要靠它決定分頁列上有哪幾格——分頁是**宣告**出來的，不是資料生出來的。"""
    demo = next(g for g in client.get("/api/extensions").json() if g["id"] == "demo")

    assert demo["panels"] == [{"id": "demo", "name": "示範面板", "entry": "ui/index.html"}]


def test_trusted_panels_can_load_external_resources(client: TestClient) -> None:
    response = client.get("/api/extensions/demo/asset/ui/index.html")
    assert response.status_code == 200
    assert "content-security-policy" not in response.headers
    assert response.headers["x-content-type-options"] == "nosniff"


def test_子資源不帶_csp(client: TestClient) -> None:
    """CSP 管的是**文件**能載什麼。掛在每個 .js 上不會多擋到任何東西，只會讓
    「這條規則從哪裡來的」多幾個要查的地方。"""
    r = client.get("/api/extensions/demo/asset/ui/panel.js")

    assert "content-security-policy" not in r.headers


def test_面板的檔案帶_cors(client: TestClient) -> None:
    """面板是 opaque origin，所以它拿**自己的**檔案也算跨來源。

    `<script type="module">` 的抓取一律走 CORS（classic script 不會），
    `@font-face` 與 `fetch` 也是。少了這一行的症狀是「HTML 與 CSS 都到了、JS 沒
    跑起來」——因為 `<link rel=stylesheet>` 是 no-cors，進得來。
    """
    for path in ("ui/index.html", "ui/panel.js", "ui/panel.css"):
        r = client.get(f"/api/extensions/demo/asset/{path}")
        assert r.headers["access-control-allow-origin"] == "*", path

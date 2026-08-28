"""`/api/projects` 與 `/api/extensions`（§15 P0b 第 1、2 步的驗收）。

三條驗收線：

  1. app 起得來（`blocky serve` 的實質內容）
  2. 題庫的 `project.json` PUT 進去再 GET 回來**內容等價**——不掉欄位、不改 blockId
  3. 壞的 IR 回 422 且訊息指名 blockId——也就是存檔時就跑 §4 的載入期驗證

第 3 條是重點：驗證邏輯早就寫好了，這一步只是把它接到 HTTP 上。所以這裡也
有一個測試專門確認 API 層**沒有**重寫一份驗證。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from blocky.api.app import create_app
from blocky.extensions import DEFAULT_EXTENSIONS_ROOT

CORPUS = Path(__file__).parents[1] / "conformance"


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    app = create_app(db_path=tmp_path / "blocky.db", extensions_root=DEFAULT_EXTENSIONS_ROOT)
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


def test_missing_project_is_404(client: TestClient) -> None:
    assert client.get("/api/projects/nope").status_code == 404


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
    from blocky.interpreter import declarations

    body = client.get("/api/extensions").json()
    by_id = {m["id"]: m for m in body}

    assert set(declarations.manifests()) <= set(by_id)
    assert all(by_id[ns]["builtin"] is True for ns in declarations.manifests())
    assert by_id["demo"].get("builtin", False) is False


def test_extension_payload_is_enough_to_draw_a_block(client: TestClient) -> None:
    """§8.1 第 2 步：manifest → Blockly block definition 要有的東西都在。"""
    by_id = {m["id"]: m for m in client.get("/api/extensions").json()}
    repeat = next(b for b in by_id["control"]["blocks"] if b["opcode"] == "repeat")

    assert repeat["type"] == "command"
    assert "%(times)" in repeat["text"]
    assert repeat["args"]["times"]["type"] == "number"
    assert repeat["args"]["body"]["type"] == "stack"
    assert by_id["control"]["color"].startswith("#")


def test_static_dropdown_options_are_declared(client: TestClient) -> None:
    """內建的下拉是靜態的（選項就是宣告的一部分），積木包的是動態的。"""
    by_id = {m["id"]: m for m in client.get("/api/extensions").json()}
    stop = next(b for b in by_id["control"]["blocks"] if b["opcode"] == "stop")
    values = [o["value"] for o in stop["args"]["scope"]["options"]]
    assert values == ["this_script", "all"]
    assert stop["args"]["scope"]["field"] is True

    color_of = next(b for b in by_id["demo"]["blocks"] if b["opcode"] == "color_of")
    assert color_of["args"]["fruit"]["source"] == "list_fruits"
    assert "options" not in color_of["args"]["fruit"]

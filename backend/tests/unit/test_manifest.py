"""manifest 的驗證（§7.2）。

這些題目全部是「manifest 寫錯了」而不是「執行期出錯」。它們該在載入積木包
時就爆，因為漂移的症狀——工具箱裡一顆按了沒反應的積木——要等到使用者真的
拖出來用才會被發現。§11 的 AI 生成積木包更是完全靠這一層兜底。
"""

from __future__ import annotations

import pytest

from blockyard.errors import ExtensionError
from blockyard.extensions import BUNDLED_ROOT, Manifest, discover, load_locales, parse_manifest, scan

BASE = {"manifestVersion": 1, "id": "demo2", "name": "示範", "version": "0.1.0"}


def mf(**over) -> dict:
    return {**BASE, **over}


def bad(data: dict, fragment: str) -> None:
    with pytest.raises(ExtensionError, match=fragment):
        parse_manifest(data, where="test")


# ---- 命名空間 ----


def test_id_cannot_shadow_a_builtin_namespace() -> None:
    """否則 `data.set` 的意義會取決於使用者裝了什麼包（§4.4）。"""
    bad(mf(id="data"), "內建命名空間")


def test_id_must_be_an_identifier() -> None:
    bad(mf(id="My-Pack"), "小寫識別字")


def test_opcode_must_not_carry_the_namespace() -> None:
    bad(
        mf(palette=[{"opcode": "demo2.echo", "type": "reporter", "text": "x"}]),
        "不含命名空間前綴",
    )


def test_duplicate_opcode() -> None:
    b = {"opcode": "echo", "type": "reporter", "text": "x"}
    bad(mf(palette=[b, dict(b)]), "opcode 重複")


# ---- 積木宣告的內部一致性 ----


def test_text_placeholder_without_an_arg() -> None:
    """`%(message)` 沒有對應參數 = 前端渲染時會少一個孔。"""
    bad(
        mf(palette=[{"opcode": "send", "type": "command", "text": "送出 %(message)"}]),
        r"%\(message\) 沒有對應的參數",
    )


def test_command_cannot_declare_returns() -> None:
    bad(
        mf(palette=[{"opcode": "go", "type": "command", "text": "go", "returns": "object"}]),
        "不會回傳值",
    )


def test_dropdown_arg_needs_a_source() -> None:
    bad(
        mf(palette=[{
            "opcode": "pick", "type": "reporter", "text": "挑 %(x)",
            "args": {"x": {"type": "dropdown"}},
        }]),
        "必須宣告 source",
    )


def test_min_max_only_on_numbers() -> None:
    bad(
        mf(palette=[{
            "opcode": "pick", "type": "reporter", "text": "挑 %(x)",
            "args": {"x": {"type": "string", "max": 3}},
        }]),
        "只適用於 number",
    )


def test_yields_only_on_hat() -> None:
    bad(
        mf(palette=[{
            "opcode": "go", "type": "command", "text": "go",
            "yields": [{"name": "x"}],
        }]),
        "只適用於 hat",
    )


def test_unknown_field_is_rejected() -> None:
    """打錯的欄位靜靜被忽略，等同於那行宣告沒寫。"""
    bad(mf(colour="#fff"), "colour")


# ---- 語意細節 ----


def test_absent_default_differs_from_explicit_null() -> None:
    """「沒寫 default」是必填，`default: null` 是預設值為 null。"""
    m = parse_manifest(
        mf(palette=[{
            "opcode": "go", "type": "command", "text": "go %(a) %(b)",
            "args": {"a": {"type": "string"}, "b": {"type": "string", "default": None}},
        }]),
        where="test",
    )
    args = m.blocks[0].args
    assert not args["a"].has_default
    assert args["b"].has_default


def test_interpolate_defaults_follow_section_4_7() -> None:
    """string 預設開插值、code 預設關——shell 指令裡的 `${HOME}` 不該被替換。"""
    m = parse_manifest(
        mf(palette=[{
            "opcode": "go", "type": "command", "text": "go %(a) %(b) %(c)",
            "args": {
                "a": {"type": "string"},
                "b": {"type": "code"},
                "c": {"type": "code", "interpolate": True},
            },
        }]),
        where="test",
    )
    args = m.blocks[0].args
    assert (args["a"].interpolates, args["b"].interpolates, args["c"].interpolates) == (
        True, False, True
    )


def test_boolean_block_declares_its_return_by_its_shape() -> None:
    m = parse_manifest(
        mf(palette=[{"opcode": "ok", "type": "boolean", "text": "ok"}]), where="test"
    )
    assert m.blocks[0].declared_return == "boolean"


# ---- 磁碟 ----


def test_demo_pack_is_valid() -> None:
    sources = discover(BUNDLED_ROOT)
    assert "demo" in sources
    assert isinstance(sources["demo"].manifest, Manifest)


def test_default_locale_is_backward_compatible() -> None:
    assert parse_manifest(mf(), where="test").defaultLocale == "zh-TW"


def test_locale_overlay_is_loaded_and_validated(tmp_path) -> None:
    manifest = parse_manifest(mf(
        description="描述",
        palette=[{
            "opcode": "say", "type": "command", "text": "說 %(text)",
            "args": {"text": {"type": "string", "label": "文字"}},
        }],
    ), where="test")
    root = tmp_path / "locales"
    root.mkdir()
    (root / "en.yaml").write_text(
        "name: Demo\ndescription: Description\nblocks:\n  say:\n    text: 'say %(text)'\n"
        "    args:\n      text: {label: Text}\n",
        encoding="utf-8",
    )
    locales, warnings = load_locales(tmp_path, manifest)
    assert locales["en"]["blocks"]["say"]["text"] == "say %(text)"
    assert warnings == ()


def test_bad_locale_is_ignored_at_runtime_but_fails_strict_check(tmp_path) -> None:
    manifest = parse_manifest(mf(palette=[{
        "opcode": "say", "type": "command", "text": "說 %(text)",
        "args": {"text": {"type": "string"}},
    }]), where="test")
    root = tmp_path / "locales"
    root.mkdir()
    (root / "en.yaml").write_text("blocks:\n  say:\n    text: say\n", encoding="utf-8")
    locales, warnings = load_locales(tmp_path, manifest)
    assert locales == {}
    assert "placeholder" in warnings[0]
    with pytest.raises(ExtensionError, match="placeholder"):
        load_locales(tmp_path, manifest, strict=True)


def assert_problem(root, dirname: str, match: str) -> None:
    """這個包讀不進來，而且**其他包不受影響**（P3 第 2 步）。

    這幾條規則一個字都沒有變，變的是它們怎麼被回報：`discover()` 原本整批拋，
    於是一份手滑的 manifest 就讓 `GET /api/extensions` 回 500。現在壞的那個
    走 `scan().problems`，由 `GET /api/extensions/problems` 端到擴充功能面板上。
    """
    found = scan(root)
    assert dirname not in found.sources
    assert [p.dir for p in found.problems] == [dirname]
    assert match in found.problems[0].message


def test_directory_name_must_match_the_id(tmp_path) -> None:
    """專案 IR 只記 id；若目錄名可以不同，「這顆積木是誰提供的」就不好回答。"""
    d = tmp_path / "notdemo"
    d.mkdir()
    (d / "manifest.yaml").write_text(
        "manifestVersion: 1\nid: demo\nname: x\nversion: 0.1.0\n", encoding="utf-8"
    )
    assert_problem(tmp_path, "notdemo", "不一致")


# ---- 內建與積木包的界線（D21）----
#
# 內建與積木包共用同一個 `Manifest` 模型，差別只有 `builtin` 這個旗標。這一組
# 題目守的是那條界線：**共用模型不等於共用權限**。


def test_a_pack_cannot_call_itself_builtin(tmp_path) -> None:
    """否則寫一行 `builtin: true` 就能改寫 `data.set` 的意思。"""
    d = tmp_path / "sneaky"
    d.mkdir()
    (d / "manifest.yaml").write_text(
        "manifestVersion: 1\nid: sneaky\nname: x\nversion: 0.1.0\nbuiltin: true\n",
        encoding="utf-8",
    )
    assert_problem(tmp_path, "sneaky", "不能標記 builtin")


def test_builtin_id_must_be_a_builtin_namespace() -> None:
    bad(mf(id="whatever", builtin=True), "不是內建命名空間")


def test_builtin_cannot_declare_dependencies() -> None:
    """內建沒有 `main.py`，沒有東西可以裝、也沒有邊界可以守。"""
    bad(mf(id="data", builtin=True, requirements=["httpx"]), "不能宣告 requirements")
    assert "permissions" not in parse_manifest(mf(id="data", builtin=True, permissions=["net"]), where="test").model_dump()


def test_packs_cannot_declare_builtin_only_arg_types() -> None:
    """`variable` 綁的是變數、`stack` 是 C 型積木——兩者都沒有值能過 §7.5 的邊界。

    `expression`（§4.7b）擋的理由不同但同樣硬：那個欄位是一套**語言**，開放給
    積木包等於讓每個包各自定義一套算式語法，而使用者只會看到「都是運算式，
    為什麼這裡能寫那裡不能」。
    """
    for arg_type in ("variable", "stack", "expression"):
        bad(
            mf(palette=[{
                "opcode": "go", "type": "command", "text": "go",
                "args": {"x": {"type": arg_type}},
            }]),
            f"不能宣告 {arg_type} 型參數",
        )


# ---- D32：hat 的 `yields` 由使用者命名 ----


def hat(**over) -> dict:
    """一顆宣告了「訊息變數」那一格的 hat。"""
    return mf(palette=[{
        "opcode": "on_message",
        "type": "hat",
        "text": "當收到訊息 %(message)",
        "args": {"message": {"type": "variable", "binds": True, "default": "message", **over}},
        "yields": [{"name": "message", "type": "object"}],
    }])


def test_a_pack_may_let_the_user_name_a_yield() -> None:
    """§7.5 邊界上唯一的窄門（D32）。

    它剛好不碰那條邊界：這一格的值從不送給積木包（`start_trigger` 不吃參數），
    它只決定 host 把 yield 綁成哪個名字。而那個名字原本是**積木包作者**取的，
    於是使用者的全域變數 `content` 會在那顆帽子底下靜靜地變成別的東西（§4.5）。
    """
    m = parse_manifest(hat(), where="test")
    spec = m.block("on_message")
    assert spec is not None
    assert spec.binds_a_yield("message")
    assert spec.yield_bindings({"message": "訊息"}) == {"message": "訊息"}
    # 空的那一格退回宣告的名字：一顆剛拉出來的積木照樣有東西可以綁
    assert spec.yield_bindings({"message": ""}) == {"message": "message"}


def test_a_hat_binding_must_point_at_a_yield() -> None:
    """指不到任何 yield 的話，這一格建立的是一個**永遠沒有值**的名字——畫布上
    讀它一律是未知變數，而積木上看起來一切正常。"""
    broken = hat()
    broken["palette"][0]["yields"] = [{"name": "content", "type": "string"}]
    bad(broken, "不在 yields 裡")


def test_a_hat_binding_cannot_declare_a_scope() -> None:
    """範圍已經由那顆 hat 的 body 說完了（D29：hat 的 body 是整條腳本）。"""
    bad(hat(scope="frame"), "不能再宣告 scope")


def test_a_pack_still_cannot_name_a_yield_on_a_command() -> None:
    """窄門只對 hat 開。`yields` 本來就只有 hat 有，所以一顆 command 上的
    `type: variable` 仍然是在邊界上開洞。"""
    bad(
        mf(palette=[{
            "opcode": "go", "type": "command", "text": "跑 %(name)",
            "args": {"name": {"type": "variable", "binds": True}},
        }]),
        "不能宣告 variable 型參數",
    )


def test_packs_cannot_declare_fields_or_static_dropdowns() -> None:
    """積木包的參數一律是輸入孔；下拉一律是動態的（選項來自外部服務）。"""
    bad(
        mf(palette=[{
            "opcode": "go", "type": "command", "text": "go %(x)",
            "args": {"x": {"type": "string", "field": True}},
        }]),
        "不能是 field",
    )
    bad(
        mf(palette=[{
            "opcode": "go", "type": "command", "text": "go %(x)",
            "args": {"x": {"type": "dropdown", "options": ["a", "b"]}},
        }]),
        "請用 source",
    )


def test_packs_cannot_declare_dynamic_blocks() -> None:
    """dynamic 積木由專案資料生成（§4.6 的函式），只有內建有。"""
    bad(
        mf(palette=[{"opcode": "go", "type": "reporter", "text": "go", "dynamic": True}]),
        "只有內建有",
    )


def test_terminal_only_applies_to_command() -> None:
    """cap block 是 command 的修飾，不是第五種形狀（§4.6）。

    reporter 沒有 `next` 可以擋，hat 標成 terminal 等於宣告一顆永遠跑不到
    body 的帽子——兩者都是宣告寫錯了，該在載入積木包時就說。
    """
    bad(
        mf(palette=[{"opcode": "go", "type": "reporter", "text": "go", "terminal": True}]),
        "terminal 只適用於 command",
    )


def test_packs_may_declare_terminal_blocks() -> None:
    """`terminal` **不在**內建專屬名單裡：它不碰 §7.5 的邊界（§4.6）。"""
    manifest = parse_manifest(
        mf(palette=[{"opcode": "halt", "type": "command", "text": "結束", "terminal": True}]),
        where="test",
    )
    assert manifest.block("halt").terminal is True


def test_section_is_an_entry_of_its_own() -> None:
    """`section` 是 palette 裡的一個條目：字串多一行標題，`True` 只斷開（§8.1）。"""
    manifest = parse_manifest(
        mf(palette=[
            {"section": "比較"},
            {"opcode": "a", "type": "command", "text": "a"},
            {"section": True},
            {"opcode": "b", "type": "command", "text": "b"},
        ]),
        where="test",
    )
    assert [type(e).__name__ for e in manifest.palette] == [
        "SectionSpec", "BlockSpec", "SectionSpec", "BlockSpec",
    ]
    assert manifest.palette[0].title == "比較"
    assert manifest.palette[2].title is None
    # 導出的 view 只有積木——直譯器與 validator 看到的是這一份。
    assert [b.opcode for b in manifest.blocks] == ["a", "b"]


def test_section_cannot_be_an_empty_string() -> None:
    """空字串是「我想要斷開但不想寫標題」寫錯了，而它畫出來是一行看不見的標題。"""
    bad(mf(palette=[{"section": "  "}]), "section: true")


def test_section_false_is_meaningless() -> None:
    """條目化之後 `section: false` 不再是「這顆積木不是段落開頭」，而是一個空條目。"""
    bad(mf(palette=[{"section": False}]), "沒有意義")


def test_a_section_before_a_deprecated_block_is_fine_now() -> None:
    """條目化**刪掉了一條規則**。

    `section` 掛在積木上的時候，「段落開頭是一顆不上架的積木」等於整段標題默默
    消失，所以載入期要擋。分段自己是一個條目之後，它跟哪顆積木上不上架無關——
    規則不是搬家，是不存在了。
    """
    m = parse_manifest(
        mf(palette=[
            {"section": "比較"},
            {"opcode": "a", "type": "command", "text": "a", "deprecated": True},
            {"opcode": "b", "type": "command", "text": "b"},
        ]),
        where="test",
    )
    assert m.palette[0].title == "比較"


def test_dropdown_needs_source_or_options() -> None:
    base = {"opcode": "go", "type": "command", "text": "go %(x)"}
    bad(mf(palette=[{**base, "args": {"x": {"type": "dropdown"}}}]), "source（動態）或 options")
    bad(
        mf(id="data", builtin=True, palette=[{
            **base, "args": {"x": {"type": "dropdown", "source": "s", "options": ["a"]}},
        }]),
        "只能擇一",
    )


def test_option_shorthand_expands_to_value_only() -> None:
    """`options: [upper, lower]` 是 `[{value: upper}, …]` 的簡寫。"""
    m = parse_manifest(
        mf(id="data", builtin=True, palette=[{
            "opcode": "go", "type": "command", "text": "go %(x)",
            "args": {"x": {"type": "dropdown", "field": True, "options": ["upper", {
                "value": "lower", "label": "小寫"}]}},
        }]),
        where="test",
    )
    opts = m.blocks[0].args["x"].options
    assert [(o.value, o.label) for o in opts] == [("upper", None), ("lower", "小寫")]


def test_expression_args_are_always_fields() -> None:
    """運算式是這顆積木自己的內容，不是可以被別的積木蓋掉的孔（§4.7b）。"""
    m = parse_manifest(
        mf(id="operator", builtin=True, palette=[{
            "opcode": "expr", "type": "reporter", "text": "運算 %(expr)",
            "args": {"expr": {"type": "expression", "default": "1 + 1"}},
        }]),
        where="test",
    )
    assert m.field_args("expr").keys() == {"expr"}
    assert m.input_args("expr") == {}


def test_variable_args_are_always_fields() -> None:
    """變數名稱不能由積木求值——它是積木自己的欄位（§4.2、§8.5）。"""
    m = parse_manifest(
        mf(id="data", builtin=True, palette=[{
            "opcode": "go", "type": "command", "text": "設定 %(name) 為 %(value)",
            "args": {"name": {"type": "variable"}, "value": {"type": "string"}},
        }]),
        where="test",
    )
    assert m.field_args("go").keys() == {"name"}
    assert m.input_args("go").keys() == {"value"}


# ---- 工具箱按鈕（D25、§7.2）----


def test_open_url_button_must_declare_a_url() -> None:
    bad(mf(palette=[{"button": "docs", "label": "說明", "action": "open_url"}]), "必須宣告 url")


def test_open_url_rejects_non_http_schemes() -> None:
    """`javascript:` 要擋在**宣告層**。

    前端拿到這個字串是要交給瀏覽器開的，所以一個包就能靠它在編輯器裡跑任意
    程式碼——而那正是 D25 (c)「積木包不得自帶前端程式碼」明文封死的東西。
    擋在這裡而不是前端：宣告層擋得住的東西，不該指望每個消費端都記得擋。
    """
    bad(
        mf(palette=[{
            "button": "x", "label": "點我", "action": "open_url",
            "url": "javascript:alert(1)",
        }]),
        "只能是 http",
    )


def test_open_url_accepts_an_internal_docs_path() -> None:
    m = parse_manifest(
        mf(palette=[{
            "button": "docs",
            "label": "How to setup bot token",
            "action": "open_url",
            "url": "/docs/discord/",
        }]),
        where="test",
    )
    assert m.buttons[0].url == "/docs/discord/"


def test_open_url_rejects_other_internal_paths() -> None:
    bad(
        mf(palette=[{
            "button": "x", "label": "點我", "action": "open_url", "url": "/api/keys",
        }]),
        "站內 /docs/",
    )


def test_call_button_must_declare_a_handler() -> None:
    bad(mf(palette=[{"button": "t", "label": "測試", "action": "call"}]), "必須宣告 handler")


def test_button_fields_belong_to_one_action_only() -> None:
    bad(
        mf(palette=[{"button": "t", "label": "測試", "action": "open_config", "url": "https://x"}]),
        "只有 open_url",
    )
    bad(
        mf(palette=[{"button": "t", "label": "測試", "action": "open_config", "handler": "go"}]),
        "只有 call",
    )


def test_duplicate_button_id() -> None:
    b = {"button": "docs", "label": "說明", "action": "open_config"}
    bad(mf(palette=[b, dict(b)]), "按鈕 id 重複")


# ---- palette：一份清單、三種條目（§7.2）----


def test_palette_keeps_the_order_and_splits_into_views() -> None:
    """寫的人只寫一次，讀的人各拿各的 view。"""
    m = parse_manifest(
        mf(palette=[
            {"opcode": "a", "type": "command", "text": "a"},
            {"button": "docs", "label": "說明", "action": "open_config"},
            {"button": "test", "label": "測試", "action": "open_config"},
            {"section": "工具"},
            {"opcode": "b", "type": "command", "text": "b"},
        ]),
        where="test",
    )
    # 順序是版面（工具箱照著畫）
    assert [type(e).__name__ for e in m.palette] == [
        "BlockSpec", "ButtonSpec", "ButtonSpec", "SectionSpec", "BlockSpec",
    ]
    # view 是宣告（直譯器、validator、題庫看這兩份）
    assert [b.opcode for b in m.blocks] == ["a", "b"]
    assert [b.id for b in m.buttons] == ["docs", "test"]


def test_unknown_entry_kind_says_which_key_is_missing() -> None:
    """沒有這句話的話，union 比對不中時會把三種條目的錯誤全部列出來。"""
    bad(mf(palette=[{"label": "?", "action": "open_config"}]), "認不出種類")


def test_button_key_is_also_its_id() -> None:
    m = parse_manifest(
        mf(palette=[{"button": "docs", "label": "說明", "action": "open_config"}]),
        where="test",
    )
    assert m.buttons[0].button == "docs"
    assert m.buttons[0].id == "docs"


def test_packs_cannot_open_the_editors_own_dialogs() -> None:
    """`create_procedure` 開的是編輯器自己的對話框（§8.5），不屬於任何積木包。

    這條與 `variable` / `stack` / `dynamic` 是同一條線（D22）：同一個模型，
    一條載入期的權限線——而不是為內建另立一套 schema。
    """
    bad(
        mf(palette=[{"button": "create", "label": "創建積木", "action": "create_procedure"}]),
        "只有內建能宣告",
    )


# ---- 封面（§8.1、D31）----
#
# `cover` 與 `PanelSpec.entry` 是同一件事的兩個入口：manifest 說一個檔名，後端
# 把 bytes 交給瀏覽器。所以路徑規則共用一段（`_inside_pack`），而這幾題是那段
# 在 `cover` 這一側也接上了的證據。


def test_cover_only_takes_images() -> None:
    """`<img>` 是它唯一的用途，所以白名單比面板 asset 的還窄。"""
    bad(mf(cover="preview.html"), "封面只收")
    bad(mf(cover="preview.svg"), "封面只收")


def test_cover_cannot_escape_the_pack() -> None:
    bad(mf(cover="../../etc/x.png"), "跳出包目錄")
    bad(mf(cover="/etc/x.png"), "相對路徑")


def test_cover_is_optional() -> None:
    """沒宣告不是錯——那格畫名字的第一個字，那條路本來就在。"""
    assert parse_manifest(mf(), where="test").cover is None


def test_declared_cover_must_exist(tmp_path) -> None:
    """載入期就要說。不然症狀是擴充功能面板上一格破圖，而破圖說不出它是
    「還沒放」還是「路徑打錯了」。"""
    import yaml

    d = tmp_path / "demo2"
    d.mkdir()
    (d / "manifest.yaml").write_text(yaml.safe_dump(mf(cover="preview.png")))
    (d / "main.py").write_text("")

    assert_problem(tmp_path, "demo2", "找不到封面")

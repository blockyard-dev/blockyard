"""manifest 的驗證（§7.2）。

這些題目全部是「manifest 寫錯了」而不是「執行期出錯」。它們該在載入積木包
時就爆，因為漂移的症狀——工具箱裡一顆按了沒反應的積木——要等到使用者真的
拖出來用才會被發現。§11 的 AI 生成積木包更是完全靠這一層兜底。
"""

from __future__ import annotations

import pytest

from blocky.errors import ExtensionError
from blocky.extensions import DEFAULT_EXTENSIONS_ROOT, Manifest, discover, parse_manifest

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
        mf(blocks=[{"opcode": "demo2.echo", "type": "reporter", "text": "x"}]),
        "不含命名空間前綴",
    )


def test_duplicate_opcode() -> None:
    b = {"opcode": "echo", "type": "reporter", "text": "x"}
    bad(mf(blocks=[b, dict(b)]), "opcode 重複")


# ---- 積木宣告的內部一致性 ----


def test_text_placeholder_without_an_arg() -> None:
    """`%(message)` 沒有對應參數 = 前端渲染時會少一個孔。"""
    bad(
        mf(blocks=[{"opcode": "send", "type": "command", "text": "送出 %(message)"}]),
        r"%\(message\) 沒有對應的參數",
    )


def test_command_cannot_declare_returns() -> None:
    bad(
        mf(blocks=[{"opcode": "go", "type": "command", "text": "go", "returns": "object"}]),
        "不會回傳值",
    )


def test_dropdown_arg_needs_a_source() -> None:
    bad(
        mf(blocks=[{
            "opcode": "pick", "type": "reporter", "text": "挑 %(x)",
            "args": {"x": {"type": "dropdown"}},
        }]),
        "必須宣告 source",
    )


def test_min_max_only_on_numbers() -> None:
    bad(
        mf(blocks=[{
            "opcode": "pick", "type": "reporter", "text": "挑 %(x)",
            "args": {"x": {"type": "string", "max": 3}},
        }]),
        "只適用於 number",
    )


def test_yields_only_on_hat() -> None:
    bad(
        mf(blocks=[{
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
        mf(blocks=[{
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
        mf(blocks=[{
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
        mf(blocks=[{"opcode": "ok", "type": "boolean", "text": "ok"}]), where="test"
    )
    assert m.blocks[0].declared_return == "boolean"


# ---- 磁碟 ----


def test_demo_pack_is_valid() -> None:
    sources = discover(DEFAULT_EXTENSIONS_ROOT)
    assert "demo" in sources
    assert isinstance(sources["demo"].manifest, Manifest)


def test_directory_name_must_match_the_id(tmp_path) -> None:
    """專案 IR 只記 id；若目錄名可以不同，「這顆積木是誰提供的」就不好回答。"""
    d = tmp_path / "notdemo"
    d.mkdir()
    (d / "manifest.yaml").write_text(
        "manifestVersion: 1\nid: demo\nname: x\nversion: 0.1.0\n", encoding="utf-8"
    )
    with pytest.raises(ExtensionError, match="不一致"):
        discover(tmp_path)


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
    with pytest.raises(ExtensionError, match="不能標記 builtin"):
        discover(tmp_path)


def test_builtin_id_must_be_a_builtin_namespace() -> None:
    bad(mf(id="whatever", builtin=True), "不是內建命名空間")


def test_builtin_cannot_declare_dependencies() -> None:
    """內建沒有 `main.py`，沒有東西可以裝、也沒有邊界可以守。"""
    bad(mf(id="data", builtin=True, requirements=["httpx"]), "不能宣告 requirements")
    bad(mf(id="data", builtin=True, permissions=["net"]), "不能宣告 requirements")


def test_packs_cannot_declare_builtin_only_arg_types() -> None:
    """`variable` 綁的是變數、`stack` 是 C 型積木——兩者都沒有值能過 §7.5 的邊界。

    `expression`（§4.7b）擋的理由不同但同樣硬：那個欄位是一套**語言**，開放給
    積木包等於讓每個包各自定義一套算式語法，而使用者只會看到「都是運算式，
    為什麼這裡能寫那裡不能」。
    """
    for arg_type in ("variable", "stack", "expression"):
        bad(
            mf(blocks=[{
                "opcode": "go", "type": "command", "text": "go",
                "args": {"x": {"type": arg_type}},
            }]),
            f"不能宣告 {arg_type} 型參數",
        )


def test_packs_cannot_declare_fields_or_static_dropdowns() -> None:
    """積木包的參數一律是輸入孔；下拉一律是動態的（選項來自外部服務）。"""
    bad(
        mf(blocks=[{
            "opcode": "go", "type": "command", "text": "go %(x)",
            "args": {"x": {"type": "string", "field": True}},
        }]),
        "不能是 field",
    )
    bad(
        mf(blocks=[{
            "opcode": "go", "type": "command", "text": "go %(x)",
            "args": {"x": {"type": "dropdown", "options": ["a", "b"]}},
        }]),
        "請用 source",
    )


def test_packs_cannot_declare_dynamic_blocks() -> None:
    """dynamic 積木由專案資料生成（§4.6 的函式），只有內建有。"""
    bad(
        mf(blocks=[{"opcode": "go", "type": "reporter", "text": "go", "dynamic": True}]),
        "只有內建有",
    )


def test_dropdown_needs_source_or_options() -> None:
    base = {"opcode": "go", "type": "command", "text": "go %(x)"}
    bad(mf(blocks=[{**base, "args": {"x": {"type": "dropdown"}}}]), "source（動態）或 options")
    bad(
        mf(id="data", builtin=True, blocks=[{
            **base, "args": {"x": {"type": "dropdown", "source": "s", "options": ["a"]}},
        }]),
        "只能擇一",
    )


def test_option_shorthand_expands_to_value_only() -> None:
    """`options: [upper, lower]` 是 `[{value: upper}, …]` 的簡寫。"""
    m = parse_manifest(
        mf(id="data", builtin=True, blocks=[{
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
        mf(id="operator", builtin=True, blocks=[{
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
        mf(id="data", builtin=True, blocks=[{
            "opcode": "go", "type": "command", "text": "設定 %(name) 為 %(value)",
            "args": {"name": {"type": "variable"}, "value": {"type": "string"}},
        }]),
        where="test",
    )
    assert m.field_args("go").keys() == {"name"}
    assert m.input_args("go").keys() == {"value"}

"""可重複參數群組（§16 Q19，P2）。"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from blockyard.errors import ValidationError
from blockyard.extensions.manifest import BlockSpec
from blockyard.interpreter import declarations
from blockyard.repeat import count_of, validate_blocks


def spec(**over: Any) -> BlockSpec:
    base: dict[str, Any] = {
        "opcode": "demo",
        "type": "command",
        "text": "如果 %(condition) 那麼",
        "args": {"condition": {"type": "boolean"}, "then": {"type": "stack"}},
        "repeat": {
            "label": "否則如果 %(condition) 那麼",
            "args": {"condition": {"type": "boolean"}, "body": {"type": "stack"}},
        },
    }
    base.update(over)
    return BlockSpec.model_validate(base)


CATCH_SPEC: dict[str, Any] = {
    "opcode": "multi_catch",
    "type": "command",
    "text": "嘗試 %(try)",
    "args": {"try": {"type": "stack"}},
    "repeat": {
        "label": "出錯時把錯誤存進 %(error_name)",
        "args": {
            "error_name": {"type": "variable", "binds": True, "scope": "catch"},
            "catch": {"type": "stack"},
        },
    },
}


# --------------------------------------------------------------------------
# 宣告
# --------------------------------------------------------------------------


def test_expanded_names_start_at_one() -> None:
    """基底那一份不編號——它本來就在 `args` 裡，而且是沒按過 `+` 時的樣子。
    所以編號從 1 開始不是選擇，是那件事的直接後果。"""
    s = spec()
    assert s.repeat_arg_name("condition", 0) == "condition_1"
    assert sorted(s.repeat_args(2)) == [
        "body_1",
        "body_2",
        "condition",
        "condition_1",
        "condition_2",
        "then",
    ]


def test_expanding_does_not_mutate_the_declaration() -> None:
    """宣告是共用的：一顆積木按了 `+` 不能改變別顆積木長什麼樣。"""
    s = spec()
    s.repeat_args(3)
    assert sorted(s.args) == ["condition", "then"]


def test_a_repeat_arg_that_collides_is_rejected() -> None:
    """展開之後 `condition_1` 到底是群組的第 1 份還是作者自己寫的那一格，
    只有作者知道——而 IR 讀不出來。擋在宣告期最便宜。"""
    with pytest.raises(ValueError, match="撞名"):
        spec(args={"condition": {"type": "boolean"}, "condition_1": {"type": "string"}})


def test_a_hat_cannot_repeat() -> None:
    """一顆事件積木沒有「多來一份」的意思。"""
    with pytest.raises(ValueError, match="hat"):
        spec(type="hat", returns=None)


def test_the_label_must_reference_declared_args() -> None:
    with pytest.raises(ValueError, match="沒有對應的參數"):
        spec(repeat={"label": "否則如果 %(nope) 那麼", "args": {"condition": {"type": "boolean"}}})


def test_an_empty_repeat_group_is_rejected() -> None:
    with pytest.raises(ValueError, match="不能是空的"):
        spec(repeat={"label": "又一份", "args": {}})


# --------------------------------------------------------------------------
# 讀份數
# --------------------------------------------------------------------------


def test_count_of_is_quiet_when_there_is_nothing_to_read() -> None:
    """執行期讀一個沒宣告 `repeat` 的積木應該安靜地是 0，不是拋錯——那顆積木
    根本沒有這個概念。"""
    assert count_of(None, spec()) == 0
    assert count_of({}, spec()) == 0
    assert count_of({"repeat": 2}, None) == 0
    assert count_of({"repeat": 2}, spec(repeat=None)) == 0


@pytest.mark.parametrize("raw", ["2", 2.5, -1, True, None])
def test_count_of_ignores_junk(raw: Any) -> None:
    assert count_of({"repeat": raw}, spec()) == 0


def test_count_of_clamps_to_the_declared_max() -> None:
    assert count_of({"repeat": 9999}, spec()) == 20


# --------------------------------------------------------------------------
# 存檔驗證
# --------------------------------------------------------------------------


def resolve(_: str) -> BlockSpec | None:
    return spec()


def test_a_block_without_repeat_may_not_carry_one() -> None:
    """多半是手寫 IR 或別的版本產生的。放行的話那個數字永遠不會有人讀，
    而使用者以為他設了什麼。"""
    with pytest.raises(ValidationError, match="沒有可重複"):
        validate_blocks({"b": {"opcode": "x", "mutation": {"repeat": 1}}}, lambda _: None)


def test_a_count_beyond_the_max_is_rejected() -> None:
    with pytest.raises(ValidationError, match="不在宣告的"):
        validate_blocks({"b": {"opcode": "x", "mutation": {"repeat": 999}}}, resolve)


def test_a_missing_socket_is_rejected() -> None:
    """**這一條最要緊。** 少的那一格在執行期是「沒填」，而 `如果` 少了條件會
    安靜地走 false 那一邊——一個看不出來的錯。"""
    with pytest.raises(ValidationError, match="少了 body"):
        validate_blocks(
            {
                "b": {
                    "opcode": "x",
                    "mutation": {"repeat": 1},
                    "inputs": {"condition_1": {"kind": "block", "id": "c"}},
                }
            },
            resolve,
        )


def test_a_complete_block_passes() -> None:
    validate_blocks(
        {
            "b": {
                "opcode": "x",
                "mutation": {"repeat": 1},
                "inputs": {
                    "condition_1": {"kind": "block", "id": "c"},
                    "body_1": {"kind": "stack", "id": "s"},
                },
            }
        },
        resolve,
    )


def test_zero_is_always_fine() -> None:
    validate_blocks({"b": {"opcode": "x", "mutation": None}}, resolve)
    validate_blocks({"b": {"opcode": "x"}}, resolve)


# --------------------------------------------------------------------------
# 端到端：`如果⋯否則如果`
# --------------------------------------------------------------------------


def test_if_else_declares_a_repeat_group() -> None:
    """§16 Q19 的第一個消費者。"""
    s = declarations.block("control.if_else")
    assert s is not None and s.repeat is not None
    assert sorted(s.repeat.args) == ["body", "condition"]


def chain_project(*, repeat: int, complete: bool = True) -> dict[str, Any]:
    blocks: dict[str, Any] = {
        "hat": {"opcode": "event.when_flag_clicked", "next": "if"},
        "if": {
            "opcode": "control.if_else",
            "parent": "hat",
            "mutation": {"repeat": repeat},
            "inputs": {"condition": {"kind": "block", "id": "c0"}},
        },
        "c0": {"opcode": "operator.false", "parent": "if"},
    }
    for i in range(1, repeat + 1):
        blocks["if"]["inputs"][f"condition_{i}"] = {"kind": "block", "id": f"c{i}"}
        blocks[f"c{i}"] = {"opcode": "operator.true", "parent": "if"}
        if complete:
            blocks["if"]["inputs"][f"body_{i}"] = {"kind": "stack", "id": f"b{i}"}
            blocks[f"b{i}"] = {
                "opcode": "debug.log",
                "parent": "if",
                "inputs": {"text": {"kind": "literal", "value": str(i)}},
            }
    return {
        "formatVersion": 1,
        "meta": {"id": "p1", "name": "鏈"},
        "scripts": [{"id": "sc_1", "top": "hat"}],
        "blocks": blocks,
    }


@pytest.fixture
def client(tmp_path: Any) -> Any:
    from blockyard.api.app import create_app
    from blockyard.extensions import BUNDLED_ROOT

    app = create_app(db_path=tmp_path / "blockyard.db", extensions_root=BUNDLED_ROOT)
    with TestClient(app) as c:
        yield c


def test_a_chain_saves(client: TestClient) -> None:
    assert client.put("/api/projects/p1", json=chain_project(repeat=2)).status_code in (200, 201)


def test_a_chain_with_a_missing_socket_is_422(client: TestClient) -> None:
    res = client.put("/api/projects/p1", json=chain_project(repeat=1, complete=False))
    assert res.status_code == 422
    assert res.json()["detail"]["blockId"] == "if"


# --------------------------------------------------------------------------
# D29 × Q19：範圍不能跨出自己那一份
# --------------------------------------------------------------------------


def test_scope_is_renumbered_with_its_own_copy() -> None:
    """第 2 份 catch 綁的名字，範圍是**第 2 份**那一疊。

    原樣搬過來的話它會宣稱自己在第 1 份 catch 裡有效——存檔期於是擋錯一顆積木、
    放行另一顆，而畫面上那兩顆長得一模一樣。
    """
    args = BlockSpec.model_validate(CATCH_SPEC).repeat_args(2)
    assert args["error_name_1"].scope == "catch_1"
    assert args["error_name_2"].scope == "catch_2"
    # 宣告是共用的：展開一次不能改到別顆積木看到的那一份
    assert BlockSpec.model_validate(CATCH_SPEC).repeat.args["error_name"].scope == "catch"


def test_a_group_scope_must_stay_inside_its_group() -> None:
    bad = {**CATCH_SPEC, "args": {"try": {"type": "stack"}, "base": {"type": "stack"}}}
    bad["repeat"] = {
        **CATCH_SPEC["repeat"],
        "args": {
            "error_name": {"type": "variable", "binds": True, "scope": "base"},
            "catch": {"type": "stack"},
        },
    }
    with pytest.raises(ValueError, match="不能跨出自己那一份"):
        BlockSpec.model_validate(bad)


def test_a_base_scope_must_not_point_into_the_group() -> None:
    """那一疊在份數是 0 的時候根本不存在。"""
    bad = {
        **CATCH_SPEC,
        "args": {
            "try": {"type": "stack"},
            "name": {"type": "variable", "binds": True, "scope": "catch"},
        },
    }
    with pytest.raises(ValueError, match="份數是 0 的時候不存在"):
        BlockSpec.model_validate(bad)

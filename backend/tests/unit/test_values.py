"""§4.3 轉換表的逐格覆蓋，含每一個錯誤情況（§17.4）。"""

from __future__ import annotations

import pytest

from blockyard.errors import BadIndexError, TypeCoercionError
from blockyard.ir.values import (
    can_cast,
    is_empty,
    is_type,
    js_number_to_string,
    normalize_index,
    to_boolean,
    to_number,
    to_string,
    type_of,
)


@pytest.mark.parametrize(
    "value,expected",
    [
        (5.0, "5"), (5, "5"), (100.0, "100"), (0.5, "0.5"), (-0.0, "0"),
        (0.1 + 0.2, "0.30000000000000004"), (1 / 3, "0.3333333333333333"),
        (1e21, "1e+21"), (1e-7, "1e-7"), (1e-6, "0.000001"),
        (2**53, "9007199254740992"), (1.5e300, "1.5e+300"), (9.5e-8, "9.5e-8"),
    ],
)
def test_number_stringification_matches_js(value, expected):
    """D15：字串化跟隨 JS `Number.prototype.toString`，不是 Python 的 str()。"""
    assert js_number_to_string(value) == expected


@pytest.mark.parametrize(
    "value,expected",
    [(None, "null"), (True, "boolean"), (5, "number"), (5.5, "number"),
     ("x", "string"), ([], "list"), ({}, "object")],
)
def test_type_of(value, expected):
    assert type_of(value) == expected


def test_list_and_object_are_distinct_and_null_is_its_own_type():
    """§4.8 的兩個違反 JS 直覺之處。"""
    assert is_type([], "list") and not is_type([], "object")
    assert is_type(None, "null") and not is_type(None, "object")


@pytest.mark.parametrize(
    "value,expected",
    [(None, ""), (True, "true"), (False, "false"), (5.0, "5"),
     ([1, 2], "[1,2]"), ({"a": 1}, '{"a":1}'), ("x", "x")],
)
def test_to_string_table(value, expected):
    assert to_string(value) == expected


@pytest.mark.parametrize(
    "value,expected",
    [("12", 12), ("1.5", 1.5), ("  7 ", 7), ("", 0), (True, 1), (False, 0), (None, 0)],
)
def test_to_number_table(value, expected):
    assert to_number(value) == expected


@pytest.mark.parametrize("value", ["abc", [], {}, "nan", "inf"])
def test_to_number_failures(value):
    with pytest.raises(TypeCoercionError):
        to_number(value)


@pytest.mark.parametrize(
    "value,expected",
    [(False, False), (0, False), ("", False), (None, False), ([], False), ({}, False),
     (True, True), (1, True), ("x", True), ([0], True), ({"a": 1}, True)],
)
def test_falsy_set(value, expected):
    assert to_boolean(value) is expected


def test_zero_is_falsy_but_not_empty():
    """§4.3 的刻意不一致——「數字 0 不是空的」才符合直覺。"""
    assert to_boolean(0) is False
    assert is_empty(0) is False


def test_can_cast_vs_is():
    """§4.8：這兩個問題天天用到，共用一顆積木使用者永遠猜不到答案是哪個。"""
    assert can_cast("123", "number") and not is_type("123", "number")
    assert not can_cast("abc", "number")
    # 清單／物件不能由其他型別「轉換」而來
    assert not can_cast("[]", "list")


@pytest.mark.parametrize("idx,expected", [(1, 0), (3, 2), (-1, 2), (-3, 0), ("last", 2), (1.0, 0)])
def test_normalize_index(idx, expected):
    assert normalize_index(idx, 3) == expected


def test_index_zero_has_dedicated_message():
    """1-based 用不到 0，那個位置正好空出來當「0-based 誤用」的偵測器。"""
    with pytest.raises(BadIndexError) as e:
        normalize_index(0, 3)
    assert "索引從 1 開始" in e.value.message
    assert "你是不是要 1" in (e.value.hint or "")


@pytest.mark.parametrize("idx", [4, -4, 1.5, "abc", True])
def test_index_errors(idx):
    with pytest.raises(BadIndexError):
        normalize_index(idx, 3)

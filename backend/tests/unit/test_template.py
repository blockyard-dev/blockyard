"""§4.7 插值的單元與 property test（§17.4）。"""

from __future__ import annotations

import pytest
from hypothesis import assume, given, settings
from hypothesis import strategies as st

from blocky.errors import BlockyError, ValidationError
from blocky.ir.template import evaluate, has_interpolation, parse, validate_name

DATA = {"i": 3, "items": [10, 20, 30], "o": {"a": {"b": "深"}}, "s": "文字"}
R = DATA.__getitem__


@pytest.mark.parametrize(
    "src,expected",
    [
        ("${i}", 3),                       # 整格取值保留型別
        ("${items}", [10, 20, 30]),
        ("第 ${i} 筆", "第 3 筆"),           # 有其他文字 → 拼接
        ("${items[1]}", 10),
        ("${items[-1]}", 30),
        ("${items[last]}", 30),
        ("${o.a.b}", "深"),
        ("$${x}", "${x}"),                 # 逸出
        ("$5 元", "$5 元"),                 # 裸 $ 不需逸出
        ("${i}${i}", "33"),
    ],
)
def test_evaluate(src, expected):
    assert evaluate(parse(src), R) == expected


@pytest.mark.parametrize(
    "src", ["${a + b}", "${count * 2}", "${x ? y : z}", "${upper(n)}", "${a - b}", "${a && b}"]
)
def test_expressions_rejected_at_parse_time(src):
    """D9：這條線要守得很硬。一旦允許算術，`${}` 會滑成一套迷你語言。"""
    with pytest.raises(ValidationError) as e:
        parse(src)
    assert "不支援運算" in str(e.value)


def test_bracket_negative_is_not_subtraction():
    """`items[-1]` 的負號不該被運算式偵測誤判——這是實作時真的踩到過的坑。"""
    assert evaluate(parse("${items[-1]}"), R) == 30


@pytest.mark.parametrize("src", ["${}", "${a", "${a[1}", "${a[x]}"])
def test_malformed_rejected(src):
    with pytest.raises(ValidationError):
        parse(src)


def test_string_attribute_error_suggests_parse_json():
    """§4.7 說這是「整份設計裡投入產出比最高的一行字」。"""
    with pytest.raises(BlockyError) as e:
        evaluate(parse("${s.foo}"), R)
    assert "是文字不是物件" in e.value.message
    assert "解析 JSON" in (e.value.hint or "")


@pytest.mark.parametrize("name", ["a.b", "a[1]", "a{b}", "a$b", " a", "a ", ""])
def test_forbidden_variable_names(name):
    with pytest.raises(ValidationError):
        validate_name(name)


@pytest.mark.parametrize("name", ["計數", "a b", "a_b", "a+b", "a-b", "數量2"])
def test_allowed_variable_names(name):
    """中文、空格、底線一律允許；`+ - * /` 不禁（§4.7）。"""
    validate_name(name)


# 排除會產生 ${ 的字元，讓策略專心測「純字面字串」這條路徑
_plain = st.text(alphabet=st.characters(blacklist_characters="${}[]\\"), max_size=40)


@given(_plain)
@settings(max_examples=200)
def test_plain_text_round_trips(s):
    """不含 ${} 的字串必須原樣輸出，且不被判定為 template。"""
    assert not has_interpolation(s)
    assert evaluate(parse(s), R) == s


@given(_plain, _plain)
@settings(max_examples=200)
def test_interpolation_is_concatenation(a, b):
    """`a${i}b` 的結果恆等於 a + "3" + b——**只要 a、b 不同時為空**。

    兩者皆空時整格就只剩一個插值，那條路徑走的是「回傳原值、保留型別」
    （§4.7），結果是數字 3 而不是字串 "3"。這個 assume 不是在迴避 bug，
    它就是規格本身。
    """
    assume(a != "" or b != "")
    src = f"{a}${{i}}{b}"
    assert evaluate(parse(src), R) == f"{a}3{b}"


@given(_plain)
@settings(max_examples=100)
def test_whole_field_keeps_type_regardless_of_padding(pad):
    """反過來的性質：只要有其他文字，就一定回字串。"""
    assume(pad != "")
    assert isinstance(evaluate(parse(f"{pad}${{items}}"), R), str)
    assert evaluate(parse("${items}"), R) == [10, 20, 30]

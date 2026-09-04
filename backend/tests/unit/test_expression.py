"""§4.7b 運算積木的文法（D23）。

三件事各有測試：**算得對**（優先序、結合律、單目負號）、**擋得住**（文法之外
的東西一律是存檔期錯誤）、**與積木一致**（`/` `%` 的邊界情況與
`operator.divide` / `operator.mod` 必須是同一個答案）。

第三組不是形式主義：兩份實作對 `-7 % 2` 或 `10 / 0` 給出不同答案時，畫面上
兩顆積木長得完全一樣，使用者查不出來。
"""

from __future__ import annotations

import pytest

from blockyard.errors import BlockyardError, TypeCoercionError, ValidationError
from blockyard.ir.expression import evaluate, parse
from blockyard.ir.values import divide, modulo

DATA = {"a": 10, "b": "4", "o": {"x": 3}, "l": [1, 2, 3], "s": "文字", "t": True}
R = DATA.__getitem__


def run(src: str):
    return evaluate(parse(src), R)


# --------------------------------------------------------------------------
# 算得對
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "src,expected",
    [
        ("1", 1),
        ("1.5", 1.5),
        ("1+2*3", 7),                     # 乘除先於加減
        ("(1+2)*3", 9),
        ("2*3+4*5", 26),
        ("10-3-2", 5),                    # 左結合：不是 10-(3-2)
        ("100/10/2", 5),
        ("10%3", 1),
        ("2*3%4", 2),                     # % 與 * 同一層，由左而右
        ("-3", -3),
        ("-3+5", 2),
        ("2*-3", -6),                     # 單目負號可以跟在運算子後面
        ("2--3", 5),
        ("+3", 3),
        ("-(2+3)", -5),
        ("((1))", 1),
        ("  1  +  2  ", 3),               # 空白隨便放
    ],
)
def test_arithmetic(src: str, expected) -> None:
    assert run(src) == expected


@pytest.mark.parametrize(
    "src,expected",
    [
        ("${a}", 10),
        ("${a}*2/4+1", 6),                # 使用者回報的那一條
        ("${o.x}*${l[2]}", 6),            # 路徑與 §4.7 完全相同
        ("${l[last]}+1", 4),
        ("${b}+1", 5),                    # 運算元走 §4.3 的 to_number："4" → 4
        ("${t}+1", 2),                    # true → 1
    ],
)
def test_operands(src: str, expected) -> None:
    assert run(src) == expected


def test_refs_are_collected_for_the_static_check() -> None:
    """§4.5 的「這個變數有沒有被 set 過」直接吃 refs，與 Template 同一個機制。"""
    expr = parse("${a} + ${o.x} * 2")
    assert [r.display() for r in expr.refs] == ["a", "o.x"]
    assert expr.roots == {"a", "o"}


# --------------------------------------------------------------------------
# 擋得住：文法之外的東西一律是**存檔期**錯誤
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "src",
    [
        "",                # 空的
        "   ",
        "1+",              # 缺運算元
        "*2",
        "(1+2",            # 括號沒收
        "1)",
        "1 2",             # 兩個運算元之間沒有運算子
        "${a}>2",          # 比較 → 拉積木
        "${a}==2",
        "${a} && 1",
        "1 ? 2 : 3",       # 三元
        "max(1,2)",        # 函式呼叫
        "abs ${a}",
        "a*2",             # 裸變數名（會與「函式呼叫」共用同一句訊息）
        "$a",              # `${}` 少了大括號
        "${a+b}",          # 路徑裡不能有運算——這句由 §4.7 的 parser 給
        "${}",
        "${a",
        "2^3",             # 沒有次方；要的話拉 math_op
        '1+"x"',           # 沒有字串常值
        "1e3",             # 指數寫法不收
        "0x10",
    ],
)
def test_rejected_at_save_time(src: str) -> None:
    with pytest.raises(ValidationError):
        parse(src)


def test_errors_carry_the_block_id() -> None:
    """422 要標得到是哪一顆積木——沒有 blockId 就只剩一行紅字（§8.4）。"""
    with pytest.raises(ValidationError) as e:
        parse("${a} > 2", block_id="blk_7", field_name="expr")
    assert e.value.block_id == "blk_7"
    assert e.value.path == "expr"


def test_function_call_message_points_somewhere_useful() -> None:
    """「不能用『m』」對想寫 max(a,b) 的人一點忙都幫不上。"""
    with pytest.raises(ValidationError, match="不能呼叫函式"):
        parse("max(1,2)")


# --------------------------------------------------------------------------
# 執行期：型別與除以 0
# --------------------------------------------------------------------------


def test_non_numeric_operand_fails_at_runtime() -> None:
    with pytest.raises(TypeCoercionError):
        run("${s}+1")


def test_missing_variable_propagates_from_the_resolver() -> None:
    with pytest.raises(KeyError):
        run("${nope}+1")


@pytest.mark.parametrize("src", ["1/0", "${a}/(2-2)", "1%0"])
def test_division_by_zero_is_an_error_not_infinity(src: str) -> None:
    with pytest.raises(BlockyardError):
        run(src)


@pytest.mark.parametrize(
    "a,b",
    [(10, 2), (1, 3), (-7, 2), (7, -2), (7.5, 2), (-7.5, 2), (10, 4)],
)
def test_matches_the_operator_blocks(a: float, b: float) -> None:
    """運算式的 `/` `%` 與 `operator.divide` / `operator.mod` 是同一份實作。

    這個測試守的是「以後不會有人為了方便在其中一邊多寫一條分支」。
    """
    assert run(f"{a}/{b}") == divide(a, b)
    assert run(f"{a}%{b}") == modulo(a, b)


def test_integers_stay_integers() -> None:
    """`2*3` 是 6 不是 6.0：呈現層雖然一樣（D15），型別在 §4.3 的索引上看得到。"""
    assert isinstance(run("2*3"), int)
    assert isinstance(run("1.5*2"), float)

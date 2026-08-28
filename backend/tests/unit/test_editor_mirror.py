"""編輯器行內語法標示與後端解析器的**同句話**測試（§8.5）。

`packages/editor/src/ir/highlight.ts` 是 `template.py` / `expression.py` 的
不丟例外版本：它讓 `FieldText` 在使用者打字的當下就畫紅線、把原因寫進 warning
icon。規格仍然是後端（存檔的 422 才是那道門），但兩邊的**句子必須一模一樣**
——欄位裡看到一句話、按存檔看到另一句話，使用者會以為那是兩個問題。

這個檔案只做一件事：拿 `tests/fixtures/field_messages.yaml` 跑後端。前端的
`highlight.test.ts` 拿**同一份 YAML** 跑自己。誰改了訊息、誰漏抄了一條規則，
兩邊之一會紅。

「前端複製一份測資自己維護」是這裡刻意避開的做法——那樣漂移的那天兩邊都會
繼續綠著，而這正是題庫 fixture 由前端直接讀後端 yaml 的同一個理由。
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest
import yaml

from blocky.errors import ValidationError
from blocky.ir import expression, template

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "field_messages.yaml"

_CASES = yaml.safe_load(FIXTURE.read_text(encoding="utf-8"))


def _ids(kind: str) -> list[str]:
    return [f"{kind}:{c['value']!r}" for c in _CASES[kind]]


@pytest.mark.parametrize("case", _CASES["template"], ids=_ids("template"))
def test_template_messages(case: dict) -> None:
    expected = case.get("error")
    if expected is not None:
        with pytest.raises(ValidationError) as exc:
            template.parse(case["value"])
        assert exc.value.message == expected
        return

    parsed = template.parse(case["value"])
    assert parsed.whole is case.get("whole", False)
    if "roots" in case:
        assert sorted(parsed.roots) == sorted(case["roots"])


@pytest.mark.parametrize("case", _CASES["expression"], ids=_ids("expression"))
def test_expression_messages(case: dict) -> None:
    expected = case.get("error")
    if expected is not None:
        with pytest.raises(ValidationError) as exc:
            expression.parse(case["value"])
        assert exc.value.message == expected
        return

    parsed = expression.parse(case["value"])
    if "roots" in case:
        assert sorted(parsed.roots) == sorted(case["roots"])


@pytest.mark.parametrize("case", _CASES["variable"], ids=_ids("variable"))
def test_variable_name_messages(case: dict) -> None:
    expected = case.get("error")
    if expected is None:
        template.validate_name(case["value"])
        return
    with pytest.raises(ValidationError) as exc:
        template.validate_name(case["value"])
    assert exc.value.message == expected


def test_fixture_covers_every_error_message_in_the_grammar() -> None:
    """每一句 `ValidationError` 都要有人測到。

    沒有這一條的話，新增一條文法規則（連帶一句新訊息）不會有任何東西提醒
    「前端也要抄」——而漏抄的症狀是欄位安靜地不畫紅線，只有按下存檔才會知道，
    正是這一步想消滅的那種延遲。
    """
    covered = {
        case["error"]
        for kind in ("template", "expression", "variable")
        for case in _CASES[kind]
        if case.get("error")
    }
    # 訊息會帶入變數（出事的字元、token、變數名），所以比對的是「抹掉可變部分
    # 之後的句型」。原始碼那一側的 f-string 插值抹成 `…`，比對時只要求
    # 「fixture 裡有一句以這個前綴開頭」——訊息尾巴接的常數（如 `_ALLOWED`
    # 那份允許清單）本來就不必逐字重複一遍。
    skeletons = {_skeleton(m) for m in covered}

    for module in (template, expression):
        for literal in _validation_messages(Path(module.__file__)):
            prefix = _skeleton(literal).split("…")[0]
            assert any(s.startswith(prefix) for s in skeletons), (
                f"{Path(module.__file__).name} 有一句沒有進 field_messages.yaml：{literal}"
            )


def _skeleton(message: str) -> str:
    """把訊息裡會變的部分抹掉，只留句型。"""
    message = re.sub(r"「[^」]*」", "「」", message)
    message = re.sub(r'"[^"]*"', '""', message)
    message = re.sub(r"（出現了[^）]*）", "（）", message)
    message = re.sub(r"不能包含 [^：]*", "不能包含 ", message)
    return message


def _validation_messages(path: Path) -> list[str]:
    """原始碼裡所有 `ValidationError(...)` 的第一個字串引數。

    用 AST 而不是正則：f-string 與跨行的呼叫都要抓得到，而那兩種寫法在
    `expression.py` 裡都有。
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
        if name != "ValidationError" or not node.args:
            continue
        rendered = _render(node.args[0])
        if rendered is not None:
            out.append(rendered)
    return out


def _render(node: ast.expr) -> str | None:
    """字串常值直接回傳；f-string 把插值換成佔位符。"""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        parts = []
        for value in node.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                parts.append(value.value)
            else:
                parts.append("…")
        return "".join(parts)
    return None

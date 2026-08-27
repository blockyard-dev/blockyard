"""跑committed 的題庫 fixture（§17）。

兩層檢查：
  1. meta.yaml 的 expect —— 手寫的規格
  2. expected.jsonl ——— 黃金事件軌跡，抓「結果對了但過程錯了」
"""

from __future__ import annotations

from pathlib import Path

import pytest

from blocky.conformance import check, diff_trace, read_case, run_case

ROOT = Path(__file__).parent / "conformance"


def _dirs() -> list[Path]:
    return sorted(p.parent for p in ROOT.rglob("meta.yaml"))


def _id(p: Path) -> str:
    return str(p.relative_to(ROOT))


@pytest.mark.parametrize("case_dir", _dirs(), ids=_id)
async def test_case(case_dir: Path) -> None:
    case, golden = read_case(case_dir)
    result = await run_case(case)

    problems = check(case, result)
    assert not problems, (
        f"\n{case.title}\n規格：{case.spec}\n\n" + "\n".join(problems)
    )

    if golden:
        d = diff_trace(golden, result.events)
        assert d is None, f"\n黃金軌跡不符（{case.title}）\n{d}"


def test_corpus_covers_spec_table() -> None:
    """§17.2 的表格每一列都要有題目。這個測試守的是題庫本身的完整性。"""
    required_tags = {
        "D15", "index", "variables", "procedure", "unwind", "try_catch",
        "template", "D9", "type", "D10", "persist", "D12", "time",
        "comparison", "eval_order", "threads", "events",
        # §7.5 的 Host 邊界。合約測試（tests/contract）跑的是介面本身，
        # 這裡跑的是「從積木到積木包」那條完整路徑。
        "extension", "host_boundary", "missing_extension",
        # §4.2 的形狀驗證：載入期擋掉，認不得的 opcode 除外
        "shape", "unknown_block",
    }
    seen: set[str] = set()
    for d in _dirs():
        case, _ = read_case(d)
        seen.update(case.tags)
    missing = required_tags - seen
    assert not missing, f"§17.2 中這些規則還沒有對應題目：{sorted(missing)}"

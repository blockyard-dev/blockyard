"""產生／更新題庫 fixture。

用法：
    python tests/gen_corpus.py --check    只跑 expect 斷言，不寫檔（CI 用）
    python tests/gen_corpus.py            寫 fixture 並更新黃金軌跡

黃金軌跡是**產生**的，expect 是**手寫**的。只有 expect 全部通過的題目才會
寫出黃金軌跡——否則就是把 bug 鎖進題庫。
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from blocky.conformance import check, run_case, write_case  # noqa: E402
from tests.corpus import CASES  # noqa: E402

ROOT = Path(__file__).parent / "conformance"


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只驗證，不寫檔")
    ap.add_argument("--filter", default="", help="只跑路徑含此字串的題目")
    args = ap.parse_args()

    passed, failed = 0, []
    for case in CASES:
        if args.filter and args.filter not in case.path:
            continue
        result = await run_case(case)
        problems = check(case, result)
        if problems:
            failed.append((case, problems, result))
            continue
        passed += 1
        if not args.check:
            write_case(ROOT, case, result.events)

    print(f"\n通過 {passed} / {passed + len(failed)}")
    for case, problems, result in failed:
        print(f"\n{'=' * 72}\n✗ {case.path} — {case.title}\n  規格：{case.spec}")
        for p in problems:
            print(f"  {p}")
        if result.load_error:
            print(f"  載入期錯誤：{result.load_error}")
        elif result.error:
            print(f"  執行期錯誤：{result.error}")
        print(f"  實際 logs：{result.logs}")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

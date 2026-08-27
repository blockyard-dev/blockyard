"""把 IR 的 JSON Schema 匯出到 packages/shared-schema/（§14）。

`shared-schema` 是 IR 的**唯一真實來源**。前端的 TS 型別由這份 JSON Schema
產生（`json-schema-to-typescript`），後端直接用 pydantic 模型——兩邊同源，
避免定義漂移。

用法：python tools/export_schema.py
CI 應該跑 `--check`，schema 有變動卻沒重新產生就讓建置失敗。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from blocky.ir.schema import Project  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "packages" / "shared-schema" / "project.schema.json"


def build() -> str:
    schema = Project.model_json_schema(mode="validation")
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["$id"] = "https://blocky.dev/schema/project.schema.json"
    schema["title"] = "Blocky Project IR"
    schema["description"] = "積木專案的中介表示（IR）。設計文件 §4。"
    return json.dumps(schema, ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只檢查是否為最新，不寫檔")
    args = ap.parse_args()

    content = build()
    if args.check:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != content:
            print(f"schema 不是最新的，請跑 python tools/export_schema.py", file=sys.stderr)
            return 1
        print("schema 是最新的")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(content, encoding="utf-8")
    print(f"已寫入 {OUT.relative_to(Path.cwd().parent)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

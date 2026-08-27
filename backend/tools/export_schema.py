"""把 IR 與 manifest 的 JSON Schema 匯出到 packages/shared-schema/（§14）。

`shared-schema` 是這兩份契約的**唯一真實來源**。前端的 TS 型別由 JSON Schema
產生（`json-schema-to-typescript`），後端直接用 pydantic 模型——兩邊同源，
避免定義漂移。

manifest 也在這裡，是因為 D21 之後它同樣是前後端的介面：§8.1 的動態積木註冊
拿 `/api/extensions` 的 manifest 直接轉成 Blockly 的 block definition，內建與
第三方都是。前端要照著 `args[].type` 決定畫哪種欄位，那份型別必須是產生的。

用法：python tools/export_schema.py
CI 應該跑 `--check`，schema 有變動卻沒重新產生就讓建置失敗。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from blocky.extensions.manifest import Manifest  # noqa: E402
from blocky.ir.schema import Project  # noqa: E402

OUT_DIR = Path(__file__).resolve().parents[2] / "packages" / "shared-schema"

TARGETS = {
    "project.schema.json": (
        Project,
        "Blocky Project IR",
        "積木專案的中介表示（IR）。設計文件 §4。",
    ),
    "manifest.schema.json": (
        Manifest,
        "Blocky Extension Manifest",
        "一個命名空間的積木宣告。內建與積木包共用（設計文件 §7.2、D21）。",
    ),
}


def build(model: type, title: str, description: str, filename: str) -> str:
    schema = model.model_json_schema(mode="validation")
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["$id"] = f"https://blocky.dev/schema/{filename}"
    schema["title"] = title
    schema["description"] = description
    return json.dumps(schema, ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只檢查是否為最新，不寫檔")
    args = ap.parse_args()

    stale: list[str] = []
    for filename, (model, title, description) in TARGETS.items():
        content = build(model, title, description, filename)
        out = OUT_DIR / filename
        if args.check:
            if not out.exists() or out.read_text(encoding="utf-8") != content:
                stale.append(filename)
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(content, encoding="utf-8")
        print(f"已寫入 {out.relative_to(Path.cwd().parent)}")

    if args.check:
        if stale:
            print(
                f"schema 不是最新的（{', '.join(stale)}），請跑 python tools/export_schema.py",
                file=sys.stderr,
            )
            return 1
        print("schema 是最新的")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

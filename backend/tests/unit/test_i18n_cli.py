from pathlib import Path
from typing import Any

import yaml

from blockyard.extensions import BUNDLED_ROOT
from blockyard.extensions.manifest import load_locale_files, load_locales, load_manifest
from blockyard.i18n_cli import check_pack, extract_pack, locale_template
from blockyard.interpreter import declarations
from blockyard.interpreter.declarations import BUILTINS_DIR


def write_pack(root: Path, text: str = "說 %(value)") -> None:
    (root / "manifest.yaml").write_text(
        "manifestVersion: 1\nid: demo\nname: 示範\nversion: '1'\n"
        "palette:\n  - opcode: say\n    type: command\n"
        f"    text: '{text}'\n    args:\n      value: {{type: string, label: 內容}}\n",
        encoding="utf-8",
    )


def test_extract_creates_complete_template_and_check_accepts_it(tmp_path) -> None:
    write_pack(tmp_path)
    target, changed = extract_pack(tmp_path, "en")
    data = yaml.safe_load(target.read_text(encoding="utf-8"))
    assert data["blocks"]["say"]["text"] == "說 %(value)"
    assert data["blocks"]["say"]["args"]["value"]["label"] == "內容"
    assert changed == []
    check_pack(tmp_path)


def test_extract_preserves_translation_and_marks_changed_source(tmp_path) -> None:
    write_pack(tmp_path)
    target, _ = extract_pack(tmp_path, "en")
    data = yaml.safe_load(target.read_text(encoding="utf-8"))
    data["blocks"]["say"]["text"] = "say %(value)"
    target.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")
    write_pack(tmp_path, "輸出 %(value)")
    target, changed = extract_pack(tmp_path, "en")
    assert "blocks.say.text" in changed
    assert "# SOURCE CHANGED: blocks.say.text" in target.read_text(encoding="utf-8")
    assert yaml.safe_load(target.read_text(encoding="utf-8"))["blocks"]["say"]["text"] == "say %(value)"


def _leaf_paths(value: Any, prefix: str = "") -> set[str]:
    if not isinstance(value, dict):
        return {prefix}
    return set().union(*(
        _leaf_paths(child, f"{prefix}.{key}".lstrip("."))
        for key, child in value.items()
    ))


def test_all_official_english_catalogs_cover_every_translatable_field() -> None:
    missing: dict[str, list[str]] = {}
    for pack in sorted(BUNDLED_ROOT.iterdir()):
        manifest_path = pack / "manifest.yaml"
        if not manifest_path.exists():
            continue
        manifest = load_manifest(manifest_path)
        english = load_locales(pack, manifest, strict=True)[0].get("en", {})
        absent = _leaf_paths(locale_template(manifest)) - _leaf_paths(english)
        if absent:
            missing[manifest.id] = sorted(absent)

    for manifest in declarations.manifests().values():
        english = load_locale_files(
            BUILTINS_DIR / "locales", manifest, strict=True,
        ).get("en", {})
        absent = _leaf_paths(locale_template(manifest)) - _leaf_paths(english)
        if absent:
            missing[manifest.id] = sorted(absent)

    assert missing == {}

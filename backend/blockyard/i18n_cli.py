"""Author tooling for manifest locale overlays."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from blockyard.errors import ExtensionError
from blockyard.extensions.manifest import Manifest, SectionSpec, load_locales, load_manifest


def check_pack(pack: Path) -> None:
    manifest = load_manifest(pack / "manifest.yaml")
    load_locales(pack, manifest, strict=True)


def extract_pack(pack: Path, locale: str) -> tuple[Path, list[str]]:
    manifest = load_manifest(pack / "manifest.yaml")
    current = locale_template(manifest)
    root = pack / "locales"
    target = root / f"{locale}.yaml"
    snapshot = root / ".sources" / f"{locale}.yaml"
    existing = _yaml_mapping(target) if target.exists() else {}
    previous = _yaml_mapping(snapshot) if snapshot.exists() else {}
    changed: list[str] = []
    merged = _merge(current, existing, previous, "", changed)
    root.mkdir(parents=True, exist_ok=True)
    snapshot.parent.mkdir(parents=True, exist_ok=True)
    comments = "".join(f"# SOURCE CHANGED: {path}\n" for path in changed)
    target.write_text(comments + yaml.safe_dump(merged, allow_unicode=True, sort_keys=False), encoding="utf-8")
    snapshot.write_text(yaml.safe_dump(current, allow_unicode=True, sort_keys=False), encoding="utf-8")
    return target, changed


def locale_template(mf: Manifest) -> dict[str, Any]:
    out: dict[str, Any] = {"name": mf.name}
    if mf.description is not None:
        out["description"] = mf.description
    blocks: dict[str, Any] = {}
    buttons: dict[str, Any] = {}
    sections: dict[str, Any] = {}
    for entry in mf.palette:
        if hasattr(entry, "opcode"):
            block: dict[str, Any] = {"text": entry.text}
            args: dict[str, Any] = {}
            all_args = {**entry.args, **(entry.repeat.args if entry.repeat else {})}
            for name, spec in all_args.items():
                item: dict[str, Any] = {}
                if spec.label is not None: item["label"] = spec.label
                if spec.help is not None: item["help"] = spec.help
                if spec.options: item["options"] = {o.value: (o.label or o.value) for o in spec.options}
                if item: args[name] = item
            if args: block["args"] = args
            if entry.repeat: block["repeatLabel"] = entry.repeat.label
            blocks[entry.opcode] = block
        elif hasattr(entry, "button"):
            buttons[entry.button] = {"label": entry.label}
        elif isinstance(entry, SectionSpec) and entry.id and entry.title:
            sections[entry.id] = {"title": entry.title}
    if blocks: out["blocks"] = blocks
    if buttons: out["buttons"] = buttons
    if sections: out["sections"] = sections
    config = {c.key: {k: v for k, v in {"label": c.label, "help": c.help}.items() if v is not None} for c in mf.config}
    config = {k: v for k, v in config.items() if v}
    if config: out["config"] = config
    if mf.panels: out["panels"] = {p.id: {"name": p.name} for p in mf.panels}
    return out


def _yaml_mapping(path: Path) -> dict[str, Any]:
    try:
        value = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise ExtensionError(f"讀不到 {path}：{exc}") from None
    if not isinstance(value, dict):
        raise ExtensionError(f"{path} 的根節點必須是 mapping")
    return value


def _merge(source: Any, translated: Any, previous: Any, path: str, changed: list[str]) -> Any:
    if not isinstance(source, dict):
        if translated is None:
            return source
        if previous is not None and previous != source and translated != source:
            changed.append(path)
        return translated
    translated = translated if isinstance(translated, dict) else {}
    previous = previous if isinstance(previous, dict) else {}
    return {
        key: _merge(value, translated.get(key), previous.get(key), f"{path}.{key}".lstrip("."), changed)
        for key, value in source.items()
    }

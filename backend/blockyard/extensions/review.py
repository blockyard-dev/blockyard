"""暫存包的安裝摘要。讀宣告與來源，不讀取或掃描程式碼。"""
from __future__ import annotations

from dataclasses import asdict
from typing import Any

from blockyard.extensions.diff import diff
from blockyard.extensions.install import Staged
from blockyard.extensions.manifest import Manifest


def review(staged: Staged, *, installed: Manifest | None) -> dict[str, Any]:
    mf = staged.source.manifest
    return {
        "token": staged.token,
        "id": mf.id,
        "name": mf.name,
        "version": mf.version,
        "author": mf.author,
        "description": mf.description,
        "origin": asdict(staged.origin),
        "editor": mf.editor.model_dump() if mf.editor else None,
        "requirements": list(mf.requirements),
        "blocks": [{"opcode": mf.full_opcode(b.opcode), "text": b.text} for b in mf.blocks],
        "panels": [{"id": p.id, "name": p.name} for p in mf.panels],
        "config": [
            {"key": c.key, "label": c.label, "type": c.type, "envVar": c.envVar}
            for c in mf.config
        ],
        "urls": list(dict.fromkeys(b.url for b in mf.buttons if b.url)),
        "installed": None if installed is None else {
            "version": installed.version, "diff": diff(installed, mf),
            "editor": installed.editor.model_dump() if installed.editor else None,
        },
    }


__all__ = ["review"]

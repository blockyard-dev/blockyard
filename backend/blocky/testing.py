"""題庫的作者工具（§17）。

手寫扁平的 blocks map 很痛苦，而痛苦的題庫沒有人會補。這裡提供一組巢狀的
builder，展開成**真正的 IR**——存在磁碟上的 fixture 仍然是 project.json，
題庫因此同時驗證 IR 格式本身。

blockId 依文件順序決定（blk_1, blk_2, …），所以是穩定的：expected.jsonl
裡的 blockId 不會因為改了別處而整批位移。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Tpl:
    """含 `${}` 的字串輸入。"""

    value: str


@dataclass
class Stack:
    """C 型積木的內部堆疊。"""

    blocks: list["Blk"] = field(default_factory=list)


@dataclass
class Blk:
    opcode: str
    inputs: dict[str, Any] = field(default_factory=dict)
    fields: dict[str, Any] = field(default_factory=dict)
    mutation: dict[str, Any] | None = None
    ui: dict[str, Any] | None = None


def blk(opcode: str, *, fields: dict | None = None, mutation: dict | None = None, **inputs) -> Blk:
    return Blk(opcode=opcode, inputs=inputs, fields=fields or {}, mutation=mutation)


def var(name: str) -> Blk:
    """`(名稱)` 讀取積木的捷徑——題目裡出現的頻率高到值得一個縮寫。"""
    return blk("data.get", fields={"name": name})


class _Builder:
    def __init__(self) -> None:
        self.blocks: dict[str, dict[str, Any]] = {}
        self._n = 0

    def _next_id(self) -> str:
        self._n += 1
        return f"blk_{self._n}"

    def add_stack(self, items: list[Blk], parent: str | None) -> str | None:
        """把一串積木展開成用 next 串起來的扁平結構，回第一顆的 id。"""
        first: str | None = None
        prev: str | None = None
        for item in items:
            bid = self.add_block(item, parent=parent if prev is None else prev)
            if first is None:
                first = bid
            if prev is not None:
                self.blocks[prev]["next"] = bid
            prev = bid
        return first

    def add_block(self, b: Blk, parent: str | None) -> str:
        bid = self._next_id()
        # 先佔位再填 inputs：子積木的 parent 要指向這一顆
        self.blocks[bid] = {
            "opcode": b.opcode,
            "parent": parent,
            "next": None,
            "inputs": {},
            "fields": dict(b.fields),
            "mutation": b.mutation,
            "ui": b.ui,
        }
        inputs: dict[str, Any] = {}
        for name, v in b.inputs.items():
            inputs[name] = self._input(v, parent=bid)
        self.blocks[bid]["inputs"] = inputs
        return bid

    def _input(self, v: Any, parent: str) -> dict[str, Any]:
        if isinstance(v, Blk):
            return {"kind": "block", "id": self.add_block(v, parent=parent)}
        if isinstance(v, Stack):
            return {"kind": "stack", "id": self.add_stack(v.blocks, parent=parent)}
        if isinstance(v, Tpl):
            from blocky.errors import ValidationError
            from blocky.ir import template as tpl_mod

            try:
                parsed = tpl_mod.parse(v.value)
            except ValidationError:
                # 刻意無效的題目（例如 `${a + b}`）也要寫得出 fixture——
                # 它們的重點就是「載入期才該擋」，所以 builder 放行，
                # 由 load() 拒絕。
                return {"kind": "template", "value": v.value, "refs": [], "whole": False}
            return {
                "kind": "template",
                "value": v.value,
                "refs": [r.to_ir() for r in parsed.refs],
                "whole": parsed.whole,
            }
        if isinstance(v, list):  # list 字面直接寫成 stack 的簡寫
            return {"kind": "stack", "id": self.add_stack(v, parent=parent)}
        return {"kind": "literal", "value": v}


def build(
    *,
    scripts: list[list[Blk]],
    procedures: dict[str, dict[str, Any]] | None = None,
    extensions: list[tuple[str, str]] | None = None,
    name: str = "題目",
) -> dict[str, Any]:
    """組出一份完整的 project.json。

    scripts 的每一項是一串積木，第一顆必須是 hat。
    procedures 的每一項是 {"name":..., "params":[...], "returns":..., "body":[Blk...]}。
    """
    bld = _Builder()
    out_scripts: list[dict[str, Any]] = []

    for i, stack in enumerate(scripts, 1):
        top = bld.add_stack(stack, parent=None)
        out_scripts.append({"id": f"sc_{i}", "top": top, "x": 0, "y": i * 100})

    out_procs: dict[str, Any] = {}
    for pid, spec in (procedures or {}).items():
        # 定義積木本身是 hat，body 掛在它底下
        def_id = bld.add_block(blk("procedure.definition", fields={"proc": pid}), parent=None)
        body_id = bld.add_stack(spec.get("body", []), parent=def_id)
        bld.blocks[def_id]["next"] = body_id
        out_procs[pid] = {
            "name": spec.get("name", pid),
            "params": spec.get("params", []),
            "returns": spec.get("returns"),
            "body": body_id,
            "definitionBlock": def_id,
        }

    return {
        "formatVersion": 1,
        "meta": {"id": "prj_test", "name": name},
        "extensions": [{"id": i, "version": v} for i, v in (extensions or [])],
        "variables": {},
        "procedures": out_procs,
        "scripts": out_scripts,
        "blocks": bld.blocks,
    }

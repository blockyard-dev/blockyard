"""換一版之前，先說出誰會受影響（`docs/extension-design.md` §4）。

更新跟第一次裝走**同一條管線**，唯一的差別是畫布上已經有它的積木——所以審閱
畫面多一段差集。判準與刪除一致：**會讓畫布上的積木失去來源的動作，都要先說出
誰會受影響。**

| 差集 | 怎麼辦 | 為什麼 |
|---|---|---|
| 少了一顆積木，**而畫布上有** | 擋 | 跟「還有 3 顆在用，不准刪」是同一句話 |
| 參數變了，**而畫布上有** | 警告後放行 | 那幾顆會多出填不了東西的空孔（§16 Q21） |
| 沒人用到的變動 | 只說一聲 | 多三顆、少一顆沒人用的 |

**「而畫布上有」這半句不在這裡算。** 這個模組只比兩份 manifest，回答的是
「這一版跟那一版差在哪」；誰在畫布上是前端才知道的事（那份工作區還沒存檔，
後端手上那一份可能是十分鐘前的）。同一個分工在「刪除一個擴充功能」那條路上
已經存在——後端說得出這個包有哪幾顆積木，數得出畫布上有幾顆的是 `App`。

回傳純資料（dict），與 `review.py` 同一個理由：只有前端一個消費者。

**分不出來的就不假裝分得出來**（§8）：「參數變了」在 manifest 上看得見，
**「這顆積木的意思變了」看不見**——而那才是更新真正危險的地方。這個模組
只說它真的知道的事。
"""

from __future__ import annotations

from typing import Any

from blockyard.extensions.manifest import ArgSpec, BlockSpec, Manifest


def diff(installed: Manifest, incoming: Manifest) -> dict[str, Any]:
    """`installed` → `incoming` 之間的差集。"""
    old = {b.opcode: b for b in installed.blocks}
    new = {b.opcode: b for b in incoming.blocks}

    gone: list[dict[str, Any]] = []
    changed: list[dict[str, Any]] = []
    for opcode, before in old.items():
        after = new.get(opcode)
        if after is None:
            gone.append(_gone(installed, before, "missing"))
        elif after.type != before.type:
            # **形狀變了等於這顆積木不在了。** `reporter` 變成 `command` 的那一
            # 顆，畫布上原本插在別人輸入孔裡的那幾顆會變成插不進去的東西——而
            # 使用者看到的是「積木還在，但整段程式壞了」，比消失更難懂。所以它
            # 走「少了一顆」那一列，不走「參數變了」。
            gone.append(_gone(installed, before, "shape"))
        elif (entry := _changed(installed, before, after)) is not None:
            changed.append(entry)

    return {
        "version": {"from": installed.version, "to": incoming.version},
        "gone": gone,
        "changed": changed,
        "added": [
            {"opcode": incoming.full_opcode(b.opcode), "text": b.text}
            for op, b in new.items()
            if op not in old
        ],
        "requirementsChanged": sorted(installed.requirements) != sorted(incoming.requirements),
    }


def _gone(mf: Manifest, spec: BlockSpec, why: str) -> dict[str, Any]:
    return {"opcode": mf.full_opcode(spec.opcode), "text": spec.text, "why": why}


def _changed(mf: Manifest, before: BlockSpec, after: BlockSpec) -> dict[str, Any] | None:
    """同一顆積木的兩版之間差在哪，沒差就 `None`。"""
    added = [
        {"name": name, "required": _required(spec)}
        for name, spec in after.args.items()
        if name not in before.args
    ]
    removed = [name for name in before.args if name not in after.args]
    retyped = [
        {"name": name, "from": before.args[name].type, "to": spec.type}
        for name, spec in after.args.items()
        if name in before.args and before.args[name].type != spec.type
    ]
    # 積木上那句話變了，畫布上那幾顆的長相就變了。它不會壞掉任何東西，但使用者
    # 會看到自己沒有動過的積木換了字——說一聲比讓他自己發現好。
    text_changed = before.text != after.text
    # §13.1：opcode 永不移除，只標記 deprecated（工具箱隱藏，既有專案仍可執行）。
    # 所以它不是「少了一顆」，但畫布上已經有的那幾顆從此生不出第二顆。
    now_deprecated = after.deprecated and not before.deprecated
    if not (added or removed or retyped or text_changed or now_deprecated):
        return None
    return {
        "opcode": mf.full_opcode(before.opcode),
        "text": after.text,
        "argsAdded": added,
        "argsRemoved": removed,
        "argsRetyped": retyped,
        "textChanged": text_changed,
        "nowDeprecated": now_deprecated,
    }


def _required(spec: ArgSpec) -> bool:
    """這一格沒填會不會出事。

    多一格必填的參數，畫布上那幾顆積木會多出**填不了東西的空孔**（§16 Q21）
    ——而那份專案從此存不起來（`normalize_args` 的「少了必填參數」）。多一格
    選填的只是多一個孔。兩者都要說，但它們不是同一件事。

    問的是 `has_default` 而不是 `default is None`：§7.2 說「沒寫 default」與
    「`default: null`」是兩件事，後者是選填。"""
    return not spec.has_default


__all__ = ["diff"]

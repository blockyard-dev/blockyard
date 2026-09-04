"""工具箱裡那一顆積木帶進來的一小段 IR（§5.1 的「點一下就跑」）。

Run 跑的是**已存檔的那一份專案**（理由在 `manager.py` 開頭）。工具箱裡的積木
不在存檔裡——它還沒有被拉出來，畫布上根本沒有它，而使用者想做的事只有一件：
**點一下看看它會做什麼**。這個模組是那條規則唯一的例外，而例外只開這麼大：

- 一段 IR **併進載入用的那一份**，跑完就沒了。硬碟上的 `project.json` 一個
  位元組都沒有動——`ProjectStore` 在這條路上是唯讀的。
- 只收得下 `blocks`／`scripts`／`extensions` 三個 key。`variables`、
  `procedures`、`meta` 一律以存檔那一份為準：工具箱裡的一顆積木沒有資格改
  專案的宣告，而 `procedure.call` 要找的定義本來就在存檔裡。
- **id 撞到就報錯**，不是覆蓋。執行紀錄、事件流與畫面上的高亮全部照 blockId
  認人，讓兩顆積木共用一個 id 等於讓那三樣東西同時指錯人。

`extensions` 是併集而不是照抄存檔那一份：§13.3 的載入只認**宣告過**的包
（`api/validation.py` 的 `only=declared`），所以點一顆 `http.get` 而專案還沒
用過 http 時，不補上這筆宣告的話它會變成 `unknown_block`——使用者做對了每一
步，錯誤卻指著積木。這正是 P1 第一天撞到的那件事（見 `serialize.ts` 開頭）。
"""

from __future__ import annotations

from typing import Any

from blockyard.errors import ValidationError

#: 一段 scratch 只能講這三件事。多出來的 key 一律報錯而不是安靜忽略——安靜
#: 忽略的話，前端哪天多送一個 `procedures` 會變成「存檔那一份無聲勝出」。
ALLOWED_KEYS = frozenset({"blocks", "scripts", "extensions"})


def merge(data: Any, scratch: Any, block_id: str | None) -> dict[str, Any]:
    """把 `scratch` 併進 `data`，回一份**新的** IR。原本那份不動。

    併不進去的都是 `ValidationError`（路由翻成 422 + `blockId`），與存檔走
    同一條錯誤路：使用者按下去之後看到的是一句話，不是一個開始了又立刻死掉、
    還占著一格執行歷史的 Run。
    """
    if not isinstance(data, dict):
        raise ValidationError("專案必須是一個 JSON 物件")
    if not isinstance(scratch, dict):
        raise ValidationError("scratch 必須是一個 JSON 物件")

    unknown = sorted(set(scratch) - ALLOWED_KEYS)
    if unknown:
        raise ValidationError(f"scratch 不認得這些 key：{'、'.join(unknown)}")

    # scratch 的意思是「跑**這一顆**」。沒有 blockId 的話它是一段沒有人會執行
    # 的 IR——那不是一個可以安靜通過的請求，而是呼叫端寫錯了。
    if block_id is None:
        raise ValidationError("scratch 只能跟 blockId 一起送")

    blocks = scratch.get("blocks") or {}
    scripts = scratch.get("scripts") or []
    extensions = scratch.get("extensions") or []
    if not isinstance(blocks, dict) or not isinstance(scripts, list):
        raise ValidationError("scratch 的 blocks 要是物件、scripts 要是陣列")
    if block_id not in blocks:
        raise ValidationError(f"scratch 裡沒有積木 {block_id}", block_id=block_id)

    saved_blocks = data.get("blocks") or {}
    saved_scripts = data.get("scripts") or []
    if isinstance(saved_blocks, dict):
        clash = sorted(set(blocks) & set(saved_blocks))
        if clash:
            raise ValidationError(
                f"scratch 的積木 id 撞到存檔裡的：{'、'.join(clash)}",
                block_id=clash[0],
            )
    saved_script_ids = {
        s["id"] for s in saved_scripts if isinstance(s, dict) and isinstance(s.get("id"), str)
    }
    for script in scripts:
        if isinstance(script, dict) and script.get("id") in saved_script_ids:
            raise ValidationError(f"scratch 的腳本 id 撞到存檔裡的：{script['id']}")

    merged = dict(data)
    merged["blocks"] = {**saved_blocks, **blocks} if isinstance(saved_blocks, dict) else blocks
    merged["scripts"] = [*saved_scripts, *scripts] if isinstance(saved_scripts, list) else scripts
    merged["extensions"] = _extensions(data.get("extensions"), extensions)
    return merged


def _extensions(saved: Any, extra: Any) -> Any:
    """宣告的併集。**存檔那一份的版本贏**——專案其餘的積木正是照它跑的。"""
    if not isinstance(saved, list):
        return extra if isinstance(extra, list) else saved
    if not isinstance(extra, list):
        return saved

    declared = {e["id"] for e in saved if isinstance(e, dict) and isinstance(e.get("id"), str)}
    out = list(saved)
    for entry in extra:
        if isinstance(entry, dict) and entry.get("id") not in declared:
            declared.add(entry["id"])
            out.append(entry)
    return out

"""`event.when_webhook` 的路徑解析與驗證（§9.1、§9.3，P2 第 2c 步）。

與 `blocky/cron.py` 同一個形狀，理由也同一條：**存檔驗證與真的掛路由走同一份
實作**，所以「存檔時驗過的路徑一定掛得上」是結構上的事實。分成兩份的話，第一次
它們對不齊時，使用者會拿到一份存得進去、但那個網址永遠回 404 的專案。

## 為什麼要正規化路徑

使用者會打 `/hook`、`hook`、`/hook/`，心裡想的是同一件事。三種都當成不同的路徑
的話，他會盯著一個「明明設好了卻 404」的畫面——而那三個字串在積木上長得幾乎
一樣。所以一律收斂成不帶前後斜線的形式，並且**把正規化後的樣子當成 key**。

## 為什麼路徑不能有 `..` 或空段

它們不會造成路徑穿越（我們是在自己的 dict 裡查表，不是開檔案），但它們會讓同一
個 webhook 有兩個網址寫法——而 §9.3 的整個安全模型建立在「這個網址猜不到」上，
兩種寫法就是兩份要一起想清楚的東西。擋掉比想清楚便宜。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from blocky.errors import ValidationError

#: `event.when_webhook` 的 opcode。這個檔案是它唯一知道自己名字的地方。
WEBHOOK_OPCODE = "event.when_webhook"

PATH_FIELD = "path"

#: 一段路徑允許的字元。刻意窄：webhook 的網址是拿去貼進別的系統設定欄位的，
#: 而那些欄位對非 ASCII 的處理各家都不一樣。
_SEGMENT = re.compile(r"^[A-Za-z0-9._~-]+$")

#: §9.3 的隨機 token 長度（hex 字元數）。
TOKEN_CHARS = 32


@dataclass(frozen=True)
class WebhookSpec:
    """一顆 webhook 積木要的全部東西。"""

    path: str

    @property
    def spec(self) -> tuple[Any, ...]:
        return (self.path,)


def parse(fields: dict[str, Any], *, block_id: str | None = None) -> WebhookSpec:
    """從一顆 `when_webhook` 積木的 `fields` 解出路徑。失敗一律是 `ValidationError`。"""
    raw = fields.get(PATH_FIELD)
    if not isinstance(raw, str) or not raw.strip():
        raise ValidationError(
            "請填寫 webhook 路徑（例如 `github`）",
            block_id=block_id,
            path=PATH_FIELD,
        )

    segments = [seg for seg in raw.strip().strip("/").split("/")]
    if not segments or any(seg == "" for seg in segments):
        raise ValidationError(
            f"路徑「{raw}」有空的一段。請用 `github` 或 `github/push` 這種形式",
            block_id=block_id,
            path=PATH_FIELD,
        )
    for seg in segments:
        if seg in (".", ".."):
            raise ValidationError(
                f"路徑不能含有「{seg}」——它會讓同一個 webhook 有兩個網址寫法",
                block_id=block_id,
                path=PATH_FIELD,
            )
        if not _SEGMENT.match(seg):
            raise ValidationError(
                f"路徑「{seg}」含有不能用的字元。只能用英數字與 `.` `_` `~` `-`"
                "（這個網址要貼進別的系統的設定欄位，那些欄位對非 ASCII 的處理各家不同）",
                block_id=block_id,
                path=PATH_FIELD,
            )

    return WebhookSpec(path="/".join(segments))


def validate_blocks(blocks: Any) -> None:
    """存檔驗證的入口：掃過所有 `when_webhook` 積木，並擋掉**同路徑兩顆**。

    同一份專案裡兩顆 webhook 積木用同一個路徑，是一個看不出來的錯：兩顆都存得
    進去、兩顆都掛得上，但打進來的請求只會餵到其中一顆——而畫面上兩顆長得一樣。
    """
    if not isinstance(blocks, dict):
        return
    seen: dict[str, str] = {}
    for bid, block in blocks.items():
        if not isinstance(block, dict) or block.get("opcode") != WEBHOOK_OPCODE:
            continue
        spec = parse(block.get("fields") or {}, block_id=bid)
        if (other := seen.get(spec.path)) is not None:
            raise ValidationError(
                f"路徑「{spec.path}」有兩顆 webhook 積木在用（另一顆是 {other}）。"
                "打進來的請求只會餵到其中一顆，而畫面上兩顆長得一樣",
                block_id=bid,
                path=PATH_FIELD,
            )
        seen[spec.path] = bid


__all__ = [
    "PATH_FIELD",
    "TOKEN_CHARS",
    "WEBHOOK_OPCODE",
    "WebhookSpec",
    "parse",
    "validate_blocks",
]

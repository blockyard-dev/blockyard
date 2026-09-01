"""`event.when_cron` 的解析與驗證（§9.1、§4.9，P2 第 2b 步）。

**一份實作，兩個呼叫端。** 存檔驗證（`api/validation.py`）與真的排程
（`runs/triggers.py`）走同一個 `parse()`，所以「存檔時驗過的東西一定排得上」
不是一句承諾，是一個結構上的事實。分成兩份的話，第一次它們對不齊時，使用者
會拿到一份存得進去、卻永遠不會觸發的專案——而那種 bug 沒有任何畫面看得出來。

**放在頂層而不是 `runs/` 底下**，因為那兩個呼叫端一個在 `api/`、一個在
`runs/`，而 `runs/__init__` 已經（透過 `manager.py`）匯入 `api.validation`。
這個檔案只依賴 `blocky.errors` 與 APScheduler，是一片葉子，兩邊都進得來。

## 為什麼 timezone 是必填

§4.9 的那句話：**沒有它，同一份專案在不同機器上會在不同時刻觸發。** 這與 D11
拒絕「可設定的索引基底」是同一個理由——一份 IR 應該自我描述，而不是在讀它的
機器上才決定意思。

所以這裡不做「沒填就用系統時區」的退讓。退讓的代價是：使用者把專案分享出去，
對方跑起來的時間跟他看到的不一樣，而**兩邊的畫面長得一模一樣**。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from apscheduler.triggers.cron import CronTrigger

from blocky.errors import ValidationError

#: `event.when_cron` 的 opcode。這個檔案是它唯一知道自己名字的地方。
CRON_OPCODE = "event.when_cron"

CRON_FIELD = "cron"
TIMEZONE_FIELD = "timezone"


@dataclass(frozen=True)
class CronSpec:
    """一顆 cron 積木要的全部東西。

    `spec` 是 §9.2 的 diff 用的：它變了就得重排，沒變就別動——使用者改一句 log
    的文字然後存檔，那份排程不該被拆掉重建（它會讓「下一次什麼時候跑」跳掉）。
    """

    expression: str
    timezone: str

    @property
    def spec(self) -> tuple[Any, ...]:
        return (self.expression, self.timezone)

    def trigger(self) -> CronTrigger:
        return CronTrigger.from_crontab(self.expression, timezone=self.timezone)


def parse(fields: dict[str, Any], *, block_id: str | None = None) -> CronSpec:
    """從一顆 `when_cron` 積木的 `fields` 解出排程。失敗一律是 `ValidationError`。

    錯誤帶 `blockId`，所以前端標得回那顆積木——與 §4.7b 的運算式語法錯誤同一條
    原則：留到執行期的話，一顆設錯的 cron 可以安靜地不觸發好幾個月。
    """
    expression = fields.get(CRON_FIELD)
    timezone = fields.get(TIMEZONE_FIELD)

    if not isinstance(expression, str) or not expression.strip():
        raise ValidationError(
            "請填寫排程時間（cron 運算式，例如 `0 9 * * *` 是每天早上九點）",
            block_id=block_id,
            path=CRON_FIELD,
        )
    if not isinstance(timezone, str) or not timezone.strip():
        raise ValidationError(
            "請選擇時區。沒有它，同一份專案在不同機器上會在不同時刻觸發",
            block_id=block_id,
            path=TIMEZONE_FIELD,
        )

    expression = expression.strip()
    timezone = timezone.strip()

    try:
        CronTrigger.from_crontab(expression, timezone=timezone)
    except ValueError as e:
        # APScheduler 的訊息是英文的，而且它說的是欄位數不對這種實作細節。
        # 把它包在一句看得懂的話裡，但**保留原文**——排錯時那句才是線索。
        raise ValidationError(
            f"看不懂的排程時間「{expression}」。cron 是五欄：分 時 日 月 星期"
            f"（例如 `0 9 * * *` 是每天早上九點）。{e}",
            block_id=block_id,
            path=CRON_FIELD,
        ) from None
    except Exception as e:  # ZoneInfoNotFoundError 等
        raise ValidationError(
            f"不認得的時區「{timezone}」。請用 IANA 名稱，例如 `Asia/Taipei`。{e}",
            block_id=block_id,
            path=TIMEZONE_FIELD,
        ) from None

    return CronSpec(expression=expression, timezone=timezone)


def validate_blocks(blocks: dict[str, Any]) -> None:
    """存檔驗證的入口：掃過所有 `when_cron` 積木。

    只驗**腳本最上面**那顆？不——這裡不管位置。一顆 hat 放在畫布中間是形狀
    驗證（D20）的題目，而一顆設錯時間的 cron 不管放在哪裡都是設錯的。

    不是 dict 就直接回：那是結構驗證的題目，而它已經在這之前跑過了。這個守衛
    是給直接呼叫這個函式的人準備的。
    """
    if not isinstance(blocks, dict):
        return
    for bid, block in blocks.items():
        if not isinstance(block, dict) or block.get("opcode") != CRON_OPCODE:
            continue
        parse(block.get("fields") or {}, block_id=bid)


__all__ = ["CRON_FIELD", "CRON_OPCODE", "TIMEZONE_FIELD", "CronSpec", "parse", "validate_blocks"]

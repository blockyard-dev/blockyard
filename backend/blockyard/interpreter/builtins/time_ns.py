"""time 命名空間（§4.9）。

時間戳是 **object 而不是裸 number**，因為時區必須跟著值走。若時間戳是裸
數字，`格式化(現在時間)` 就得另外問「用哪個時區」，而那個問題會在每一顆
時間積木上重複出現。

代價是 `type.of` 對它回 "object"——可接受，因為型別系統不打算長出第七種
型別。`time.timestamp` 是逃生口，需要裸數字時明確要一次。
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from blockyard.errors import BlockyardError, TypeCoercionError
from blockyard.interpreter.engine import Thread
from blockyard.interpreter.registry import value
from blockyard.ir.schema import Block
from blockyard.ir.values import TYPE_LABELS_ZH, to_number, type_of

TIMESTAMP_TYPE = "timestamp"

_UNITS_MS = {
    "millisecond": 1,
    "second": 1000,
    "minute": 60_000,
    "hour": 3_600_000,
    "day": 86_400_000,
    "week": 604_800_000,
}


def make_timestamp(epoch_ms: float, tz: str) -> dict[str, Any]:
    return {"__type": TIMESTAMP_TYPE, "epochMs": epoch_ms, "tz": tz}


def is_timestamp(v: Any) -> bool:
    return isinstance(v, dict) and v.get("__type") == TIMESTAMP_TYPE


async def _require_ts(t: Thread, b: Block, name: str = "time") -> dict[str, Any]:
    v = await t.value(b, name)
    if is_timestamp(v):
        return v
    # 寬鬆一點：裸數字視為 epoch 毫秒，用專案時區。這是常見的 API 回傳形式，
    # 強迫使用者先包一顆積木沒有意義。
    if type_of(v) == "number":
        return make_timestamp(v, t.interp.timezone)
    raise BlockyardError(
        f"這裡需要時間，收到{TYPE_LABELS_ZH[type_of(v)]}",
        hint="是不是需要先用「解析時間」？",
    )


def _dt(ts: dict[str, Any]) -> datetime:
    return datetime.fromtimestamp(ts["epochMs"] / 1000, tz=_zone(ts["tz"]))


def _zone(name: str) -> ZoneInfo | timezone:
    if name in ("UTC", "utc"):
        return timezone.utc
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise BlockyardError(f'不認得時區 "{name}"', hint="例如 Asia/Taipei、UTC") from None


# --------------------------------------------------------------------------


@value("time.now")
async def _now(t: Thread, b: Block) -> dict[str, Any]:
    tz = await t.string(b, "timezone", default="") or t.interp.timezone
    return make_timestamp(t.interp.clock(), tz)


@value("time.timestamp")
async def _timestamp(t: Thread, b: Block) -> float:
    """逃生口：需要裸數字時明確要一次。"""
    return (await _require_ts(t, b))["epochMs"]


@value("time.parse")
async def _parse(t: Thread, b: Block) -> dict[str, Any]:
    s = (await t.string(b, "text")).strip()
    tz = await t.string(b, "timezone", default="") or t.interp.timezone
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        raise TypeCoercionError(
            f'無法解析時間 "{s}"', hint="需要 ISO 8601 格式，例如 2026-08-27T09:00:00"
        ) from None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_zone(tz))
    return make_timestamp(dt.timestamp() * 1000, tz)


# 用 YYYY/MM/DD 這類 token 而不是 strftime 的 %Y——使用者不會知道 %Y 是什麼。
_FORMAT_TOKENS = [
    ("YYYY", lambda d: f"{d.year:04d}"),
    ("MM", lambda d: f"{d.month:02d}"),
    ("DD", lambda d: f"{d.day:02d}"),
    ("HH", lambda d: f"{d.hour:02d}"),
    ("mm", lambda d: f"{d.minute:02d}"),
    ("ss", lambda d: f"{d.second:02d}"),
    ("SSS", lambda d: f"{d.microsecond // 1000:03d}"),
]
_FORMAT_RE = re.compile("|".join(tok for tok, _ in _FORMAT_TOKENS))
_FORMATTERS = dict(_FORMAT_TOKENS)

NAMED_FORMATS = {
    "date": "YYYY-MM-DD",
    "datetime": "YYYY-MM-DD HH:mm:ss",
    "time": "HH:mm:ss",
    "iso": "__iso__",
}


@value("time.format")
async def _format(t: Thread, b: Block) -> str:
    ts = await _require_ts(t, b)
    fmt = t.field(b, "format", "date")
    fmt = NAMED_FORMATS.get(fmt, fmt)
    d = _dt(ts)
    if fmt == "__iso__":
        return d.isoformat()
    return _FORMAT_RE.sub(lambda m: _FORMATTERS[m.group(0)](d), fmt)


@value("time.add")
async def _add(t: Thread, b: Block) -> dict[str, Any]:
    ts = await _require_ts(t, b)
    n = await t.number(b, "amount", default=0)
    unit = t.field(b, "unit", "day")
    if unit not in _UNITS_MS:
        raise BlockyardError(f"未知的時間單位 {unit}")
    if unit in ("day", "week"):
        # 天與週走行事曆運算，才能正確跨越日光節約時間。
        # 直接加毫秒會讓「明天同一時間」在 DST 切換日差一小時。
        days = n * (7 if unit == "week" else 1)
        d = _dt(ts) + timedelta(days=days)
        return make_timestamp(d.timestamp() * 1000, ts["tz"])
    return make_timestamp(ts["epochMs"] + n * _UNITS_MS[unit], ts["tz"])


@value("time.diff")
async def _diff(t: Thread, b: Block) -> float:
    a = await _require_ts(t, b, "a")
    c = await _require_ts(t, b, "b")
    unit = t.field(b, "unit", "day")
    if unit not in _UNITS_MS:
        raise BlockyardError(f"未知的時間單位 {unit}")
    delta = (a["epochMs"] - c["epochMs"]) / _UNITS_MS[unit]
    return int(delta) if float(delta).is_integer() else delta


_PARTS = {
    "year": lambda d: d.year,
    "month": lambda d: d.month,
    "day": lambda d: d.day,
    "hour": lambda d: d.hour,
    "minute": lambda d: d.minute,
    "second": lambda d: d.second,
    "weekday": lambda d: d.isoweekday(),   # 1 = 週一 … 7 = 週日
    "week": lambda d: d.isocalendar().week,
    "yearday": lambda d: d.timetuple().tm_yday,
}


@value("time.part")
async def _part(t: Thread, b: Block) -> int:
    ts = await _require_ts(t, b)
    part = t.field(b, "part", "day")
    fn = _PARTS.get(part)
    if fn is None:
        raise BlockyardError(f"未知的時間欄位 {part}", hint=f"可用：{'、'.join(_PARTS)}")
    return fn(_dt(ts))

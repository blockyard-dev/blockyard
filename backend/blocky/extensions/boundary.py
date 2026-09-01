"""Host 邊界的正規化與驗證（§7.5）。

`call` 除了 dispatch，還要在 args 進去、回傳值出來時各做一件事。這兩件事
**只在此處實作一次**：每個 Host 實作都呼叫這裡，所以 InProcessHost 與
SubprocessHost 的行為一致不是靠自律，是靠共用同一段程式碼（§17.4 的合約測試
再把這件事釘死）。

積木作者不需要、也不應該自己寫這兩件事。回傳值驗證看似瑣碎，但它把「宣告
object 卻回了字串」擋在源頭，而不是三顆積木之後才以「文字沒有 items」的形式
爆開（§4.7）。
"""

from __future__ import annotations

import json
from typing import Any

from blocky.errors import ExtensionError, TypeCoercionError
from blocky.extensions.manifest import ArgSpec, BlockSpec, Manifest
from blocky.ir.values import (
    TYPE_LABELS_ZH,
    TYPE_LIST,
    TYPE_OBJECT,
    TYPE_STRING,
    js_number_to_string,
    to_boolean,
    to_number,
    to_string,
    type_of,
)

# 文字類參數：下拉送出的是選項的 value，secret 是金鑰庫取出的字串，
# 三者在值模型裡都只是 string（§4.3）。
_STRING_TYPES = frozenset({"string", "code", "secret", "dropdown"})

# §7.2：`object` / `list` 是**嚴格宣告**，不做任何轉換。要自動處理請宣告 `json`。
_STRICT_TYPES: dict[str, str] = {"object": TYPE_OBJECT, "list": TYPE_LIST}

_PACK_HINT = "這是積木包的問題，不是你的流程寫錯了"


def _where(manifest: Manifest, spec: BlockSpec) -> str:
    return f"積木包「{manifest.name}」的 {manifest.full_opcode(spec.opcode)}"


# --------------------------------------------------------------------------
# 進：依 manifest 的 args 型別正規化
# --------------------------------------------------------------------------


def normalize_args(
    manifest: Manifest, spec: BlockSpec, raw: dict[str, Any], *, block_id: str | None = None
) -> dict[str, Any]:
    where = _where(manifest, spec)

    if unknown := set(raw) - set(spec.args):
        raise ExtensionError(
            f"{where} 收到沒有宣告的參數 {'、'.join(sorted(unknown))}",
            block_id=block_id,
            hint=_PACK_HINT,
        )

    out: dict[str, Any] = {}
    # 依**宣告順序**，與 §4.6 的求值順序一致；也讓錯誤訊息的順序可預測。
    for name, arg in spec.args.items():
        if name in raw:
            value = raw[name]
        elif arg.has_default:
            value = arg.default
        else:
            raise ExtensionError(
                f"{where} 少了必填參數 {name}", block_id=block_id, hint=_PACK_HINT
            )
        out[name] = _coerce(arg, name, value, where=where, block_id=block_id)

    ensure_transportable(out, where=where, what="參數", block_id=block_id)
    return out


def _coerce(
    arg: ArgSpec, name: str, v: Any, *, where: str, block_id: str | None
) -> Any:
    if arg.type == "json":
        return _coerce_json(name, v, where=where, block_id=block_id)

    # 邊界套用的是 §4.3 那張轉換表本身，不是第二套規則。積木包的參數孔與內建
    # 積木的參數孔對同一個值必須有同一種反應——否則使用者得記住「這顆是內建的
    # 所以會轉，那顆是別人寫的所以不會」，而畫面上兩者長得一模一樣。
    if arg.type in _STRING_TYPES:
        return to_string(v, block_id=block_id)      # 全函數，不會失敗
    if arg.type == "boolean":
        return to_boolean(v)                        # 全函數，falsy 集合見 §4.3
    if arg.type == "number":
        return _coerce_number(arg, name, v, where=where, block_id=block_id)

    # `object` / `list` 是嚴格宣告（§7.2）：值不是該型別就是錯誤。
    # 它們是唯一的例外，因為 §4.3 根本沒有「轉成物件」這一格——那只可能是
    # JSON parse，而 parse 必須看得見（D10）。
    want = _STRICT_TYPES[arg.type]
    got = type_of(v)
    if got != want:
        raise ExtensionError(
            f"{where} 的參數 {name} 需要{TYPE_LABELS_ZH[want]}，收到{TYPE_LABELS_ZH[got]}",
            block_id=block_id,
            hint="是不是需要先用「解析 JSON」？" if got == TYPE_STRING else None,
        )
    return v


def _coerce_json(name: str, v: Any, *, where: str, block_id: str | None) -> Any:
    """`json` 是**結構化資料入口**（§7.2）。

    保證 `main.py` 永遠拿到 dict / list，所以 parse 出來的純量也是錯誤——
    否則「不必寫一行防呆」這個承諾就有例外。
    """
    t = type_of(v)
    if t in (TYPE_OBJECT, TYPE_LIST):
        return v
    if t == TYPE_STRING:
        try:
            parsed = json.loads(v)
        except json.JSONDecodeError:
            raise ExtensionError(
                f"參數 {name} 收到的文字不是合法 JSON",
                block_id=block_id,
                hint=f'開頭是："{v[:60]}"' if v else "收到的是空字串",
            ) from None
        if type_of(parsed) not in (TYPE_OBJECT, TYPE_LIST):
            raise ExtensionError(
                f"參數 {name} 需要物件或清單，這段 JSON 解析出來是"
                f"{TYPE_LABELS_ZH[type_of(parsed)]}",
                block_id=block_id,
            )
        return parsed
    raise ExtensionError(
        f"{where} 的參數 {name} 需要物件或清單，收到{TYPE_LABELS_ZH[t]}",
        block_id=block_id,
    )


def _coerce_number(
    arg: ArgSpec, name: str, v: Any, *, where: str, block_id: str | None
) -> Any:
    try:
        n = to_number(v, block_id=block_id)
    except TypeCoercionError as e:
        raise ExtensionError(
            f"{where} 的參數 {name}：{e.message}", block_id=block_id, hint=e.hint
        ) from None

    # min / max 宣告在 manifest 上，所以也在邊界檢查——與 returns 同一類：
    # 宣告一次，兩邊都不用重寫。
    if arg.min is not None and n < arg.min:
        raise ExtensionError(
            f"{where} 的參數 {name} 不能小於 {js_number_to_string(arg.min)}，"
            f"收到 {js_number_to_string(n)}",
            block_id=block_id,
        )
    if arg.max is not None and n > arg.max:
        raise ExtensionError(
            f"{where} 的參數 {name} 不能大於 {js_number_to_string(arg.max)}，"
            f"收到 {js_number_to_string(n)}",
            block_id=block_id,
        )
    return n


# --------------------------------------------------------------------------
# 出：依 manifest 的 returns 驗證
# --------------------------------------------------------------------------


def validate_return(
    manifest: Manifest, spec: BlockSpec, result: Any, *, block_id: str | None = None
) -> Any:
    where = _where(manifest, spec)

    if spec.type in ("command", "hat"):
        # command 沒有輸出孔，回傳值無處可去。靜靜丟掉會讓作者以為它有效。
        if result is not None:
            raise ExtensionError(
                f"{where} 是指令型積木，不該回傳值",
                block_id=block_id,
                hint=_PACK_HINT,
            )
        return None

    ensure_transportable(result, where=where, what="回傳值", block_id=block_id)

    declared = spec.declared_return
    if declared in (None, "any"):
        return result

    got = type_of(result)
    if got != declared:
        raise ExtensionError(
            f"{where} 宣告回傳{TYPE_LABELS_ZH[declared]}，實際回傳"
            f"{TYPE_LABELS_ZH[got]}",
            block_id=block_id,
            hint=_PACK_HINT,
        )
    return result


# --------------------------------------------------------------------------
# dropdown 的回傳形狀（§7.3）
# --------------------------------------------------------------------------


def validate_dropdown_options(options: Any, source: str) -> list[dict[str, Any]]:
    if not isinstance(options, list) or not all(
        isinstance(o, dict) and isinstance(o.get("label"), str) and "value" in o
        for o in options
    ):
        raise ExtensionError(f"下拉來源 {source} 必須回傳 [{{label, value}}, ...]")
    return options


# --------------------------------------------------------------------------
# 隱含約束：可 JSON 序列化（§7.5、§12.3）
# --------------------------------------------------------------------------

_MAX_DEPTH = 64


def ensure_transportable(
    v: Any, *, where: str, what: str, block_id: str | None = None
) -> None:
    """從第一天就強制「args 與回傳值必須可 JSON 序列化」。

    檢查的是**語意型別**（§4.3 的六種）而不是 `json.dumps` 跑不跑得動：
    `json.dumps` 會放行 NaN、會用 `default=` 把 datetime 悄悄變成字串，而那
    正是換 IPC 時才會發現的那類問題。這裡用 `type_of` 當唯一的門，因為它已經
    是整個 runtime 對「什麼是值」的定義。
    """

    def walk(node: Any, path: str, depth: int) -> None:
        if depth > _MAX_DEPTH:
            raise ExtensionError(
                f"{where} 的{what}巢狀過深（超過 {_MAX_DEPTH} 層）", block_id=block_id
            )
        try:
            t = type_of(node)
        except TypeCoercionError:
            raise ExtensionError(
                f"{where} 的{what}{path}是 {type(node).__name__}，"
                f"不是可傳輸的值",
                block_id=block_id,
                hint="積木的 args 與回傳值必須可 JSON 序列化（§7.5）",
            ) from None
        if t == TYPE_LIST:
            for i, item in enumerate(node, 1):
                walk(item, f"{path}[{i}]", depth + 1)
        elif t == TYPE_OBJECT:
            for k, item in node.items():
                if not isinstance(k, str):
                    raise ExtensionError(
                        f"{where} 的{what}{path}有非文字的 key（{type(k).__name__}）",
                        block_id=block_id,
                    )
                walk(item, f"{path}.{k}", depth + 1)

    walk(v, "", 0)


__all__ = [
    "ensure_transportable",
    "normalize_args",
    "validate_dropdown_options",
    "validate_return",
]

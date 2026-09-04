"""金鑰讀寫（§12.1、D28）。

`secret` 型 `config` 存進 OS keyring，不是 `project.json` 或任何檔案——分享
專案不能等於分享明文金鑰。**那條線的落點就是這一句**，而不是「明文永遠不
出得了這個模組」：使用者從自己的機器把自己的金鑰複製到自己的剪貼簿
（`api/keys.py` 的 `/reveal`）跟分享專案是兩回事。

這一層只管靜態儲存；事件流的遮蔽是 §12.2、`interpreter/events.py` 的事。
"""

from __future__ import annotations

from typing import Any

import keyring

from blockyard.extensions.manifest import Manifest

SERVICE = "blockyard"


def _username(ext_id: str, key: str) -> str:
    return f"{ext_id}.{key}"


#: webhook 簽章密鑰的命名空間（§9.3、§16 Q22）。用一個**不可能是 ext_id 的
#: 前綴**（積木包 id 不含 `:`），所以它跟積木包的金鑰共用同一個 keyring 服務
#: 卻永遠撞不到。
WEBHOOK_NS = "webhook:"


def webhook_owner(project_id: str) -> str:
    """簽章密鑰的「擁有者」。以專案為範圍，key 是 blockId。

    為什麼是 `專案 + blockId` 而不是 `專案` 一把：一份專案可以同時收 GitHub 與
    某個內部系統的 webhook，而那是兩個不同單位發的密鑰。共用一把等於要求使用者
    去說服其中一邊改。
    """
    return f"{WEBHOOK_NS}{project_id}"


def get(ext_id: str, key: str) -> str | None:
    return keyring.get_password(SERVICE, _username(ext_id, key))


def set(ext_id: str, key: str, value: str) -> None:
    keyring.set_password(SERVICE, _username(ext_id, key), value)


def delete(ext_id: str, key: str) -> bool:
    """拿掉一把。回傳「本來有沒有東西」，讓呼叫端分得出 404 與 204。

    D28 原本寫「沒有單筆刪除」，那是在只能貼 `.env` 的前提下——整份匯入的
    介面裡，單筆刪除確實沒有位置。有了逐筆新增之後它就是同一件事的另一半：
    使用者按得下「加一把」，就一定會想按「拿掉」，不給的結果是他自己去開
    鑰匙圈，而那比在這裡刪危險得多。
    """
    if not is_configured(ext_id, key):
        return False
    keyring.delete_password(SERVICE, _username(ext_id, key))
    return True


def suffix(ext_id: str, key: str) -> str | None:
    """末四碼，給列表用來分辨「現在裝著的是哪一把」。

    D28 的「不顯示明文」在這裡鬆成「不顯示完整明文」——換過金鑰之後看不出
    裝著的是新的還是舊的，是這個面板實際上最常見的困惑。**短的就整個不給**：
    末四碼對一把 6 個字元的密鑰來說不是遮蔽，是洩漏。
    """
    value = get(ext_id, key)
    if not value or len(value) < 8:
        return None
    return value[-4:]


def is_configured(ext_id: str, key: str) -> bool:
    return bool(get(ext_id, key))


def resolve_config(manifests: dict[str, Manifest]) -> dict[str, dict[str, Any]]:
    """每個包宣告的 `secret` 型 config 去 keyring 查一輪，組成
    `open_registry(config=...)` 要的形狀。非 secret 型別目前沒有儲存的地方，
    只落 manifest 的 `default`——`open_config` 面板還是 stub，這是刻意縮小
    的範圍。
    """
    out: dict[str, dict[str, Any]] = {}
    for ext_id, manifest in manifests.items():
        values: dict[str, Any] = {}
        for spec in manifest.config:
            if spec.type == "secret":
                values[spec.key] = get(ext_id, spec.key)
            elif spec.has_default:
                values[spec.key] = spec.default
        if values:
            out[ext_id] = values
    return out


def secret_values(manifests: dict[str, Manifest], config: dict[str, dict[str, Any]]) -> list[str]:
    """§12.2：這次 Run 實際用到的 secret 明文值，餵給 `EventSink` 做值遮蔽。

    吃 `resolve_config()` 已經算好的 `config`，不重新查一次 keyring——`config`
    裡哪些 key 是 secret 型，還是得回頭問 manifest（`config` 這個 dict 本身
    分不出「這是 secret 的值」跟「這是 string 的 default」）。
    """
    out: list[str] = []
    for ext_id, manifest in manifests.items():
        values = config.get(ext_id, {})
        for spec in manifest.config:
            if spec.type == "secret":
                v = values.get(spec.key)
                if v:
                    out.append(v)
    return out


__all__ = [
    "SERVICE",
    "delete",
    "get",
    "is_configured",
    "resolve_config",
    "secret_values",
    "set",
    "suffix",
]

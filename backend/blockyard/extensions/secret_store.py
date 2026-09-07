"""金鑰讀寫（§12.1、D28）。

`secret` 型 `config` 存進 OS keyring，不是 `project.json` 或任何檔案——分享
專案不能等於分享明文金鑰。**那條線的落點就是這一句**，而不是「明文永遠不
出得了這個模組」：使用者從自己的機器把自己的金鑰複製到自己的剪貼簿
（`api/keys.py` 的 `/reveal`）跟分享專案是兩回事。

**一把金鑰屬於一個專案**（§16 Q23）：keyring 的 username 是
`{專案 id}:{ext_id}.{key}`。沒有那一格的話，兩個專案各接一個 Discord bot
時後填的會直接蓋掉先填的，而畫面上沒有任何東西說得出這件事。P0b 存下來的那些
（沒有專案維度）由 `migrate_legacy()` 搬過去一次。

這一層只管靜態儲存；事件流的遮蔽是 §12.2、`interpreter/events.py` 的事。
"""

from __future__ import annotations

from typing import Any

import keyring

from blockyard.extensions.manifest import Manifest

SERVICE = "blockyard"


def _username(owner: str, key: str) -> str:
    return f"{owner}.{key}"


def owner_of(project_id: str, ext_id: str) -> str:
    """**一把金鑰屬於一個專案裡的一個積木包**（§16 Q23、`project-storage-design.md`
    §6）。

    兩個專案各接一個 Discord bot 是最普通不過的事，而在這一格出現之前，後填的
    那一把會直接蓋掉先填的——沒有任何畫面說得出那件事發生過。

    分隔符用 `:`，跟 `WEBHOOK_NS` 同一個理由：積木包 id 不含 `:`（`EXT_ID`），
    專案 id 也不含（`storage.PROJECT_ID`），所以 `prj_ab12:discord.bot_token`
    只有一種拆法。

    **範圍是「這個專案」，不是「這台機器」**，所以換一個專案就是從頭填一次。
    現在的答案是使用者自己複製（金鑰面板給得出完整明文，D28 的 `/reveal`）；
    「從別的專案帶一把過來」是之後的事。
    """
    return f"{project_id}:{ext_id}"


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


def get(owner: str, key: str) -> str | None:
    return keyring.get_password(SERVICE, _username(owner, key))


def set(owner: str, key: str, value: str) -> None:
    keyring.set_password(SERVICE, _username(owner, key), value)


def delete(owner: str, key: str) -> bool:
    """拿掉一把。回傳「本來有沒有東西」，讓呼叫端分得出 404 與 204。

    D28 原本寫「沒有單筆刪除」，那是在只能貼 `.env` 的前提下——整份匯入的
    介面裡，單筆刪除確實沒有位置。有了逐筆新增之後它就是同一件事的另一半：
    使用者按得下「加一把」，就一定會想按「拿掉」，不給的結果是他自己去開
    鑰匙圈，而那比在這裡刪危險得多。
    """
    if not is_configured(owner, key):
        return False
    keyring.delete_password(SERVICE, _username(owner, key))
    return True


def suffix(owner: str, key: str) -> str | None:
    """末四碼，給列表用來分辨「現在裝著的是哪一把」。

    D28 的「不顯示明文」在這裡鬆成「不顯示完整明文」——換過金鑰之後看不出
    裝著的是新的還是舊的，是這個面板實際上最常見的困惑。**短的就整個不給**：
    末四碼對一把 6 個字元的密鑰來說不是遮蔽，是洩漏。
    """
    value = get(owner, key)
    if not value or len(value) < 8:
        return None
    return value[-4:]


def is_configured(owner: str, key: str) -> bool:
    return bool(get(owner, key))


def resolve_config(
    manifests: dict[str, Manifest], *, project_id: str
) -> dict[str, dict[str, Any]]:
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
                values[spec.key] = get(owner_of(project_id, ext_id), spec.key)
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


def migrate_legacy(project_id: str, manifests: dict[str, Manifest]) -> list[str]:
    """P0b 那些**沒有專案維度**的金鑰搬到 `project_id` 底下。回傳搬了哪幾把。

    §3 那條規則的理由就是這件事：改一個 keyring 的字串就是搬一次使用者資料，
    而不搬的症狀是「我什麼都沒改，它說沒設定」——金鑰一把都沒掉，只是沒有人
    再去那個名字底下找過。

    **只搬、不複製**：留著舊的那一份，下一次使用者把新的刪掉時它會復活，而
    一把刪不掉的金鑰比一把要重填的金鑰難懂得多。

    keyring 沒有可攜的「列出全部」，所以搬得動的只有**現在宣告得出來的那幾把**
    （已安裝的包 × 它宣告的 secret）。那正好是唯一有意義的集合：宣告不見了的
    金鑰本來就沒有任何一條路讀得到它。
    """
    moved: list[str] = []
    for ext_id, manifest in manifests.items():
        for spec in manifest.config:
            if spec.type != "secret":
                continue
            new_owner = owner_of(project_id, ext_id)
            if is_configured(new_owner, spec.key):
                continue
            legacy = get(ext_id, spec.key)
            if not legacy:
                continue
            set(new_owner, spec.key, legacy)
            delete(ext_id, spec.key)
            moved.append(f"{ext_id}.{spec.key}")
    return moved


__all__ = [
    "SERVICE",
    "delete",
    "get",
    "is_configured",
    "migrate_legacy",
    "owner_of",
    "resolve_config",
    "secret_values",
    "set",
    "suffix",
]

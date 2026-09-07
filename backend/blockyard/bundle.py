"""一份專案怎麼帶出門（`docs/project-storage-design.md` §5、§7）。

**儲存是參照，運輸是打包。** 活著的專案只記積木包的 id（IR 的 `extensions`
就是這個形狀），程式碼住在 per-machine 的 `~/.blockyard/extensions/`；**匯出時
才把用到的那幾個包的原始碼複製進 bundle**。

那不是折衷，是兩件不同的東西：store 是共用的（五個專案都用 `discord`，磁碟上
一份），bundle 是自足的（它要在一台什麼都沒有的機器上展得開）。沒有一個系統
把「我電腦上的安裝」與「我寄出去的那一份」做成同一個東西，因為它們的最佳形狀
剛好相反：前者要去重，後者要自足。

    我的專案.blockyard          （就是一個 .zip）
      bundle.json               ← 格式版本、匯出時間、帶了哪幾個包、每個包的 digest
      project.json              ← IR 原文，一個欄位不多一個不少
      extensions/
        greet/
          manifest.yaml
          main.py
          ...

**不帶 venv**：裡面的路徑是絕對的，換一台機器就錯（`pack_files` 早就跳過
`.venv` 了，同一條規則）。依賴在收的那一端從 `requirements` 重建。

**不帶收據**（`.blockyard-source.json`）。理由與「一個包不能自己說自己從哪來」
一模一樣，只是主詞換成一份 bundle：**別人的專案檔不能告訴我的機器某個包是官方
的。** 收的那一端自己開一張新的（`origin: "bundle"`）。解壓那一步就把它丟掉了
（`install._is_junk`），所以這條規則不必靠匯出端的自律。

**不帶金鑰**（D28）。那是另一個檔案，見 `api/bundle.py` 的 `.env` 那一段：一份
帶金鑰的 bundle 與一份不帶的如果是同一個檔案，它就會被轉寄、被丟上 GitHub——
而那一刻沒有人記得三天前勾過什麼。
"""

from __future__ import annotations

import io
import json
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from blockyard.errors import BlockyardError
from blockyard.extensions import discover, receipt
from blockyard.extensions.manifest import pack_files, read_pack
from blockyard.storage import PROJECT_ID, StoredProject

#: 副檔名。**一個字就說得出「這是一份專案」**，而它同時是使用者在檔案總管裡
#: 唯一分得出 bundle 與普通 zip 的東西。
SUFFIX = ".blockyard"

#: bundle 自己的格式版本。與 IR 的 `formatVersion` 分開：一份 bundle 的外殼
#: （帶了哪幾個包、digest 怎麼算）與裡面那份 IR 是兩件會各自演化的事。
FORMAT_VERSION = 1

MANIFEST_NAME = "bundle.json"
PROJECT_NAME = "project.json"
EXT_DIR = "extensions"


@dataclass(frozen=True)
class BundlePack:
    """bundle 裡的一個積木包（`bundle.json` 的一列）。"""

    id: str
    name: str
    version: str
    #: 匯出那一刻的內容雜湊。收的那一端拿它回答一個具體問題：「我手上這個
    #: `http`，跟這份 bundle 裡的是不是同一個」（§7）。
    digest: str

    def to_json(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "version": self.version, "digest": self.digest}


@dataclass(frozen=True)
class Bundle:
    """讀回來的一份 bundle。"""

    #: `project.json` 的原文。**一個欄位不多一個不少**——收的那一端存進去的
    #: 就是這一份（同 `storage/projects.py` 的 round-trip 規則）。
    project: dict[str, Any]
    packs: list[BundlePack]
    #: 解開之後那個目錄。`extensions/<id>` 就在底下，安裝時整個搬走。
    dir: Path
    exported_at: str | None = None


def build(stored: StoredProject, *, extensions_root: Path) -> bytes:
    """把一份專案折成一個 `.blockyard`。

    **帶的是「這份專案真的用到的包」**（IR 的 `extensions`，那是從畫布上的積木
    算出來的事實），不是使用者工具箱上加過的那些。一個加進工具箱、還沒拉出積木
    的包不會進 bundle——bundle 描述的是這份專案，不是我當時的桌面。

    宣告了但這台機器上沒有的包**跳過，不是錯誤**（§13.3 的同一條線）：那份
    IR 本來就跑得起來，只是那幾顆積木是佔位符。硬要在匯出這一步失敗，等於讓
    一個早就壞了的專案連備份都做不出來。
    """
    sources = discover(extensions_root)
    packs: list[BundlePack] = []
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for ext_id in _declared(stored.data):
            source = sources.get(ext_id)
            if source is None:
                continue
            packs.append(
                BundlePack(
                    id=ext_id,
                    name=source.manifest.name,
                    version=source.manifest.version,
                    digest=receipt.digest(source.dir),
                )
            )
            for path in pack_files(source.dir):
                rel = path.relative_to(source.dir).as_posix()
                zf.writestr(f"{EXT_DIR}/{ext_id}/{rel}", path.read_bytes())

        zf.writestr(
            MANIFEST_NAME,
            json.dumps(
                {
                    "formatVersion": FORMAT_VERSION,
                    "exportedAt": _now(),
                    "project": {"id": stored.id, "name": stored.name},
                    "extensions": [p.to_json() for p in packs],
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
        )
        # IR 原文，**不經過任何模型重新序列化**：存的是 PUT 進來的那一份，
        # 匯出的也要是同一份（`storage/projects.py` 開頭那段的理由）。
        zf.writestr(
            PROJECT_NAME, json.dumps(stored.data, ensure_ascii=False, indent=2) + "\n"
        )
    return buf.getvalue()


def read(dest: Path) -> Bundle:
    """把一個**已經解開**的目錄讀成 `Bundle`。解壓那一步在 `api/bundle.py`
    ——它與積木包共用同一個解壓器（symlink、壓縮炸彈、`..` 那幾條規則沒有
    第二份實作）。

    讀不出來就丟 `BlockyardError`，而且每一句話都說得出使用者手上那個檔案
    哪裡不對——這條路的另一端是一個剛選完檔案的人。
    """
    meta = _read_json(dest / MANIFEST_NAME, "bundle.json")
    version = meta.get("formatVersion")
    if version != FORMAT_VERSION:
        raise BlockyardError(
            f"這份專案檔的格式是 v{version}，這個版本的 Blockyard 讀的是 v{FORMAT_VERSION}"
        )
    project = _read_json(dest / PROJECT_NAME, "project.json")

    packs: list[BundlePack] = []
    for entry in meta.get("extensions") or []:
        if not isinstance(entry, dict):
            continue
        ext_id = entry.get("id")
        if not isinstance(ext_id, str):
            continue
        pack_dir = dest / EXT_DIR / ext_id
        if not (pack_dir / "manifest.yaml").is_file():
            # `bundle.json` 說有、檔案卻不在。**跳過而不是拒收整份**：那份 IR
            # 仍然打得開，而少的那幾顆積木會是佔位符（§13.3）——那比「這個檔案
            # 壞了」更接近真相，也更可解。
            continue
        # **版本與名字從 manifest 讀，不從 `bundle.json` 讀**：後者是匯出那一端
        # 寫的一句話，而前者是真的會被裝進來的那份東西自己說的。digest 同理，
        # 由收的那一端自己算（見 `api/bundle.py` 的比對）。
        source = read_pack(pack_dir, expect_id=ext_id)
        packs.append(
            BundlePack(
                id=ext_id,
                name=source.manifest.name,
                version=source.manifest.version,
                digest=receipt.digest(pack_dir),
            )
        )

    return Bundle(
        project=project,
        packs=packs,
        dir=dest,
        exported_at=meta.get("exportedAt") if isinstance(meta.get("exportedAt"), str) else None,
    )


def bundled_id(project: dict[str, Any]) -> str | None:
    """bundle 裡那份 IR 自稱的 id。形狀不合就 `None`。

    收的那一端**在這個 id 沒被占用時會沿用它**（§3：匯出再匯入回來不動 id，
    那讓 keyring 裡那幾把金鑰仍然指得到同一個專案），占用了就開一個新的
    （§10：技術上一定並存）。
    """
    raw = (project.get("meta") or {}).get("id") if isinstance(project.get("meta"), dict) else None
    return raw if isinstance(raw, str) and PROJECT_ID.match(raw) else None


def filename_for(name: str) -> str:
    """一個專案名字變成一個檔名。

    路徑分隔符與控制字元洗掉，剩下的**原樣留著**——中文、空白、括號在
    macOS 與 Windows 上都是合法的檔名，替使用者把「我的專案」改成
    `wo-de-zhuan-an` 只會讓他在下載資料夾裡找不到自己剛剛存的東西。
    """
    cleaned = "".join(
        c for c in name if c.isprintable() and c not in '/\\:*?"<>|'
    ).strip()
    return f"{cleaned[:80] or '未命名專案'}{SUFFIX}"


def _declared(data: dict[str, Any]) -> list[str]:
    return [
        e["id"]
        for e in (data.get("extensions") or [])
        if isinstance(e, dict) and isinstance(e.get("id"), str)
    ]


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError:
        raise BlockyardError(f"這個檔案裡沒有 {label}——它看起來不是一份 Blockyard 專案") from None
    except ValueError:
        raise BlockyardError(f"這份專案檔的 {label} 壞了，讀不出來") from None
    if not isinstance(data, dict):
        raise BlockyardError(f"這份專案檔的 {label} 壞了，讀不出來")
    return data


def _now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


__all__ = [
    "EXT_DIR",
    "FORMAT_VERSION",
    "MANIFEST_NAME",
    "PROJECT_NAME",
    "SUFFIX",
    "Bundle",
    "BundlePack",
    "build",
    "bundled_id",
    "filename_for",
    "read",
]

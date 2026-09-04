"""§12.1 的「靜態掃描」：AST 偵測危險呼叫，與 `permissions` 宣告不符時警告。

**先講清楚它不是什麼。** 這不是沙箱，也不是一道擋得住惡意的門——
`getattr(__builtins__, "ev" + "al")` 一行就繞過去了，而積木包本來就是以使用者
權限跑在他自己的機器上（§12 的威脅模型第一句）。真正守得住的是 §7.6 的 venv
隔離與**使用者自己看那份原始碼**。

它是什麼：**一支指著程式碼的手指**。審閱畫面上攤開的是幾百行 Python，而使用者
多半不會逐行讀完；這裡做的事是把「第 42 行在開子行程」放到他眼前，讓那幾百行
裡值得看的那幾行有一個入口。所以：

* **命中不擋安裝**（§12.1 是「知情同意」，不是審核）。
* **寧可誤報也要說**——一個包 `import httpx` 卻沒宣告 `net`，最無害的解釋是
  作者忘了寫宣告，而那件事本身就值得使用者知道：`permissions` 那一列是他唯一
  拿到的摘要，而摘要跟程式碼對不起來就是摘要沒有用。
* **漏報是必然的**，所以文案不能說「安全」。它只說得出「我看到了這些」。

`permission` 有值的 finding 會跟 manifest 的宣告對一次（`review()`），對不上的
那幾條在畫面上另外標出來——那正是 §12.1 表格裡「與宣告不符時警告」那一格。
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

from blockyard.extensions.manifest import Manifest, Permission, pack_files

#: `import X` / `from X import ...` 的根模組 → （對應權限, 說給使用者聽的一句話）。
#:
#: 只列**根**模組：`urllib.request` 與 `urllib.parse` 差很多，但這裡的目的是
#: 指路不是判決，而多看一眼 `urllib.parse` 的成本遠低於漏掉 `urllib.request`。
_IMPORTS: dict[str, tuple[Permission | None, str]] = {
    "subprocess": ("subprocess", "會開別的程式"),
    "multiprocessing": ("subprocess", "會開別的行程"),
    "pty": ("subprocess", "會開一個終端機"),
    "socket": ("net", "會直接開網路連線"),
    "ssl": ("net", "會開加密的網路連線"),
    "asyncio.streams": ("net", "會直接開網路連線"),
    "requests": ("net", "會自己打網路（不經過 ctx.http）"),
    "httpx": ("net", "會自己打網路（不經過 ctx.http）"),
    "aiohttp": ("net", "會自己打網路（不經過 ctx.http）"),
    "urllib": ("net", "可能會自己打網路（不經過 ctx.http）"),
    "http": ("net", "可能會自己打網路（不經過 ctx.http）"),
    "ftplib": ("net", "會連 FTP"),
    "smtplib": ("net", "會寄信"),
    "websockets": ("net", "會開 WebSocket"),
    "shutil": ("fs.write", "會搬移或刪除檔案"),
    "tempfile": ("fs.write", "會寫暫存檔"),
    "sqlite3": ("fs.write", "會開資料庫檔案"),
    "ctypes": (None, "會直接呼叫作業系統的原生程式庫"),
    "marshal": (None, "會載入 Python 的內部位元組格式"),
    "pickle": (None, "會反序列化 pickle（等同執行任意程式碼）"),
    "keyring": (None, "會碰作業系統的鑰匙圈"),
}

#: 點名的呼叫。key 是**寫在程式碼裡的樣子**——`os.system(...)` 認得，
#: `from os import system` 之後的 `system(...)` 認不得（見模組 docstring 的「漏報」）。
_CALLS: dict[str, tuple[Permission | None, str]] = {
    "eval": (None, "會把字串當程式碼跑"),
    "exec": (None, "會把字串當程式碼跑"),
    "compile": (None, "會把字串編成程式碼"),
    "__import__": (None, "會用字串決定要載入哪個模組"),
    "open": ("fs.read", "會開檔案"),
    "os.system": ("subprocess", "會用 shell 執行一行指令"),
    "os.popen": ("subprocess", "會用 shell 執行一行指令"),
    "os.remove": ("fs.write", "會刪檔案"),
    "os.unlink": ("fs.write", "會刪檔案"),
    "os.rename": ("fs.write", "會搬檔案"),
    "os.getenv": ("env", "會讀環境變數"),
    "os.environ.get": ("env", "會讀環境變數"),
    "importlib.import_module": (None, "會用字串決定要載入哪個模組"),
}

#: 讀屬性就算數的那幾個（`os.environ["X"]` 不是呼叫）。
_ATTRS: dict[str, tuple[Permission | None, str]] = {
    "os.environ": ("env", "會讀環境變數"),
}


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    message: str
    #: 這件事屬於哪一項 `permissions`。`None` = 不對應任何一項（`eval` 那類），
    #: 所以它永遠只是「說一聲」，不會變成「宣告不符」。
    permission: Permission | None
    #: manifest 有沒有宣告這一項。`permission is None` 時固定為 `True`——
    #: 沒有對應的宣告，就沒有「不符」可言。
    declared: bool = True


def scan_pack(pack_dir: Path, manifest: Manifest) -> list[Finding]:
    """掃一個包目錄下的每一支 `.py`，照檔名與行號排好。

    `__pycache__` 與 `.venv` 那幾層不算（`PACK_SKIP_DIRS`）——對著 pip 裝進來的
    東西亮紅燈，只會讓這份清單在第一個包就長到沒有人看。

    **只掃 `.py`**：面板的 JS 跑在 `sandbox` 的 iframe 裡、`connect-src 'none'`
    （見 `api/extensions.py::_panel_csp`），它能做的事已經被瀏覽器框住了；而
    Python 那一側是完整的機器權限。兩邊的風險差一個數量級，一份把兩者混在一起
    的清單只會讓真正要看的那幾行被稀釋掉。
    """
    declared = set(manifest.permissions)
    out: list[Finding] = []
    for path in (p for p in pack_files(pack_dir) if p.suffix == ".py"):
        rel = path.relative_to(pack_dir).as_posix()
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        try:
            tree = ast.parse(text, filename=rel)
        except SyntaxError as e:
            # **語法錯誤要說出來**，而且它比任何一條規則都值得說：這個包裝進去
            # 之後，症狀是工具箱裡一顆按了就報「載入 main.py 失敗」的積木，而
            # 那要等到使用者真的拖出來按下去才會發生。
            out.append(
                Finding(
                    path=rel,
                    line=e.lineno or 1,
                    message=f"這個檔案的語法有錯，Python 讀不進去：{e.msg}",
                    permission=None,
                )
            )
            continue
        out.extend(_walk(tree, rel, declared))
    return out


def _walk(tree: ast.AST, rel: str, declared: set[Permission]) -> list[Finding]:
    out: list[Finding] = []
    # 同一行同一件事只說一次。`os.environ.get(...)` 同時命中 `_CALLS` 的
    # `os.environ.get` 與 `_ATTRS` 的 `os.environ`——兩條說的是同一件事，而重複
    # 的條目會讓這份清單看起來比實際嚴重。比對的是**理由**不是訊息：訊息裡帶著
    # 「哪一個寫法」，而那正是兩條唯一不同的地方。
    seen: set[tuple[int, Permission | None, str]] = set()

    def add(line: int, hit: tuple[Permission | None, str], what: str) -> None:
        perm, why = hit
        if (line, perm, why) in seen:
            return
        seen.add((line, perm, why))
        out.append(
            Finding(
                path=rel,
                line=line,
                message=f"{what}：{why}",
                permission=perm,
                declared=perm is None or perm in declared,
            )
        )

    # **先掃呼叫再掃屬性**：`os.environ.get(...)` 兩邊都命中，而先跑的那個決定
    # 使用者看到的是哪一個寫法。`os.environ.get()` 比 `os.environ` 準。
    nodes = list(ast.walk(tree))
    for node in nodes:
        if isinstance(node, ast.Import):
            for alias in node.names:
                if hit := _IMPORTS.get(alias.name.split(".")[0]):
                    add(node.lineno, hit, f"import {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if hit := _IMPORTS.get(root):
                add(node.lineno, hit, f"from {node.module} import …")
        elif isinstance(node, ast.Call):
            if (name := _dotted(node.func)) and (hit := _CALLS.get(name)):
                add(node.lineno, hit, f"{name}()")
    for node in nodes:
        if isinstance(node, ast.Attribute) and (name := _dotted(node)):
            if hit := _ATTRS.get(name):
                add(node.lineno, hit, name)

    out.sort(key=lambda f: (f.line, f.message))
    return out


def _dotted(node: ast.AST) -> str | None:
    """`os.environ.get` → `"os.environ.get"`；認不出來就 `None`。

    只走 `Name` 與 `Attribute` 兩種：`d["os"].system(...)` 這種寫法接不出名字，
    而那正是漏報那一半（模組 docstring）。
    """
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name):
        return None
    parts.append(node.id)
    return ".".join(reversed(parts))


__all__ = ["Finding", "scan_pack"]

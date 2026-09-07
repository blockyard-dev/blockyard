"""插件的暫存、安裝、更新與解除安裝。

stage() 只解壓與驗證宣告，review() 產生安裝摘要；install()/update() 才安裝
Python 依賴並搬入目錄。兩段共用同一份暫存 bytes 與來源收據。純前端包跳過
Python 環境，安裝不執行 JS。保留路徑、大小、名稱檢查與垃圾桶回復機制。
"""

from __future__ import annotations

import contextlib
import gzip
import io
import json
import re
import shutil
import stat
import tarfile
import time
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import IO

from blockyard.errors import ExtensionError
from blockyard.extensions import bundled, receipt, trash
from blockyard.extensions.manifest import (
    RECEIPT_FILE,
    ExtensionSource,
    in_skipped_dir,
    read_pack,
)
from blockyard.extensions.venv import discard_venv, ensure_interpreter

#: 壓縮檔本身的上限。一個積木包是幾個 `.py` 加一份 manifest，帶了 vendored
#: three.js 的面板包也就幾 MB——32MB 給的是很寬的餘裕，擋的是「有人把整個
#: node_modules 拖進來」與那個 request 在記憶體裡的樣子。
MAX_ZIP_BYTES = 32 * 1024 * 1024
#: 解開之後的總量上限。**這一條才是擋 zip bomb 的那一條**：42KB 的壓縮檔可以
#: 解出 4.5PB，而上面那條看到的永遠是 42KB。
MAX_TOTAL_BYTES = 128 * 1024 * 1024
#: 條目數上限。大小不是唯一的成本——一百萬個空檔案的總量是 0。
MAX_MEMBERS = 4000

#: macOS 的 Finder 對著資料夾按「壓縮」就會多出這兩樣東西。**跳過而不是拒絕**：
#: 這是這個專案的使用者最可能用來包一個積木包的動作，而為了兩個他看不見的檔案
#: 說「這個 zip 有問題」，等於要求他去學 `zip -x`。
_JUNK_PREFIXES = ("__MACOSX/",)
#: `RECEIPT_FILE` 在這裡是刻意的：**一個包不能自己說自己從哪來**（§2）。
#: 丟掉而不是拒收——我們本來就會寫自己那一張，收下再覆蓋只是多一步。
_JUNK_NAMES = (".DS_Store", "Thumbs.db", RECEIPT_FILE)

#: 積木包 id 的形狀。與 `manifest.py` 那條同一份規則（目錄名必須等於 id），
#: 抄過來是因為這裡用它做的事不一樣：那裡驗的是宣告，這裡驗的是**一個會被
#: 接成路徑、然後整個搬走的字串**。
#:
#: 公開的，因為 API 那一層也要它：每一條吃 `{ext_id}` 的路由在把那個字串接成
#: 路徑之前都得問同一個問題，而問兩種形狀的話，比較寬的那一條就是那道門。
EXT_ID = re.compile(r"^[a-z][a-z0-9_]*$")

#: staging token 的形狀。**一定要驗**——它會被接成一個路徑，而
#: `../../etc` 是一個看起來很無辜的字串。
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{16,64}$")

#: 說不出檔名時，收據上那一行。
UPLOADED = "從這台電腦上傳"


@dataclass(frozen=True)
class Staged:
    """解開了、讀得進來、還沒裝的一個包。"""

    token: str
    dir: Path
    source: ExtensionSource
    #: bytes 從哪來。**在 `stage()` 那一刻就定了**，而且落在暫存區的一個
    #: sidecar 檔案裡（`origin_path`），不是等按下安裝才問——按下安裝的那個
    #: 請求只帶得動一個 token，而「來源是安裝的人記的」要成立，記的時機就得
    #: 是我們手上真的拿著那份 bytes 的時候。
    origin: receipt.Origin


def stage(
    data: bytes, staging_root: Path, *, token: str, origin: receipt.Origin
) -> Staged:
    """把上傳的 bytes 解成一個暫存的積木包目錄。

    讀不進來就丟 `ExtensionError`，而且**暫存目錄會被清掉**——失敗留下的東西
    沒有人會再來收。

    `origin` 在這裡收下並**寫進暫存區**（`origin_path`），因為這是我們手上真的
    拿著那份 bytes 的一刻。按下安裝的那個請求只帶得動一個 token。
    """
    if len(data) > MAX_ZIP_BYTES:
        raise ExtensionError(
            f"這個檔案有 {len(data) // 1024 // 1024}MB，"
            f"超過 {MAX_ZIP_BYTES // 1024 // 1024}MB 的上限"
        )
    dest = staged_dir(staging_root, token)
    dest.mkdir(parents=True)
    try:
        extract_archive(data, dest)
        if not (dest / "manifest.yaml").is_file():
            raise ExtensionError(
                "這裡面沒有 manifest.yaml。一個積木包的最外層要有 "
                "manifest.yaml 與 main.py（壓縮那個資料夾本身也可以）"
            )
        source = read_pack(dest)
        _write_origin(staging_root, token, origin)
    except Exception:
        discard(staging_root, token)
        raise
    return Staged(token=token, dir=dest, source=source, origin=origin)


async def install(staged: Staged, extensions_root: Path) -> ExtensionSource:
    """把暫存目錄變成一個裝好的積木包。回傳它在新家的樣子。

    **同 id 的已經在那裡就不是這條路**——那是 `update()`，而兩者的差別不在
    「要不要覆蓋檔案」，在於畫布上已經有它的積木，所以要先有一段差集。這裡
    誠實地拒絕，而不是偷偷變成一次更新。
    """
    ext_id = staged.source.id
    target = extensions_root / ext_id
    if target.exists():
        raise ExtensionError(f"「{ext_id}」已經裝過了。要換一版走的是更新那條路")
    if not extensions_root.is_dir():
        raise ExtensionError(f"積木包資料夾不存在：{extensions_root}")

    # 失敗就整條停在這裡：什麼都還沒搬進去，使用者按下「安裝」之前與之後這台
    # 機器上的積木包一模一樣（見模組 docstring 的順序）。
    if staged.source.has_python:
        await ensure_interpreter(ext_id, staged.source.manifest.requirements)
    source = _finish(staged, target)
    # 墓碑說的是「我現在不要這個 id」，而他剛剛親手裝了一個同名的包。
    bundled.forget_tombstone(extensions_root, ext_id)
    return source


async def update(
    staged: Staged, extensions_root: Path
) -> tuple[ExtensionSource, trash.Stashed]:
    """換一版。回傳新的那一份，以及舊的那一份去了垃圾桶的哪裡。

    **順序不是「刪掉再裝」**（§4）：舊的先搬進垃圾桶，任何一步失敗就搬回來。
    那個垃圾桶同時是「更新完發現更糟」的退路——所以它去了哪裡要回傳出去，
    不能只是一個實作細節。

    **沒有收據的不更新**，跟不解除安裝是同一條規則的同一面（§2）：那個資料夾
    是使用者自己放的，很可能就是他正在編輯的東西，而更新會把它整份搬走。

    venv 在動任何檔案之前就先建好（模組 docstring 的順序）。它有一個誠實的
    代價：venv 是掛在 id 上的，所以新版的依賴裝進去之後，即使更新失敗、舊的
    包搬回來了，那支 venv 裡也已經是新的依賴。那不會壞掉舊版（依賴幾乎總是
    往上長），而且下一次載入時 `ensure_interpreter` 看 `.requirements.lock`
    對不上就會裝回去。**把 venv 也做成可回滾要在磁碟上留兩份**，而那個成本
    買到的是一個會自己修好的狀態。
    """
    ext_id = staged.source.id
    target = extensions_root / ext_id
    if not (target / "manifest.yaml").is_file():
        raise ExtensionError(f"「{ext_id}」還沒裝過，所以沒有東西可以更新")
    if receipt.read(target) is None:
        raise ExtensionError(
            f"「{ext_id}」是你自己放進 {extensions_root} 的，我們不動它——"
            "沒有收據的資料夾很可能正是你在編輯的那一份。要換掉它就自己把那個"
            "資料夾移走，再裝一次"
        )

    if staged.source.has_python:
        await ensure_interpreter(ext_id, staged.source.manifest.requirements)

    stashed = trash.stash(target, trash_root=trash.root_for(extensions_root))
    try:
        return _finish(staged, target), stashed
    except Exception:
        # 搬到一半失敗。**退回原狀，而不是留下半個包**——後者會讓工具箱上那
        # 一格在下一次重新整理時消失，而使用者做的事只是按了一下更新。
        trash.restore(stashed)
        raise


def uninstall(ext_id: str, extensions_root: Path) -> trash.Stashed:
    """把一個包從磁碟上移走（§5 選單上的「解除安裝⋯」）。

    **核心規則：只解除安裝我們裝的**（§2）。沒有收據 = 使用者自己放的 =
    不碰。那不是錯誤狀態——那是一個人正在那個資料夾裡寫他自己的包，而替他
    刪掉一個他正在編輯的目錄，是這整份設計裡唯一一件真的會弄丟東西的事。

    做的三件事，順序有意義：

    1. **搬進垃圾桶**（不是刪掉）。這一步成功了，這個包就算移除了。
    2. **立一張墓碑**。官方包的資料夾一旦不在，「只鋪不存在的」就會在下一次
       啟動時把它鋪回來——而使用者剛剛才拔掉它（§8）。
    3. **丟掉 venv**。它整份都是從 `requirements` 算出來的，重建只要一句話。

    **不管畫布上還有沒有它的積木。** 那個判斷在前端（那份工作區還沒存檔，
    後端手上那一份可能是十分鐘前的），與「刪除一個擴充功能」共用同一條路。
    """
    target = _pack_dir(extensions_root, ext_id)
    if not (target / "manifest.yaml").is_file():
        raise ExtensionError(f"這台機器上沒有裝「{ext_id}」")
    if receipt.read(target) is None:
        raise ExtensionError(
            f"「{ext_id}」是你自己放進 {extensions_root} 的，我們不碰它。"
            "要移除就自己把那個資料夾拿走"
        )

    stashed = trash.stash(target, trash_root=trash.root_for(extensions_root))
    bundled.tombstone(extensions_root, ext_id)
    discard_venv(ext_id)
    return stashed


def _pack_dir(extensions_root: Path, ext_id: str) -> Path:
    """`extensions_root / ext_id`，但先確認 `ext_id` 真的是一個 id。

    **一定要驗**：這個字串從 URL 路徑來，而它會被接成一個路徑——接下來那幾
    行做的事是「把這個目錄搬到垃圾桶」，所以 `../../Documents` 是一個看起來
    很無辜的字串。形狀跟 manifest 的 id 是同一條（`EXT_ID`），因為目錄名與
    id 必須一致（`scan()`）。
    """
    if not EXT_ID.match(ext_id):
        raise ExtensionError(f"「{ext_id}」不是一個合法的積木包 id")
    return extensions_root / ext_id


def _finish(staged: Staged, target: Path) -> ExtensionSource:
    """搬進去、開收據，然後**用新家的路徑重讀一次**。

    重讀不是保險，是必要的：`ExtensionSource.dir` 指著暫存目錄，而那個目錄下
    一秒就不在了。回傳一份指著舊路徑的東西，症狀會是面板資源與封面 404。

    **收據在搬完之後才寫**：它記的 digest 是「裝進去的那一份」，而在搬之前
    那句話還沒有主詞。順序也讓失敗的樣子單純——搬失敗就什麼都沒有，而不是
    一張指著不存在的目錄的收據。
    """
    shutil.move(str(staged.dir), str(target))
    receipt.write(target, staged.origin, version=staged.source.manifest.version)
    return read_pack(target, expect_id=target.name)


def discard(staging_root: Path, token: str) -> None:
    """使用者按了取消，或審閱畫面被關掉。**本來就不在也算成功**——這個函式
    描述的是結束狀態。"""
    shutil.rmtree(staged_dir(staging_root, token), ignore_errors=True)
    origin_path(staging_root, token).unlink(missing_ok=True)


def purge_stale(staging_root: Path, *, max_age: float = 3600) -> None:
    """收掉沒有人按下一步的暫存目錄。

    使用者選了一個 `.zip`、看了一眼摘要、覺得不對就關掉分頁——那條路上沒有
    任何一個請求告訴後端可以清了。掛在「下一次有人匯入」而不是一個排程上：
    這件事的成本與頻率都低到不值得一個活著的 task，而唯一會累積出東西的人正是
    那個又來匯入一次的人。
    """
    if not staging_root.is_dir():
        return
    deadline = time.time() - max_age
    for d in staging_root.iterdir():
        try:
            if d.stat().st_mtime >= deadline:
                continue
            if d.is_dir():
                shutil.rmtree(d, ignore_errors=True)
            else:
                # 來源那張 sidecar。它比目錄小得多，但一樣會累積。
                d.unlink(missing_ok=True)
        except OSError:
            continue


def staged_dir(staging_root: Path, token: str) -> Path:
    if not _TOKEN.match(token):
        raise ExtensionError("這個匯入編號不合法")
    return staging_root / token


def origin_path(staging_root: Path, token: str) -> Path:
    """來源那張 sidecar。

    **放在暫存的包目錄旁邊，不是裡面**：那個目錄整個會被搬進 extensions root，
    而審閱畫面攤開的正是它——一個使用者沒看過、卻出現在「這個 .zip 裡有什麼」
    清單上的檔案，本身就是一句需要解釋的話。
    """
    return staged_dir(staging_root, token).with_name(f"{token}.origin.json")


def _write_origin(staging_root: Path, token: str, origin: receipt.Origin) -> None:
    origin_path(staging_root, token).write_text(
        json.dumps(asdict(origin), ensure_ascii=False), encoding="utf-8"
    )


def read_origin(staging_root: Path, token: str) -> receipt.Origin:
    """把 sidecar 讀回來。

    **讀不到不是錯誤**：後端在使用者查看摘要期間裡重啟過、或是這份匯入
    來自舊版本。那時候唯一還說得出口的真話是「使用者從自己的電腦裝的」——
    origin 仍然是 `zip`，只是那一行 label 給不出檔名。
    """
    try:
        data = json.loads(origin_path(staging_root, token).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict) or data.get("origin") not in receipt.ORIGINS:
        return receipt.Origin(origin="zip", label=UPLOADED)

    def text(key: str) -> str | None:
        value = data.get(key)
        return value if isinstance(value, str) else None

    return receipt.Origin(
        origin=str(data["origin"]),
        label=text("label") or UPLOADED,
        url=text("url"),
        ref=text("ref"),
        commit=text("commit"),
    )


# --------------------------------------------------------------------------
# 解壓
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class _Member:
    """壓縮檔裡的一個檔案，已經洗過名字。

    `.zip` 與 `.tar.gz` 只差在誰產生這份清單——**規則一條都不能差**。§3 說
    「多一個來源不該多一條驗證路徑，不然『從 GitHub 裝的包比較少檢查』遲早
    是真的」，而那句話在程式碼裡就是這個 dataclass：`.tar.gz` 是 GitHub 那條
    路的形狀（§6），它走的是同一段 `_write`。
    """

    #: 洗乾淨的相對路徑（POSIX）。
    name: str
    #: 壓縮檔 header 自己報的大小。**它是壓縮檔說的話**，不是事實——真正的
    #: 把關在 `_copy`，這裡只用來早一點擋掉一個一看就過大的東西。
    size: int
    open: Callable[[], IO[bytes]]


def extract_archive(data: bytes, dest: Path) -> None:
    """把一個壓縮檔解到 `dest`，**每一個條目都要自己走一遍規則**。

    標準函式庫的 `extractall()` 擋得掉絕對路徑與 `..`（`tarfile` 從 3.12 起
    也有 `filter="data"`），但它們擋不住這裡在乎的另外三件事：**symlink**
    （兩種格式都存得下，而一條指向 `~/.ssh` 的連結每個字元都合法——
    `panel_asset()` 那條路正是為了它才比對 `resolve()`）、**解壓後的總量**
    （壓縮炸彈），以及**最外層那一層資料夾**（見 `_strip_root`）。三件都要在
    寫進磁碟之前決定，所以這裡先掃一遍名單再寫。

    **格式靠開頭那幾個位元組認，不靠副檔名。** 副檔名是使用者打的字，而
    GitHub 那條路上根本沒有檔名（§3：三個入口只差「怎麼把 bytes 弄到暫存
    目錄」，而這裡已經是「拿到了」之後）。

    **匯入一份專案 bundle 走的也是這裡**（`api/bundle.py`）。那份 `.blockyard`
    裡裝著別人機器上的積木包原始碼，所以上面每一條規則對它一字不改地成立——
    寫第二個解壓器就是讓其中一條規則遲早只在其中一邊生效。
    """
    with _archive(data) as members:
        _write(members, dest)


@contextlib.contextmanager
def _archive(data: bytes) -> Iterator[list[_Member]]:
    """認得的兩種壓縮檔 → 一份 `_Member` 清單。

    context manager 而不是回傳清單：`open` 那幾個 callable 讀的是還開著的
    `ZipFile`／`TarFile`，所以它們的壽命必須綁在一起。
    """
    if data[:2] == b"\x1f\x8b":
        try:
            tf = tarfile.open(fileobj=io.BytesIO(_gunzip(data)))
        except tarfile.TarError:
            # gzip 解得開、裡面卻不是一份 tar。**這仍然是使用者送進來的東西**，
            # 所以它是一句話不是一個 500。
            raise ExtensionError("這個 .tar.gz 壞了，解不開") from None
        with tf:
            yield _tar_members(tf)
    elif data[:2] == b"PK":
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile:
            raise ExtensionError("這個 .zip 壞了，解不開") from None
        with zf:
            yield _zip_members(zf)
    else:
        raise ExtensionError("認不得這個檔案——積木包要是一個 .zip 或 .tar.gz")


def _gunzip(data: bytes) -> bytes:
    """先解 gzip 那一層，**而且有上限**。

    `tarfile` 讀 `.tar.gz` 是串流的，所以光是列出裡面有哪些檔案就會把整條
    gzip 解完——一個 32MB 的 `.tar.gz` 可以解出幾百 GB，而那一步在
    `MAX_TOTAL_BYTES` 有機會說話之前就跑完了。這裡把那一層先解在記憶體裡並
    數著，於是「列目錄」這件事本身也受同一條上限管。

    代價是最壞情況下記憶體裡有 128MB。這台後端只服務本機的一個人（§12.1），
    而換到的是「所有格式共用同一條總量規則」。
    """
    out = io.BytesIO()
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as gz:
            while chunk := gz.read(1024 * 1024):
                out.write(chunk)
                if out.tell() > MAX_TOTAL_BYTES:
                    raise ExtensionError(
                        f"解開之後超過 {MAX_TOTAL_BYTES // 1024 // 1024}MB，不收"
                    )
    except (OSError, EOFError):
        # 半截的下載、或一個開頭剛好像 gzip 的東西。`BadGzipFile` 是 `OSError`
        # 的子類別，而它與真正的 I/O 錯誤在這條路上是同一件事：這份 bytes 讀
        # 不成一個壓縮檔。
        raise ExtensionError("這個 .tar.gz 壞了，解不開") from None
    return out.getvalue()


def _zip_members(zf: zipfile.ZipFile) -> list[_Member]:
    members = []
    for info in zf.infolist():
        name = info.filename.replace("\\", "/")
        if _is_junk(name) or info.is_dir():
            continue
        mode = stat.S_IFMT(info.external_attr >> 16)
        if mode == stat.S_IFLNK:
            raise ExtensionError(f"這個壓縮檔裡有一條符號連結（{name}），不收")
        if mode not in (0, stat.S_IFREG):
            raise ExtensionError(f"這個壓縮檔裡有一個不是普通檔案的東西（{name}），不收")
        members.append(
            _Member(
                name=_safe_name(name),
                size=info.file_size,
                open=lambda i=info: zf.open(i),  # type: ignore[misc]
            )
        )
    return members


def _tar_members(tf: tarfile.TarFile) -> list[_Member]:
    """`.tar.gz` 那一側。

    tar 存得下的東西比 zip 多（硬連結、裝置檔、FIFO），而**多出來的每一種都
    不收**：一個積木包是幾個檔案加一份 manifest，沒有一種需要它們。`isreg()`
    以外一律擋，而不是安靜跳過——安靜跳過會讓一個帶著 symlink 的 tarball 裝
    起來看似正常，然後在某個 `open()` 上以一句無關的錯誤現形。
    """
    members = []
    for info in tf.getmembers():
        name = info.name.replace("\\", "/")
        if _is_junk(name) or info.isdir():
            continue
        if info.issym() or info.islnk():
            raise ExtensionError(f"這個壓縮檔裡有一條符號連結（{name}），不收")
        if not info.isreg():
            raise ExtensionError(f"這個壓縮檔裡有一個不是普通檔案的東西（{name}），不收")
        members.append(
            _Member(
                name=_safe_name(name),
                size=info.size,
                # `extractfile()` 對 `isreg()` 的條目不會回 None，但型別說它會。
                open=lambda i=info: _must_open(tf, i),  # type: ignore[misc]
            )
        )
    return members


def _must_open(tf: tarfile.TarFile, info: tarfile.TarInfo) -> IO[bytes]:
    f = tf.extractfile(info)
    if f is None:  # pragma: no cover - isreg() 之後走不到
        raise ExtensionError(f"讀不出 {info.name}")
    return f


def _write(members: list[_Member], dest: Path) -> None:
    """名單過完規則之後，才真的寫進磁碟。"""
    if len(members) > MAX_MEMBERS:
        raise ExtensionError(f"這個壓縮檔裡超過 {MAX_MEMBERS} 個檔案，不收")
    if sum(m.size for m in members) > MAX_TOTAL_BYTES:
        raise ExtensionError(f"解開之後超過 {MAX_TOTAL_BYTES // 1024 // 1024}MB，不收")
    if not members:
        raise ExtensionError("這個壓縮檔是空的")

    strip = _strip_root([m.name for m in members])
    budget = MAX_TOTAL_BYTES
    for member in members:
        rel = member.name
        out = dest / (rel[len(strip):] if strip else rel)
        if not out.resolve().is_relative_to(dest.resolve()):
            raise ExtensionError(f"{rel} 會寫到積木包資料夾外面")
        out.parent.mkdir(parents=True, exist_ok=True)
        budget -= _copy(member, out, budget)


def _copy(member: _Member, out: Path, budget: int) -> int:
    """一個檔案，邊寫邊數。

    上面那一輪加總信的是 header 自己報的大小，而**那是壓縮檔說的話**：一個
    手工做出來的 zip 可以報 1 個 byte 然後吐出 4GB。這裡數的是真的寫出去了
    多少。
    """
    written = 0
    with member.open() as src, out.open("wb") as dst:
        while chunk := src.read(64 * 1024):
            written += len(chunk)
            if written > budget:
                raise ExtensionError(
                    f"解開之後超過 {MAX_TOTAL_BYTES // 1024 // 1024}MB，不收"
                )
            dst.write(chunk)
    return written


def _is_junk(name: str) -> bool:
    """**解壓那一步就丟掉**，而不是解完再忽略。

    `__pycache__` 與 `.venv` 進得來的話，審閱畫面上那份檔案清單就會有幾千列
    （而它們不屬於這個包），而且 `.venv` 裡的路徑是絕對的，換一台機器就錯。
    共用 `PACK_SKIP_DIRS` 的理由見那裡：掃描、審閱、解壓要看到同一個包。
    """
    return (
        name.startswith(_JUNK_PREFIXES)
        or PurePosixPath(name).name in _JUNK_NAMES
        or in_skipped_dir(name)
    )


def _safe_name(name: str) -> str:
    """把一個壓縮檔條目名變成一條乾淨的相對路徑，不合法就丟。

    **不做「清洗後放行」**：把 `../../x` 悄悄改成 `x` 會讓一個惡意的 zip 裝進來
    之後看起來完全正常，而它本來是要告訴我們一件事的。
    """
    parts = [p for p in name.split("/") if p not in ("", ".")]
    if not parts:
        raise ExtensionError(f"這個壓縮檔裡有一個怪路徑：{name}")
    if name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        raise ExtensionError(f"這個壓縮檔裡有絕對路徑（{name}），不收")
    if ".." in parts:
        raise ExtensionError(f"這個壓縮檔裡有一個往外跑的路徑（{name}），不收")
    return "/".join(parts)


def _strip_root(names: list[str]) -> str:
    """對著資料夾按右鍵壓縮，得到的是 `mypack/manifest.yaml` 不是 `manifest.yaml`。

    **這是使用者最可能做的那個動作**，所以它要成立。GitHub 的 tarball 也一定
    多包一層（`<repo>-<ref>/`），所以 §6 的第 2 點在這裡是免費的——同一條規則
    處理的是同一件事。規則刻意窄：全部條目共用同一個最外層資料夾，而且最外層
    **沒有** manifest.yaml——後者擋的是一個真的把面板放在 `ui/` 之外還帶了一個
    同名子資料夾的包。回傳要砍掉的字首（含斜線），沒有就回空字串。
    """
    if any("/" not in n for n in names):
        return ""
    roots = {n.split("/", 1)[0] for n in names}
    if len(roots) != 1:
        return ""
    return roots.pop() + "/"


__all__ = [
    "EXT_ID",
    "extract_archive",
    "MAX_MEMBERS",
    "MAX_TOTAL_BYTES",
    "MAX_ZIP_BYTES",
    "UPLOADED",
    "Staged",
    "discard",
    "install",
    "origin_path",
    "purge_stale",
    "read_origin",
    "stage",
    "staged_dir",
    "uninstall",
    "update",
]

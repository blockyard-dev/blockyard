"""從 GitHub 裝一個積木包（`docs/extension-design.md` §6）。

§3 說**一條管線，三個入口**，而三個入口只差第一步——怎麼把 bytes 弄到暫存
目錄。這個模組就是那一步的第三種寫法，長度大約是它應有的樣子：解析網址、抓一
份 tarball、順便說得出裝進來的是哪一個 commit。驗證、審閱、建 venv、寫收據，
一個字都不在這裡。

六件只有這條路才有的事：

1. **不 `git clone`，抓 tarball**：一個請求，不需要這台機器上有 git，也不用
   整段歷史。
2. **tarball 一定多包一層**（`<repo>-<ref>/`）——這件事已經免費了，
   `install.py::_strip_root` 處理的就是它（「對著資料夾按右鍵壓縮」同一條規則）。
3. **一個 repo 一個包**：規則是「repo 根要有 `manifest.yaml`」，而那句話已經
   由 `stage()` 說了。monorepo 的 `#subdir` 先不做。
4. 編輯器下載來源 bytes，之後走共用的安裝摘要與格式驗證。
5. **收據記 `commit` 不記分支名**（見 `_commit_of`）：`main` 明天就不是今天
   那一份了。
6. **私有 repo 與 rate limit：token 進 keyring**，走 D28 已經有的那條路。
   先不做，但要確定它塞得進去——而它塞得進去（多一個 header 而已）。
"""

from __future__ import annotations

import io
import re
import tarfile
from dataclasses import dataclass
from urllib.parse import urlsplit

from blockyard.errors import ExtensionError
from blockyard.extensions.receipt import Origin

#: 抓 tarball 的地方。**不是 `api.github.com`**：那條路要算 rate limit
#: （沒帶 token 是每小時 60 次，而它是以 IP 計的——共用出口的網路很容易已經
#: 被別人用完），`codeload` 不算。代價是拿不到 API 那份 metadata，而我們唯一
#: 需要的那一格（commit）在 tarball 自己身上（`_commit_of`）。
CODELOAD = "https://codeload.github.com"

#: 網址上一段合法的 owner／repo。GitHub 自己的規則比這寬鬆一點，但寬鬆的那
#: 幾個字元（`.` 開頭之類）我們不需要，而這個字串會被接進一個 URL。
_SEGMENT = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
#: 分支、tag 或 commit。可以有斜線（`release/1.x` 是合法的分支名）。
_REF = re.compile(r"^[A-Za-z0-9._\-/]{1,200}$")

#: 抓多久算太久。這是一個人按下按鈕之後在等的事情。
TIMEOUT = 60.0


@dataclass(frozen=True)
class Target:
    """要去 GitHub 拿的那一份。"""

    owner: str
    repo: str
    #: 使用者打的那個分支／tag，沒指定就是 `None`（= 預設分支）。
    ref: str | None = None

    @property
    def slug(self) -> str:
        return f"{self.owner}/{self.repo}"

    @property
    def url(self) -> str:
        return f"https://github.com/{self.slug}"


def parse(text: str) -> Target:
    """把使用者貼進來的東西變成一個 `Target`。

    收得下的形狀刻意寬：`https://github.com/u/r`、`github.com/u/r`、`u/r`、
    後面掛 `.git`、`/tree/<ref>`（那是使用者按下分支下拉之後網址列的樣子）、
    以及 `u/r@<ref>`。**寬的是形狀，不是規則**——每一段仍然要過
    `_SEGMENT`／`_REF`，因為它們會被接進一個我們自己要去打的網址。

    `/tree/<ref>` 的 `<ref>` 可以有斜線（`tree/release/1.x`），而那與
    「`tree/main/some/dir`（指著一個子目錄）」在網址上長得一模一樣——GitHub
    自己也是靠問 API 才分得出來。我們整段收下，然後讓 codeload 去判斷：它
    認不得就是 404，而那句話比我們猜錯之後裝進一個不對的東西好。
    """
    raw = text.strip()
    if not raw:
        raise ExtensionError("請貼一個 GitHub 網址")

    ref: str | None = None
    if "://" in raw or raw.startswith("github.com/"):
        parts = urlsplit(raw if "://" in raw else f"https://{raw}")
        if parts.hostname not in ("github.com", "www.github.com"):
            raise ExtensionError(f"只認得 github.com 上的網址，這個是 {parts.hostname or raw}")
        segs = [s for s in parts.path.split("/") if s]
        if len(segs) >= 4 and segs[2] in ("tree", "commit"):
            ref = "/".join(segs[3:])
        segs = segs[:2]
    else:
        # `u/r@ref` 與 `u/r`。`@` 只在最後一段有意義，所以從右邊切。
        body, _, at_ref = raw.partition("@")
        ref = at_ref or None
        segs = [s for s in body.split("/") if s]

    if len(segs) != 2:
        raise ExtensionError(
            f"看不懂「{text.strip()}」。要的是一個 repo 的網址，"
            "像 https://github.com/someone/my-blocks"
        )
    owner, repo = segs[0], segs[1].removesuffix(".git")
    for seg in (owner, repo):
        if not _SEGMENT.match(seg):
            raise ExtensionError(f"「{seg}」不是一段合法的 GitHub 名字")
    # `..` 在 git 的 refname 規則裡本來就是不合法的，而在**這裡**它是另一件事：
    # 這一段會被接進一條我們自己要去打的網址，所以 `../../` 是一個看起來很無辜
    # 的字串（同 `install.py::_safe_name` 的理由）。
    if ref is not None and (not _REF.match(ref) or ".." in ref.split("/")):
        raise ExtensionError(f"「{ref}」不是一段合法的分支或 tag")
    return Target(owner=owner, repo=repo, ref=ref)


def describe(target: Target) -> str:
    """要去哪裡抓，寫成一句給人看的話。

    §6 第 4 點：**這是編輯器自己在打外網**，所以按下去之前畫面上要說得出這件
    事。給網址而不是「正在下載…」——那句話沒有回答使用者唯一該問的問題。
    """
    where = f"{target.slug}（{target.ref}）" if target.ref else target.slug
    return f"從 {where} 抓一份程式碼"


async def fetch(target: Target) -> tuple[bytes, Origin]:
    """抓下來，回 `(bytes, 這份東西從哪來)`。

    回的是一張 `Origin` 而不只是 bytes：**來源是安裝的人記的**（§2），而這裡
    正是我們手上真的拿著那份 bytes 的一刻——commit 也只有這一刻問得到。
    """
    data = await _download(_tarball_url(target))
    return data, Origin(
        origin="github",
        label=f"github.com/{target.slug}",
        url=target.url,
        ref=target.ref,
        commit=_commit_of(data),
    )


def _tarball_url(target: Target) -> str:
    """沒指定 ref 就用 `HEAD`。

    codeload 認 `HEAD`，而那是「這個 repo 的預設分支」——比寫死 `main` 好，
    因為那個猜測對每一個還在 `master` 上的 repo 都是錯的，而錯的樣子是 404。
    """
    return f"{CODELOAD}/{target.owner}/{target.repo}/tar.gz/{target.ref or 'HEAD'}"


async def _download(url: str) -> bytes:
    """抓一份 tarball，**邊抓邊數**。

    `MAX_ZIP_BYTES` 那一條在 `stage()` 裡也會擋，但那時整份東西已經在記憶體
    裡了——這裡是唯一還來得及在中途放手的地方，而網路那一端可以是任意大。
    """
    import httpx

    from blockyard.extensions.install import MAX_ZIP_BYTES

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=TIMEOUT) as client:
            async with client.stream("GET", url) as response:
                if response.status_code == 404:
                    raise ExtensionError(
                        f"GitHub 上找不到這個 repo 或這個分支（{url}）。"
                        "私有的 repo 現在還裝不了"
                    )
                if response.status_code != 200:
                    raise ExtensionError(f"GitHub 回了 {response.status_code}（{url}）")
                chunks: list[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > MAX_ZIP_BYTES:
                        raise ExtensionError(
                            f"這個 repo 超過 {MAX_ZIP_BYTES // 1024 // 1024}MB，不收"
                        )
                    chunks.append(chunk)
    except httpx.HTTPError as e:
        # 連不上、DNS、逾時。**要說出網址**——這條路上使用者能做的第一件事是
        # 確認自己貼的東西對不對。
        raise ExtensionError(f"連不上 GitHub（{url}）：{e}") from None
    return b"".join(chunks)


def _commit_of(data: bytes) -> str | None:
    """這份 tarball 是哪一個 commit。

    **不多打一個請求。** GitHub 產生的 tarball 第一個條目是 `pax_global_header`，
    而那個 pax 標頭的 `comment` 就是完整的 40 字元 sha——`tarfile` 把它讀進
    `pax_headers`。所以「記 commit 不記分支名」（§6 第 5 點）是免費的，不必去
    問 `api.github.com`、也就不必付它的 rate limit。

    **問不到就是 `None`，不是錯誤。** 收據上那一格空著只代表我們說不出裝進來
    的是哪一份；而為了一格 metadata 讓整個安裝失敗，是把次要的東西擺到主要的
    位置。

    `mode="r|gz"` 是**串流**模式，所以這裡只會解開到第一個標頭為止——一份會
    炸開成幾百 GB 的 tarball 在這條路上仍然只花掉幾 KB。（真正的總量上限在
    `install.py`，而那是解壓那一步的事；這個函式在它之前跑。）
    """
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r|gz") as tf:
            commit = tf.pax_headers.get("comment", "")
    except (OSError, tarfile.TarError, EOFError):
        return None
    return commit if re.fullmatch(r"[0-9a-f]{40}", commit) else None


__all__ = ["CODELOAD", "Target", "describe", "fetch", "parse"]

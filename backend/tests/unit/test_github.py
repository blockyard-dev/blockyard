"""從 GitHub 裝一個積木包（`docs/extension-design.md` §6）。

三件事在這裡守：**網址看得懂**、**裝進來的是哪一個 commit 說得出來**，以及
**那條路與 `.zip` 走的是同一段驗證**（§3：多一個來源不該多一條驗證路徑，
不然「從 GitHub 裝的包比較少檢查」遲早是真的）。

網路不在測試裡：這幾題問的是我們自己那幾行，而「codeload 回什麼」不是我們
說了算的東西。真的那一趟由 `_download` 負責，這裡把它換掉。
"""

from __future__ import annotations

import io
import tarfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from blockyard.api.app import create_app
from blockyard.errors import ExtensionError
from blockyard.extensions import github

SHA = "0123456789abcdef0123456789abcdef01234567"

MANIFEST = """\
manifestVersion: 1
id: greet
name: 打招呼
version: 0.1.0
permissions: []
requirements: []
palette:
  - opcode: hello
    type: reporter
    text: 說哈囉
    returns: string
"""

MAIN = """\
from blockyard import block


@block("greet.hello")
async def hello(ctx):
    return "哈囉"
"""


def tarball(*, commit: str | None = SHA, prefix: str = "greet-main/") -> bytes:
    """做一份長得像 GitHub 那樣的 tarball：多包一層資料夾，第一個條目是
    `pax_global_header`（`comment` 就是 commit）。"""
    buf = io.BytesIO()
    headers = {"comment": commit} if commit else {}
    with tarfile.open(
        fileobj=buf, mode="w:gz", format=tarfile.PAX_FORMAT, pax_headers=headers
    ) as tf:
        for name, body in (("manifest.yaml", MANIFEST), ("main.py", MAIN)):
            info = tarfile.TarInfo(prefix + name)
            data = body.encode()
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


# --------------------------------------------------------------------------
# 網址
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "owner", "repo", "ref"),
    [
        ("https://github.com/someone/my-blocks", "someone", "my-blocks", None),
        ("http://github.com/someone/my-blocks/", "someone", "my-blocks", None),
        ("github.com/someone/my-blocks.git", "someone", "my-blocks", None),
        ("someone/my-blocks", "someone", "my-blocks", None),
        ("someone/my-blocks@v1.2.0", "someone", "my-blocks", "v1.2.0"),
        # 使用者按下分支下拉之後網址列的樣子。
        ("https://github.com/someone/my-blocks/tree/dev", "someone", "my-blocks", "dev"),
        # 分支名可以有斜線。
        (
            "https://github.com/someone/my-blocks/tree/release/1.x",
            "someone",
            "my-blocks",
            "release/1.x",
        ),
    ],
)
def test_the_shapes_people_actually_paste(
    text: str, owner: str, repo: str, ref: str | None
) -> None:
    target = github.parse(text)
    assert (target.owner, target.repo, target.ref) == (owner, repo, ref)


@pytest.mark.parametrize(
    "text",
    [
        "",
        "   ",
        "https://gitlab.com/someone/my-blocks",
        "https://github.com/someone",
        "https://example.com/x/y",
        "git@github.com:someone/my-blocks.git",
    ],
)
def test_things_we_will_not_guess_at(text: str) -> None:
    with pytest.raises(ExtensionError):
        github.parse(text)


def test_a_ref_is_not_a_place_to_smuggle_a_path() -> None:
    """這幾段會被接進一個我們自己要去打的網址。"""
    with pytest.raises(ExtensionError):
        github.parse("someone/my-blocks@../../etc/passwd")


def test_where_it_will_go(monkeypatch: pytest.MonkeyPatch) -> None:
    """§6 第 4 點：**這是編輯器自己在打外網**，UI 上要說得出現在要去哪裡抓。"""
    assert "someone/my-blocks" in github.describe(github.parse("someone/my-blocks"))
    assert "dev" in github.describe(github.parse("someone/my-blocks@dev"))


def test_no_ref_means_the_default_branch() -> None:
    """寫死 `main` 對每一個還在 `master` 上的 repo 都是錯的，而錯的樣子是 404。"""
    assert github._tarball_url(github.parse("someone/my-blocks")).endswith("/tar.gz/HEAD")


# --------------------------------------------------------------------------
# commit：記的是它，不是分支名
# --------------------------------------------------------------------------


def test_the_commit_comes_out_of_the_tarball_itself() -> None:
    """**不多打一個請求。** GitHub 產生的 tarball 第一個條目是
    `pax_global_header`，而那個標頭的 `comment` 就是完整的 sha。"""
    assert github._commit_of(tarball()) == SHA


def test_a_tarball_without_that_header_is_not_an_error() -> None:
    """問不到就是 `None`：為了一格 metadata 讓整個安裝失敗，是把次要的東西
    擺到主要的位置。"""
    assert github._commit_of(tarball(commit=None)) is None
    assert github._commit_of("這不是一份 tarball".encode()) is None


@pytest.mark.asyncio
async def test_fetch_writes_the_origin_down(monkeypatch: pytest.MonkeyPatch) -> None:
    """**來源是安裝的人記的**，而抓下來的那一刻正是我們手上真的拿著那份
    bytes 的時候（§2）。"""
    monkeypatch.setattr(github, "_download", _fake_download(tarball()))

    data, origin = await github.fetch(github.parse("someone/my-blocks@dev"))

    assert data[:2] == b"\x1f\x8b"
    assert origin.origin == "github"
    assert origin.label == "github.com/someone/my-blocks"
    assert origin.url == "https://github.com/someone/my-blocks"
    # 分支名留著（使用者當初打的是它），但真正裝進來的那一份由 commit 說。
    assert origin.ref == "dev"
    assert origin.commit == SHA


def _fake_download(data: bytes):  # noqa: ANN202
    async def download(url: str) -> bytes:
        return data

    return download


# --------------------------------------------------------------------------
# 端點：與 `.zip` 同一條管線
# --------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    root = tmp_path / "home" / "extensions"
    root.mkdir(parents=True)
    return TestClient(
        create_app(
            db_path=tmp_path / "blockyard.db",
            extensions_root=root,
            staging_root=tmp_path / "staging",
        )
    )


def test_the_whole_github_path(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """審閱 → 安裝 → 收據上寫著 commit。**中間那一段與 `.zip` 是同一段。**"""
    monkeypatch.setattr(github, "_download", _fake_download(tarball()))

    review = client.post(
        "/api/extensions/import/github",
        json={"url": "https://github.com/someone/my-blocks"},
    )
    assert review.status_code == 200, review.text
    body = review.json()
    # tarball 一定多包一層（`greet-main/`），而那一層由「對著資料夾按右鍵壓縮」
    # 那條規則處理掉——所以這裡看到的是包自己的檔案。
    assert "files" not in body
    assert body["origin"]["commit"] == SHA
    assert body["id"] == "greet"

    done = client.post(f"/api/extensions/import/{body['token']}")
    assert done.status_code == 200, done.text

    receipts = client.get("/api/extensions/receipts").json()
    receipt = next(r for r in receipts if r["extId"] == "greet")
    assert receipt["origin"] == "github"
    assert receipt["commit"] == SHA
    assert receipt["url"] == "https://github.com/someone/my-blocks"


def test_a_bad_url_is_422_with_the_reason(client: TestClient) -> None:
    res = client.post("/api/extensions/import/github", json={"url": "https://gitlab.com/x/y"})
    assert res.status_code == 422
    assert "github.com" in res.json()["detail"]["message"]


def test_no_url_is_400(client: TestClient) -> None:
    assert client.post("/api/extensions/import/github", json={}).status_code == 400


def test_a_repo_without_a_manifest_says_so(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """§6 第 3 點：一個 repo 一個包，規則是「repo 根要有 `manifest.yaml`」
    ——而那句話由 `stage()` 說，不是這條路自己再說一次。"""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        info = tarfile.TarInfo("repo-main/README.md")
        info.size = 2
        tf.addfile(info, io.BytesIO(b"hi"))
    monkeypatch.setattr(github, "_download", _fake_download(buf.getvalue()))

    res = client.post("/api/extensions/import/github", json={"url": "someone/my-blocks"})
    assert res.status_code == 422
    assert "manifest.yaml" in res.json()["detail"]["message"]


def test_a_tarball_with_a_symlink_is_refused(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """tar 存得下的東西比 zip 多，而多出來的每一種都不收——一條指向
    `~/.ssh` 的連結每個字元都合法。"""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, body in (("greet-main/manifest.yaml", MANIFEST), ("greet-main/main.py", MAIN)):
            info = tarfile.TarInfo(name)
            data = body.encode()
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
        link = tarfile.TarInfo("greet-main/secrets")
        link.type = tarfile.SYMTYPE
        link.linkname = "/Users/someone/.ssh/id_rsa"
        tf.addfile(link)
    monkeypatch.setattr(github, "_download", _fake_download(buf.getvalue()))

    res = client.post("/api/extensions/import/github", json={"url": "someone/my-blocks"})
    assert res.status_code == 422
    assert "符號連結" in res.json()["detail"]["message"]


def test_a_broken_tarball_is_422_not_500(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """半截的下載是**使用者送進來的東西**，不是後端出事。"""
    monkeypatch.setattr(github, "_download", _fake_download(b"\x1f\x8b" + b" broken"))
    res = client.post("/api/extensions/import/github", json={"url": "someone/my-blocks"})
    assert res.status_code == 422
    assert "壞了" in res.json()["detail"]["message"]

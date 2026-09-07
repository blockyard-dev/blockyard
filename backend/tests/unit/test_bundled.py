"""官方包怎麼從 wheel 鋪到使用者的擴充功能目錄（`docs/extension-design.md` §2）。

這裡守的是兩句話：**第一次啟動要鋪**，以及**之後永遠不要再碰**。第二句才是
真正的那一條——「開機時默默覆蓋磁碟上的東西」是這整份設計裡唯一會弄丟使用者
東西的動作，而它一旦寫進去就再也看不出來。
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from blockyard.api.app import create_app
from blockyard.extensions import BUNDLED_ROOT, discover, seed_bundled


def test_seeds_the_shipped_packs(tmp_path: Path) -> None:
    seeded = seed_bundled(tmp_path / "extensions")
    assert "demo" in seeded and "http" in seeded
    # 鋪過去的要是**掃得到的包**，不只是一堆檔案。
    assert set(discover(tmp_path / "extensions")) == set(seeded)


def test_repo_only_things_do_not_ship(tmp_path: Path) -> None:
    """包自帶的 `tests/` 是這個 repo 的回歸網，不是包的內容。"""
    root = tmp_path / "extensions"
    seed_bundled(root)
    assert (BUNDLED_ROOT / "http" / "tests").is_dir()
    assert not (root / "http" / "tests").exists()
    assert not list(root.rglob("__pycache__"))


def test_second_start_changes_nothing(tmp_path: Path) -> None:
    """**已經在那裡的一律不碰**——包括被改過的、被更新過的。"""
    root = tmp_path / "extensions"
    seed_bundled(root)
    edited = root / "demo" / "main.py"
    edited.write_text("# 使用者改過這一份\n")

    assert seed_bundled(root) == []
    assert edited.read_text() == "# 使用者改過這一份\n"


def test_a_folder_deleted_by_hand_grows_back(tmp_path: Path) -> None:
    """**這一條是對的，不是缺口。**

    「只鋪不存在的」對「還沒鋪過」與「使用者自己去砍了那個資料夾」看起來一模
    一樣——而在那種情況下鋪回去正是該做的事（那台機器看起來就是新的）。分辨
    兩者的是墓碑，而墓碑由**解除安裝**那條路立起來，不是由檔案總管。

    拔掉之後不長回來那一條在 `test_lifecycle.py`。
    """
    root = tmp_path / "extensions"
    seed_bundled(root)
    assert "demo" in discover(root)

    shutil.rmtree(root / "demo")
    assert seed_bundled(root) == ["demo"]


def test_app_without_extensions_root_uses_the_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`blockyard serve` 不帶 `--extensions` 走的就是這條：家在哪、誰去鋪。"""
    monkeypatch.setenv("BLOCKYARD_HOME", str(tmp_path / "home"))
    app = create_app(db_path=tmp_path / "blockyard.db")
    assert app.state.extensions_root == tmp_path / "home" / "extensions"
    assert "demo" in discover(app.state.extensions_root)


def test_app_with_extensions_root_is_left_alone(tmp_path: Path) -> None:
    """指定了就一個字都不動——測試的 tmp 目錄與 `--extensions` 走同一條路。"""
    root = tmp_path / "elsewhere"
    root.mkdir()
    app = create_app(db_path=tmp_path / "blockyard.db", extensions_root=root)
    assert app.state.extensions_root == root
    assert list(root.iterdir()) == []

"""積木包的 manifest（§7.2）。

manifest 是**積木包的契約**：積木長什麼樣、參數是什麼型別、回傳什麼型別。
Host 在邊界（§7.5）就是照這份宣告做正規化與驗證，所以這裡驗得越嚴，
`main.py` 要寫的防呆越少——那正是 D10 與 §11「AI 生成積木包」的前提：
**填對 manifest 就不會錯**。

因此本模組的驗證刻意超出「pydantic 型別對不對」的範圍，也檢查宣告之間的
一致性：`text` 的 `%(x)` 有沒有對應的參數、`command` 有沒有偷偷宣告
`returns`、`dropdown` 有沒有給 `source`。這些錯誤留到執行期才炸，使用者只
會看到一顆不動的積木。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import Field, field_validator, model_validator
from pydantic import ValidationError as PydanticError

from blocky.errors import ExtensionError
from blocky.ir.schema import ReturnType, Strict

# 內建命名空間（§4.4）不得被積木包佔用——否則 `data.set` 的意義會取決於
# 使用者裝了什麼包。
BUILTIN_NAMESPACES = frozenset(
    {"event", "control", "data", "object", "operator", "procedure", "type", "time", "debug"}
)

ArgType = Literal[
    "string", "number", "boolean", "dropdown", "secret", "object", "list", "json", "code"
]
BlockShape = Literal["command", "reporter", "boolean", "hat"]
Permission = Literal["net", "fs.read", "fs.write", "subprocess", "env"]
Concurrency = Literal["drop", "queue", "restart", "parallel"]

# 參數與 opcode 都走這個形狀：它同時要當 Python 識別字與 IR 的 key。
_IDENT = re.compile(r"^[a-z][a-z0-9_]*$")
_PLACEHOLDER = re.compile(r"%\((\w+)\)")

# §4.7：`string` 預設開插值、`code` 預設關（shell 指令裡的 `${HOME}` 不該被替換）
_INTERPOLATE_BY_DEFAULT = {"string": True, "code": False}


class ArgSpec(Strict):
    """一個參數的宣告。"""

    type: ArgType
    default: Any = None
    label: str | None = None
    help: str | None = None
    source: str | None = None          # dropdown 專用：提供選項的 @dropdown 函式名
    multiline: bool = False            # string / code：渲染成 textarea（§7.2）
    rows: int | None = None
    interpolate: bool | None = None    # 覆寫 §4.7 的預設
    min: float | None = None           # number 專用，Host 在邊界檢查
    max: float | None = None

    @property
    def has_default(self) -> bool:
        """`default: null` 與「沒寫 default」是兩件事：後者代表必填。"""
        return "default" in self.model_fields_set

    @property
    def interpolates(self) -> bool:
        if self.interpolate is not None:
            return self.interpolate
        return _INTERPOLATE_BY_DEFAULT.get(self.type, False)

    @model_validator(mode="after")
    def _check(self) -> ArgSpec:
        if self.type == "dropdown" and not self.source:
            raise ValueError("dropdown 參數必須宣告 source")
        if self.type != "dropdown" and self.source:
            raise ValueError("只有 dropdown 參數能宣告 source")
        if self.type not in ("string", "code") and (
            self.multiline or self.rows is not None or self.interpolate is not None
        ):
            raise ValueError("multiline / rows / interpolate 只適用於 string 與 code")
        if self.type != "number" and (self.min is not None or self.max is not None):
            raise ValueError("min / max 只適用於 number")
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError(f"min（{self.min}）大於 max（{self.max}）")
        return self


class YieldSpec(Strict):
    """hat 綁進 thread-local 的變數（§5.4 第 2 層，唯讀）。"""

    name: str
    type: str = "any"


class ConfigSpec(Strict):
    """使用者要填的設定。`secret` 型別存進金鑰庫（§12.1）。"""

    key: str
    type: Literal["string", "number", "boolean", "secret"] = "string"
    label: str | None = None
    help: str | None = None
    default: Any = None

    @property
    def has_default(self) -> bool:
        return "default" in self.model_fields_set


class BlockSpec(Strict):
    """一顆積木的宣告。`opcode` 是**不帶命名空間**的短名。"""

    opcode: str
    type: BlockShape
    text: str
    args: dict[str, ArgSpec] = Field(default_factory=dict)
    returns: ReturnType | None = None
    blocking: bool = False
    # §13.1：opcode 永不移除，只標記 deprecated（工具箱隱藏，既有專案仍可執行）
    deprecated: bool = False
    yields: list[YieldSpec] = Field(default_factory=list)
    concurrency: Concurrency | None = None

    @field_validator("opcode")
    @classmethod
    def _opcode_shape(cls, v: str) -> str:
        if not _IDENT.match(v):
            raise ValueError(f"opcode 必須是小寫識別字且不含命名空間前綴：{v}")
        return v

    @field_validator("args")
    @classmethod
    def _arg_names(cls, v: dict[str, ArgSpec]) -> dict[str, ArgSpec]:
        for name in v:
            if not _IDENT.match(name):
                raise ValueError(f"參數名必須是小寫識別字：{name}")
        return v

    @model_validator(mode="after")
    def _check(self) -> BlockSpec:
        placeholders = set(_PLACEHOLDER.findall(self.text))
        if missing := placeholders - set(self.args):
            raise ValueError(f"text 裡的 %({'), %('.join(sorted(missing))}) 沒有對應的參數")

        if self.type in ("command", "hat") and self.returns is not None:
            raise ValueError(f"{self.type} 型積木不會回傳值，不能宣告 returns")
        if self.type == "boolean" and self.returns not in (None, "boolean"):
            raise ValueError("boolean 型積木的 returns 只能是 boolean")
        if self.type != "hat" and (self.yields or self.concurrency is not None):
            raise ValueError("yields / concurrency 只適用於 hat")
        return self

    @property
    def declared_return(self) -> ReturnType | None:
        """實際要在邊界驗證的回傳型別。

        boolean 型積木的形狀本身就是宣告，作者不必再寫一次 `returns: boolean`。
        """
        if self.type == "boolean":
            return "boolean"
        return self.returns


class Manifest(Strict):
    manifestVersion: Literal[1] = 1
    id: str
    name: str
    version: str
    author: str | None = None
    description: str | None = None
    color: str | None = None
    permissions: list[Permission] = Field(default_factory=list)
    requirements: list[str] = Field(default_factory=list)
    config: list[ConfigSpec] = Field(default_factory=list)
    blocks: list[BlockSpec] = Field(default_factory=list)

    @field_validator("id")
    @classmethod
    def _id_shape(cls, v: str) -> str:
        if not _IDENT.match(v):
            raise ValueError(f"積木包 id 必須是小寫識別字：{v}")
        if v in BUILTIN_NAMESPACES:
            raise ValueError(f'"{v}" 是內建命名空間（§4.4），積木包不能用這個 id')
        return v

    @model_validator(mode="after")
    def _check(self) -> Manifest:
        seen: set[str] = set()
        for b in self.blocks:
            if b.opcode in seen:
                raise ValueError(f"opcode 重複：{b.opcode}")
            seen.add(b.opcode)

        keys: set[str] = set()
        for c in self.config:
            if c.key in keys:
                raise ValueError(f"config key 重複：{c.key}")
            keys.add(c.key)
        return self

    # ---- 便利存取 ----

    def full_opcode(self, opcode: str) -> str:
        return f"{self.id}.{opcode}"

    def block(self, opcode: str) -> BlockSpec | None:
        """接受短名或 `id.短名`。"""
        short = opcode.split(".", 1)[1] if opcode.startswith(f"{self.id}.") else opcode
        return next((b for b in self.blocks if b.opcode == short), None)

    def dropdown_sources(self) -> set[str]:
        return {a.source for b in self.blocks for a in b.args.values() if a.source}

    def config_defaults(self) -> dict[str, Any]:
        return {c.key: c.default for c in self.config if c.has_default}


# --------------------------------------------------------------------------
# 從磁碟讀取
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ExtensionSource:
    """磁碟上的一個積木包。

    manifest 是**資料**，任何 process 都讀得到；`main.py` 是**程式碼**，只有
    Host 那一側會載入。這個分界是 §7.6 換 SubprocessHost 時不用改介面的原因。
    """

    id: str
    dir: Path
    manifest: Manifest

    @property
    def entrypoint(self) -> Path:
        return self.dir / "main.py"


def parse_manifest(data: Any, *, where: str) -> Manifest:
    try:
        return Manifest.model_validate(data)
    except PydanticError as e:
        raise ExtensionError(f"{where} 的 manifest 有問題：{_first_error(e)}") from None


def load_manifest(path: Path) -> Manifest:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as e:
        raise ExtensionError(f"讀不到 {path}：{e}") from None
    return parse_manifest(data, where=str(path))


def discover(root: Path) -> dict[str, ExtensionSource]:
    """掃描 `extensions/`，回傳 id → 來源。

    目錄名與 manifest 的 `id` 必須一致：專案 IR 只記 id，若兩者可以不同，
    「這顆積木是誰提供的」就得靠掃描全部 manifest 才答得出來。
    """
    sources: dict[str, ExtensionSource] = {}
    if not root.is_dir():
        return sources

    for d in sorted(p for p in root.iterdir() if p.is_dir()):
        mf_path = d / "manifest.yaml"
        if not mf_path.exists():
            continue
        mf = load_manifest(mf_path)
        if mf.id != d.name:
            raise ExtensionError(f"目錄名 {d.name} 與 manifest 的 id「{mf.id}」不一致")
        sources[mf.id] = ExtensionSource(id=mf.id, dir=d, manifest=mf)
    return sources


def _first_error(e: PydanticError) -> str:
    err = e.errors()[0]
    loc = ".".join(str(p) for p in err["loc"])
    msg = err["msg"].removeprefix("Value error, ")
    return f"{loc}：{msg}" if loc else msg


__all__ = [
    "BUILTIN_NAMESPACES",
    "ArgSpec",
    "BlockSpec",
    "ConfigSpec",
    "ExtensionSource",
    "Manifest",
    "YieldSpec",
    "discover",
    "load_manifest",
    "parse_manifest",
]

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
from blocky.ir.schema import PLACEHOLDER, ReturnType, Strict

# 內建命名空間（§4.4）不得被積木包佔用——否則 `data.set` 的意義會取決於
# 使用者裝了什麼包。
BUILTIN_NAMESPACES = frozenset(
    {"event", "control", "data", "object", "operator", "procedure", "type", "time", "debug"}
)

ArgType = Literal[
    "string", "number", "boolean", "dropdown", "secret", "object", "list", "json", "code",
    # 以下只有內建積木用得到（D21）。積木包宣告它們會在載入期被擋下——
    # 積木包的參數一律是輸入孔，沒有 C 型積木，也不綁變數。
    "variable",   # 變數名稱欄位（§4.5、§8.5 的自動完成）
    "stack",      # C 型積木的內部堆疊（§4.2 的 StackInput）
    "expression", # 算術運算式（§4.7b）。只有 `operator.expr` 那一顆用它
]

# 積木包不得使用的參數型別與修飾（見上）
BUILTIN_ONLY_ARG_TYPES = frozenset({"variable", "stack", "expression"})

BlockShape = Literal["command", "reporter", "boolean", "hat"]
# 工具箱按鈕的動作字彙表（D25）。**這張表就是那個「封頂」**：加一個成員是一次
# 明確的決定，而不是積木包送一段程式碼進來就多一種能力。
ButtonAction = Literal[
    "open_url",          # 前端：開一個外部連結（URL 要進 §12.1 的審閱畫面）
    "open_config",       # 前端：跳到這個包的設定面板
    "call",              # 後端：呼叫 main.py 的 @button（§7.3）
    "create_procedure",  # 前端、**只有內建**：開「創建積木」對話框（§8.5、D26）
]
# 只有內建宣告得起的動作：它開的是編輯器自己的對話框，不屬於任何一個積木包。
BUILTIN_ONLY_ACTIONS = frozenset({"create_procedure"})
# `open_url` 只收這兩種 scheme。**`javascript:` 必須擋在宣告層**——前端拿到
# 這個字串是要交給瀏覽器開的，一個包就能用它在編輯器裡執行任意程式碼，而那
# 正是 D25 (c) 明文封死的東西。
URL_SCHEMES = ("https://", "http://")
Permission = Literal["net", "fs.read", "fs.write", "subprocess", "env"]
Concurrency = Literal["drop", "queue", "restart", "parallel"]

# 參數與 opcode 都走這個形狀：它同時要當 Python 識別字與 IR 的 key。
_IDENT = re.compile(r"^[a-z][a-z0-9_]*$")
# 佔位符語法由 `ir/schema.py` 定義：函式的簽章模板（D26）用的是**同一個**，
# 兩邊各寫一條 regex 會讓「語法完全一樣」這句話慢慢變成半真的。
_PLACEHOLDER = PLACEHOLDER

# §4.7：`string` 預設開插值、`code` 預設關（shell 指令裡的 `${HOME}` 不該被替換）
_INTERPOLATE_BY_DEFAULT = {"string": True, "code": False}


class OptionSpec(Strict):
    """靜態下拉的一個選項（內建積木用）。

    積木包的下拉是**動態**的（`source` 指向 `@dropdown` 函式），因為選項來自
    外部服務；內建積木的下拉是**固定**的（`unit` 只有那六個），選項就是宣告的
    一部分，沒有人可以去問。
    """

    value: str
    label: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _shorthand(cls, v: Any) -> Any:
        """`options: [upper, lower]` 是 `[{value: upper}, {value: lower}]` 的簡寫。"""
        return {"value": v} if isinstance(v, str) else v


class ArgSpec(Strict):
    """一個參數的宣告。"""

    type: ArgType
    default: Any = None
    label: str | None = None
    help: str | None = None
    source: str | None = None          # dropdown 專用：提供選項的 @dropdown 函式名
    options: list[OptionSpec] | None = None   # dropdown 專用：靜態選項（內建）
    # §4.2：值存在 IR 的 `fields` 而不是 `inputs`。field 屬於積木自己，塞不進
    # 別的積木——`重複 (10) 次` 的 10 是輸入孔，`停止 [這個腳本]` 的下拉不是。
    # 積木包的參數一律是輸入孔，所以這個欄位只有內建會設。
    field: bool = False
    # §4.5：這一格的名字**由這顆積木建立**（`設定 [x] 為`、`對 … 的每一項 [item]`、
    # `出錯時把錯誤存進 [error]`），而不是讀一個別人建立的名字。編輯器的靜態檢查
    # 靠它分辨兩者：只出現在讀取端、從未出現在任何 binds 欄位的名字就是打錯字
    # （§8.5）。沒有這個宣告，前端只能寫死一份 opcode 名單——那正是 D21 要消滅的
    # 東西。`data.change` 刻意**不是** binds：它會寫，但 §4.5 要求變數已存在。
    binds: bool = False
    # §4.6：這顆積木**回傳的就是這一格所指名字的值**——也就是「讀一個變數」的
    # 那顆積木。`binds` 的另一面，而且同樣是前端問不出來的事：`data.get` 與
    # `data.list_length` 的宣告一模一樣（reporter + 一個 variable 參數），差別
    # 只在回傳的是值還是長度，那件事只有人分得出來。
    #
    # 函式分類要為每個參數各列一顆填好名字的 `取得 (參數名)`（§4.6，不新增
    # opcode），而它得先知道哪一顆積木是那個「取得」。沒有這個宣告，前端只能
    # 寫死 `data.get`——那正是 D21 要消滅的東西。
    reads: bool = False
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

    @property
    def is_field(self) -> bool:
        """存在 IR 的 `fields`（§4.2）。

        變數名稱與運算式永遠是 field，型別本身就蘊含了這件事：前者綁的是名字
        不是值，後者是這顆積木自己的內容——一個能被別的積木蓋掉的運算式，等於
        同一個值有兩個來源。
        """
        return self.field or self.type in ("variable", "expression")

    @property
    def is_stack(self) -> bool:
        """C 型積木的內部堆疊。它在 `inputs` 裡，但不是可求值的孔。"""
        return self.type == "stack"

    @model_validator(mode="after")
    def _check(self) -> ArgSpec:
        if self.type == "dropdown" and not (self.source or self.options):
            raise ValueError("dropdown 參數必須宣告 source（動態）或 options（靜態）")
        if self.source and self.options:
            raise ValueError("source 與 options 只能擇一：選項要嘛是問來的，要嘛是寫死的")
        if self.type != "dropdown" and self.source:
            raise ValueError("只有 dropdown 參數能宣告 source")
        if self.type != "dropdown" and self.options is not None:
            raise ValueError("只有 dropdown 參數能宣告 options")
        if self.type == "stack" and (self.field or self.has_default):
            raise ValueError("stack 參數是內部堆疊，不能是 field，也沒有預設值")
        if self.type == "expression" and self.default is not None and not isinstance(self.default, str):
            raise ValueError("expression 參數的 default 必須是運算式文字")
        if self.type not in ("string", "code") and (
            self.multiline or self.rows is not None or self.interpolate is not None
        ):
            raise ValueError("multiline / rows / interpolate 只適用於 string 與 code")
        if self.type != "number" and (self.min is not None or self.max is not None):
            raise ValueError("min / max 只適用於 number")
        if self.binds and self.type != "variable":
            raise ValueError("binds 只適用於 variable：它說的是「這個名字由這顆積木建立」")
        if self.reads and self.type != "variable":
            raise ValueError("reads 只適用於 variable：它說的是「這顆積木回傳這個名字的值」")
        if self.reads and self.binds:
            raise ValueError("binds 與 reads 互斥：一格不會同時是建立與讀出")
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError(f"min（{self.min}）大於 max（{self.max}）")
        return self


class ButtonSpec(Strict):
    """工具箱裡的非積木條目（D25、§7.2）。

    按鈕出現在該命名空間分類的最上面（Scratch 放「製作積木」的位置）。它**不是
    積木**：沒有輸入孔、沒有回傳值、不會出現在畫布上、不進 IR、不會被 Run
    執行——「開說明文件」「測一下 token 對不對」硬做成積木就是把它塞進一個不
    屬於它的形狀。
    """

    id: str
    label: str
    action: ButtonAction
    url: str | None = None      # open_url 專用
    handler: str | None = None  # call 專用：main.py 裡 @button 的名字

    @field_validator("id")
    @classmethod
    def _id_shape(cls, v: str) -> str:
        if not _IDENT.match(v):
            raise ValueError(f"按鈕 id 必須是小寫識別字：{v}")
        return v

    @model_validator(mode="after")
    def _check(self) -> ButtonSpec:
        if self.action == "open_url":
            if not self.url:
                raise ValueError("open_url 按鈕必須宣告 url")
            if not self.url.startswith(URL_SCHEMES):
                raise ValueError(f"open_url 的 url 只能是 http(s)：{self.url}")
        elif self.url:
            raise ValueError(f"只有 open_url 按鈕能宣告 url：{self.id}")

        if self.action == "call":
            if not self.handler:
                raise ValueError("call 按鈕必須宣告 handler（main.py 的 @button 名稱）")
        elif self.handler:
            raise ValueError(f"只有 call 按鈕能宣告 handler：{self.id}")
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
    # §4.6：積木由專案資料生成——`procedure.call` 的參數是函式的參數，
    # `procedure.definition` 與 `procedure.param` 的名字也是。工具箱不列出它們
    # （前端從 `project.procedures` 生成）。只有內建用得到。
    dynamic: bool = False
    # §4.6：**形狀由專案資料決定**——`procedure.call` 在函式沒宣告回傳型別時
    # 沒有輸出孔，是 command。整份宣告裡只有這一顆。
    #
    # 這件事原本是 `dynamic` 的隱含後果（「reporter 形狀的 dynamic 積木同時也是
    # command」），但 `procedure.param` 一出現那條規則就錯了：它也是 dynamic，
    # 形狀卻是固定的 reporter。隱含規則放行一顆 `參數` 積木接在堆疊上，D20 的
    # 載入期形狀驗證對它默默失效，錯誤要跑到執行期才以「不是指令型積木」出現。
    alsoCommand: bool = False
    # §4.6：cap block——插得進堆疊，但自己沒有 `next`（`procedure.return`、
    # Scratch 的「停止」）。**刻意不做成第五種 `type`**：cap 在連接語意上仍然
    # 是 command（它是 `next` 的合法目標、放得進 C 型積木），做成第五種形狀
    # 會讓 D20 的 `_require_shape(want="command")` 開始拒絕一顆合法的「回傳」，
    # 於是形狀的字彙表要多一條「cap 也算 command」的例外。
    #
    # 積木包**可以**宣告它（不在 `_check_builtin_boundary` 的名單裡）：它不碰
    # §7.5 的邊界，一顆「結束」積木沒有壞處。
    terminal: bool = False
    yields: list[YieldSpec] = Field(default_factory=list)
    concurrency: Concurrency | None = None
    # §8.1：**這顆積木是工具箱裡新一段的開頭**。`True` 只斷開，字串另外在上面
    # 放一行標題。宣告的是語意（「這裡是一段」），不是版面——間隔多大、標題長
    # 什麼樣子由編輯器決定（`toolbox.ts`），否則每個積木包各自決定留白，而使用
    # 者看到的是同一份工具箱。
    #
    # 刻意**不做成 `blocks` 裡的哨兵條目**（TurboWarp 的 `"---"`）：那份清單同時
    # 是直譯器的宣告表、IR validator 與 AST 測試的資料來源，往裡面塞不是宣告的
    # 東西，等於每一處 `for spec in blocks` 都要先過濾。
    section: str | bool = False

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
        if self.terminal and self.type != "command":
            raise ValueError("terminal 只適用於 command：它說的是「這顆積木下面不能再接」")
        if self.alsoCommand and self.type != "reporter":
            raise ValueError("alsoCommand 只適用於 reporter：它說的是「這一顆也可能沒有輸出孔」")
        if isinstance(self.section, str) and not self.section.strip():
            raise ValueError("section 是空字串：只想斷開一段而不放標題請寫 section: true")
        # 下架的積木不上工具箱（§13.1），段落開頭掛在它身上等於整段標題默默消失。
        if self.section and self.deprecated:
            raise ValueError("deprecated 積木不能是段落開頭：把 section 移到下一顆")
        if self.section and self.dynamic:
            raise ValueError("dynamic 積木不上工具箱，宣告 section 沒有意義")
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
    """一個命名空間的宣告。**內建與積木包共用這一個模型**（D21）。

    差別只有 `builtin` 這個旗標，以及它帶出的幾條規則：內建可以佔用內建命名
    空間、可以宣告 `variable` / `stack` 參數與 `dynamic` 積木，但**不能**宣告
    `requirements` / `permissions`——內建沒有 `main.py`，沒有東西可以裝、
    也沒有邊界可以守。
    """

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
    # D25：工具箱裡的非積木條目。第一個使用者是函式分類的「＋ 創建積木」。
    buttons: list[ButtonSpec] = Field(default_factory=list)
    # D21：內建命名空間的宣告（`interpreter/builtins/*.yaml`）。載入積木包的
    # 那條路徑（`discover`）會拒絕它，所以第三方沒辦法自稱內建。
    builtin: bool = False

    @field_validator("id")
    @classmethod
    def _id_shape(cls, v: str) -> str:
        if not _IDENT.match(v):
            raise ValueError(f"積木包 id 必須是小寫識別字：{v}")
        return v

    @model_validator(mode="after")
    def _check(self) -> Manifest:
        self._check_builtin_boundary()

        seen: set[str] = set()
        for b in self.blocks:
            if b.opcode in seen:
                raise ValueError(f"opcode 重複：{b.opcode}")
            seen.add(b.opcode)

        ids: set[str] = set()
        for b in self.buttons:
            if b.id in ids:
                raise ValueError(f"按鈕 id 重複：{b.id}")
            ids.add(b.id)

        keys: set[str] = set()
        for c in self.config:
            if c.key in keys:
                raise ValueError(f"config key 重複：{c.key}")
            keys.add(c.key)
        return self

    def _check_builtin_boundary(self) -> None:
        """把「內建才有」的宣告擋在積木包外面。

        這些不是型別檢查擋得住的東西——`type: variable` 對 pydantic 完全合法。
        但一個能綁變數名稱、能長 C 型堆疊的積木包，等於在 §7.5 的邊界上開洞：
        那些東西沒有值可以送過 process 邊界。
        """
        if self.builtin:
            if self.id not in BUILTIN_NAMESPACES:
                raise ValueError(f'"{self.id}" 不是內建命名空間（§4.4），不能標記 builtin')
            if self.requirements or self.permissions:
                raise ValueError("內建沒有 main.py，不能宣告 requirements / permissions")
            return

        if self.id in BUILTIN_NAMESPACES:
            raise ValueError(f'"{self.id}" 是內建命名空間（§4.4），積木包不能用這個 id')
        for btn in self.buttons:
            if btn.action in BUILTIN_ONLY_ACTIONS:
                raise ValueError(f"按鈕 {btn.id}：{btn.action} 是編輯器自己的動作，只有內建能宣告")
        for b in self.blocks:
            if b.dynamic:
                raise ValueError(f"{b.opcode}：dynamic 積木由專案資料生成，只有內建有")
            for name, a in b.args.items():
                if a.type in BUILTIN_ONLY_ARG_TYPES:
                    raise ValueError(f"{b.opcode}.{name}：積木包不能宣告 {a.type} 型參數")
                if a.field:
                    raise ValueError(f"{b.opcode}.{name}：積木包的參數一律是輸入孔，不能是 field")
                if a.options is not None:
                    raise ValueError(
                        f"{b.opcode}.{name}：積木包的下拉必須是動態的，請用 source"
                    )

    # ---- 便利存取 ----

    def full_opcode(self, opcode: str) -> str:
        return f"{self.id}.{opcode}"

    def block(self, opcode: str) -> BlockSpec | None:
        """接受短名或 `id.短名`。"""
        short = opcode.split(".", 1)[1] if opcode.startswith(f"{self.id}.") else opcode
        return next((b for b in self.blocks if b.opcode == short), None)

    def input_args(self, opcode: str) -> dict[str, ArgSpec]:
        """存在 IR `inputs` 的參數（含 stack）。§8.1 的第二個一致性測試要用。"""
        spec = self.block(opcode)
        return {} if spec is None else {n: a for n, a in spec.args.items() if not a.is_field}

    def field_args(self, opcode: str) -> dict[str, ArgSpec]:
        spec = self.block(opcode)
        return {} if spec is None else {n: a for n, a in spec.args.items() if a.is_field}

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
        if mf.builtin:
            # 內建宣告住在 `interpreter/builtins/`，不在這裡。放行的話，一個包
            # 只要寫 `builtin: true` 就能改寫 `data.set` 的意思。
            raise ExtensionError(f"{mf_path}：積木包不能標記 builtin")
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
    "BUILTIN_ONLY_ARG_TYPES",
    "ArgSpec",
    "BlockSpec",
    "ConfigSpec",
    "ExtensionSource",
    "Manifest",
    "OptionSpec",
    "YieldSpec",
    "discover",
    "load_manifest",
    "parse_manifest",
]

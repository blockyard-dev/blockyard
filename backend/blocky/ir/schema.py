"""IR（`project.json`）的 pydantic 模型（§4.1、§4.2）。

`shared-schema` 最終要從這裡（或反過來）產生 TS 型別，避免前後端定義漂移。
目前以 pydantic 為唯一真實來源，JSON Schema 由 `model_json_schema()` 匯出。
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

from blocky.errors import ValidationError
from blocky.ir import template as tpl


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


# --------------------------------------------------------------------------
# Input（§4.2 的四種 kind）
# --------------------------------------------------------------------------


class LiteralInput(Strict):
    """使用者直接輸入的值。

    §4.7：`literal` 維持「笨資料」——解譯器**不掃描它找 `${`**。含插值的
    字串在存檔時就會被解析成 TemplateInput，因此一個正當寫著 `${HOME}` 的
    shell 指令不會被偷偷替換。
    """

    kind: Literal["literal"] = "literal"
    value: Any = None


class TemplateInput(Strict):
    """含 `${}` 插值的字串（§4.7）。"""

    kind: Literal["template"] = "template"
    value: str
    refs: list[dict[str, Any]] = Field(default_factory=list)
    whole: bool = False


class BlockInput(Strict):
    """由 reporter / boolean 積木求值。"""

    kind: Literal["block"] = "block"
    id: str


class StackInput(Strict):
    """C 型積木的內部堆疊（迴圈體、if 分支）。"""

    kind: Literal["stack"] = "stack"
    id: str | None = None


Input = Annotated[
    Union[LiteralInput, TemplateInput, BlockInput, StackInput],
    Field(discriminator="kind"),
]


# --------------------------------------------------------------------------
# Block
# --------------------------------------------------------------------------


class Block(Strict):
    opcode: str
    parent: str | None = None
    next: str | None = None
    inputs: dict[str, Input] = Field(default_factory=dict)
    fields: dict[str, Any] = Field(default_factory=dict)
    mutation: dict[str, Any] | None = None
    # §4.2：純呈現狀態。解譯器與 codegen 完全忽略；允許任意未知 key（前向相容）。
    ui: dict[str, Any] | None = None

    @field_validator("opcode")
    @classmethod
    def _opcode_shape(cls, v: str) -> str:
        if "." not in v:
            raise ValueError(f"opcode 必須是 namespace.name 格式：{v}")
        return v

    @property
    def namespace(self) -> str:
        return self.opcode.split(".", 1)[0]


# --------------------------------------------------------------------------
# Procedure（§4.6）
# --------------------------------------------------------------------------

ReturnType = Literal["any", "number", "string", "boolean", "list", "object"]


class ProcParam(Strict):
    id: str
    name: str
    type: str = "any"


class Procedure(Strict):
    name: str
    params: list[ProcParam] = Field(default_factory=list)
    # null = 無回傳值，呼叫積木為 command 形狀（§4.6）
    returns: ReturnType | None = None
    body: str | None = None
    definitionBlock: str | None = None


# --------------------------------------------------------------------------
# 頂層
# --------------------------------------------------------------------------


class Script(Strict):
    id: str
    top: str
    x: float = 0
    y: float = 0
    enabled: bool = True


class ExtensionRef(Strict):
    id: str
    version: str


class Meta(Strict):
    model_config = ConfigDict(extra="allow")
    id: str = "prj_local"
    name: str = "未命名專案"
    createdAt: str | None = None
    updatedAt: str | None = None


class VariableIndex(Strict):
    """§4.5：這**不是宣告的結果，而是索引**。

    存檔時掃過所有積木彙整而成，只供變數監看面板、名稱自動完成與靜態檢查使用。
    刪掉整個欄位再重新產生不影響執行語意。
    """

    firstSeen: str | None = None


class Project(Strict):
    formatVersion: int = 1
    meta: Meta = Field(default_factory=Meta)
    extensions: list[ExtensionRef] = Field(default_factory=list)
    variables: dict[str, VariableIndex] = Field(default_factory=dict)
    procedures: dict[str, Procedure] = Field(default_factory=dict)
    scripts: list[Script] = Field(default_factory=list)
    blocks: dict[str, Block] = Field(default_factory=dict)

    # ---- 便利存取 ----

    def block(self, block_id: str) -> Block:
        b = self.blocks.get(block_id)
        if b is None:
            raise ValidationError(f"找不到積木 {block_id}", block_id=block_id)
        return b

    def iter_stack(self, first: str | None):
        """沿著 `next` 走完一串積木。"""
        cur = first
        seen: set[str] = set()
        while cur is not None:
            if cur in seen:
                raise ValidationError(f"積木串成環：{cur}", block_id=cur)
            seen.add(cur)
            b = self.block(cur)
            yield cur, b
            cur = b.next

    def procedure_by_definition(self, block_id: str) -> tuple[str, Procedure] | None:
        for pid, proc in self.procedures.items():
            if proc.definitionBlock == block_id:
                return pid, proc
        return None


# --------------------------------------------------------------------------
# 載入：解析 template、跑存檔期驗證
# --------------------------------------------------------------------------


class LoadedProject:
    """Project 加上解析後的 template 快取。

    §4.7 的硬規則在這裡執行：**`refs` 是衍生欄位，載入時一律重新 parse
    `value`**，執行期只認重新解析的結果。IR 裡帶的 `refs` 只用於驗證。
    """

    def __init__(self, project: Project, templates: dict[tuple[str, str], tpl.Template]):
        self.project = project
        self._templates = templates

    def template(self, block_id: str, input_name: str) -> tpl.Template:
        return self._templates[(block_id, input_name)]

    def __getattr__(self, name: str) -> Any:
        return getattr(self.project, name)


def load(data: dict[str, Any], *, strict_refs: bool = True) -> LoadedProject:
    """從 dict 載入並驗證專案。

    strict_refs=False 讓手寫的題庫 fixture 可以省略 `refs`——因為它本來就是
    衍生欄位，要求人手維護等於自找漂移。
    """
    project = Project.model_validate(data)
    templates: dict[tuple[str, str], tpl.Template] = {}

    for bid, block in project.blocks.items():
        for name, inp in block.inputs.items():
            if not isinstance(inp, TemplateInput):
                continue
            parsed = tpl.parse(inp.value, block_id=bid, input_name=name)
            templates[(bid, name)] = parsed

            if parsed.whole != inp.whole:
                raise ValidationError(
                    f"whole 標記與內容不符（應為 {parsed.whole}）", block_id=bid, path=name
                )
            if strict_refs and inp.refs:
                expected = [r.to_ir() for r in parsed.refs]
                if inp.refs != expected:
                    raise ValidationError(
                        "refs 與 value 不一致；refs 是衍生欄位，請重新產生",
                        block_id=bid,
                        path=name,
                    )
            # 無論 IR 帶了什麼，一律以重新解析的結果覆寫
            inp.refs = [r.to_ir() for r in parsed.refs]

    _validate_structure(project)
    return LoadedProject(project, templates)


def _validate_structure(p: Project) -> None:
    """存檔／載入期的結構驗證（§4.6 return 位置、參照完整性）。"""
    for bid, block in p.blocks.items():
        for name, inp in block.inputs.items():
            ref_id = getattr(inp, "id", None)
            if ref_id is not None and ref_id not in p.blocks:
                raise ValidationError(
                    f"輸入 {name} 指向不存在的積木 {ref_id}", block_id=bid, path=name
                )
        if block.next is not None and block.next not in p.blocks:
            raise ValidationError(f"next 指向不存在的積木 {block.next}", block_id=bid)

    for s in p.scripts:
        if s.top not in p.blocks:
            raise ValidationError(f"script {s.id} 的 top 指向不存在的積木 {s.top}")

    # §4.6：`return` 放在定義積木的 body 之外 → **存檔時**驗證錯誤，
    # 不是執行期才報。
    proc_bodies = {proc.definitionBlock for proc in p.procedures.values()}
    for bid, block in p.blocks.items():
        if block.opcode != "procedure.return":
            continue
        if not _has_ancestor_in(p, bid, proc_bodies):
            raise ValidationError(
                "「回傳」只能放在函式定義裡面", block_id=bid
            )
        if block.next is not None:
            raise ValidationError("「回傳」是終止積木，下面不能接積木", block_id=bid)


def _has_ancestor_in(p: Project, bid: str, targets: set[str | None]) -> bool:
    cur: str | None = bid
    seen: set[str] = set()
    while cur is not None and cur not in seen:
        seen.add(cur)
        if cur in targets:
            return True
        cur = p.blocks[cur].parent if cur in p.blocks else None
    return False

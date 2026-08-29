"""IR（`project.json`）的 pydantic 模型（§4.1、§4.2）。

`shared-schema` 最終要從這裡（或反過來）產生 TS 型別，避免前後端定義漂移。
目前以 pydantic 為唯一真實來源，JSON Schema 由 `model_json_schema()` 匯出。
"""

from __future__ import annotations

import re
from typing import Annotated, Any, Callable, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

from blocky.errors import ValidationError
from blocky.ir import expression as expr
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


#: 簽章與 manifest `text` 共用的佔位符語法（§4.6、§7.2）。
#:
#: **`extensions/manifest.py` 匯入這一份**，不另寫一條：D26 說函式的簽章模板
#: 「與 manifest 的 `text` 完全一樣」，而兩條各自維護的 regex 遲早會讓那句話
#: 變成半真的。
PLACEHOLDER = re.compile(r"%\((\w+)\)")


class ProcParam(Strict):
    id: str
    name: str
    type: str = "any"


class Procedure(Strict):
    """一個自訂函式（§4.6）。

    `name` 是一份**簽章模板**而不是一個名字（D26）：`"跳 %(a1) 次 到 %(a2)"`
    畫出來是 `跳 (10) 次 到 [左]`。佔位符引用的是參數的 **id**，不是名稱——
    名稱是使用者隨時會改的東西，而模板不該跟著壞掉。

    一個 `%(` 都沒有的簽章是**合法的相容模式**（排版退回
    `呼叫 <名稱> 參數名: (孔)`），不是舊資料：AI 生成的 IR（D5）多半長那樣。
    """

    name: str
    params: list[ProcParam] = Field(default_factory=list)
    # null = 無回傳值，呼叫積木為 command 形狀（§4.6）
    returns: ReturnType | None = None
    body: str | None = None
    definitionBlock: str | None = None

    @property
    def placeholders(self) -> list[str]:
        """簽章裡引用到的參數 id，依出現順序。"""
        return PLACEHOLDER.findall(self.name)

    @property
    def display_name(self) -> str:
        """給人看的一句話：把 `%(id)` 換成參數名稱。

        `跳 %(a1) 次 到 %(a2)` → `跳 (次數) 次 到 (方向)`。錯誤訊息與工具箱
        的標題用它——IR 的參數 id 在畫面上一個字都不該出現。
        """
        names = {p.id: p.name for p in self.params}
        return PLACEHOLDER.sub(lambda m: f"({names.get(m.group(1), m.group(1))})", self.name)


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

    def __init__(
        self,
        project: Project,
        templates: dict[tuple[str, str], tpl.Template],
        expressions: dict[tuple[str, str], expr.Expression] | None = None,
    ):
        self.project = project
        self._templates = templates
        self._expressions = expressions or {}

    def template(self, block_id: str, input_name: str) -> tpl.Template:
        return self._templates[(block_id, input_name)]

    def expression(self, block_id: str, field_name: str) -> expr.Expression:
        """§4.7b 的運算式欄位，解析結果與 template 同一條原則：用載入時算好的。"""
        parsed = self._expressions.get((block_id, field_name))
        if parsed is None:
            # 載入時沒有人告訴 `load()` 這個欄位是運算式，於是它沒有被解析、
            # 也沒有被驗證。這不是使用者的錯，是呼叫端漏了 `expressions=`。
            raise ValidationError(
                f"欄位 {field_name} 沒有被當成運算式載入", block_id=block_id, path=field_name
            )
        return parsed

    def __getattr__(self, name: str) -> Any:
        return getattr(self.project, name)


ShapeResolver = Callable[[str], frozenset[str]]
#: opcode → 宣告成 `type: expression` 的欄位名（§4.7b）。與 ShapeResolver
#: 同一個理由由呼叫端傳進來：這個問題只有宣告層答得出來，而 ir 層不該認識它。
ExpressionResolver = Callable[[str], frozenset[str]]
#: opcode → 是不是 cap block（§4.6）。同上：只有宣告層答得出來。
TerminalResolver = Callable[[str], bool]


def load(
    data: dict[str, Any],
    *,
    strict_refs: bool = True,
    shapes: ShapeResolver | None = None,
    expressions: ExpressionResolver | None = None,
    terminals: TerminalResolver | None = None,
) -> LoadedProject:
    """從 dict 載入並驗證專案。

    strict_refs=False 讓手寫的題庫 fixture 可以省略 `refs`——因為它本來就是
    衍生欄位，要求人手維護等於自找漂移。

    `shapes` 給了才做形狀驗證（見 `_validate_shapes`）。它是選填的，因為形狀
    要問過擴充系統才知道，而 ir 層不該認識擴充系統；呼叫端載完積木包後把
    `interpreter.registry.resolve_shape(...)` 傳進來。

    `expressions` 同理（§4.7b）：哪些欄位是運算式寫在宣告裡，呼叫端傳
    `interpreter.declarations.expression_fields`。沒給就不解析，那些欄位在
    執行期會以「沒有被當成運算式載入」失敗——比默默當成字串跑掉好。

    `terminals` 同理（§4.6）：哪些積木是 cap block。沒給就不檢查「下面接了
    東西」——與 `shapes` 一樣，那是一個要問過擴充系統才答得出來的問題。
    """
    project = Project.model_validate(data)
    templates: dict[tuple[str, str], tpl.Template] = {}
    exprs: dict[tuple[str, str], expr.Expression] = {}

    for bid, block in project.blocks.items():
        # §4.7b：運算式與 template 一樣**在存檔期解析**，語法錯誤帶著 blockId
        # 回到那顆積木上，而不是等執行到才說。
        for name in expressions(block.opcode) if expressions else ():
            raw = block.fields.get(name)
            if raw is None:
                continue  # 沒填 = 用宣告的 default，由前端補；空專案不該炸
            if not isinstance(raw, str):
                raise ValidationError(
                    f"欄位 {name} 必須是運算式文字", block_id=bid, path=name
                )
            exprs[(bid, name)] = expr.parse(raw, block_id=bid, field_name=name)

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

    _validate_structure(project, terminals)
    if shapes is not None:
        _validate_shapes(project, shapes)
    return LoadedProject(project, templates, exprs)


def _validate_structure(p: Project, terminals: TerminalResolver | None = None) -> None:
    """存檔／載入期的結構驗證（§4.6 return 位置與 cap block、參照完整性）。"""
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

    for proc in p.procedures.values():
        _validate_signature(proc)

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

    # §4.6：cap block 下面不能接積木。這句話原本寫死比對 `procedure.return`，
    # 現在讀 `terminal` 宣告（D21）——前端據同一句宣告不畫下凸點，所以正常
    # 操作根本接不上；這裡擋的是手寫或舊版產生的 IR。
    if terminals is not None:
        for bid, block in p.blocks.items():
            if block.next is not None and terminals(block.opcode):
                raise ValidationError(
                    f"{block.opcode} 是終止積木，下面不能接積木", block_id=bid
                )


# --------------------------------------------------------------------------
# 形狀驗證
# --------------------------------------------------------------------------

# 一顆積木被「誰」指到，就決定了它必須是什麼形狀。
_WRONG_SHAPE = {
    ("command", "value"): "{op} 是回報型積木，不能接在堆疊上",
    ("command", "hat"): "{op} 是事件積木，只能放在腳本最上面",
    ("value", "command"): "{op} 是指令型積木，不能插進輸入孔",
    ("value", "hat"): "{op} 是事件積木，不能插進輸入孔",
}


def _validate_shapes(p: Project, resolve: ShapeResolver) -> None:
    """積木形狀與它所在的位置必須相符。

    這件事**必須在載入期做**。放到執行期有兩個後果：錯誤要等那條路徑真的被
    走到才會出現（if 的另一半可以躺著錯好幾個月），而且它會以 ValidationError
    的形式從 Thread 裡漏出來——那不是 BlockyError，發不出 `block.error`，
    前端只會看到一個安靜停掉的 Thread。§4.6 對 `return` 的位置早就是載入期
    驗證，這裡只是把同一條原則套到所有積木上。

    **認不得的 opcode 不算錯**：那是 §13.3 的佔位符（積木包還沒安裝，或專案
    來自更新版的 runtime），保留給執行期以 UnknownBlockError 呈現。

    **`Script.top` 沒有形狀限制**（§4.1）。沒有 hat 的頂層堆疊是合法 IR，只是
    永遠不會被 trigger 選中——§5.1 的觸發條件是「top 的 opcode 等於這次的
    trigger」，一顆 `data.set` 不等於任何 trigger，所以它自然就不跑。曾經有一條
    「腳本最上面必須是事件積木」的檢查，刪掉了：它擋的是使用者天天在做的兩件事
    （寫到一半的積木要能存檔、落單堆疊要能點一下就跑），而它想擋的「hat 出現在
    堆疊中間」由下面的 `_require_shape` 擋，訊息還更準確——那是 `next` 接的積木
    必須是 command，與 top 是什麼形狀無關。
    """
    for bid, block in p.blocks.items():
        for name, inp in block.inputs.items():
            if isinstance(inp, BlockInput):
                _require_shape(p, resolve, inp.id, "value", path=f"{bid}.{name}")
            elif isinstance(inp, StackInput) and inp.id is not None:
                _require_shape(p, resolve, inp.id, "command", path=f"{bid}.{name}")
        if block.next is not None:
            _require_shape(p, resolve, block.next, "command", path=bid)

    for pid, proc in p.procedures.items():
        d = proc.definitionBlock
        if d is not None and p.block(d).opcode != "procedure.definition":
            raise ValidationError(f"函式 {pid} 的定義積木不是「定義」積木", block_id=d)


def _validate_signature(proc: Procedure) -> None:
    """簽章模板與參數列必須對得起來（§4.6、D26）。

    兩條規則，方向相反：

    - 引用了不存在的參數 → 那個佔位符畫不出東西來。
    - **一旦排了版，就必須把每個參數都放進去**。半套排版沒有合理的畫法：漏掉
      的參數要嘛憑空消失（呼叫端永遠填不到它，而函式體讀得到它）、要嘛偷偷附
      在句尾——兩種都會讓畫面說謊。

    完全沒有佔位符是**相容模式**，不進這條檢查：那時候版面由 `params` 的順序
    決定，每個參數都一定畫得出來。
    """
    ids = {param.id for param in proc.params}
    used = proc.placeholders

    if unknown := [ref for ref in used if ref not in ids]:
        raise ValidationError(
            f"函式 {proc.display_name} 的簽章引用了不存在的參數："
            f"%({'), %('.join(sorted(set(unknown)))})",
            block_id=proc.definitionBlock,
        )

    if not used:
        return

    if missing := [param for param in proc.params if param.id not in set(used)]:
        names = "、".join(param.name for param in missing)
        raise ValidationError(
            f"函式 {proc.display_name} 的簽章沒有用到參數 {names}："
            "簽章一旦自己排版，每個參數都要有位置",
            block_id=proc.definitionBlock,
        )


def _require_shape(
    p: Project, resolve: ShapeResolver, bid: str, want: str, *, path: str
) -> None:
    op = p.block(bid).opcode
    shapes = resolve(op)
    if not shapes or want in shapes:
        return
    actual = sorted(shapes)[0]
    template = _WRONG_SHAPE.get((want, actual))
    raise ValidationError(
        template.format(op=op) if template else f"{op} 不能放在這裡",
        block_id=bid,
        path=path,
    )


def _has_ancestor_in(p: Project, bid: str, targets: set[str | None]) -> bool:
    cur: str | None = bid
    seen: set[str] = set()
    while cur is not None and cur not in seen:
        seen.add(cur)
        if cur in targets:
            return True
        cur = p.blocks[cur].parent if cur in p.blocks else None
    return False

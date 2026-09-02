"""題庫內容（§17.2）。

這份清單直接對應設計文件中「講了會踩雷但畫面上看不出來」的每一條規則。
**任何一條規則沒有對應題目，那條規則就等於沒寫。**

每一題的 `spec` 欄位指回設計文件章節；改動語意時應該先改這裡，再改實作。
"""

from __future__ import annotations

from blocky.conformance import Case
from blocky.testing import Stack, Tpl, blk, build, var

FLAG = "event.when_flag_clicked"


def hat(*blocks):
    return [blk(FLAG), *blocks]


def log(v):
    return blk("debug.log", text=v)


def one(*blocks, procedures=None):
    return build(scripts=[hat(*blocks)], procedures=procedures)


CASES: list[Case] = []


def case(path, title, spec, project, expect, **kw):
    CASES.append(Case(path=path, title=title, spec=spec, project=project, expect=expect, **kw))


# ==========================================================================
# §4.3 值模型與型別轉換
# ==========================================================================

case(
    "values/number_is_double",
    "5.0 字串化為 \"5\"，10/2 也是——語意層只有 double（D15）",
    "§4.3 number 是 double",
    one(
        log(5.0),
        log(blk("operator.divide", a=10, b=2)),
        log(blk("operator.divide", a=1, b=3)),
        log(blk("operator.add", a=0.1, b=0.2)),
        log(1e21),
    ),
    {"status": "ok", "logs": ["5", "5", "0.3333333333333333", "0.30000000000000004", "1e+21"]},
    tags=["number", "D15"],
)

case(
    "values/type_of_never_says_int",
    "type.of 一律回 number，沒有 int",
    "§4.3 number 是 double",
    one(
        log(blk("type.of", value=5)),
        log(blk("type.of", value=5.5)),
        log(blk("type.of", value=blk("operator.divide", a=10, b=2))),
    ),
    {"status": "ok", "logs": ["number", "number", "number"]},
    tags=["number", "D15"],
)

case(
    "values/zero_is_falsy_but_not_empty",
    "0 是 falsy，但 type.is_empty(0) 為 false——刻意的不一致",
    "§4.3 「空」與 falsy 是兩件事",
    one(
        log(blk("operator.not", value=0)),
        log(blk("type.is_empty", value=0)),
        log(blk("type.is_empty", value="")),
        log(blk("type.is_empty", value=blk("data.new_list"))),
    ),
    {"status": "ok", "logs": ["true", "false", "true", "true"]},
    tags=["falsy", "is_empty"],
)

case(
    "values/string_coercion_table",
    "→ string 的轉換表：true/null/list/object",
    "§4.3 值模型與型別轉換",
    one(
        log(True),
        log(None),
        log(blk("object.to_json", value=blk("data.new_list"))),
        log(blk("type.cast", value=123, fields={"type": "string"})),
    ),
    {"status": "ok", "logs": ["true", "", "[]", "123"]},
    tags=["coercion"],
)

# ==========================================================================
# §4.3 索引規則
# ==========================================================================

case(
    "errors/index_zero_has_own_message",
    "索引 0 有專屬錯誤訊息：「索引從 1 開始」",
    "§4.3 索引規則",
    one(
        blk("data.set", fields={"name": "items"}, value=blk("data.new_list")),
        blk("data.list_add", fields={"name": "items"}, item="甲"),
        log(blk("data.list_item", fields={"name": "items"}, index=0)),
    ),
    {
        "status": "error",
        "error": {"code": "index", "message_contains": "索引從 1 開始", "hint_contains": "你是不是要 1"},
    },
    tags=["index", "D11"],
)

case(
    "errors/index_out_of_range_is_error",
    "越界是執行期錯誤，不回 null",
    "§4.3 索引規則",
    one(
        blk("data.set", fields={"name": "items"}, value=blk("data.new_list")),
        blk("data.list_add", fields={"name": "items"}, item="甲"),
        log(blk("data.list_item", fields={"name": "items"}, index=9)),
    ),
    {"status": "error", "error": {"code": "index", "message_contains": "超出範圍"}},
    tags=["index"],
)

case(
    "values/index_negative_and_last",
    "-1 是倒數第一，last 是最後一項",
    "§4.3 索引規則",
    one(
        blk("data.set", fields={"name": "items"}, value=blk("data.new_list")),
        blk("data.list_add", fields={"name": "items"}, item="甲"),
        blk("data.list_add", fields={"name": "items"}, item="乙"),
        blk("data.list_add", fields={"name": "items"}, item="丙"),
        log(blk("data.list_item", fields={"name": "items"}, index=1)),
        log(blk("data.list_item", fields={"name": "items"}, index=-1)),
        log(blk("data.list_item", fields={"name": "items"}, index="last")),
        log(blk("data.list_item", fields={"name": "items"}, index=-2)),
    ),
    {"status": "ok", "logs": ["甲", "丙", "丙", "乙"]},
    tags=["index"],
)

case(
    "values/index_float_integral_ok",
    "items[1.0] 合法且等同 items[1]；items[1.5] 是錯誤",
    "§4.3 number 是 double",
    one(
        blk("data.set", fields={"name": "items"}, value=blk("data.new_list")),
        blk("data.list_add", fields={"name": "items"}, item="甲"),
        log(blk("data.list_item", fields={"name": "items"}, index=1.0)),
        log(blk("data.list_item", fields={"name": "items"}, index=1.5)),
    ),
    {"status": "error", "logs": ["甲"], "error": {"code": "index", "message_contains": "必須是整數"}},
    tags=["index", "D15"],
)

case(
    "errors/object_key_missing_is_error",
    "object key 不存在是錯誤，不是 null",
    "§4.3 索引規則",
    one(
        blk("data.set", fields={"name": "o"}, value=blk("object.parse_json", text='{"a":1}')),
        log(blk("object.get", object=var("o"), key="b")),
    ),
    {"status": "error", "error": {"code": "key", "message_contains": "沒有 \"b\" 這個欄位"}},
    tags=["object"],
)

case(
    "values/object_get_with_default",
    "object.get 接了預設值孔就不報錯",
    "§4.3 索引規則",
    one(
        blk("data.set", fields={"name": "o"}, value=blk("object.parse_json", text='{"a":1}')),
        log(blk("object.get", object=var("o"), key="b", default="沒有")),
    ),
    {"status": "ok", "logs": ["沒有"]},
    tags=["object"],
)

# ==========================================================================
# §4.5 免宣告變數
# ==========================================================================

case(
    "data/write_creates_variable",
    "寫入即建立：沒碰過任何「建立變數」按鈕",
    "§4.5 執行語意",
    one(
        blk("data.set", fields={"name": "count"}, value=0),
        blk("control.repeat", times=10, body=Stack([
            blk("data.change", fields={"name": "count"}, value=1),
        ])),
        log(var("count")),
    ),
    {"status": "ok", "logs": ["10"], "vars": {"count": 10}},
    tags=["variables", "D7"],
)

case(
    "errors/read_undefined_variable",
    "讀取未建立的變數是錯誤，且附編輯距離建議",
    "§4.5 執行語意",
    one(
        blk("data.set", fields={"name": "count"}, value=1),
        log(var("conut")),
    ),
    {
        "status": "error",
        "error": {
            "code": "undefined_variable",
            "message_contains": '未知變數 "conut"',
            "hint_contains": '你是不是要 "count"',
        },
    },
    tags=["variables", "Q7"],
)

case(
    "errors/change_undefined_variable",
    "change 未建立的變數是錯誤，不是從 0 起算",
    "§4.5 執行語意",
    one(blk("data.change", fields={"name": "count"}, value=1)),
    {
        "status": "error",
        "error": {"code": "undefined_variable", "message_contains": "還沒建立"},
    },
    tags=["variables"],
)

# ==========================================================================
# §4.6 自訂函式與回傳值
# ==========================================================================

_SUM_PROC = {
    "p_sum": {
        "name": "加總",
        "params": [{"id": "a1", "name": "清單", "type": "list"}],
        "returns": "number",
        "body": [
            blk("data.set", fields={"name": "總和"}, value=0),
            blk("control.for_each", fields={"name": "x"}, list=var("清單"), body=Stack([
                blk("data.change", fields={"name": "總和"}, value=var("x")),
            ])),
            blk("procedure.return", value=var("總和")),
        ],
    }
}

case(
    "procedure/return_value_into_input_slot",
    "有回傳值的函式，呼叫積木可塞進 log 的輸入孔",
    "§4.6 自訂函式與回傳值",
    build(
        scripts=[hat(
            blk("data.set", fields={"name": "nums"}, value=blk("data.new_list")),
            blk("data.list_add", fields={"name": "nums"}, item=1),
            blk("data.list_add", fields={"name": "nums"}, item=2),
            blk("data.list_add", fields={"name": "nums"}, item=3),
            log(blk("procedure.call", mutation={"proc": "p_sum"}, a1=var("nums"))),
        )],
        procedures=_SUM_PROC,
    ),
    {"status": "ok", "logs": ["6"]},
    tags=["procedure", "D8"],
)

case(
    "procedure/return_inside_loop_exits_function",
    "return 在 repeat 迴圈內 → 中斷整個函式，不只跳出迴圈",
    "§4.6 執行語意",
    build(
        scripts=[hat(log(blk("procedure.call", mutation={"proc": "p_find"})))],
        procedures={
            "p_find": {
                "name": "找第一個",
                "params": [],
                "returns": "number",
                "body": [
                    blk("data.set", fields={"name": "i"}, value=0),
                    blk("control.repeat", times=10, body=Stack([
                        blk("data.change", fields={"name": "i"}, value=1),
                        blk("control.if", condition=blk("operator.gte", a=var("i"), b=3),
                            then=Stack([blk("procedure.return", value=var("i"))])),
                    ])),
                    # 走到這裡就代表 return 只跳出了迴圈——那是 bug
                    blk("procedure.return", value=-999),
                ],
            }
        },
    ),
    {"status": "ok", "logs": ["3"], "vars": {"i": 3}},
    tags=["procedure", "unwind"],
)

case(
    "procedure/try_catch_must_not_swallow_return",
    "try_catch 不可捕捉 ProcedureReturn——最容易寫錯的一題",
    "§4.6 執行語意 / §5.6",
    build(
        scripts=[hat(log(blk("procedure.call", mutation={"proc": "p_t"})))],
        procedures={
            "p_t": {
                "name": "在 try 裡回傳",
                "params": [],
                "returns": "string",
                "body": [
                    blk("control.try_catch",
                        fields={"error_name": "error"},
                        **{"try": Stack([blk("procedure.return", value="回傳成功")]),
                           "catch": Stack([blk("procedure.return", value="被吞掉了")])}),
                    blk("procedure.return", value="穿透失敗"),
                ],
            }
        },
    ),
    {"status": "ok", "logs": ["回傳成功"]},
    tags=["procedure", "try_catch", "unwind"],
)

case(
    "procedure/no_return_yields_null",
    "跑完 body 沒遇到 return → 回傳 null",
    "§4.6 執行語意",
    build(
        scripts=[hat(log(blk("type.of", value=blk("procedure.call", mutation={"proc": "p_n"}))))],
        procedures={
            "p_n": {"name": "什麼都不回", "params": [], "returns": "any",
                    "body": [blk("data.set", fields={"name": "x"}, value=1)]},
        },
    ),
    {"status": "ok", "logs": ["null"]},
    tags=["procedure"],
)

case(
    "procedure/recursion_limit",
    "遞迴深度超過 200 → 拋錯而非堆疊爆掉",
    "§5.4 變數作用域",
    build(
        scripts=[hat(log(blk("procedure.call", mutation={"proc": "p_r"}, a1=1)))],
        procedures={
            "p_r": {
                "name": "無限遞迴", "params": [{"id": "a1", "name": "n", "type": "number"}],
                "returns": "number",
                "body": [blk("procedure.return",
                             value=blk("procedure.call", mutation={"proc": "p_r"},
                                       a1=blk("operator.add", a=var("n"), b=1)))],
            }
        },
    ),
    {"status": "error", "error": {"code": "recursion_limit", "message_contains": "200"}},
    tags=["procedure", "recursion"],
)

case(
    "procedure/eval_order_left_to_right",
    "輸入孔由左而右、深度優先求值（用帶副作用的 reporter 驗證）",
    "§4.6 執行語意",
    one(
        log(blk("operator.add",
                a=blk("debug.inspect", value=1),
                b=blk("debug.inspect", value=2))),
    ),
    {"status": "ok", "logs": ["number: 1", "number: 2", "3"]},
    tags=["procedure", "eval_order"],
)

case(
    "procedure/param_shadows_global",
    "名稱解析順序：參數 → thread-local → 全域",
    "§5.4 變數作用域",
    build(
        scripts=[hat(
            blk("data.set", fields={"name": "x"}, value="全域"),
            log(blk("procedure.call", mutation={"proc": "p_s"}, a1="參數")),
            log(var("x")),
        )],
        procedures={
            "p_s": {"name": "回傳 x", "params": [{"id": "a1", "name": "x", "type": "string"}],
                    "returns": "string", "body": [blk("procedure.return", value=var("x"))]},
        },
    ),
    {"status": "ok", "logs": ["參數", "全域"]},
    tags=["procedure", "scope"],
)

# ==========================================================================
# §4.7 字串插值
# ==========================================================================

case(
    "template/interpolate_nested_path",
    "第 ${i} 筆：${resp.items[1].title} 能正確取值",
    "§4.7 語法",
    one(
        blk("data.set", fields={"name": "i"}, value=3),
        blk("data.set", fields={"name": "resp"},
            value=blk("object.parse_json", text='{"items":[{"title":"甲"},{"title":"乙"}]}')),
        log(Tpl("第 ${i} 筆：${resp.items[1].title}")),
    ),
    {"status": "ok", "logs": ["第 3 筆：甲"]},
    tags=["template", "D9"],
)

case(
    "template/whole_field_keeps_type",
    "整格取值保留原型別，可直接餵進 for each",
    "§4.7 整格取值 vs 字串拼接",
    one(
        blk("data.set", fields={"name": "resp"},
            value=blk("object.parse_json", text='{"items":[1,2,3]}')),
        blk("data.set", fields={"name": "sum"}, value=0),
        blk("control.for_each", fields={"name": "x"}, list=Tpl("${resp.items}"), body=Stack([
            blk("data.change", fields={"name": "sum"}, value=var("x")),
        ])),
        log(blk("type.of", value=Tpl("${resp.items}"))),
        log(var("sum")),
    ),
    {"status": "ok", "logs": ["list", "6"], "vars": {"sum": 6}},
    tags=["template"],
)

case(
    "template/escape_and_bare_dollar",
    "$${ 逸出成字面的 ${；其餘 $ 一律字面",
    "§4.7 語法",
    one(log(Tpl("$${HOME} 要 $5 元"))),
    {"status": "ok", "logs": ["${HOME} 要 $5 元"]},
    tags=["template"],
)

case(
    "template/expression_rejected_at_load",
    "${a + b} 在存檔期就被擋，不是執行期",
    "§4.7 核心限制 / D9",
    one(log(Tpl("${a + b}"))),
    {"status": "load_error", "load_error": "不支援運算"},
    tags=["template", "D9"],
)

case(
    "template/string_attribute_gets_parse_json_hint",
    "${str.foo} 的錯誤訊息提示「是不是需要先用解析 JSON」",
    "§4.7 錯誤語意",
    one(
        blk("data.set", fields={"name": "s"}, value='{"a":1}'),
        log(Tpl("${s.a}")),
    ),
    {
        "status": "error",
        "error": {"code": "template", "message_contains": "是文字不是物件",
                  "hint_contains": "解析 JSON"},
    },
    tags=["template"],
)

case(
    "template/index_zero_in_path",
    "${items[0]} 走同一套索引規則，拿到專屬訊息",
    "§4.7 錯誤語意",
    one(
        blk("data.set", fields={"name": "items"}, value=blk("data.new_list")),
        blk("data.list_add", fields={"name": "items"}, item="甲"),
        log(Tpl("${items[0]}")),
    ),
    {"status": "error", "error": {"code": "index", "message_contains": "索引從 1 開始"}},
    tags=["template", "index"],
)

case(
    "template/last_in_path",
    "${items[last]} 與 ${items[-1]} 等價",
    "§4.7 語法",
    one(
        blk("data.set", fields={"name": "items"}, value=blk("data.new_list")),
        blk("data.list_add", fields={"name": "items"}, item="甲"),
        blk("data.list_add", fields={"name": "items"}, item="乙"),
        log(Tpl("${items[last]}/${items[-1]}")),
    ),
    {"status": "ok", "logs": ["乙/乙"]},
    tags=["template", "index"],
)

# ==========================================================================
# §4.7b 運算積木（D23）
# ==========================================================================


def expr(source: str):
    """`運算 (…)`。運算式是 field，不是輸入孔——它是這顆積木自己的內容。"""
    return blk("operator.expr", fields={"expr": source})


case(
    "operator/boolean_literals",
    "真 / 假 是字面值積木，插得進六角形孔——那個孔沒有影子（§8.1）",
    "§4.4 邏輯",
    one(
        log(blk("operator.true")),
        log(blk("operator.false")),
        log(blk("operator.and", a=blk("operator.true"), b=blk("operator.false"))),
        blk("control.if", condition=blk("operator.true"), then=Stack([log("走到了")])),
        blk("control.if", condition=blk("operator.false"), then=Stack([log("不該走到")])),
    ),
    {"status": "ok", "logs": ["true", "false", "false", "走到了"]},
    tags=["logic"],
)

case(
    "expression/precedence_and_parens",
    "運算 ((1+2)*3) 與 (1+2*3) 不同：優先序與括號都照數學",
    "§4.7b 文法",
    one(
        log(expr("1 + 2 * 3")),
        log(expr("(1 + 2) * 3")),
        log(expr("10 - 3 - 2")),      # 左結合
        log(expr("2 * -3")),          # 單目負號
        log(expr("10 % 3")),
    ),
    {"status": "ok", "logs": ["7", "9", "5", "-6", "1"]},
    tags=["expression", "D23"],
)

case(
    "expression/variables_use_the_same_paths",
    "運算式裡的 ${a.b[1]} 與字串插值是同一套路徑",
    "§4.7b 運算元",
    one(
        blk("data.set", fields={"name": "n"}, value=10),
        blk("data.set", fields={"name": "resp"},
            value=blk("object.parse_json", text='{"items":[2,4]}')),
        log(expr("${n} * 2 / 4 + 1")),
        log(expr("${resp.items[2]} - ${resp.items[1]}")),
    ),
    {"status": "ok", "logs": ["6", "2"]},
    tags=["expression", "D23"],
)

case(
    "expression/operands_convert_like_everything_else",
    "運算元走 §4.3 的轉換表：\"4\" 是 4，true 是 1，文字則是執行期錯誤",
    "§4.3 值模型 / §4.7b",
    one(
        blk("data.set", fields={"name": "s"}, value="4"),
        log(expr("${s} + 1")),
        blk("data.set", fields={"name": "bad"}, value="四"),
        log(expr("${bad} + 1")),
    ),
    {
        "status": "error",
        "logs": ["5"],
        "error": {"code": "type", "message_contains": "無法把文字"},
    },
    tags=["expression", "D23"],
)

case(
    "expression/syntax_error_is_a_load_error",
    "運算式的語法錯誤在存檔期就擋下來，與 ${a + b} 同一條原則",
    "§4.7b 解析時機 / D9",
    one(log(expr("${a} > 2"))),
    {"status": "load_error", "load_error": "不能用"},
    tags=["expression", "D23", "D9"],
)

case(
    "expression/divide_by_zero_matches_the_block",
    "運算式的 / 與「÷」積木是同一份語意：除以 0 是錯誤，不是 Infinity",
    "§4.7b 求值 / §4.3",
    one(
        log(blk("operator.divide", a=10, b=4)),
        log(expr("10 / 4")),
        log(expr("1 / 0")),
    ),
    {
        "status": "error",
        "logs": ["2.5", "2.5"],
        "error": {"message_contains": "不能除以 0"},
    },
    tags=["expression", "D23"],
)

# ==========================================================================
# §4.8 型別積木
# ==========================================================================

case(
    "type/is_vs_can_cast",
    '"123" 對 type.is 是 false，對 can_cast 是 true——所以必須是兩顆積木',
    "§4.8 為什麼 is 和 can_cast 必須是兩顆",
    one(
        log(blk("type.is", value="123", fields={"type": "number"})),
        log(blk("type.can_cast", value="123", fields={"type": "number"})),
        log(blk("type.is", value=123, fields={"type": "number"})),
        log(blk("type.can_cast", value="abc", fields={"type": "number"})),
    ),
    {"status": "ok", "logs": ["false", "true", "true", "false"]},
    tags=["type"],
)

case(
    "type/list_and_object_are_distinct",
    "清單與物件是兩種型別；null 是獨立型別——都違反 JS 直覺",
    "§4.8 兩個違反 JS 直覺的地方",
    one(
        log(blk("type.is", value=blk("data.new_list"), fields={"type": "object"})),
        log(blk("type.is", value=blk("data.new_list"), fields={"type": "list"})),
        log(blk("type.is", value=None, fields={"type": "object"})),
        log(blk("type.is", value=None, fields={"type": "null"})),
    ),
    {"status": "ok", "logs": ["false", "true", "false", "true"]},
    tags=["type"],
)

case(
    "type/cast_refuses_object",
    "cast 的下拉不含物件——把字串變成物件只可能是 JSON parse",
    "§4.8 下拉選項 / D10",
    one(log(blk("type.cast", value='{"a":1}', fields={"type": "object"}))),
    {"status": "error", "error": {"code": "type", "hint_contains": "解析 JSON"}},
    tags=["type", "D10"],
)

case(
    "type/try_cast_uses_default",
    "try_cast 轉不動就用預設值，省掉一整個 try_catch",
    "§4.8 型別積木",
    one(
        log(blk("type.try_cast", value="abc", default=0, fields={"type": "number"})),
        log(blk("type.try_cast", value="42", default=0, fields={"type": "number"})),
    ),
    {"status": "ok", "logs": ["0", "42"]},
    tags=["type"],
)

case(
    "type/parse_json_is_never_automatic",
    "parse 永不自動：字串就是字串，直到有一顆看得見的積木",
    "§4.8 JSON / D10",
    one(
        blk("data.set", fields={"name": "s"}, value='{"a":1}'),
        log(blk("type.of", value=var("s"))),
        log(blk("type.of", value=blk("object.parse_json", text=var("s")))),
    ),
    {"status": "ok", "logs": ["string", "object"]},
    tags=["type", "D10"],
)

# ==========================================================================
# §5 控制流與錯誤處理
# ==========================================================================

case(
    "control/try_catch_binds_error",
    "try_catch 綁定 error 變數（含 message / code / blockId）",
    "§5.6 錯誤處理",
    one(
        blk("control.try_catch", fields={"error_name": "error"},
            **{"try": Stack([log(var("nope"))]),
               "catch": Stack([log(Tpl("接到了：${error.code}"))])}),
        log("繼續執行"),
    ),
    {"status": "ok", "logs": ["接到了：undefined_variable", "繼續執行"]},
    tags=["try_catch"],
)

case(
    "control/if_chain_takes_the_first_match",
    "如果⋯否則如果⋯否則：由上往下，第一個成立的就停（§16 Q19）",
    "§16 Q19 可重複參數群組",
    one(
        blk("control.if_else",
            mutation={"repeat": 2},
            condition=blk("operator.false"),
            then=Stack([log("不該走到 then")]),
            condition_1=blk("operator.true"),
            body_1=Stack([log("第一個 elif")]),
            condition_2=blk("operator.true"),
            body_2=Stack([log("不該走到第二個 elif")]),
            **{"else": Stack([log("不該走到 else")])}),
    ),
    {"status": "ok", "logs": ["第一個 elif"]},
    tags=["if_chain", "repeat"],
)

case(
    "control/if_chain_falls_through_to_else",
    "所有 elif 都不成立時走 else",
    "§16 Q19 可重複參數群組",
    one(
        blk("control.if_else",
            mutation={"repeat": 1},
            condition=blk("operator.false"),
            then=Stack([log("不該走到 then")]),
            condition_1=blk("operator.false"),
            body_1=Stack([log("不該走到 elif")]),
            **{"else": Stack([log("走到 else")])}),
    ),
    {"status": "ok", "logs": ["走到 else"]},
    tags=["if_chain", "repeat"],
)

case(
    "control/if_chain_does_not_evaluate_later_conditions",
    "命中之後**不再求值**後面的條件——分支的 reporter 可以帶副作用",
    "§16 Q19 可重複參數群組",
    one(
        blk("control.if_else",
            mutation={"repeat": 2},
            condition=blk("operator.false"),
            then=Stack([log("不該走到 then")]),
            condition_1=blk("operator.true"),
            body_1=Stack([log("命中")]),
            # 這一格如果被求值，`debug.inspect` 會留下一筆 log——而下面的
            # 期望裡只有「命中」一行。**用副作用當證人**，不是用結果：一個
            # 「多算了一次但答案一樣」的實作，只看結果是抓不到的。
            condition_2=blk("operator.eq",
                            a=blk("debug.inspect", value="偷偷算了"), b="偷偷算了"),
            body_2=Stack([log("不該走到")]),
            **{"else": Stack([log("不該走到 else")])}),
    ),
    {"status": "ok", "logs": ["命中"]},
    tags=["if_chain", "repeat", "side_effects"],
)

case(
    "control/if_chain_without_mutation_is_a_plain_if_else",
    "沒有 mutation 的 if_else 行為完全不變（向下相容）",
    "§16 Q19 可重複參數群組",
    one(
        blk("control.if_else",
            condition=blk("operator.false"),
            then=Stack([log("不該走到 then")]),
            **{"else": Stack([log("走到 else")])}),
    ),
    {"status": "ok", "logs": ["走到 else"]},
    tags=["if_chain", "repeat"],
)

case(
    "control/throw_is_caught_by_try",
    "丟出錯誤 被 try_catch 接住，code 是 thrown",
    "§5.6 錯誤處理",
    one(
        blk("control.try_catch", fields={"error_name": "error"},
            **{"try": Stack([blk("control.throw", message="這份資料不對")]),
               "catch": Stack([log(Tpl("${error.code}：${error.message}"))])}),
        log("繼續執行"),
    ),
    {"status": "ok", "logs": ["thrown：這份資料不對", "繼續執行"]},
    tags=["try_catch", "throw"],
)

case(
    "control/throw_uncaught_ends_the_thread",
    "沒有 try 接住的 丟出錯誤 中止這條 thread",
    "§5.6 錯誤處理",
    one(
        log("丟之前"),
        blk("control.throw", message="停"),
    ),
    {"status": "error", "logs": ["丟之前"]},
    tags=["throw", "errors"],
)

case(
    "control/throw_skips_the_rest_of_the_try",
    "丟出錯誤 之後 try 裡剩下的積木不執行",
    "§5.6 錯誤處理",
    one(
        blk("control.try_catch", fields={"error_name": "error"},
            **{"try": Stack([
                   log("丟之前"),
                   blk("control.if", condition=blk("operator.true"),
                       then=Stack([blk("control.throw", message="停")])),
                   log("丟之後"),
               ]),
               "catch": Stack([log("接到了")])}),
    ),
    {"status": "ok", "logs": ["丟之前", "接到了"]},
    tags=["try_catch", "throw"],
)

case(
    "control/stop_this_script_not_caught_by_try",
    "control.stop 必須穿透 try_catch",
    "§5.6 錯誤處理",
    one(
        blk("control.try_catch", fields={"error_name": "error"},
            **{"try": Stack([blk("control.stop", fields={"scope": "this_script"})]),
               "catch": Stack([log("被吞掉了")])}),
        log("不該執行到"),
    ),
    {"status": "ok", "logs": []},
    tags=["try_catch", "stop"],
)

case(
    "control/other_threads_keep_running",
    "一個 thread 出錯，其餘 thread 繼續執行",
    "§5.6 錯誤處理",
    build(scripts=[
        hat(log(var("nope"))),
        hat(log("我還活著")),
    ]),
    {"status": "error", "logs": ["我還活著"]},
    tags=["threads", "errors"],
)

case(
    "control/for_each_snapshots_list",
    "for each 迭代前先複製：迴圈體改原清單不影響迭代範圍",
    "§4.4 control",
    one(
        blk("data.set", fields={"name": "items"}, value=blk("data.new_list")),
        blk("data.list_add", fields={"name": "items"}, item=1),
        blk("data.list_add", fields={"name": "items"}, item=2),
        blk("data.set", fields={"name": "n"}, value=0),
        blk("control.for_each", fields={"name": "x"}, list=var("items"), body=Stack([
            blk("data.change", fields={"name": "n"}, value=1),
            blk("data.list_add", fields={"name": "items"}, item=99),
        ])),
        log(var("n")),
    ),
    {"status": "ok", "logs": ["2"], "vars": {"n": 2}},
    tags=["control"],
)

# ---- §5.4 D29：綁定的作用範圍 = 綁它那顆積木的 body ----

case(
    "control/for_each_var_dies_with_the_loop",
    "迴圈變數只在迴圈體裡有效；迴圈外面讀它是錯誤，而且訊息指名是哪顆積木綁的",
    "§5.4 綁定的作用範圍（D29）",
    one(
        blk("data.set", fields={"name": "items"}, value=blk("data.new_list")),
        blk("data.list_add", fields={"name": "items"}, item=1),
        blk("data.list_add", fields={"name": "items"}, item=2),
        blk("control.for_each", fields={"name": "x"}, list=var("items"), body=Stack([
            log(var("x")),
        ])),
        log(var("x")),
    ),
    {
        "status": "error",
        "logs": ["1", "2"],
        "error": {
            "code": "undefined_variable",
            # 這句話是 D29 唯一會被使用者看到的地方：既有專案在迴圈後讀迴圈
            # 變數，會從「拿得到最後一項」變成錯誤。一句 `未知變數 "x"` 會讓
            # 人去找一個根本沒打錯的字。
            "message_contains": "只在那顆「對 ⋯ 的每一項 x」裡面有效",
        },
    },
    tags=["control", "variables", "D29"],
)

case(
    "control/for_each_vars_do_not_collide_across_threads",
    "兩條 thread 各跑一個同名迴圈變數的 for each、迴圈體裡有 await → 互不干擾",
    "§5.4 綁定的作用範圍（D29）",
    build(scripts=[
        hat(
            blk("data.set", fields={"name": "a"}, value=blk("data.new_list")),
            blk("data.list_add", fields={"name": "a"}, item=1),
            blk("data.list_add", fields={"name": "a"}, item=2),
            blk("control.for_each", fields={"name": "x"}, list=var("a"), body=Stack([
                # 讓出 event loop：沒有這個 await，兩條 thread 不會交錯，
                # 這一題就永遠是綠的（而 bug 還在）。
                blk("control.wait", seconds=0),
                log(Tpl("A${x}")),
            ])),
        ),
        hat(
            blk("data.set", fields={"name": "b"}, value=blk("data.new_list")),
            blk("data.list_add", fields={"name": "b"}, item=10),
            blk("data.list_add", fields={"name": "b"}, item=20),
            blk("control.for_each", fields={"name": "x"}, list=var("b"), body=Stack([
                blk("control.wait", seconds=0),
                log(Tpl("B${x}")),
            ])),
        ),
    ]),
    # 迴圈變數寫全域時這裡會是 A10 / B10 / A20 / B20 ——兩邊互相踩，而
    # 「值對了一半」正是這種 bug 唯一的樣子。
    {"status": "ok", "logs": ["A1", "B10", "A2", "B20"]},
    tags=["control", "threads", "variables", "D29"],
)

case(
    "control/catch_binding_does_not_cross_a_call",
    "catch 裡呼叫的函式讀不到 error——C block 綁的名字不穿過函式呼叫",
    "§5.4 綁定的作用範圍（D29）",
    build(
        scripts=[hat(
            blk("control.try_catch", fields={"error_name": "錯誤"},
                **{"try": Stack([blk("control.throw", message="爆了")]),
                   "catch": Stack([
                       # 同一顆積木在 catch 裡直接讀得到（下一行證明）
                       log(Tpl("${錯誤.message}")),
                       log(blk("procedure.call", mutation={"proc": "p_peek"})),
                   ])}),
        )],
        procedures={
            "p_peek": {
                "name": "偷看錯誤",
                "params": [],
                "returns": "string",
                "body": [blk("procedure.return", value=var("錯誤"))],
            }
        },
    ),
    {
        "status": "error",
        "logs": ["爆了"],
        "error": {
            "code": "undefined_variable",
            "message_contains": "只在那顆「嘗試 ⋯ 出錯時把錯誤存進 錯誤」裡面有效",
            "hint_contains": "用參數傳進來",
        },
    },
    tags=["try_catch", "procedure", "variables", "D29"],
)

case(
    "control/set_a_bound_name_is_a_load_error",
    "迴圈體裡的「設定 [迴圈變數]」是存檔期錯誤，訊息指名那顆 for each",
    "§5.4 綁定的作用範圍（D29）",
    one(
        blk("data.set", fields={"name": "items"}, value=blk("data.new_list")),
        blk("control.for_each", fields={"name": "x"}, list=var("items"), body=Stack([
            # 讀的是第 2 層、寫的是第 3 層，而畫面上這兩顆積木長得一模一樣。
            blk("data.set", fields={"name": "x"}, value="蓋掉"),
        ])),
    ),
    {"status": "load_error", "load_error": "「x」是那顆「對 ⋯ 的每一項 x」綁的名字"},
    tags=["control", "variables", "validation", "D29"],
)

case(
    "control/repeat_evaluates_count_once",
    "repeat 的次數只在進入迴圈前求值一次",
    "§4.4 control",
    one(
        blk("data.set", fields={"name": "n"}, value=3),
        blk("data.set", fields={"name": "hits"}, value=0),
        blk("control.repeat", times=var("n"), body=Stack([
            blk("data.change", fields={"name": "hits"}, value=1),
            blk("data.change", fields={"name": "n"}, value=10),
        ])),
        log(var("hits")),
    ),
    {"status": "ok", "logs": ["3"], "vars": {"hits": 3}},
    tags=["control"],
)

# ==========================================================================
# 比較語意（原文件未定義，這裡補上）
# ==========================================================================

case(
    "values/equality_does_not_coerce",
    '相等比較不做型別轉換："5" 不等於 5',
    "§4.4 operator 比較語意",
    one(
        log(blk("operator.eq", a="5", b=5)),
        log(blk("operator.eq", a=5, b=5.0)),
        log(blk("operator.eq", a=blk("data.new_list"), b=blk("data.new_list"))),
    ),
    {"status": "ok", "logs": ["false", "true", "true"]},
    tags=["operator", "comparison"],
)

def approx(a, b):
    return blk("operator.eq", fields={"op": "approx"}, a=a, b=b)


case(
    "values/approx_equality_coerces",
    "≈ 去頭尾空白、不分大小寫、跨型別先轉換（D24）",
    "§4.4.1 比較語意",
    one(
        log(approx(" 5 ", 5)),          # 規則 3：兩邊都轉得成數字
        log(approx("ABC", "abc ")),     # 規則 2：同型別文字，trim + casefold
        log(approx(True, "TRUE")),      # 規則 4：轉成文字才對得上
        log(approx(True, 1)),           # 規則 3：布林走 1 / 0
        log(approx(blk("operator.add", a=0.1, b=0.2), 0.3)),  # 規則 2：相對誤差
        log(approx("abc", 5)),          # 規則 4：文字對不上
    ),
    {"status": "ok", "logs": ["true", "true", "true", "true", "true", "false"]},
    tags=["operator", "comparison", "D24"],
)

case(
    "values/approx_equality_keeps_absence_distinct",
    "≈ 的三條邊界：null 不約等於任何東西、容器不遞迴、0 不吸收極小值（D24）",
    "§4.4.1 比較語意",
    one(
        # null 走規則 1，連空字串與 0 都不約等於——寬鬆比對可以少問一個型別，
        # 不能少問一次「有沒有值」。空字串同理：它不是 0。
        log(approx(blk("object.parse_json", text="null"), 0)),
        log(approx("", 0)),
        log(approx("", "  ")),
        # 容器走規則 1，不把 ≈ 遞迴進元素
        log(approx(blk("object.parse_json", text='["a "]'),
                   blk("object.parse_json", text='["a"]'))),
        # 相對誤差沒有絕對下限，所以 0 只約等於 0
        log(approx(0, 1e-300)),
    ),
    {"status": "ok", "logs": ["false", "false", "true", "false", "false"]},
    tags=["operator", "comparison", "D24"],
)

case(
    "values/approx_inequality_is_the_negation",
    "≉ 就是 ≈ 的否定；省略 op 欄位的手寫 IR 仍然是嚴格比對（D24、D5）",
    "§4.4.1 比較語意",
    one(
        log(blk("operator.neq", fields={"op": "approx"}, a=" 5 ", b=5)),
        log(blk("operator.neq", fields={"op": "approx"}, a="abc", b=5)),
        # 沒有 fields.op：fallback 是 exact，`=` 的語意一個字都沒有改
        log(blk("operator.eq", a="5", b=5)),
        log(blk("operator.neq", a="5", b=5)),
    ),
    {"status": "ok", "logs": ["false", "true", "false", "true"]},
    tags=["operator", "comparison", "D24"],
)

case(
    "operator/ordering_compares_as_numbers",
    "大小比較預設照數字比，兩邊先 to_number（D27）",
    "§4.4.1 比較語意",
    one(
        # 使用者打進文字影子的 "5"：這是 D27 要修的那條路
        log(blk("operator.lt", a="5", b=10)),
        log(blk("operator.gt", a=" 12 ", b=9)),
        # 嗅探會在這題答錯——字典序說 "10" < "9"
        log(blk("operator.gte", a="10", b="9")),
        # 布林走 1 / 0，與 §4.3 的 to_number 同一張表
        log(blk("operator.lte", a=True, b=1)),
    ),
    {"status": "ok", "logs": ["true", "true", "true", "true"]},
    tags=["operator", "comparison", "D27"],
)

case(
    "operator/ordering_text_mode_is_lexicographic",
    "選了「照文字比」才走字典序；省略 mode 欄位的手寫 IR 是 number（D27、D5）",
    "§4.4.1 比較語意",
    one(
        log(blk("operator.lt", fields={"mode": "text"}, a="10", b="9")),
        log(blk("operator.gt", fields={"mode": "text"}, a="banana", b="apple")),
        # to_string 是全函數，所以文字模式沒有失敗模式
        log(blk("operator.lt", fields={"mode": "text"}, a=False, b="true")),
        # 沒有 fields.mode：fallback 是 number
        log(blk("operator.lt", a="10", b="9")),
    ),
    {"status": "ok", "logs": ["true", "true", "true", "false"]},
    tags=["operator", "comparison", "D27"],
)

case(
    "errors/ordering_non_numeric_text_is_error",
    "照數字比但轉不成數字 → 執行期錯誤，訊息提示先轉型",
    "§4.4.1 比較語意",
    one(log(blk("operator.lt", a="abc", b=10))),
    {"status": "error", "error": {"code": "type", "hint_contains": "轉為數字"}},
    tags=["operator", "comparison", "D27"],
)

case(
    "errors/ordering_null_is_error",
    "null 兩種模式都不能比大小——「有沒有值」不是「誰比較大」（D27）",
    "§4.4.1 比較語意",
    one(log(blk("operator.gt", a=blk("object.parse_json", text="null"), b=0))),
    {"status": "error", "error": {"code": "type", "message_contains": "不能比較"}},
    tags=["operator", "comparison", "D27"],
)

# ==========================================================================
# §5.4 / D12 生命週期
# ==========================================================================

case(
    "persist/globals_do_not_survive_run",
    "全域變數不跨 Run 存活；persist_* 才會（D12）",
    "§5.4 全域變數的生命週期",
    one(
        log(blk("data.persist_get", fields={"name": "累計"}, default=0)),
        blk("data.persist_set", fields={"name": "累計"},
            value=blk("operator.add", a=blk("data.persist_get", fields={"name": "累計"}, default=0), b=1)),
        log(blk("data.persist_get", fields={"name": "累計"}, default=0)),
    ),
    {"status": "ok", "logs": ["7", "8"], "persist": {"累計": 8}},
    persist={"累計": 7},
    tags=["persist", "D12"],
)

case(
    "persist/get_has_default_not_error",
    "persist_get 有預設值孔而非報錯——第一次執行必然不存在",
    "§5.4 第 4 層",
    one(
        log(blk("data.persist_has", fields={"name": "沒設過"})),
        log(blk("data.persist_get", fields={"name": "沒設過"}, default="預設")),
    ),
    {"status": "ok", "logs": ["false", "預設"]},
    tags=["persist", "D12"],
)

# ==========================================================================
# §4.9 時間
# ==========================================================================

_T = 1756281600000  # 2025-08-27T08:00:00Z

case(
    "time/timezone_travels_with_value",
    "時區跟著值走：同一個時間戳在不同時區格式化結果不同",
    "§4.9 時間戳的表示",
    one(
        log(blk("time.format", time=blk("time.now"), fields={"format": "datetime"})),
        log(blk("time.format", time=blk("time.now", timezone="UTC"), fields={"format": "datetime"})),
    ),
    {"status": "ok", "logs": ["2025-08-27 16:00:00", "2025-08-27 08:00:00"]},
    clock=_T, timezone="Asia/Taipei",
    tags=["time"],
)

case(
    "time/add_days_crosses_dst",
    "加「天」走行事曆運算，跨日光節約時間仍是同一個鐘點",
    "§4.9 日期時間積木",
    one(
        blk("data.set", fields={"name": "t"},
            value=blk("time.parse", text="2025-03-08T12:00:00", timezone="America/New_York")),
        log(blk("time.format", time=var("t"), fields={"format": "datetime"})),
        log(blk("time.format",
                time=blk("time.add", time=var("t"), amount=1, fields={"unit": "day"}),
                fields={"format": "datetime"})),
    ),
    {"status": "ok", "logs": ["2025-03-08 12:00:00", "2025-03-09 12:00:00"]},
    timezone="America/New_York",
    tags=["time", "dst"],
)

case(
    "time/part_and_diff",
    "time.part 與 time.diff",
    "§4.9 日期時間積木",
    one(
        blk("data.set", fields={"name": "a"}, value=blk("time.parse", text="2025-08-27T00:00:00")),
        blk("data.set", fields={"name": "b"}, value=blk("time.parse", text="2025-08-20T00:00:00")),
        log(blk("time.diff", a=var("a"), b=var("b"), fields={"unit": "day"})),
        log(blk("time.part", time=var("a"), fields={"part": "weekday"})),
        log(blk("time.part", time=var("a"), fields={"part": "month"})),
    ),
    {"status": "ok", "logs": ["7", "3", "8"]},
    tags=["time"],
)

# ==========================================================================
# §6.2 事件
# ==========================================================================

case(
    "events/value_over_4kb_is_truncated",
    "block.exit 的 value 超過 4KB 會被截斷並標記",
    "§6.2 流量控制",
    one(
        blk("data.set", fields={"name": "big"}, value="x" * 5000),
        log(blk("operator.length", text=var("big"))),
    ),
    {"status": "ok", "logs": ["5000"]},
    tags=["events"],
)

# ==========================================================================
# §4.6 載入期驗證
# ==========================================================================

case(
    "procedure/signature_template_is_display_only",
    "簽章模板（%(參數id)）只改畫面，執行語意與純名稱的簽章一模一樣",
    "§4.6 簽章是一份模板（D26）",
    build(
        scripts=[hat(log(blk("procedure.call", mutation={"proc": "p_jump"}, a1=3, a2="左")))],
        procedures={
            "p_jump": {
                # 畫出來是 `跳 (3) 次 到 [左]`；函式體讀的仍然是參數**名稱**
                # （§5.4 第 1 層），與模板無關。
                "name": "跳 %(a1) 次 到 %(a2)",
                "params": [
                    {"id": "a1", "name": "次數", "type": "number"},
                    {"id": "a2", "name": "方向", "type": "string"},
                ],
                "returns": "string",
                "body": [
                    blk("procedure.return", value=Tpl("往 ${方向} 跳 ${次數} 次")),
                ],
            }
        },
    ),
    {"status": "ok", "logs": ["往 左 跳 3 次"]},
    tags=["procedure", "D26"],
)

case(
    "errors/signature_unknown_placeholder",
    "簽章引用了不存在的參數 → 存檔期驗證錯誤",
    "§4.6 簽章是一份模板（D26）",
    build(
        scripts=[hat(log("x"))],
        procedures={
            "p_x": {
                "name": "跳 %(nope) 次",
                "params": [{"id": "a1", "name": "次數", "type": "number"}],
                "body": [blk("procedure.return", value=1)],
            }
        },
    ),
    {"status": "load_error", "load_error": "引用了不存在的參數"},
    tags=["procedure", "validation", "D26"],
)

case(
    "errors/signature_must_place_every_param",
    "簽章一旦自己排版就要放進每個參數；漏掉的那個在畫面上永遠填不到",
    "§4.6 簽章是一份模板（D26）",
    build(
        scripts=[hat(log("x"))],
        procedures={
            "p_y": {
                "name": "跳 %(a1) 次",
                "params": [
                    {"id": "a1", "name": "次數", "type": "number"},
                    {"id": "a2", "name": "方向", "type": "string"},
                ],
                "body": [blk("procedure.return", value=1)],
            }
        },
    ),
    {"status": "load_error", "load_error": "沒有用到參數 方向"},
    tags=["procedure", "validation", "D26"],
)

case(
    "errors/return_outside_procedure",
    "return 掛在 hat 底下 → 存檔期驗證錯誤，不是執行期",
    "§4.6 執行語意",
    one(blk("procedure.return", value=1)),
    {"status": "load_error", "load_error": "只能放在函式定義裡面"},
    tags=["procedure", "validation"],
)


# ==========================================================================
# §7.5 Extension Host 邊界
#
# 這些題目跑的是 `extensions/demo`——一個純函式、不打網路的假積木包。
# 它們驗的不是那個包，是**邊界**：進去的參數怎麼正規化、出來的值怎麼驗證。
# P1 換成 SubprocessHost 時，同一批題目必須原封不動地綠（§17.4）。
# ==========================================================================

DEMO = [("demo", "0.1.0")]


def ext(*blocks, extensions=None):
    return build(scripts=[hat(*blocks)], extensions=extensions if extensions is not None else DEMO)


case(
    "extensions/call_and_reverse_log",
    "積木包的 reporter 能被呼叫，ctx.log 走反向通道落在 enter/exit 之間",
    "§7.5 Extension Host 抽象",
    ext(log(blk("demo.echo", text="world"))),
    {"status": "ok", "logs": ["echo 第 1 次", "hi, world"]},
    tags=["extension", "host_boundary"],
)

case(
    "extensions/returns_contract_violation",
    "宣告 returns: object 卻回字串 → 在 Host 邊界就錯，訊息指名那個積木包",
    "§7.5 邊界的正規化與驗證",
    ext(log(blk("demo.broken_returns"))),
    {
        "status": "error",
        "error": {
            "code": "extension",
            "message_contains": "demo.broken_returns 宣告回傳物件，實際回傳文字",
            "hint_contains": "積木包的問題",
        },
    },
    tags=["extension", "host_boundary"],
)

case(
    "extensions/json_arg_normalized",
    "type: json 的參數在邊界正規化，main.py 永遠拿到 dict / list",
    "§7.2 json 與 object / list 的差別",
    ext(
        log(blk("object.to_json", value=blk("demo.wrap", body='{"a":1}'))),
        log(blk("object.to_json", value=blk("demo.wrap", body="[1,2]"))),
        log(blk("object.to_json", value=blk("demo.wrap", body=blk("data.new_list")))),
    ),
    {
        "status": "ok",
        "logs": ['{"wrapped":{"a":1}}', '{"wrapped":[1,2]}', '{"wrapped":[]}'],
    },
    tags=["extension", "host_boundary", "D10"],
)

case(
    "extensions/json_arg_rejects_bad_text",
    "type: json 收到不是 JSON 的文字 → 專用訊息，不是「object 沒有 items」",
    "§7.5 邊界的正規化與驗證",
    ext(log(blk("demo.wrap", body="not json"))),
    {
        "status": "error",
        "error": {"code": "extension", "message_contains": "參數 body 收到的文字不是合法 JSON"},
    },
    tags=["extension", "host_boundary"],
)

case(
    "extensions/number_arg_converts",
    "type: number 依 §4.3 轉換——這是邊界上唯一會做轉換的型別",
    "§7.5 邊界的正規化與驗證",
    ext(log(blk("demo.add", a="3", b=True))),
    {"status": "ok", "logs": ["4"]},
    tags=["extension", "host_boundary"],
)

case(
    "extensions/number_arg_out_of_range",
    "manifest 宣告的 min / max 也在邊界檢查",
    "§7.2 參數的三個修飾欄位",
    ext(log(blk("demo.add", a=1, b=999))),
    {
        "status": "error",
        "error": {"code": "extension", "message_contains": "參數 b 不能大於 100"},
    },
    tags=["extension", "host_boundary"],
)

case(
    "extensions/args_follow_the_conversion_table",
    "邊界套用的是 §4.3 那張轉換表本身——積木包的孔與內建積木的孔反應相同",
    "§7.5 邊界的正規化與驗證",
    ext(
        log(blk("demo.echo", text=5)),
        log(blk("demo.echo", text=blk("data.new_list"))),
        blk("control.if", condition=blk("demo.is_even", n="4"),
            then=Stack([log("字串 4 也是偶數")])),
    ),
    {"status": "ok", "logs": ["echo 第 1 次", "hi, 5", "echo 第 2 次", "hi, []", "字串 4 也是偶數"]},
    tags=["extension", "host_boundary"],
)

case(
    "extensions/object_and_list_args_are_strict",
    "object / list 是嚴格宣告，不轉換——要自動處理的參數應該宣告成 json",
    "§7.2 json 與 object / list 的差別",
    ext(log(blk("demo.count_items", items="[1,2,3]"))),
    {
        "status": "error",
        "error": {
            "code": "extension",
            "message_contains": "參數 items 需要清單，收到文字",
            "hint_contains": "解析 JSON",
        },
    },
    tags=["extension", "host_boundary"],
)

case(
    "extensions/args_eval_left_to_right",
    "積木包的參數同樣由左而右、深度優先求值——求值在引擎這一側，不因第三方而異",
    "§4.6 執行語意",
    ext(log(blk("demo.add", a=blk("debug.inspect", value=1), b=blk("debug.inspect", value=2)))),
    {"status": "ok", "logs": ["number: 1", "number: 2", "3"]},
    tags=["extension", "eval_order"],
)

case(
    "extensions/boolean_and_dropdown",
    "boolean 形狀的積木可插進條件孔；dropdown 參數送的是選項的 value",
    "§7.2 manifest.yaml",
    ext(
        blk("control.if", condition=blk("demo.is_even", n=4),
            then=Stack([log(blk("demo.color_of", fruit="banana"))])),
        blk("control.if", condition=blk("demo.is_even", n=3),
            then=Stack([log("不該出現")])),
    ),
    {"status": "ok", "logs": ["黃色"]},
    tags=["extension", "host_boundary"],
)

case(
    "extensions/missing_pack_is_placeholder",
    "專案用到沒安裝的積木包 → 積木保留為佔位符，執行時說得出「裝了就會好」",
    "§13.3 缺少 extension 的處理",
    ext(log(blk("nope.something")), extensions=[("nope", "1.0.0")]),
    {
        "status": "error",
        "error": {
            "code": "extension",
            "message_contains": "積木包「nope」，但它還沒安裝",
            "hint_contains": "安裝這個積木包",
        },
    },
    tags=["extension", "missing_extension"],
)

case(
    "extensions/pack_exception_names_the_pack",
    "積木包內部炸掉 → 包成 ExtensionError，訊息指名是哪個包，不是使用者的流程壞了",
    "§7.5 Extension Host 抽象",
    ext(blk("demo.blow_up")),
    {
        "status": "error",
        "error": {"code": "extension", "message_contains": "積木包「示範」的 demo.blow_up"},
    },
    tags=["extension", "host_boundary"],
)


# ==========================================================================
# §4.2 積木形狀（載入期驗證）
#
# 形狀錯誤留到執行期有兩個後果：if 的另一半可以躺著錯好幾個月才被走到，
# 而且它以 ValidationError 的形式從 Thread 漏出來——那不是 BlockyError，
# 發不出 block.error，前端只看到一個安靜停掉的 Thread。
# ==========================================================================

case(
    "errors/reporter_in_stack",
    "回報型積木接在堆疊上 → 載入期就擋，不是執行到才發現",
    "§4.2 Block 結構",
    one(blk("operator.add", a=1, b=2)),
    {"status": "load_error", "load_error": "不能接在堆疊上"},
    tags=["validation", "shape"],
)

case(
    "errors/command_in_input_hole",
    "指令型積木插進輸入孔 → 載入期就擋",
    "§4.2 Block 結構",
    one(log(blk("data.set", fields={"name": "x"}, value=1))),
    {"status": "load_error", "load_error": "不能插進輸入孔"},
    tags=["validation", "shape"],
)

case(
    "errors/hat_in_the_middle_of_a_stack",
    "事件積木夾在堆疊中間 → 載入期就擋",
    "§4.2 Block 結構",
    one(blk(FLAG)),
    {"status": "load_error", "load_error": "只能放在腳本最上面"},
    tags=["validation", "shape"],
)

# ==========================================================================
# §4.1 落單堆疊 + §5.1 點一下就跑
#
# 沒有 hat 的頂層堆疊是**合法 IR**：寫到一半的積木不該擋住存檔，而且落單堆疊
# 正是「點一下就跑」的對象。它不需要任何執行期特例——§5.1 的觸發條件是「top 的
# opcode 等於這次的 trigger」，一顆 debug.log 不等於任何 trigger，自己就落選。
# ==========================================================================

case(
    "control/lone_stack_loads_but_never_triggers",
    "沒有 hat 的堆疊存得下來，而且綠旗不會跑到它",
    "§4.1 scripts 的每一項不一定有 hat",
    build(scripts=[hat(log("旗子")), [log("落單")]]),
    {"status": "ok", "logs": ["旗子"]},
    tags=["shape", "manual_run"],
)

case(
    "control/click_runs_a_lone_stack",
    "點落單堆疊上的積木 → 跑得起來（§5.1 的探索手段）",
    "§5.1 點一下就跑",
    build(scripts=[hat(log("旗子")), [log("落單")]]),
    {"status": "ok", "logs": ["落單"]},
    start="blk_3",
    tags=["manual_run"],
)

case(
    "control/click_starts_from_the_top_of_the_stack",
    "點堆疊中間的積木 → 從**頂端**起跑，不是從點到的那一顆插進去",
    "§5.1 點一下就跑",
    # 從中間插進去會讓 repeat 的迴圈體脫離它的迴圈——畫面上看不出來的執行。
    build(scripts=[hat(log("A"), blk("control.repeat", times=2, body=[log("B")]))]),
    {"status": "ok", "logs": ["A", "B", "B"]},
    start="blk_4",  # repeat 迴圈體裡的那顆 log
    tags=["manual_run"],
)

case(
    "control/click_a_lone_reporter_evaluates_it",
    "畫布上一顆落單的 reporter 也存得下來，點它就求值",
    "§4.1、§5.1 起點是 reporter 時只求值那一顆",
    build(scripts=[hat(log("旗子")), [blk("operator.add", a=1, b=2)]]),
    {"status": "ok", "logs": [], "value": 3},
    start="blk_3",
    tags=["shape", "manual_run"],
)

case(
    "control/click_a_nested_reporter_does_not_run_its_parent",
    "點插在孔裡的 reporter → 只求值它，外面那顆 log 不執行",
    "§5.1 起點是 reporter 時只求值那一顆",
    build(scripts=[hat(log(blk("operator.add", a=1, b=2)))]),
    {"status": "ok", "logs": [], "value": 3},
    start="blk_3",
    tags=["manual_run"],
)

case(
    "errors/extension_block_shape_is_checked_too",
    "積木包的積木形狀一樣在載入期驗——形狀從 manifest 來",
    "§4.2 Block 結構、§7.2 manifest.yaml",
    ext(blk("demo.echo", text="x")),
    {"status": "load_error", "load_error": "不能接在堆疊上"},
    tags=["validation", "shape", "extension"],
)

case(
    "errors/unknown_opcode_stays_a_placeholder",
    "認不得的 opcode **不是**載入期錯誤——保留為佔位符，執行時才報，且報得出來",
    "§13.3 缺少 extension 的處理",
    one(log(blk("mystery.thing"))),
    {
        "status": "error",
        "error": {
            "code": "unknown_block",
            "message_contains": "不認得積木 mystery.thing",
            "hint_contains": "比較新的版本",
        },
    },
    tags=["validation", "shape", "unknown_block"],
)

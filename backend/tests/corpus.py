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

case(
    "errors/ordering_across_types_is_error",
    "大小比較不接受型別混用，訊息提示先轉型",
    "§4.4 operator 比較語意",
    one(log(blk("operator.lt", a="5", b=10))),
    {"status": "error", "error": {"code": "type", "hint_contains": "轉為數字"}},
    tags=["operator", "comparison"],
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
    "errors/return_outside_procedure",
    "return 掛在 hat 底下 → 存檔期驗證錯誤，不是執行期",
    "§4.6 執行語意",
    one(blk("procedure.return", value=1)),
    {"status": "load_error", "load_error": "只能放在函式定義裡面"},
    tags=["procedure", "validation"],
)

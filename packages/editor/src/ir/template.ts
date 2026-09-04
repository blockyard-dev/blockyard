/**
 * `${}` 插值的**最小**前端邏輯（§4.7、§8.4）。
 *
 * 這不是 `backend/blockyard/ir/template.py` 的完整移植——解析、求值、`refs` 全部
 * 留在後端（存檔時由後端重新產生，見 §4.7「`refs` 不要在前端算」）。這裡只做
 * 存檔前端**必須**自己決定的兩件事：一格文字該存成 `literal` 還是
 * `template`，以及 `template` 的 `whole` 旗標——這兩者決定 IR 的形狀，不能
 * 留給後端事後才算。
 *
 * 兩個函式都是 `template.py` 對應函式的直接移植，行為必須一致（`whole` 錯了
 * 後端會在 PUT 時以 422 拒收，見 `ir/schema.py::load` 的 `parsed.whole !=
 * inp.whole` 檢查）。
 */

/**
 * 字串裡有沒有需要解析的 `${`（未被 `$${` 逸出）。
 *
 * 存檔時用來決定一格文字該是 `kind: literal` 還是 `kind: template`。
 */
export function hasInterpolation(value: string): boolean {
  let i = 0;
  while ((i = value.indexOf('$', i)) !== -1) {
    if (value.startsWith('$${', i)) {
      i += 3;
      continue;
    }
    if (value.startsWith('${', i)) return true;
    i += 1;
  }
  return false;
}

/**
 * §4.7「整格取值」：字串恰好只有一個插值、沒有其他文字。
 *
 * 與 `template.py::parse` 的分段邏輯等價：拿掉一個 `${...}`（不含內部的
 * `}`）之後，前後都不能剩任何字元。多個插值、插值前後有文字、或內容其實是
 * `$${` 逸出，都不算 whole。
 */
const WHOLE_RE = /^\$\{[^}]*\}$/;

export function isWholeTemplate(value: string): boolean {
  return WHOLE_RE.test(value);
}

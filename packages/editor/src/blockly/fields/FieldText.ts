/**
 * `FieldText` — 編輯器裡**唯一**的文字欄位類別（§8.5）。
 *
 * 變數名稱、`${}` 插值、多行渲染三件事必須是同一個類別，用 options 開關能力。
 * 設計文件對這點說得很重：三個分開做之後一定要合併（多行欄位裡的插值 pill
 * 怎麼換行？autocomplete popup 在 textarea 裡怎麼定位？），而先合再拆的成本
 * 遠低於反過來。
 *
 * **第 3 步只做介面與多行**，第 6 步換掉內部實作：
 *
 * | 能力 | 狀態 |
 * |---|---|
 * | 多行三層（宣告／自動／強制） | 這一步做掉，見 `isMultiline()` |
 * | 變數名稱的字元限制（§4.7） | 這一步做掉，見 `validateName` |
 * | 變數名稱 autocomplete | 第 6 步 |
 * | `${}` pill 行內渲染、整格取值底色 | 第 6 步 |
 * | `${}` 內運算子的紅線 + warning | 第 6 步 |
 *
 * 繼承 `FieldMultilineInput`（官方 plugin，§8.5 指定）而不是 `FieldTextInput`：
 * 兩者的差別只在「編輯器是 textarea 還是 input」與「文字怎麼排」，而多行是
 * 這個類別本來就要有的能力。反過來從 `FieldTextInput` 起家的話，第 6 步接多行
 * 就得整個換基底類別——那正是上面那段警告在講的事。
 *
 * 附帶的好處：plugin 的 textarea 是 Enter 送出、Shift+Enter 換行，於是 §8.5
 * 說的「空欄位的使用者根本打不出第一個換行」在這裡不成立，第二層（自動偵測）
 * 真的觸發得到。
 */
import * as Blockly from 'blockly/core';
import {
  FieldMultilineInput,
  type FieldMultilineInputConfig,
} from '@blockly/field-multilineinput';

/** Blockly JSON 裡的欄位型別名稱（`{"type": "field_blocky_text"}`）。 */
export const FIELD_TEXT_TYPE = 'field_blocky_text';

/** 這個欄位的三種能力開關。全部關掉就是一個陽春的文字欄位。 */
export interface FieldTextOptions {
  /**
   * `'variable'` 時這一格是**變數名稱**而不是值（manifest 的 `type: variable`，
   * §4.5 的免宣告變數）。序列化出來仍然是字串——名稱欄位不是 Blockly 的
   * `field_variable`，那條路會把變數變成有 id 的實體（§8.5 明令關閉）。
   */
  mode?: 'text' | 'variable';
  /** 這一格的 `${}` 要當插值解析（§4.7）。第 6 步才會有視覺效果。 */
  interpolate?: boolean;
  /** 第 1 層：manifest 的 `multiline: true`。 */
  multiline?: boolean;
  /** manifest 的 `rows: n`。多行時的可見行數，超過就捲動。 */
  rows?: number;
  /**
   * 第 3 層：`blocks[].ui.multiline` 的右鍵強制切換（§4.2）。
   * `null` = 沒有強制，交給前兩層。第 6 步接上右鍵選單。
   */
  forcedMultiline?: boolean | null;
}

export interface FieldTextConfig extends FieldMultilineInputConfig, FieldTextOptions {}

export interface FieldTextFromJsonConfig extends FieldTextConfig {
  text?: string;
}

/**
 * §8.5 第 2 層「自動多行」的門檻。值本身就是判斷依據，所以這是純函數，
 * **不存進 IR**——存了就會與值漂移。
 */
const AUTO_MULTILINE_CHARS = 60;

/** 多行但 manifest 沒說幾行時的預設可見行數。 */
const DEFAULT_MULTILINE_ROWS = 4;

/**
 * 變數名稱唯一禁掉的字元（§8.5）。
 *
 * 標準不是「像不像識別字」，而是「會不會讓 `${}` 的路徑無法解析」（§4.7）。
 * 所以中文、空格、底線、`+ - * /` 全部合法，被擋下的只有路徑語法自己會用到的
 * 那幾個字元。
 */
const ILLEGAL_NAME_CHARS = /[.[\]{}$]/g;

export class FieldText extends FieldMultilineInput {
  // `declare` 而不是給初始值：Blockly 的 `Field` constructor 會呼叫
  // `configure_()` 與 `setValue()`，而 TS 的 class field 初始化是在 `super()`
  // **回來之後**才跑的——寫成 `private mode = 'text'` 的話，configure_ 剛設好的
  // 值會被初始化蓋回預設，於是 `type: variable` 的欄位不會套用名稱限制。
  // 這個順序陷阱沒有任何東西會報錯，只會安靜地失效。
  declare private mode: 'text' | 'variable';
  declare private interpolate: boolean;
  declare private declaredMultiline: boolean;
  declare private declaredRows: number | null;
  declare private forcedMultiline: boolean | null;

  constructor(
    value?: string | typeof Blockly.Field.SKIP_SETUP,
    validator?: Blockly.FieldTextInputValidator,
    config?: FieldTextConfig,
  ) {
    // 一定要傳一個物件下去：`Field` 只在 config 是 truthy 時才呼叫
    // `configure_()`，而上面那些欄位的預設值全部在 configure_ 裡。
    super(value, validator, config ?? {});
  }

  protected override configure_(config: FieldTextConfig): void {
    super.configure_(config);
    this.mode = config.mode ?? 'text';
    this.interpolate = config.interpolate ?? false;
    this.declaredMultiline = config.multiline ?? false;
    this.declaredRows = config.rows ?? null;
    this.forcedMultiline = config.forcedMultiline ?? null;
    this.syncLines();
  }

  /**
   * §8.5 的三層，優先序由下往上：強制 > 宣告 > 自動。
   *
   * 第三層不能省的理由在設計文件裡：單行 field 按 Enter 是提交不是換行。這個
   * 實作的 textarea 有 Shift+Enter，但右鍵切換仍然要留——貼上來的長字串使用者
   * 可能就是想讓它擠成一行。
   */
  isMultiline(): boolean {
    if (this.forcedMultiline !== null) return this.forcedMultiline;
    if (this.declaredMultiline) return true;
    const text = String(this.getValue() ?? '');
    return text.includes('\n') || text.length > AUTO_MULTILINE_CHARS;
  }

  /** 第 3 層的入口。第 6 步的右鍵選單與 `ui.multiline` 的讀寫都走這裡。 */
  setForcedMultiline(forced: boolean | null): void {
    this.forcedMultiline = forced;
    this.syncLines();
    this.forceRerender();
  }

  getForcedMultiline(): boolean | null {
    return this.forcedMultiline;
  }

  isVariableName(): boolean {
    return this.mode === 'variable';
  }

  isInterpolated(): boolean {
    return this.interpolate;
  }

  protected override doValueUpdate_(newValue: string): void {
    super.doValueUpdate_(newValue);
    // 值變了，第 2 層的判斷結果可能跟著變——貼上三行文字要當場變成 textarea。
    this.syncLines();
  }

  /**
   * 變數名稱模式的字元限制（§4.7、§8.5）。
   *
   * 用 validator 而不是 `onHtmlInputChange` 的攔截：validator 是 Blockly 對
   * 「值必須符合某個形狀」的正規機制，程式設定值（載入專案、第 6 步的重新命名）
   * 也會經過它。攔輸入只擋得住鍵盤。
   */
  protected override doClassValidation_(newValue?: unknown): string | null {
    const validated = super.doClassValidation_(newValue);
    if (validated === null || validated === undefined) return validated ?? null;
    if (this.mode !== 'variable') return validated;
    return validateName(validated);
  }

  /**
   * `maxLines_` 是基底類別決定「幾行之後開始捲動」的地方。單行模式壓成 1，
   * 多行模式吃 manifest 的 `rows`。
   */
  private syncLines(): void {
    this.setMaxLines(
      this.isMultiline() ? (this.declaredRows ?? DEFAULT_MULTILINE_ROWS) : 1,
    );
  }

  static override fromJson(options: FieldTextFromJsonConfig): FieldText {
    // 依 Blockly 慣例跑一次字串表解析（`%{BKY_...}`）。
    const text = Blockly.utils.parsing.replaceMessageReferences(options.text ?? '');
    return new FieldText(text, undefined, options);
  }
}

/**
 * 把名稱正規化成 §4.7 的路徑解析吃得下的樣子。獨立成函式是為了讓第 6 步的
 * 「重新命名此變數的所有引用」與存檔前的靜態檢查共用同一條規則。
 */
export function validateName(name: string): string {
  return name.replace(ILLEGAL_NAME_CHARS, '').trim();
}

Blockly.fieldRegistry.register(FIELD_TEXT_TYPE, FieldText);

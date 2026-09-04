/**
 * `FieldText` — 編輯器裡**唯一**的文字欄位類別（§8.5）。
 *
 * 變數名稱、`${}` 插值、多行渲染三件事必須是同一個類別，用 options 開關能力。
 * 設計文件對這點說得很重：三個分開做之後一定要合併（多行欄位裡的插值 pill
 * 怎麼換行？autocomplete popup 在 textarea 裡怎麼定位？），而先合再拆的成本
 * 遠低於反過來。第 3 步只做了介面與多行，這一步（第 6 步）換掉內部實作。
 *
 * | 能力 | 狀態 |
 * |---|---|
 * | 多行三層（宣告／自動／強制） | 第 3 步；強制那層這一步才接上序列化 |
 * | 變數名稱的字元限制（§4.7） | 第 3 步 |
 * | `${}` pill 行內渲染、整格取值底色 | **這一步** |
 * | `${}` 內運算子的紅線 + warning icon | **這一步** |
 * | 運算式的等寬字與語法紅線（§4.7b） | **這一步** |
 * | 變數名稱 autocomplete、`$` 觸發 | **這一步** |
 * | 右鍵：多行切換、重新命名所有引用 | **這一步** |
 *
 * 繼承 `FieldMultilineInput`（官方 plugin，§8.5 指定）而不是 `FieldTextInput`：
 * 兩者的差別只在「編輯器是 textarea 還是 input」與「文字怎麼排」，而多行是
 * 這個類別本來就要有的能力。附帶的好處是 plugin 的 textarea 有 Shift+Enter，
 * 於是 §8.5 說的「空欄位的使用者根本打不出第一個換行」在這裡不成立。
 *
 * ---
 *
 * **這一步為什麼要自己畫 `render_`**
 *
 * plugin 每一行畫一顆 `<text>`，而 pill 需要「一行之內分段」：一段文字、一段
 * `${路徑}`、一段紅線。所以 `render_` / `updateSize_` 整組換掉，改成「把
 * `ir/highlight.ts` 切好的 run 依序量寬、排版、畫底圖」。
 *
 * 換掉它同時修掉一個實測回饋：**文字欄位比數字欄位大一號**。原因是
 * `FieldTextInput.initView()` 在**影子積木裡不畫外框**（影子本身就是那顆白色
 * 膠囊，Scratch 的字面值格子），而 plugin 的 `initView()` 無條件畫——多出來
 * 的是外框自己的左右 8px 內距與 4px 圓角，於是同一句話在文字影子裡比在數字
 * 影子裡寬 16px、方 4px。這裡照 `FieldTextInput` 的規則補回來，尺寸公式也逐行
 * 對齊 `Field.updateSize_`，讓兩種影子在畫面上量起來一模一樣。
 */
import * as Blockly from 'blockly/core';
import {
  FieldMultilineInput,
  type FieldMultilineInputConfig,
} from '@blockly/field-multilineinput';
import {
  analyze,
  renameRoot,
  type Analysis,
  type AnalyzeOptions,
  type RunKind,
} from '../../ir/highlight';
import { openAutocomplete, type AutocompleteHandle } from './Autocomplete';

/** Blockly JSON 裡的欄位型別名稱（`{"type": "field_blockyard_text"}`）。 */
export const FIELD_TEXT_TYPE = 'field_blockyard_text';

/** 這個欄位的能力開關。全部關掉就是一個陽春的文字欄位。 */
export interface FieldTextOptions {
  /**
   * `'variable'` 時這一格是**變數名稱**而不是值（manifest 的 `type: variable`,
   * §4.5 的免宣告變數）。序列化出來仍然是字串——名稱欄位不是 Blockly 的
   * `field_variable`，那條路會把變數變成有 id 的實體（§8.5 明令關閉）。
   *
   * `'expression'` 是 §4.7b 的運算式（`運算 (${a}*2+1)`）。字元限制由後端的
   * 文法在存檔期擋（422 帶 blockId），這裡不攔鍵盤——與 §4.7 對 `${a+b}` 的
   * 處理同一條原則，「不給你打」講不清楚哪裡錯。這個模式在畫面上的差別是
   * 等寬字與行內的語法紅線。
   */
  mode?: 'text' | 'variable' | 'expression';
  /** 這一格的 `${}` 要當插值解析（§4.7）。 */
  interpolate?: boolean;
  /** 第 1 層：manifest 的 `multiline: true`。 */
  multiline?: boolean;
  /** manifest 的 `rows: n`。多行時的可見行數，超過就捲動。 */
  rows?: number;
  /**
   * 第 3 層：`blocks[].ui.multiline` 的右鍵強制切換（§4.2）。
   * `null` = 沒有強制，交給前兩層。
   */
  forcedMultiline?: boolean | null;
  /**
   * 這一格是**積木上的一段文字**，不是一個值。
   *
   * 目前唯一的使用者是「創建積木」對話框裡預覽積木上的說明文字（§8.5、D26）：
   * 它可以編輯，但它會變成積木文字的一部分，而**不是**一個孔。旁邊那些白色
   * 膠囊才是孔。兩者長得一樣的話，預覽就在「這顆積木會長成什麼樣」這件事上
   * 說謊了——而使用者正是看著預覽在做決定。
   *
   * 只改外觀（畫成積木底色上的一格深色矩形、白字），不改任何行為。
   */
  bare?: boolean;
  /**
   * 這一格的名字**不代表工作區裡的一個變數**，所以右鍵不列「重新命名所有
   * 引用」（§4.5）。
   *
   * 用在「創建積木」對話框的參數名稱格上：那個工作區裡只有一顆預覽積木，
   * 掃得到的引用永遠是它自己——一個永遠只會改到眼前這一格的「所有引用」，
   * 講的是一件沒有發生的事。
   */
  standalone?: boolean;
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

/** 多行但 manifest 沒說幾行時的預設可見行數（超過就捲動）。 */
const DEFAULT_MULTILINE_ROWS = 4;

/**
 * **刻意沒有「多行至少畫兩行」這條。**
 *
 * 試過：讓 `multiline` 的欄位即使值只有一行也保留兩行，好讓右鍵「多行輸入」
 * 有立即的視覺回饋。結果是 `記錄 (你好)` 這種 manifest 宣告了 `multiline: true`
 * 的欄位，明明只有一行字卻被畫成兩行高的**矩形**——而形狀是跟著行數走的，
 * 於是單行的值長得像多行。回饋看到的就是這個。
 *
 * 現在的規則單純得多：**畫幾行由值決定，形狀由畫幾行決定**。宣告與右鍵開關
 * 管的是「這一格容不容得下換行」（`maxLines`），不是「它現在多高」。代價是
 * 空欄位上按「多行輸入」看不出變化——那由選單文字翻成「取消多行輸入」來說。
 */

/**
 * 變數名稱唯一禁掉的字元（§8.5）。
 *
 * 標準不是「像不像識別字」，而是「會不會讓 `${}` 的路徑無法解析」（§4.7）。
 * 所以中文、空格、底線、`+ - * /` 全部合法，被擋下的只有路徑語法自己會用到的
 * 那幾個字元。
 */
const ILLEGAL_NAME_CHARS = /[.[\]{}$]/g;

/** pill 左右各撐出來的空白（SVG 單位）。排版時算進 run 的寬度。 */
const PILL_PAD = 4;

/** pill 比文字高出來的部分，上下各一半。 */
const PILL_GROW = 4;

/**
 * 單行欄位的外框**至少**這麼寬（以高為單位）。
 *
 * 膠囊的圓角是 `rx = 高 / 2`，而 SVG 會把 `rx` 夾到**寬的一半**——寬度小於高度
 * 時，那顆膠囊就變成一個直立的橢圓。實測回饋說的「扁掉、看起來像
 * `border-radius: 50%`」就是這個：`設定 [d] 為` 的名字只有一個字，寬度撐不到
 * 高度。給一個下限，短名字也會是一顆躺著的膠囊。
 *
 * 只套在**有外框**的欄位上。字面值影子沒有外框（見 `initView`），它的形狀由
 * 積木本身畫，寬度得跟數字影子一致——那正是上一步剛對齊好的東西。
 */
const MIN_PILL_ASPECT = 1.6;

/** autocomplete 最多列幾個。再多就不是「提示」而是「另一份清單」。 */
const MAX_COMPLETIONS = 8;

/** 積木上警告圖示的 id 前綴——見下面 `syncWarning` 對「帶 id 清除」的說明。 */
const FIELD_WARNING_PREFIX = 'blockyard-field:';

const NBSP = ' ';

/** 一行裡的一段。`ref` 畫成 pill，`error` 畫紅線。 */
interface Piece {
  kind: RunKind;
  text: string;
}

export class FieldText extends FieldMultilineInput {
  // `declare` 而不是給初始值：Blockly 的 `Field` constructor 會呼叫
  // `configure_()` 與 `setValue()`，而 TS 的 class field 初始化是在 `super()`
  // **回來之後**才跑的——寫成 `private mode = 'text'` 的話，configure_ 剛設好的
  // 值會被初始化蓋回預設，於是 `type: variable` 的欄位不會套用名稱限制。
  // 這個順序陷阱沒有任何東西會報錯，只會安靜地失效。
  declare private mode: 'text' | 'variable' | 'expression';
  declare private interpolate: boolean;
  declare private declaredMultiline: boolean;
  declare private declaredRows: number | null;
  declare private forcedMultiline: boolean | null;
  declare private bare: boolean;
  declare private standalone: boolean;

  // 同一個 `declare` 的理由（見上）：`Field` 的 constructor 會走到 `setValue`，
  // 而 class field 的初始化在 `super()` **之後**——寫成 `= null` 的話，建構時
  // 算好的分析會被初始化蓋掉，於是工具箱裡那顆積木的預設值畫不出來（畫布上
  // 那顆會，因為它多了一次 `setValue`）。症狀是「同一顆積木在工具箱是空的、
  // 拉出來才有字」，而且沒有任何東西會報錯。
  declare private analysisCache: Analysis | null;

  private autocomplete: AutocompleteHandle | null = null;
  private completion: CompletionContext | null = null;
  private onInput: (() => void) | null = null;
  private onKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private onCaretMove: (() => void) | null = null;

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
    this.bare = config.bare ?? false;
    this.standalone = config.standalone ?? false;
    this.syncLines();
  }

  // ------------------------------------------------------------------ //
  // 身分
  // ------------------------------------------------------------------ //

  isVariableName(): boolean {
    return this.mode === 'variable';
  }

  /** 這一格的名字有沒有「工作區裡的其他引用」可以一起改（見 `standalone`）。 */
  hasReferences(): boolean {
    return this.isVariableName() && !this.standalone;
  }

  isExpression(): boolean {
    return this.mode === 'expression';
  }

  isInterpolated(): boolean {
    return this.interpolate;
  }

  /** 這一格要怎麼分析。渲染、重新命名、autocomplete 共用同一份設定。 */
  analyzeOptions(): AnalyzeOptions {
    return { mode: this.mode, interpolate: this.interpolate };
  }

  /**
   * 目前這個值的分析結果。渲染、warning icon 與測試共用同一份。
   *
   * 惰性算而不是在 `doValueUpdate_` 裡算好存起來：那條路會被 class field 的
   * 初始化順序咬（見 `analysisCache` 的註解），而惰性版本最壞的情況只是多算
   * 一次——輸入都是幾十個字元的字串。
   */
  private get analysis(): Analysis {
    this.analysisCache ??= analyze(String(this.getValue() ?? ''), this.analyzeOptions());
    return this.analysisCache;
  }

  /** 目前這一格的分析結果（測試與右鍵選單用）。 */
  getAnalysis(): Analysis {
    return this.analysis;
  }

  /**
   * 這個 DOM 元素算不算「點在這一格上」。右鍵選單用它把事件對回欄位。
   *
   * 問的是 `getClickTarget_()` 而不是 `getSvgRoot()`：字面值影子上的欄位，
   * 點擊區是**整顆影子**（見 `initView`），而影子的 path 是欄位群組的兄弟
   * 節點——用 `getSvgRoot()` 問的話，點在膠囊上會答「不是這一格」，於是右鍵
   * 選單少掉那兩個項目。
   */
  containsElement(target: Element): boolean {
    return this.getClickTarget_()?.contains(target) ?? false;
  }

  // ------------------------------------------------------------------ //
  // 多行的三層（§8.5）
  // ------------------------------------------------------------------ //

  /**
   * 優先序由下往上：強制 > 宣告 > 自動。
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

  /** 第 3 層的入口。右鍵選單與 `ui.multiline` 的讀寫都走這裡。 */
  setForcedMultiline(forced: boolean | null): void {
    this.forcedMultiline = forced;
    this.syncLines();
    this.forceRerender();
  }

  getForcedMultiline(): boolean | null {
    return this.forcedMultiline;
  }

  /** manifest 已經宣告成多行——右鍵切不掉，切了也存不回去。 */
  isDeclaredMultiline(): boolean {
    return this.declaredMultiline;
  }

  /**
   * `maxLines_` 是基底類別決定「幾行之後開始捲動」的地方。單行模式壓成 1，
   * 多行模式吃 manifest 的 `rows`。
   */
  private syncLines(): void {
    this.setMaxLines(
      this.isMultiline() ? (this.declaredRows ?? DEFAULT_MULTILINE_ROWS) : 1,
    );
    this.syncOutputShape();
  }

  /**
   * 字面值影子的**外框形狀**：單行是膠囊，多行是圓角矩形（實測回饋）。
   *
   * 這一格的形狀不是欄位畫的——影子沒有外框，畫的是**積木自己的路徑**，而
   * zelos 依 `block.getOutputShape()` 決定要畫膠囊（`ROUND`）還是圓角矩形
   * （`SQUARE`，半徑就是 `CORNER_RADIUS`）。所以「多行不要膠囊」這件事只能
   * 在積木那一層講，改欄位的 `rx` 沒有用：膠囊的兩端仍然會露在外面。
   *
   * 順帶：孔的形狀也跟著變，因為 `shapeFor()` 問的是同一個值——外框與孔不會
   * 對不起來。
   */
  /**
   * 這一格現在**畫出來**是幾行。
   *
   * 不是 `isMultiline()`：那問的是「容不容得下換行」，而形狀問的是「現在長
   * 什麼樣子」。宣告成多行、但值只有一行的欄位（`記錄 (你好)`）仍然是一顆
   * 膠囊——這正是回饋指出來的那一格。
   *
   * 與 `visibleLines()` 用同一份規則（換行數，夾在 `maxLines` 內），只是不必
   * 跑一次分析——`syncLines` 在每次值變動時都會呼叫它。公開是為了讓測試問得到：
   * 形狀（膠囊 vs 圓角矩形）是渲染的產物，headless 的工作區量不到。
   */
  renderedRows(): number {
    const lines = String(this.getValue() ?? '').split('\n').length;
    return Math.min(lines, this.getMaxLines());
  }

  private syncOutputShape(): void {
    const block = this.getSourceBlock() as Blockly.BlockSvg | null;
    if (!block || !block.outputConnection || !this.isFullBlockField()) return;
    const shapes = this.getConstants()?.SHAPES;
    if (!shapes) return;

    // 單行**不是一律膠囊**：六角形的格子要維持六角形。這一格的規則是
    // 「畫出來超過一行就不要膠囊」，而不是「所有字面值都是膠囊」——寫死
    // `ROUND` 會把「創建積木」對話框裡的布林參數名（一顆 output 是 Boolean
    // 的白色六角，見 `blockly/declaration.ts`）壓成膠囊，而那正好讓預覽在
    // 「這個參數會變成哪一種孔」這件事上說謊。
    const isBoolean = block.outputConnection.getCheck()?.includes('Boolean') === true;
    const single = isBoolean ? shapes.HEXAGONAL : shapes.ROUND;
    const want = this.renderedRows() > 1 ? shapes.SQUARE : single;
    if (want === undefined || block.getOutputShape() === want) return;
    block.setOutputShape(want);
    // 影子自己與**外面那顆積木**都要重畫：孔的形狀是父積木畫的。
    void block.queueRender();
    void block.getParent()?.queueRender();
  }

  // ------------------------------------------------------------------ //
  // 值
  // ------------------------------------------------------------------ //

  /**
   * 變數名稱模式的字元限制（§4.7、§8.5）。
   *
   * 用 validator 而不是 `onHtmlInputChange` 的攔截：validator 是 Blockly 對
   * 「值必須符合某個形狀」的正規機制，程式設定值（載入專案、重新命名）也會
   * 經過它。攔輸入只擋得住鍵盤。
   */
  protected override doClassValidation_(newValue?: unknown): string | null {
    const validated = super.doClassValidation_(newValue);
    if (validated === null || validated === undefined) return validated ?? null;
    if (this.mode !== 'variable') return validated;
    return validateName(validated);
  }

  protected override doValueUpdate_(newValue: string): void {
    super.doValueUpdate_(newValue);
    this.analysisCache = null;
    // 值變了，第 2 層的判斷結果可能跟著變——貼上三行文字要當場變成 textarea。
    this.syncLines();
    this.syncWarning();
  }

  /**
   * 分析結果 → 積木上的警告圖示（§8.5）。
   *
   * **標在非影子的那顆積木上**：影子沒有自己的圖示位置，而使用者看的是外面
   * 那顆積木。id 帶上影子自己的 blockId 與欄位名，所以同一顆積木上兩格壞掉的
   * 文字不會互相蓋掉——**清除時一定要帶 id**，不帶的話 `setWarningText(null)`
   * 會把整顆警告圖示拆掉，連 `App.tsx` 的存檔警告也一起清掉。
   */
  private syncWarning(): void {
    const block = this.getSourceBlock();
    if (!block || block.isInFlyout) return;
    const host = (block.isShadow() ? block.getParent() : block) ?? block;
    host.setWarningText(this.analysis.error, `${FIELD_WARNING_PREFIX}${block.id}:${this.name ?? ''}`);
  }

  // ------------------------------------------------------------------ //
  // 外觀
  // ------------------------------------------------------------------ //

  override initView(): void {
    super.initView();
    // `FieldInput.initView()`（Blockly 13）有一段 plugin 沒有抄到的規則：zelos
    // 的 `FULL_BLOCK_FIELDS` 打開時，「整顆積木只有這一格」的簡單 reporter
    // ——也就是字面值影子——**不畫欄位外框**，改讓整顆積木當點擊區。
    //
    // 少了它，文字影子比同一個位置的數字影子多一層 8px 內距的白盒子，也就是
    // 實測回饋說的「文字欄位比數字欄位大一個」。
    //
    // `clickTarget_` 那一半同樣不能省：影子上的空欄位只畫得出一個 NBSP，沒有
    // 任何字形，而 SVG 的命中測試打不到沒有幾何的東西——不指定點擊區的話，
    // 空的文字格子會變成點不開的。這個症狀只在**空值**時出現，最容易漏測。
    if (this.isFullBlockField()) {
      this.borderRect_?.remove();
      this.borderRect_ = null;
      const root = (this.getSourceBlock() as Blockly.BlockSvg | null)?.getSvgRoot();
      if (root) this.clickTarget_ = root;
    }
    // 外框**留著**（樣式由 CSS 換掉，見 index.css）：拿掉它，一格空的說明文字
    // 就只剩一個 NBSP，而 SVG 的命中測試打不到沒有幾何的東西——那正是這個檔案
    // 前面為影子欄位補 `clickTarget_` 的同一個坑。
    if (this.bare) Blockly.utils.dom.addClass(this.fieldGroup_!, 'blockyard-bare-field');
    this.syncWarning();
  }

  /**
   * 一行一顆 `<text>` 換成「一段一顆 `<text>`」。
   *
   * 順序很重要：底圖（pill 與紅線）先進 DOM 才會畫在文字**下面**，而它們的
   * 幾何要等文字量完寬度才算得出來。所以是「先開一個空的底圖群組 → 建文字並
   * 量寬 → 回頭補底圖」。
   */
  protected override render_(): void {
    const group = this.textGroup;
    const constants = this.getConstants();
    if (!group || !constants) return;

    while (group.firstChild) group.removeChild(group.firstChild);

    const marks = Blockly.utils.dom.createSvgElement(Blockly.utils.Svg.G, {}, group);
    const lines = this.visibleLines();

    // --- 第一趟：建文字、量寬 ---
    interface Placed {
      el: SVGTextElement;
      piece: Piece;
      width: number;
      x: number;
    }
    const placed: Placed[][] = [];
    let contentWidth = 0;

    for (const line of lines) {
      const row: Placed[] = [];
      let x = 0;
      for (const piece of line) {
        if (piece.kind === 'ref') x += PILL_PAD;
        const el = Blockly.utils.dom.createSvgElement<SVGTextElement>(
          Blockly.utils.Svg.TEXT,
          { class: this.textClass(piece.kind), 'dominant-baseline': 'central' },
          group,
        );
        el.appendChild(document.createTextNode(piece.text));
        const width = Blockly.utils.dom.getTextWidth(el);
        row.push({ el, piece, width, x });
        x += width + (piece.kind === 'ref' ? PILL_PAD : 0);
      }
      contentWidth = Math.max(contentWidth, x);
      placed.push(row);
    }

    // --- 尺寸 ---
    const { width: measured, height, xPad, topPad } = this.measure(contentWidth, lines.length);
    this.size_ = new Blockly.utils.Size(measured, height);
    // **版面要用讀回來的寬度，不能用剛剛算出來的那個。**
    //
    // `FieldInput` 的 `size_` 是一對 getter / setter，而 getter 會把寬度夾到
    // 最小 14px（它自己的 `MINIMUM_WIDTH`，為了讓空欄位點得到），而且是**就地
    // 改寫**那個 Size 物件。所以 `measure()` 回 4.1（一個 `i` 的寬度）時，
    // 積木拿到的欄位盒子其實是 14——渲染器把 14 置中，我們卻把文字排在 4.1
    // 的盒子裡，於是半形單字看起來靠左約 5px。中文字寬度本來就 > 14，夾不到，
    // 所以這個症狀只有半形單字看得見（實測回饋）。
    //
    // 讀回來而不是自己也寫一個 14：那個常數是基底類別的，複製一份的那天它改了
    // 這裡不會紅，只會又歪回去。
    const width = this.size_.width;
    this.positionBorderRect_();
    if (this.borderRect_) {
      // 單行畫成膠囊、多行畫成圓角方塊。單行的膠囊是為了跟數字影子那顆橢圓
      // 講同一種話；多行的文字塊畫成膠囊只會讓第一行與最後一行被咬掉。
      const radius = lines.length === 1
        ? height / 2
        : constants.FIELD_BORDER_RECT_RADIUS;
      this.borderRect_.setAttribute('rx', String(radius));
      this.borderRect_.setAttribute('ry', String(radius));
      this.borderRect_.setAttribute('class', this.borderClass());
    }

    // --- 第二趟：定位、補底圖 ---
    const lineHeight = constants.FIELD_TEXT_HEIGHT + constants.FIELD_BORDER_RECT_Y_PADDING;
    // 單行**置中**、多行靠左。
    //
    // 置中不是美術偏好，是為了補一個洞：單行欄位有兩道最小寬度——自己畫膠囊
    // 時的 `MIN_PILL_ASPECT`（不然一個字的膠囊會變成直立的橢圓），與影子裡
    // `FieldInput` 夾的那 14px（見上面 `width` 那段）。靠左排版會把多出來的
    // 寬度**全部留在右邊**——看起來就是「左邊 padding 太小」。置中之後那份
    // 餘裕平均分到兩側，短名字在膠囊正中間。
    //
    // 多行維持靠左：一段文字置中是沒辦法讀的。
    const startX = lines.length === 1 ? Math.max(xPad, (width - contentWidth) / 2) : xPad;
    placed.forEach((row, i) => {
      const centerY = lines.length === 1
        ? height / 2
        : topPad + i * lineHeight + constants.FIELD_TEXT_HEIGHT / 2;
      for (const { el, piece, width: w, x } of row) {
        el.setAttribute('x', String(startX + x));
        el.setAttribute('y', String(centerY));
        if (piece.kind === 'ref') {
          const pillHeight = this.analysis.whole && lines.length === 1
            ? height
            : constants.FIELD_TEXT_HEIGHT + PILL_GROW;
          Blockly.utils.dom.createSvgElement(
            Blockly.utils.Svg.RECT,
            {
              class: this.analysis.whole ? 'blockyard-pill blockyard-pill-whole' : 'blockyard-pill',
              x: startX + x - PILL_PAD,
              y: centerY - pillHeight / 2,
              width: w + 2 * PILL_PAD,
              height: pillHeight,
              rx: pillHeight / 2,
              ry: pillHeight / 2,
            },
            marks,
          );
        } else if (piece.kind === 'error') {
          const y = centerY + constants.FIELD_TEXT_HEIGHT / 2 - 1;
          Blockly.utils.dom.createSvgElement(
            Blockly.utils.Svg.LINE,
            { class: 'blockyard-squiggle', x1: startX + x, y1: y, x2: startX + x + w, y2: y },
            marks,
          );
        }
      }
    });

    if (this.isBeingEdited_) {
      const input = this.htmlInput_;
      if (input) {
        Blockly.utils.dom[this.isOverflowedY_ ? 'addClass' : 'removeClass'](
          input,
          'blocklyHtmlTextAreaInputOverflowedY',
        );
        Blockly.utils.dom[this.isTextValid_ ? 'removeClass' : 'addClass'](input, 'blocklyInvalidInput');
      }
      this.resizeEditor_();
    }
  }

  /**
   * 尺寸公式**逐行對齊 `Field.updateSize_`**（單行）與 plugin 的多行版本。
   *
   * 這不是抄近路，是這一步的重點：數字影子走的是 `Field.updateSize_`，文字影子
   * 只要有一項不一樣，兩顆影子在畫面上就不一樣大——而使用者一眼就看得出來。
   */
  private measure(
    contentWidth: number,
    rows: number,
  ): { width: number; height: number; xPad: number; topPad: number } {
    const constants = this.getConstants()!;
    const xPad = this.borderRect_ ? constants.FIELD_BORDER_RECT_X_PADDING : 0;
    const topPad = this.borderRect_ ? constants.FIELD_BORDER_RECT_Y_PADDING : 0;

    let height: number;
    if (rows <= 1) {
      height = constants.FIELD_TEXT_HEIGHT;
      if (this.borderRect_) height = Math.max(height, constants.FIELD_BORDER_RECT_HEIGHT);
    } else {
      height =
        rows * constants.FIELD_TEXT_HEIGHT +
        (rows - 1) * constants.FIELD_BORDER_RECT_Y_PADDING +
        2 * topPad;
    }

    let width = contentWidth + 2 * xPad;
    if (rows <= 1 && this.borderRect_) width = Math.max(width, height * MIN_PILL_ASPECT);
    // **單行編輯時不套 `EDITOR_MIN_WIDTH`。** plugin 的下限是 150px，於是點一格
    // 短欄位會看到它當場撐開一大截，放開又縮回去——而使用者只是想改幾個字。
    // 多行才留那個下限：那時候欄位本來就已經是一塊方形區域，寬一點才打得下
    // 一段話，而且進入多行本身就是一次形狀變化，寬度跟著變不突兀。
    if (this.isBeingEdited_ && rows > 1) {
      // 捲軸吃掉的寬度也只有多行才有（單行不會溢出）。
      const input = this.htmlInput_;
      if (input) width += input.offsetWidth - input.clientWidth;
      width = Math.max(width, FieldMultilineInput.EDITOR_MIN_WIDTH);
    }
    return { width, height, xPad, topPad };
  }

  private textClass(kind: RunKind): string {
    const parts = ['blocklyText', 'blocklyMultilineText'];
    if (kind === 'ref') parts.push(this.analysis.whole ? 'blockyard-ref blockyard-ref-whole' : 'blockyard-ref');
    if (kind === 'error') parts.push('blockyard-bad');
    if (this.mode === 'expression') parts.push('blockyard-mono');
    return parts.join(' ');
  }

  private borderClass(): string {
    return this.analysis.error ? 'blocklyFieldRect blockyard-field-bad' : 'blocklyFieldRect';
  }

  /**
   * 分析出來的 run → 一行一個 `Piece[]`，套上 `maxLines_` 的溢出與
   * `maxDisplayLength` 的截斷。
   *
   * run 帶的是**原字串上的區間**，所以這裡切行、截字都只動顯示用的字串，
   * 值本身一個字元都沒有變——重新命名（`renameRoot`）拿的是值不是這裡的結果。
   */
  private visibleLines(): Piece[][] {
    const value = String(this.getValue() ?? '');
    const lines: Piece[][] = [[]];

    for (const run of this.analysis.runs) {
      const parts = value.slice(run.start, run.end).split('\n');
      parts.forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part !== '') {
          lines[lines.length - 1]!.push({ kind: run.kind, text: part.replace(/\s/g, NBSP) });
        }
      });
    }

    const overflowed = lines.length > this.getMaxLines();
    const kept = overflowed ? lines.slice(0, this.getMaxLines()) : lines;
    const truncated = kept.map((line, i) =>
      clip(line, this.maxDisplayLength, overflowed && i === kept.length - 1),
    );

    // 空欄位仍然要佔一格的寬度，不然它會塌成一條線點不到。
    if (truncated.length === 1 && truncated[0]!.length === 0) {
      truncated[0] = [{ kind: 'text', text: NBSP }];
    }
    return truncated;
  }

  /** `render_` 自己算尺寸，基底類別的這條路不再有人走。 */
  protected override updateSize_(): void {
    // 故意留空：尺寸與版面是同一次計算的兩個輸出（見 `render_`），拆成兩個
    // 方法就要把量好的寬度存成欄位，而那份快取遲早會跟畫面不同步。
  }

  // ------------------------------------------------------------------ //
  // 編輯器與 autocomplete（§8.5）
  // ------------------------------------------------------------------ //

  override showEditor_(e?: Event, quietInput?: boolean): void {
    super.showEditor_(e, quietInput);

    const input = this.htmlInput_;
    if (!input) return;
    // 運算式在編輯中也是等寬字：進出編輯狀態時字形跳一下比一路不等寬更難讀。
    if (this.mode === 'expression') input.classList.add('blockyard-mono-input');
    // 說明文字那幾格在編輯中也要維持「積木上的一段文字」的樣子。Blockly 給
    // 編輯器的預設是白底、深灰字、膠囊圓角——那正是**旁邊那顆名稱格**的樣子，
    // 於是一點進去，這一格看起來就變成了一個孔。`bare` 的整個重點是這兩者不
    // 能長得一樣（見 `FieldTextOptions.bare`），所以編輯中也要蓋掉。
    if (this.bare) input.classList.add('blockyard-bare-input');

    this.onInput = () => {
      this.refreshCompletions();
      this.scrollCaretIntoView();
    };
    input.addEventListener('input', this.onInput);
    input.addEventListener('click', this.onInput);
    // 方向鍵移動游標不發 `input`，也不會重繪——那條路只剩 keyup 追得到。
    // 它**只捲動**，不重算候選：不然上下鍵會一邊選 autocomplete 一邊把選取
    // 重設回第一項。
    this.onCaretMove = () => this.scrollCaretIntoView();
    input.addEventListener('keyup', this.onCaretMove);

    // **capture 掛在 document 上**：plugin 的 `onHtmlInputKeyDown_` 綁在
    // textarea 自己身上，而同一個元素上 capture 與 bubble 的先後順序是註冊
    // 順序決定的——掛在 document 才穩定地跑在它前面，Enter 才有機會先被
    // autocomplete 收走而不是直接提交欄位。
    this.onKeyDown = (ev) => this.handleEditorKey(ev);
    document.addEventListener('keydown', this.onKeyDown, true);

    this.refreshCompletions();
  }

  /**
   * 編輯器疊上去之後的兩件事：**形狀不要跳**、**游標要看得見**。
   *
   * `resizeEditor_` 是基底類別在每次重繪時調整 WidgetDiv 尺寸的地方，所以它
   * 同時也是「編輯框現在多大」唯一算得準的時機點。
   */
  protected override resizeEditor_(): void {
    super.resizeEditor_();
    this.syncEditorShape();
    this.scrollCaretIntoView();
  }

  /**
   * 編輯框的圓角跟著積木走：單行是膠囊，多行是圓角矩形。
   *
   * 少了這一段，點一顆膠囊欄位會看到它**當場變成方框**——因為編輯器是一個
   * HTML `<textarea>`，圓角由 Blockly 寫死成 `BORDERRADIUS`，跟底下那顆膠囊
   * 沒有關係。使用者要的是「換行時才變矩形」，而點擊不是換行。
   *
   * 值一直在變（`onHtmlInputChange_` 每個按鍵都 `setValue`），所以刪回一行時
   * 這裡也會被重新呼叫，膠囊自己會長回來。
   */
  private syncEditorShape(): void {
    const input = this.htmlInput_;
    const constants = this.getConstants();
    if (!input || !constants) return;
    const scale = this.workspace_?.getScale() ?? 1;
    const single = this.renderedRows() === 1;
    input.style.borderRadius = `${
      single ? input.offsetHeight / 2 : constants.FIELD_BORDER_RECT_RADIUS * scale
    }px`;
    // 與 SVG 那一半同一條規則（見 `render_` 的 `startX`）：單行置中、多行靠左。
    // 兩邊不一致的話，點下去文字會左右跳一下。
    input.style.textAlign = single ? 'center' : 'left';
  }

  /**
   * 超過 `rows` 行之後，textarea 會長出捲軸——但**它不會自己捲到游標那一行**。
   *
   * 原因是 plugin 的 Shift+Enter 是自己接的：`insertNewline()` 直接改
   * `input.value` 再設 `selectionStart`，而程式設定選取範圍不會觸發瀏覽器把
   * 游標捲進視野（只有真正的鍵盤輸入才會）。症狀是打到第五行之後畫面停在第
   * 一到四行，使用者看不到自己在打什麼。
   *
   * 算法直接用 textarea 自己的 `line-height`（`widgetCreate_` 依畫布縮放設好
   * 的），所以縮放中的工作區也對得上。
   */
  private scrollCaretIntoView(): void {
    const input = this.htmlInput_;
    if (!input) return;
    const lineHeight = Number.parseFloat(input.style.lineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;

    input.scrollTop = caretScrollTop({
      value: input.value,
      caret: input.selectionStart ?? input.value.length,
      lineHeight,
      padTop: Number.parseFloat(input.style.paddingTop) || 0,
      scrollTop: input.scrollTop,
      clientHeight: input.clientHeight,
    });
  }

  protected override widgetDispose_(): void {
    const input = this.htmlInput_;
    if (input && this.onInput) {
      input.removeEventListener('input', this.onInput);
      input.removeEventListener('click', this.onInput);
    }
    if (input && this.onCaretMove) input.removeEventListener('keyup', this.onCaretMove);
    if (this.onKeyDown) document.removeEventListener('keydown', this.onKeyDown, true);
    this.onInput = null;
    this.onKeyDown = null;
    this.onCaretMove = null;
    // popup 掛在 WidgetDiv 底下，`hide()` 會清空它；這裡只是把 handle 丟掉。
    this.autocomplete = null;
    this.completion = null;
    super.widgetDispose_();
  }

  private handleEditorKey(ev: KeyboardEvent): void {
    if (ev.target !== this.htmlInput_) return;
    const popup = this.autocomplete;
    if (!popup?.isOpen()) return;

    switch (ev.key) {
      case 'ArrowDown':
        popup.move(1);
        break;
      case 'ArrowUp':
        popup.move(-1);
        break;
      case 'Enter':
      case 'Tab': {
        const pick = popup.current();
        if (pick === null) return;
        this.acceptCompletion(pick);
        break;
      }
      case 'Escape':
        popup.close();
        break;
      default:
        return;
    }
    ev.preventDefault();
    ev.stopPropagation();
  }

  private refreshCompletions(): void {
    const input = this.htmlInput_;
    if (!input) return;

    const ctx = completionContext(
      input.value,
      input.selectionStart ?? input.value.length,
      this.mode,
      this.interpolate,
    );
    this.completion = ctx;
    if (!ctx) {
      this.autocomplete?.close();
      return;
    }

    const items = matchNames(collectVariableNames(mainWorkspaceOf(this)), ctx.prefix);
    if (this.autocomplete) this.autocomplete.update(items);
    else this.autocomplete = openAutocomplete(items, { onPick: (i) => this.acceptCompletion(i) });
  }

  private acceptCompletion(item: string): void {
    const input = this.htmlInput_;
    const ctx = this.completion;
    if (!input || !ctx) return;

    const insert = item + (ctx.close ? '}' : '');
    input.value = input.value.slice(0, ctx.start) + insert + input.value.slice(ctx.end);
    const caret = ctx.start + insert.length;
    input.selectionStart = caret;
    input.selectionEnd = caret;
    // 程式改 `.value` 不會發 input 事件，Blockly 因此收不到新值。
    input.dispatchEvent(new Event('input'));
    this.autocomplete?.close();
  }

  static override fromJson(options: FieldTextFromJsonConfig): FieldText {
    // 依 Blockly 慣例跑一次字串表解析（`%{BKY_...}`）。
    const text = Blockly.utils.parsing.replaceMessageReferences(options.text ?? '');
    return new FieldText(text, undefined, options);
  }
}

export interface CaretScrollInput {
  value: string;
  /** 游標在 `value` 上的位置。 */
  caret: number;
  /** 一行多高（px，已含畫布縮放）。 */
  lineHeight: number;
  /** textarea 的上內距。 */
  padTop: number;
  /** 目前捲到哪。 */
  scrollTop: number;
  /** 看得見的高度。 */
  clientHeight: number;
}

/**
 * 「要把 textarea 捲到哪，游標才看得見」——`scrollCaretIntoView` 的算術。
 *
 * 抽成純函數是因為這段數學沒有畫面就試不出來，而它錯了的症狀（打到第五行
 * 之後畫面沒跟上）只有真的打到第五行才看得到。
 *
 * 規則是最小移動：游標在視野上方就往上捲到剛好露出那一行，在下方就往下捲到
 * 剛好露出，已經看得見就**完全不動**——不然每打一個字畫面都會跳一下。
 */
export function caretScrollTop(input: CaretScrollInput): number {
  const line = input.value.slice(0, input.caret).split('\n').length - 1;
  const top = input.padTop + line * input.lineHeight;

  if (top < input.scrollTop) return top;
  const bottom = top + input.lineHeight;
  if (bottom > input.scrollTop + input.clientHeight) return bottom - input.clientHeight;
  return input.scrollTop;
}

/** 一行截到 `maxDisplayLength`；溢出的最後一行改以 `…` 收尾。 */
function clip(line: Piece[], limit: number, ellipsis: boolean): Piece[] {
  const out: Piece[] = [];
  let used = 0;
  for (const piece of line) {
    if (used >= limit) break;
    const text = piece.text.slice(0, limit - used);
    out.push({ ...piece, text });
    used += text.length;
  }
  if (!ellipsis) return out;
  const last = out[out.length - 1];
  if (last) last.text = `${last.text.slice(0, Math.max(0, last.text.length - 1))}…`;
  else out.push({ kind: 'text', text: '…' });
  return out;
}

/**
 * 把名稱正規化成 §4.7 的路徑解析吃得下的樣子。獨立成函式是為了讓
 * 「重新命名此變數的所有引用」與存檔前的靜態檢查共用同一條規則。
 */
export function validateName(name: string): string {
  return name.replace(ILLEGAL_NAME_CHARS, '').trim();
}

// -------------------------------------------------------------------- //
// autocomplete 的來源與觸發（§8.5）
// -------------------------------------------------------------------- //

interface CompletionContext {
  /** 要被換掉的區間（在 textarea 的值上）。 */
  start: number;
  end: number;
  /** 已經打了的字，用來過濾清單。 */
  prefix: string;
  /** 補完之後要不要順手補一個 `}`。 */
  close: boolean;
}

/**
 * 游標現在是不是在一個「該補變數名」的位置。
 *
 * 兩種情形，設計文件都寫了：變數名稱欄位**整格**就是一個名字（聚焦即列出），
 * 其餘欄位則是**打了 `$` 之後**（`${` 開頭、還沒關、還沒開始走 `.`／`[` 的
 * 路徑）。路徑第二段之後不補——那要知道值長什麼樣子，是執行期的事。
 */
export function completionContext(
  value: string,
  caret: number,
  mode: 'text' | 'variable' | 'expression',
  interpolate: boolean,
): CompletionContext | null {
  if (mode === 'variable') {
    return { start: 0, end: value.length, prefix: value, close: false };
  }
  if (mode !== 'expression' && !interpolate) return null;

  const open = value.lastIndexOf('${', caret);
  if (open === -1) return null;
  // `$${` 是逸出，不是插值的開頭。
  if (open > 0 && value[open - 1] === '$') return null;
  const inner = value.slice(open + 2, caret);
  if (inner.includes('}')) return null;
  if (/[.[\]]/.test(inner)) return null;

  return { start: open + 2, end: caret, prefix: inner, close: value[caret] !== '}' };
}

/** 前綴優先、其次包含。兩者都不區分大小寫，中文不受影響。 */
export function matchNames(names: string[], prefix: string): string[] {
  if (prefix === '') return names.slice(0, MAX_COMPLETIONS);
  const needle = prefix.toLowerCase();
  const starts = names.filter((n) => n.toLowerCase().startsWith(needle));
  const contains = names.filter(
    (n) => !n.toLowerCase().startsWith(needle) && n.toLowerCase().includes(needle),
  );
  // 完全一樣就不必提示了——那是使用者已經打完的東西。
  const out = [...starts, ...contains].filter((n) => n !== prefix);
  return out.slice(0, MAX_COMPLETIONS);
}

/**
 * 工作區裡出現過的變數名稱（§8.5：「掃描工作區」，不是 IR 的 `variables`）。
 *
 * 來源**只有變數名稱欄位**，不含 `${}` 裡打過的 root。理由是 §4.5 的靜態檢查
 * 就是這麼定義的：一個名字要先被 `data.set` 過才算數。把打錯的引用也收進來，
 * 等於讓 autocomplete 幫忙傳播錯字。
 */
export function collectVariableNames(workspace: Blockly.Workspace | null): string[] {
  if (!workspace) return [];
  const names = new Set<string>();
  for (const field of allTextFields(workspace)) {
    if (!field.isVariableName()) continue;
    const value = String(field.getValue() ?? '');
    if (value !== '') names.add(value);
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}

/** 工作區裡所有的 `FieldText`，含影子積木上的那些。 */
export function allTextFields(workspace: Blockly.Workspace): FieldText[] {
  const out: FieldText[] = [];
  for (const block of workspace.getAllBlocks(false)) {
    for (const input of block.inputList) {
      for (const field of input.fieldRow) {
        if (field instanceof FieldText) out.push(field);
      }
    }
  }
  return out;
}

/**
 * 這顆欄位所屬的**主**工作區。flyout 裡的積木有自己的 workspace，而
 * autocomplete 要列的是使用者畫布上的名字，不是工具箱裡那些樣板。
 */
function mainWorkspaceOf(field: Blockly.Field): Blockly.WorkspaceSvg | null {
  const workspace = field.getSourceBlock()?.workspace as Blockly.WorkspaceSvg | undefined;
  if (!workspace) return null;
  return workspace.isFlyout ? (workspace.targetWorkspace ?? null) : workspace;
}

/**
 * §4.5 的「重新命名此變數的所有引用」。
 *
 * 一次掃全工作區，變數名稱欄位與 `${}` 引用一起換，包在同一個 Blockly event
 * group 裡——設計文件明講要**一次 undo** 就能全部退回去。只動路徑的 root，
 * `${舊名.items[1]}` 換成 `${新名.items[1]}`。
 */
export function renameVariable(
  workspace: Blockly.Workspace,
  from: string,
  to: string,
): number {
  let changed = 0;
  Blockly.Events.setGroup(true);
  try {
    for (const field of allTextFields(workspace)) {
      const value = String(field.getValue() ?? '');
      const next = renameRoot(value, from, to, field.analyzeOptions());
      if (next === value) continue;
      field.setValue(next);
      changed++;
    }
  } finally {
    Blockly.Events.setGroup(false);
  }
  return changed;
}

// -------------------------------------------------------------------- //
// 右鍵選單（§8.5）
// -------------------------------------------------------------------- //

const MULTILINE_ITEM = 'blockyard_field_multiline';
const RENAME_ITEM = 'blockyard_field_rename';

/**
 * 被右鍵點到的那一格。
 *
 * `ContextMenuRegistry` 的 scope 只給得出積木，給不出欄位——但
 * `preconditionFn` 拿得到**開啟選單的那個原始事件**，事件的 target 就在那一格
 * 的 SVG 裡面。precondition 一定在 displayText / callback 之前跑（見
 * `ContextMenuRegistry.getContextMenuOptions`），所以在那裡解析一次、存起來給
 * 後兩者用是安全的。
 */
let clickedField: FieldText | null = null;

function resolveField(scope: { block?: Blockly.BlockSvg }, event: Event): FieldText | null {
  const block = scope.block;
  const target = event.target;
  if (!block || !(target instanceof Element)) return null;
  // 影子積木的選單開在父積木上（Blockly 的 `Gesture.setTargetBlock`），所以要
  // 連子孫一起找——使用者點的很可能就是那顆影子上的文字格。
  for (const candidate of block.getDescendants(false)) {
    for (const input of candidate.inputList) {
      for (const field of input.fieldRow) {
        if (field instanceof FieldText && field.containsElement(target)) return field;
      }
    }
  }
  return null;
}

export function registerFieldContextMenu(): void {
  const registry = Blockly.ContextMenuRegistry.registry;
  if (registry.getItem(MULTILINE_ITEM)) return;

  registry.register({
    id: MULTILINE_ITEM,
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: 20,
    preconditionFn: (scope, event) => {
      clickedField = resolveField(scope, event);
      const field = clickedField;
      if (!field || field.isVariableName() || field.isExpression()) return 'hidden';
      // manifest 已經宣告成多行時切不掉：`ui.multiline` 只列得出「要多行」的
      // 名字（§4.2），列不出「不要」。看得到但點不動，比整條消失誠實。
      return field.isDeclaredMultiline() ? 'disabled' : 'enabled';
    },
    displayText: () => (clickedField?.getForcedMultiline() ? '取消多行輸入' : '多行輸入'),
    callback: () => {
      const field = clickedField;
      if (!field) return;
      field.setForcedMultiline(field.getForcedMultiline() ? null : true);
    },
  });

  registry.register({
    id: RENAME_ITEM,
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: 21,
    preconditionFn: (scope, event) => {
      clickedField = resolveField(scope, event);
      const field = clickedField;
      if (!field?.hasReferences()) return 'hidden';
      return String(field.getValue() ?? '') === '' ? 'disabled' : 'enabled';
    },
    displayText: () => `重新命名「${String(clickedField?.getValue() ?? '')}」的所有引用`,
    callback: (scope) => {
      const field = clickedField;
      const workspace = scope.block?.workspace;
      if (!field || !workspace) return;
      const from = String(field.getValue() ?? '');
      Blockly.dialog.prompt('新的變數名稱', from, (answer) => {
        if (answer === null) return;
        const to = validateName(answer);
        if (to === '' || to === from) return;
        renameVariable(workspace, from, to);
      });
    },
  });
}

/**
 * 關掉 plugin 的快捷鍵提示條（`⏎ 完成 / ⇧⏎ 換行`）。
 *
 * 它是一條**絕對定位在編輯器底部**的橫幅，於是每一格文字都得替它多留一行高
 * 度與一段寬度，而它說的事情——Enter 送出、Shift+Enter 換行——是使用者按一次
 * 就會知道的。常駐的教學橫幅換來的是每一格都變大，這筆不划算：讓使用者自己
 * 發現。
 *
 * 這是 plugin 的 static，所以要在任何一顆欄位建出來之前設好。
 */
FieldMultilineInput.showHint = false;

Blockly.fieldRegistry.register(FIELD_TEXT_TYPE, FieldText);
registerFieldContextMenu();

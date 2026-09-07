/**
 * 積木包的動態下拉（D22、§8.1）。
 *
 * `http.method`／`openai.model` 這類參數宣告 `type: dropdown, source: xxx`，
 * 選項要打 `POST /api/extensions/{extId}/dropdown/{source}` 才問得到（後端
 * 端點見 `api/extensions.py`）。這顆欄位在此之前一直是文字影子頂著——形狀與
 * IR 表示完全沒變，換掉的只是影子上那顆欄位的類別（見 `define.ts::shadowFor`
 * 的 `dropdown` 分支）。
 *
 * **繼承 `Blockly.FieldDropdown` 而不是整個重寫**：拿到既有的下拉視覺（箭頭、
 * 選單開闔）不必自己畫。真正要換的只有兩件事：
 *
 * 1. `menuGenerator_` 是一個函式，讀 `this.cachedOptions`——那份清單背景抓，
 *    抓到才更新，不卡住使用者。
 * 2. **驗證放寬成任何字串都接受**（`doClassValidation_`）。`FieldDropdown` 的
 *    預設驗證會拒絕不在目前選項清單裡的值——存檔讀回一個當時選過、但清單還
 *    沒抓回來（或後來從清單消失）的值，預設驗證會把它悄悄改回舊值。這顆欄位
 *    的角色跟舊的文字影子一樣：IR 存什麼就是什麼，這裡只是幫忙挑，不是幫忙
 *    把關——把關是 manifest 的 `default` 與積木包自己執行期的事。
 *
 * **不用 `setOptions()`**：那個方法會把選中值重設成清單的第一項，等於「抓到
 * 新清單」變成「使用者的選擇被清空」。改成直接換 `cachedOptions` 再
 * `forceRerender()`，選中的值完全不動，只有顯示的文字與下次打開選單看到的
 * 清單會更新。
 *
 * **沒有選項的時候，選單裡放一句話，不是留白**（`notice()`）。清單是背景抓
 * 來的，所以「還沒抓完」「抓失敗」「真的一個都沒有」是三個不同的中間狀態，
 * 而它們原本畫出來一模一樣：點開下拉，一格空白。空白說不出 token 還沒設定、
 * 說不出伺服器還沒選，使用者只知道「這裡壞了」。這三種狀態各有一句話，用
 * `NOTICE_VALUE` 這個選不中的值頂著（見 `doClassValidation_`）。
 */
import * as Blockly from 'blockly/core';
import type { DropdownArgs } from './dropdownCache';
import { fetchDropdownOptions, peekDropdownOptions } from './dropdownCache';
import { list, t } from '../../i18n';

export const FIELD_DYNAMIC_DROPDOWN_TYPE = 'field_blockyard_dynamic_dropdown';

/**
 * 選單裡那一行「不是選項的東西」（載入中／讀不到／一個都沒有）帶的值。
 *
 * 它一定要是一個**不可能是真值**的字串：使用者點得到那一行，而點下去在
 * `FieldDropdown` 眼裡就是一次 `setValue()`。`doClassValidation_` 認出這個值
 * 就擋掉，所以點它等於沒點——不會有一個 `\u0000blockyard.notice` 被存進 IR。
 */
const NOTICE_VALUE = '\u0000blockyard.notice';
const loadingText = () => t('blockly.loadingOptions');

/** 影子積木上那個欄位的名字。與 `define.ts::SHADOW_FIELD` 同一個字串——不從
 * 那邊 import，是為了不讓這個檔案與 `define.ts` 互相 import（define.ts 已經
 * import 這個檔案的 `FIELD_DYNAMIC_DROPDOWN_TYPE`）。 */
const SHADOW_FIELD_NAME = 'VALUE';

export interface FieldDynamicDropdownConfig extends Blockly.FieldConfig {
  extId: string;
  source: string;
  /** manifest 的 `depends`：這份選項要吃同一顆積木上哪幾格的值。 */
  depends?: string[];
  /** 那幾格的 `label`（參數名 → 標籤）。「先選擇伺服器」那句話要用它——只有
   * 參數名的話那句話會變成「先選擇 server」。 */
  dependsLabels?: Record<string, string>;
  /** 值還是空的時候顯示什麼。見 `getText_`。 */
  placeholder?: string;
}

export interface FieldDynamicDropdownFromJsonConfig extends FieldDynamicDropdownConfig {
  value?: string;
}

/**
 * 抓的時候先用 `cachedOptions` 頂著；讀不到就是它一路頂到底。
 *
 * `this` 型別特意寫成基底的 `FieldDropdown`，不是 `FieldDynamicDropdown`：
 * `MenuGeneratorFunction` 期待的就是那個型別，寫成子類別會被 TS 判定成不能
 * 賦值（`this` 參數是逆變的）。這個函式只會被下面的建構子傳給
 * `FieldDynamicDropdown` 自己用，執行期 `this` 一定是子類別的實例，轉型是
 * 安全的。
 *
 * **防呆一手**：`FieldDropdown` 的建構子在自己的 setup 過程中會先呼叫一次
 * `menuGenerator_()` 來決定初始選中值——那一刻早於（或至少不保證晚於）
 * `configure_()` 把 `cachedOptions` 設好，實測會拿到 `undefined`。這裡回一個
 * 佔位選項而不是讓它炸掉；真正的值由建構子稍後 `setValue()` 覆寫回去（見
 * 下方建構子），這個佔位選項只在那個瞬間存在，使用者看不到。
 */
function dynamicMenuGenerator(this: Blockly.FieldDropdown): Blockly.MenuOption[] {
  const field = this as FieldDynamicDropdown;
  // `notice()` 是原型上的方法，所以建構期（欄位還沒初始化）呼叫得到；它讀的
  // 那幾個屬性那時還是 undefined，回 null，於是走下面那條原本的路。
  const notice = field.notice();
  if (notice) return [notice];
  const options = field.cachedOptions;
  return Array.isArray(options) && options.length > 0 ? options : [['', '']];
}

/** 這顆欄位的清單現在處於哪一種狀態。畫面上那句話由它決定（`notice()`）。 */
type LoadStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export class FieldDynamicDropdown extends Blockly.FieldDropdown {
  declare private extId: string;
  declare private source: string;
  declare private depends: string[];
  declare private dependsLabels: Record<string, string>;
  declare private placeholder: string;
  declare cachedOptions: Blockly.MenuOption[];
  private fetchToken = 0;
  /** 清單現在的狀態。**只影響顯示**——值一律照舊（見 `doClassValidation_`）。 */
  private status: LoadStatus = 'idle';
  /** `status === 'error'` 時那一句話。後端的 detail.message 直接放進來。 */
  private problem = '';
  /** 上一次抓的時候，依賴的那幾格是什麼值。用來認出「伺服器換了」。
   * `null` = 還沒抓過任何一次，跟「抓過、而那次的依賴是空的」不是同一件事。 */
  private loadedFor: string | null = null;
  private listener: ((e: Blockly.Events.Abstract) => void) | null = null;

  constructor(
    value?: string | typeof Blockly.Field.SKIP_SETUP,
    validator?: Blockly.FieldDropdownValidator,
    config?: FieldDynamicDropdownFromJsonConfig,
  ) {
    super(dynamicMenuGenerator, validator, config ?? { extId: '', source: '' });
    // `FieldDropdown` 沒有「初始值」這個建構子參數——它自己會選 `cachedOptions`
    // 的第一項（`configure_` 種的那一份，見下）。這裡再明確設一次，是為了讓
    // 「直接 `new FieldDynamicDropdown(value, ...)`」這個呼叫方式本身就正確，
    // 不必依賴呼叫端也同時把 `value` 塞進 `config`。
    if (typeof value === 'string') this.setValue(value);
  }

  protected override configure_(config: FieldDynamicDropdownFromJsonConfig): void {
    super.configure_(config);
    this.extId = config.extId;
    this.source = config.source;
    this.depends = config.depends ?? [];
    this.dependsLabels = config.dependsLabels ?? {};
    this.placeholder = config.placeholder ?? t('blockly.select');
    const seed = config.value ?? '';
    // 同一個 extId/source 常常在這顆積木被建構之前就已經抓過（工具箱把整份
    // palette 一次畫出來，這顆多半不是畫面上第一個用到這個 source 的）。快取
    // 是熱的就直接種好整份清單，選單第一次打開就是對的，不必再等一輪
    // fetch → forceRerender。
    // 吃別格的下拉在**建構的那一刻**還讀不到那幾格（`getSourceBlock()` 這時
    // 還沒接上父積木），所以只有不吃別格的才種得起熱快取。這不是效能取捨，是
    // 「那份資訊此刻不存在」——硬猜一份出來，畫出的第一眼會是別的伺服器的頻道。
    // 值是空的（`default: ""`）就**一個選項都不種**：種一個 `['', '']` 進去，
    // 點開選單看到的就是一格空白，而那正是 `notice()` 要頂掉的東西。
    const warm =
      this.depends.length === 0 ? peekDropdownOptions(this.extId, this.source) : null;
    this.cachedOptions = warm ?? (seed ? [[seed, seed]] : []);
  }

  override initView(): void {
    super.initView();
    void this.load(false);
    this.watchDependencies();
  }

  override dispose(): void {
    this.unwatchDependencies();
    super.dispose();
  }

  /**
   * 依賴的那幾格變了就重抓。
   *
   * **只重抓，不清空這一格的值。** 換了伺服器之後，舊的頻道 id 確實不再屬於
   * 新的伺服器——但「幫使用者把值清掉」要判斷這次變動是不是使用者造成的，而
   * 載入專案、undo、拖動都會走同一條事件路。那是「規則對、時機錯」的形狀
   * （PROGRESS 的第 3 條），而它的代價是**默默弄丟一個存過的值**。重抓本身
   * 是冪等的，什麼時候發生都安全：值不在新清單裡時 `getText_` 照樣顯示原始
   * 值（這顆欄位一直以來的規矩），真的送出去才由 Discord 說「找不到這個頻道」
   * ——那句話是準確的。
   */
  private watchDependencies(): void {
    if (this.depends.length === 0 || this.listener) return;
    const workspace = this.getSourceBlock()?.workspace;
    if (!workspace) return;
    this.listener = () => {
      if (this.dependencyKey() !== this.loadedFor) void this.load(false);
    };
    workspace.addChangeListener(this.listener);
  }

  private unwatchDependencies(): void {
    if (!this.listener) return;
    this.getSourceBlock()?.workspace?.removeChangeListener(this.listener);
    this.listener = null;
  }

  /**
   * 依賴的那幾格現在是什麼值。
   *
   * 這顆欄位住在**影子積木**上，而依賴的那一格是**父積木**的另一個輸入孔
   * （孔名就是參數名，見 `define.ts::toBlocklyArg`）。所以要往上一層再往旁邊
   * 找，不是在自己這顆積木上找。
   *
   * 孔裡插著真的 reporter（不是影子）時讀不出值——那要執行才知道。回空字串，
   * 讓積木包收到「還沒選」那個正常狀態：一份空清單比一份錯的清單好。
   */
  private dependencyArgs(): DropdownArgs {
    const parent = this.getSourceBlock()?.getParent();
    const out: DropdownArgs = {};
    for (const name of this.depends) {
      const target = parent?.getInput(name)?.connection?.targetBlock();
      const field = target?.isShadow() ? target.getField(SHADOW_FIELD_NAME) : null;
      out[name] = field ? String(field.getValue() ?? '') : '';
    }
    return out;
  }

  private dependencyKey(): string {
    return JSON.stringify(this.dependencyArgs());
  }

  /** 右鍵「重新整理選項」的入口：繞過快取重抓。回傳的 promise 給測試 await
   * 用；production 呼叫端（右鍵選單的 callback）不必等它。 */
  refresh(): Promise<void> {
    return this.load(true);
  }

  private async load(force: boolean): Promise<void> {
    if (!this.extId || !this.source) return;
    const token = ++this.fetchToken;
    const args = this.dependencyArgs();
    const key = JSON.stringify(args);
    // **換了伺服器就把手上那份清單丟掉。** 它屬於上一個伺服器，而一份屬於別人
    // 的頻道清單看起來完全正常——使用者會從裡面挑一個，然後拿到「找不到這個
    // 頻道」。選中的**值**不動（那是他自己選的，見 `watchDependencies`），丟掉
    // 的只有選項。
    if (this.loadedFor !== null && key !== this.loadedFor) this.cachedOptions = [];
    // 抓之前就記下來，不是抓回來才記：抓失敗（或這個伺服器一個頻道都沒有）
    // 時如果不記，每一個事件都會再打一次同一個註定失敗的請求。
    this.loadedFor = key;
    this.settle('loading');
    try {
      const options = await fetchDropdownOptions(this.extId, this.source, { force, args });
      // 這段等待期間又觸發了一次（使用者按了重新整理、或又換了伺服器），這次
      // 的結果晚到，不該覆蓋更新的那一次。
      if (token !== this.fetchToken) return;
      // 空清單**不是**「維持原狀」：`discord.channels` 在還沒選伺服器時回的就
      // 是空的，那是一個要說出來的狀態（`emptyText`），不是一次沒發生的更新。
      if (options.length > 0) this.cachedOptions = options;
      this.settle(options.length > 0 ? 'ready' : 'empty');
    } catch (e) {
      // 抓不到就維持現有選項（seed 或上一次成功的清單）——不讓整顆積木壞掉，
      // 使用者仍然看得到、改得動目前這個值（它就是一個字串）。壞掉的原因寫進
      // `problem`，選單打開時看得到：`還沒設定「Discord」的 Bot Token` 是這條
      // 路上最常見的那一句，而它原本只會變成一格空白。
      if (token !== this.fetchToken) return;
      this.problem = e instanceof Error ? e.message : String(e);
      this.settle('error');
    }
  }

  /** 換一個狀態，並且讓畫面跟上。
   *
   * `dropdownCreate()` 每次開選單都會自己重新呼叫 `getOptions(false)`，所以打開
   * 選單看到的清單一定是新的；這裡再呼叫一次是為了讓 `doValueUpdate_` 這類讀
   * `getOptions(true)`（吃快取）的內部路徑也跟著更新，不必等到使用者真的點開
   * 選單那一刻才對齊。 */
  private settle(status: LoadStatus): void {
    this.status = status;
    if (status !== 'error') this.problem = '';
    this.getOptions(false);
    this.forceRerender();
  }

  /**
   * 選單裡頂著的那一行；有真的選項就回 `null`（那時候不需要有人頂著）。
   *
   * **建構期呼叫得到**：它是原型上的方法，而 `FieldDropdown` 的建構子會先跑一次
   * `menuGenerator_()`。那一刻 `this.status` 還是 undefined（子類別的欄位在
   * `super()` 回來之後才初始化），switch 掉到 default 回 null——與這顆欄位還沒
   * 開始抓的狀態一致。
   */
  notice(): Blockly.MenuOption | null {
    if (Array.isArray(this.cachedOptions) && this.cachedOptions.length > 0) return null;
    switch (this.status) {
      case 'loading':
        return [loadingText(), NOTICE_VALUE];
      case 'error':
        return [this.problem || t('blockly.optionsUnavailable'), NOTICE_VALUE];
      case 'empty':
        return [this.emptyText(), NOTICE_VALUE];
      default:
        return null;
    }
  }

  /**
   * 真的問到了、而答案是「一個都沒有」時那句話。
   *
   * 依賴的那幾格還空著是**最常見**的那一種，而且它根本不是問題：使用者從左往
   * 右填，還沒選伺服器的那一刻本來就問不出頻道（`main.py::channels` 回空清單
   * 就是為了這個）。所以這一句要說出下一步（「先選擇伺服器」），不是說「沒有
   * 東西」——後者會讓人以為自己的伺服器裡真的沒有頻道。
   */
  private emptyText(): string {
    const args = this.dependencyArgs();
    const missing = this.depends
      .filter((name) => !args[name])
      .map((name) => this.dependsLabels[name] ?? name);
    return missing.length > 0
      ? t('blockly.selectFirst', { names: list(missing) })
      : t('blockly.noOptions');
  }

  /**
   * 放寬驗證：任何字串都接受，不檢查是不是在目前的選項清單裡。
   *
   * 原因見檔頭：清單是背景抓來的，讀存檔或還沒抓完的那一刻，目前的值有可能
   * 不在清單裡——那不代表這個值不合法，只代表清單還沒跟上。
   */
  protected override doClassValidation_(newValue?: string): string | null {
    // 唯一擋下來的東西：選單裡那一行頂著的話。它是一句提示，不是一個值——
    // 點下去在 `FieldDropdown` 眼裡卻是一次正常的選取，不擋的話它會被存進 IR，
    // 而積木包收到的是一串使用者從來沒選過的東西。
    if (newValue === NOTICE_VALUE) return null;
    return newValue ?? null;
  }

  /**
   * 選中的值不在目前的選項清單裡（清單還沒抓回來、或後來從清單消失）就直接
   * 顯示原始值——跟舊的文字影子看起來一樣，不會空白也不會噴錯。
   *
   * **值是空的就顯示提示字，不是留白。** 一顆 `default: ""` 的下拉畫出來是一
   * 個完全空白的深色膠囊——沒有文字，寬度縮到最小，連 Blockly 的下拉箭頭都跟
   * 著不見了（箭頭排在文字後面）。使用者看到的是一格「什麼都沒有的東西」，
   * 不知道那裡可以點、也不知道那裡少了什麼。**這件事在單元測試裡看不出來**：
   * 值一直都是對的空字串，壞的是樣子（PROGRESS 的第 6 條）。
   *
   * 提示字由編輯器從 manifest 的 `label` 導出（`define.ts`），不是叫每個積木
   * 包自己寫一句——會忘記的包就是大多數，而忘記的代價是一格看不見的東西。
   */
  protected override getText_(): string | null {
    const value = this.getValue();
    // 還在抓、而且這一格還沒有值：先說「載入中…」。它與提示字（「選擇伺服器」）
    // 的差別是**點開來會不會有東西**——在清單回來之前，這一格點開只有一行話，
    // 而使用者有權在點下去之前就知道這件事。有值的時候不換：那個值（一串 id）
    // 本來就是這一格現在真正的內容，換成「載入中…」等於把它藏起來。
    if (!value && this.status === 'loading') return loadingText();
    if (!value) return this.placeholder;
    const match = this.cachedOptions.find(
      (opt): opt is [string, string, string?] => Array.isArray(opt) && opt[1] === value,
    );
    return typeof match?.[0] === 'string' ? match[0] : value;
  }

  static override fromJson(options: FieldDynamicDropdownFromJsonConfig): FieldDynamicDropdown {
    return new FieldDynamicDropdown(options.value, undefined, options);
  }
}

Blockly.fieldRegistry.register(FIELD_DYNAMIC_DROPDOWN_TYPE, FieldDynamicDropdown);

// --------------------------------------------------------------------------
// 右鍵選單：「重新整理選項」
// --------------------------------------------------------------------------

const REFRESH_MENU_ID = 'blockyard_dynamic_dropdown_refresh';

function fieldOf(block: Blockly.Block | undefined): FieldDynamicDropdown | null {
  const field = block?.getField(SHADOW_FIELD_NAME);
  return field instanceof FieldDynamicDropdown ? field : null;
}

export function registerDynamicDropdownMenu(): void {
  const registry = Blockly.ContextMenuRegistry.registry;
  if (registry.getItem(REFRESH_MENU_ID)) return;
  registry.register({
    id: REFRESH_MENU_ID,
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: 100,
    preconditionFn: (scope: { block?: Blockly.BlockSvg }) =>
      fieldOf(scope.block) ? 'enabled' : 'hidden',
    displayText: () => t('blockly.refreshOptions'),
    callback: (scope: { block?: Blockly.BlockSvg }) => {
      fieldOf(scope.block)?.refresh();
    },
  });
}

registerDynamicDropdownMenu();

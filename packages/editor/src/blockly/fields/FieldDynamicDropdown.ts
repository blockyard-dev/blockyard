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
 */
import * as Blockly from 'blockly/core';
import { fetchDropdownOptions, peekDropdownOptions } from './dropdownCache';

export const FIELD_DYNAMIC_DROPDOWN_TYPE = 'field_blocky_dynamic_dropdown';

/** 影子積木上那個欄位的名字。與 `define.ts::SHADOW_FIELD` 同一個字串——不從
 * 那邊 import，是為了不讓這個檔案與 `define.ts` 互相 import（define.ts 已經
 * import 這個檔案的 `FIELD_DYNAMIC_DROPDOWN_TYPE`）。 */
const SHADOW_FIELD_NAME = 'VALUE';

export interface FieldDynamicDropdownConfig extends Blockly.FieldConfig {
  extId: string;
  source: string;
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
  const options = (this as FieldDynamicDropdown).cachedOptions;
  return Array.isArray(options) && options.length > 0 ? options : [['', '']];
}

export class FieldDynamicDropdown extends Blockly.FieldDropdown {
  declare private extId: string;
  declare private source: string;
  declare cachedOptions: Blockly.MenuOption[];
  private fetchToken = 0;

  constructor(
    value?: string | typeof Blockly.Field.SKIP_SETUP,
    validator?: Blockly.FieldDropdownValidator,
    config?: FieldDynamicDropdownFromJsonConfig,
  ) {
    super(dynamicMenuGenerator, validator, config ?? { extId: '', source: '' });
    // `FieldDropdown` 沒有「初始值」這個建構子參數——它自己會選 `cachedOptions`
    // 的第一項（`configure_` 已經把它設成 `[[value, value]]`，見下）。這裡再
    // 明確設一次，是為了讓「直接 `new FieldDynamicDropdown(value, ...)`」
    // 這個呼叫方式本身就正確，不必依賴呼叫端也同時把 `value` 塞進 `config`。
    if (typeof value === 'string') this.setValue(value);
  }

  protected override configure_(config: FieldDynamicDropdownFromJsonConfig): void {
    super.configure_(config);
    this.extId = config.extId;
    this.source = config.source;
    const seed = config.value ?? '';
    // 同一個 extId/source 常常在這顆積木被建構之前就已經抓過（工具箱把整份
    // palette 一次畫出來，這顆多半不是畫面上第一個用到這個 source 的）。快取
    // 是熱的就直接種好整份清單，選單第一次打開就是對的，不必再等一輪
    // fetch → forceRerender。
    const warm = peekDropdownOptions(this.extId, this.source);
    this.cachedOptions = warm ?? [[seed, seed]];
  }

  override initView(): void {
    super.initView();
    void this.load(false);
  }

  /** 右鍵「重新整理選項」的入口：繞過快取重抓。回傳的 promise 給測試 await
   * 用；production 呼叫端（右鍵選單的 callback）不必等它。 */
  refresh(): Promise<void> {
    return this.load(true);
  }

  private async load(force: boolean): Promise<void> {
    if (!this.extId || !this.source) return;
    const token = ++this.fetchToken;
    try {
      const options = await fetchDropdownOptions(this.extId, this.source, { force });
      // 這段等待期間又觸發了一次（例如使用者按了重新整理），這次的結果晚到，
      // 不該覆蓋更新的那一次。
      if (token !== this.fetchToken || options.length === 0) return;
      this.cachedOptions = options;
      // `dropdownCreate()` 每次開選單都會自己重新呼叫 `getOptions(false)`，
      // 所以打開選單看到的清單一定是新的；這裡再呼叫一次是為了讓
      // `doValueUpdate_` 這類讀 `getOptions(true)`（吃快取）的內部路徑也跟著
      // 更新，不必等到使用者真的點開選單那一刻才對齊。
      this.getOptions(false);
      this.forceRerender();
    } catch {
      // 抓不到就維持現有選項（seed 或上一次成功的清單）——不讓整顆積木壞掉，
      // 使用者仍然看得到、改得動目前這個值（它就是一個字串）。
    }
  }

  /**
   * 放寬驗證：任何字串都接受，不檢查是不是在目前的選項清單裡。
   *
   * 原因見檔頭：清單是背景抓來的，讀存檔或還沒抓完的那一刻，目前的值有可能
   * 不在清單裡——那不代表這個值不合法，只代表清單還沒跟上。
   */
  protected override doClassValidation_(newValue?: string): string | null {
    return newValue ?? null;
  }

  /** 選中的值不在目前的選項清單裡（清單還沒抓回來、或後來從清單消失）就直接
   * 顯示原始值——跟舊的文字影子看起來一樣，不會空白也不會噴錯。 */
  protected override getText_(): string | null {
    const value = this.getValue();
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

const REFRESH_MENU_ID = 'blocky_dynamic_dropdown_refresh';

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
    displayText: () => '重新整理選項',
    callback: (scope: { block?: Blockly.BlockSvg }) => {
      fieldOf(scope.block)?.refresh();
    },
  });
}

registerDynamicDropdownMenu();

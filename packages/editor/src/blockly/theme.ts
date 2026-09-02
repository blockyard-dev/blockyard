/**
 * 工作區外觀。
 *
 * 顏色**不放在這裡**：每顆積木的顏色來自它那份 manifest 的 `color`（§8.1），
 * 積木包自己決定要長什麼樣子。這份主題只管積木以外的東西——工作區背景、
 * 工具箱、flyout。
 */
import * as Blockly from 'blockly/core';
import {
  ContinuousFlyout,
  ContinuousToolbox,
  registerContinuousToolbox,
  type LabelFlyoutItem,
} from '@blockly/continuous-toolbox';
import { procIdFromType } from './procedures';
// 時間與曲線與畫布的「滑到那顆積木」共用一份（見 `motion.ts` 開頭）。
import { SCROLL_MS, easeOut, prefersReducedMotion } from './motion';

export const blockyTheme = Blockly.Theme.defineTheme('blocky', {
  name: 'blocky',
  base: Blockly.Themes.Zelos,
  componentStyles: {
    workspaceBackgroundColour: '#f7f7fb',
    toolboxBackgroundColour: '#ffffff',
    toolboxForegroundColour: '#33333d',
    flyoutBackgroundColour: '#eceef5',
    flyoutForegroundColour: '#33333d',
    flyoutOpacity: 1,
    scrollbarColour: '#c8ccdc',
    insertionMarkerColour: '#33333d',
    insertionMarkerOpacity: 0.3,
    cursorColour: '#33333d',
    // Zelos 的「選取」是一圈 `#fff200` 的外發光（`SELECTED_GLOW_COLOUR`），而在
    // 這個編輯器裡**點一下積木＝執行它**（App.tsx 的 `Events.CLICK`），所以那圈
    // 黃色是跟著執行走的：跑完了、白框與發光都退掉了，它還留在那裡。兩種高亮
    // 講的是同一件事的不同階段，畫面上卻是兩套顏色。
    //
    // 這裡的高亮語彙已經定好了（見 index.css：白色描邊 + 橘色外發光＝正在跑、
    // 紅色＝錯了），選取沒有第三種顏色可用，所以讓它不畫。代價是**「哪一顆被
    // 選起來了」在畫面上沒有回饋**——這個編輯器裡它幾乎沒有工作（點是執行、
    // 拖是直接拖、右鍵選單自己會指），而鍵盤導覽那圈黃色是另一條規則，還在。
    selectedGlowColour: 'transparent',
  },
  // 帽子由積木自己的 `style.hat` 決定（見 define.ts 的 applyShape）。全域打開
  // 的話，`return`、`stop` 這種沒有上接點的 cap 積木也會長出帽子。
  startHats: false,
});

/**
 * §8.1 的工具箱版面：**一條連續的捲動軸**。
 *
 * 所有分類接在同一個 flyout 裡，點分類是**捲到那一段**而不是換一份清單。這讓
 * 「我不知道那顆積木在哪一類」從一個要先答對才問得出口的問題，變成滑一遍就
 * 解決的問題——那正是新使用者最常有的處境。
 *
 * 它順帶解掉「固定寬度」那一條：flyout 只有一份，寬度就是所有積木裡最寬的
 * 那一顆，切換分類時不會再變——而畫布正是使用者在對齊積木的地方，它不該
 * 因為左邊換了一份清單就整個左右跳動。
 *
 * 註冊是覆寫式的（plugin 用 `allowOverrides`），重複呼叫安全。
 */
registerContinuousToolbox();

/**
 * 工具箱按鈕撐大一點（D25）。
 *
 * 預設量出來是 56×21 的小方塊，而 Scratch 的「製作積木」是一顆與 flyout 同寬
 * 的按鈕。這一條與「能不能點」無關，但它決定使用者按了沒反應之後會**不會再
 * 試一次**——第四輪回饋的第一句話正是「創建積木點不了」。
 *
 * 這三個是 static，所以是全域的：之後積木包的按鈕也會吃到，那正是想要的
 * （D25 的按鈕是同一個字彙表，不該長兩種樣子）。尺寸只能從這裡改——寬度是
 * `FlyoutButton` 量文字算出來寫進 rect 的，CSS 改不動。
 */
Blockly.FlyoutButton.TEXT_MARGIN_X = 20;
Blockly.FlyoutButton.TEXT_MARGIN_Y = 10;
Blockly.FlyoutButton.BORDER_RADIUS = 8;

/**
 * 積木面板的縮放**與畫布脫鉤**。
 *
 * Blockly 預設 `getFlyoutScale()` 回 `targetWorkspace.scale`，於是放大畫布會
 * 連帶把 flyout 裡的積木放大——而 flyout 的寬度是「最寬的那顆積木」算出來的，
 * 所以面板會跟著往右吃掉畫布。使用者放大畫布是為了看清楚**自己拉的那幾顆**，
 * 那個動作不該讓工具箱變寬。
 *
 * 這個方法的 JSDoc 本來就寫著 "this can be overridden"，覆寫回一個常數即可。
 * 常數用 `DEFAULT_SCALE`：面板永遠長成「畫布在預設縮放時」的樣子。
 */
const DEFAULT_SCALE = 0.75;

/**
 * 積木面板的寬度**是固定的**（px，含捲軸）。
 *
 * Blockly 的作法是「量最寬的那顆積木，flyout 就那麼寬」——那條規則的問題是
 * **一顆積木就能決定整個面板**：積木包作者哪天寫一顆很長的積木（`把 %1 從
 * %2 複製到 %3 並在完成時通知 %4`），面板就吃掉半個畫布，而那個代價由使用者
 * 付。反過來固定寬度的代價只是「那一顆在面板裡看不完整」，而使用者本來就要把
 * 它拖出來才用得到——拖出來之後在畫布上是完整的。
 *
 * 超出的部分**直接裁掉**：flyout 是一個 `<svg>`，SVG 根元素本來就會裁切自己
 * 的內容，不必另外做。所以這裡沒有橫向捲軸，也刻意不加——一條只有工具箱才有
 * 的橫向捲軸，是在為「面板應該要能看完整」這個不成立的前提付錢。
 *
 * 300 是現在量出來的寬度（內建積木最寬的那顆 + 留白 + 捲軸）附近的整數，所以
 * 這個改動對現在的畫面幾乎沒有變化——它擋的是以後。
 *
 * 「固定」指的是**不由內容決定**，不是使用者不能改：右緣有一條 `col-resize`
 * 把手（`FlyoutResizer`），寬度是使用者的偏好。這裡是它的預設值與下界。
 */
export const FLYOUT_DEFAULT_WIDTH = 300;

/**
 * 可以拉到 **0**（整條面板收起來）。
 *
 * 收到 0 之後唯一的出口是**點左邊的分類欄**（`FlyoutResizer` 認這個手勢），
 * 所以那條出口是這個下界成立的前提——沒有它，使用者會把面板拉不見然後回不來。
 */
export const FLYOUT_MIN_WIDTH = 0;


/** SVG 的 namespace（`createElementNS` 要）。 */
const SVG_NS = 'http://www.w3.org/2000/svg';

/** clipPath 的 id 要全域唯一，而按鈕每次 `show()` 都重建。 */
let clipSeq = 0;

/**
 * 按鈕上的文字：放得下就置中，放不下就靠左**並且裁掉**。
 *
 * 面板窄到文字放不下時，置中的文字會從白色圓角矩形的**兩邊**溢出去——看起來
 * 不是「被裁掉」，是「畫壞了」。所以放不下的時候改成靠左，切掉的是尾巴，那是
 * 使用者對「一段被裁掉的文字」的預期。
 *
 * 裁切要自己做：`<text>` 不會被同一群組裡的 `<rect>` 裁到（SVG 的 `<g>` 不裁
 * 內容），而 flyout 那一層的裁切在按鈕右邊還有 18px 的留白，溢出的字會先跑到
 * 面板的底色上。所以掛一個與按鈕同尺寸的 `clipPath`——每顆按鈕一個，第一次才
 * 建，之後只更新尺寸。
 */
function placeButtonText(text: SVGTextElement, width: number, height: number): void {
  // jsdom 沒有這個方法（單元測試不會走到這裡，但 optional call 比 crash 便宜）。
  const length = text.getComputedTextLength?.() ?? 0;
  const pad = Blockly.FlyoutButton.TEXT_MARGIN_X / 2;
  const fits = length <= width - pad * 2;
  text.setAttribute('text-anchor', fits ? 'middle' : 'start');
  text.setAttribute('x', String(fits ? width / 2 : pad));

  const root = text.parentElement as unknown as SVGGElement | null;
  if (!root) return;
  let clip = root.querySelector('clipPath');
  if (!clip) {
    clip = document.createElementNS(SVG_NS, 'clipPath');
    clip.setAttribute('id', `blocky-flyout-clip-${++clipSeq}`);
    clip.appendChild(document.createElementNS(SVG_NS, 'rect'));
    root.appendChild(clip);
    text.setAttribute('clip-path', `url(#${clip.id})`);
  }
  const rect = clip.querySelector('rect');
  rect?.setAttribute('width', String(width));
  rect?.setAttribute('height', String(height));
}

/**
 * 把新的寬度交給面板。
 *
 * 給 `FlyoutResizer` 用的唯一入口：元件不必認得 `FixedScaleFlyout` 這個類別，
 * 也不必知道 Blockly 把寬度存在哪。工作區還沒好、或這個工作區的 flyout 不是
 * 我們這一顆（預覽用的迷你工作區就沒有 flyout）時，安靜地什麼都不做。
 */
export function setFlyoutWidth(
  workspace: Blockly.WorkspaceSvg | null,
  px: number,
): void {
  const flyout = workspace?.getFlyout();
  if (flyout instanceof FixedScaleFlyout) flyout.setFixedWidth(px);
}

/**
 * `scrollTarget` 在 plugin 的型別裡是 private，但它同時是 plugin 自己
 * `selectCategoryByScrollPosition()` 的短路開關——動畫期間要讓它有值，左邊選取
 * 的分類才不會在飛過去的路上一格格跳。private 只是型別上的，執行期照樣寫得到；
 * 開一個有名字的型別把 cast 收在 `scrollTargetPx` 一處，換版本只要重看那裡。
 */
type ScrollTargetSlot = { scrollTarget: number | undefined };

class FixedScaleFlyout extends ContinuousFlyout {
  constructor(options: Blockly.Options) {
    super(options);
    // **函式積木不回收。**
    //
    // continuous-toolbox 的 flyout 會把上一批積木依 type 收起來重用
    // （`RecyclableBlockFlyoutInflater`），而那假設「同一個 type 永遠長同一個
    // 樣子」。函式積木不是：改一次簽章就是同一組 type 換一份定義
    // （`procedures.ts`），於是回收回來的那顆帶著舊的孔——工具箱裡的 `跳 ( ) 次`
    // 在參數已經被刪掉之後還留著那個孔，而畫布上的那顆已經對了。
    this.setBlockIsRecyclable((block) => procIdFromType(block.type) === null);
  }

  /** 使用者拉出來的寬度（px）。預設值見 `FLYOUT_DEFAULT_WIDTH`。 */
  private fixedWidth = FLYOUT_DEFAULT_WIDTH;

  override getFlyoutScale(): number {
    return DEFAULT_SCALE;
  }

  /**
   * 換一個寬度並立刻套用。
   *
   * 收尾與 `reflowInternal_` 同一組（重新定位、讓畫布重算可捲範圍、更新拖曳
   * 目標），另外多一件：**按鈕要重新撐開**。按鈕的寬度只在 `show()` 之後算過
   * 一次，而拉寬面板不經過 `show()`——少了這一句，面板變寬而「建立一個積木」
   * 停在舊寬度，右邊留一條空白。
   */
  setFixedWidth(px: number): void {
    this.fixedWidth = Math.max(FLYOUT_MIN_WIDTH, Math.round(px));
    if (this.getWidth() === this.fixedWidth) return;
    this.width_ = this.fixedWidth;
    this.position();
    this.targetWorkspace.resizeContents();
    this.targetWorkspace.recordDragTargets();
    this.stretchButtons();
  }

  /**
   * 寬度不再由內容決定（見 `FLYOUT_WIDTH`）。
   *
   * 覆寫的是 Blockly 量完內容之後**寫下寬度**的那個方法。原本它是
   * 「`max(每顆積木的寬)` + 留白 + `tabWidth_`，乘 scale，加捲軸」；這裡把量的
   * 那一段換成一個常數，其餘的收尾（重新定位、讓畫布重算可捲範圍、更新拖曳
   * 目標）照做——少任何一項，面板會停在舊的寬度或畫布不知道它變了。
   *
   * 原版在 `width_` 真的改變時還會 `translate` 主工作區（把內容從面板底下推
   * 出來），那條路只在**主工作區沒有捲軸**時才走，而我們的有。寬度是常數，
   * 這裡最多也只會真的改變一次（第一次 reflow），所以那條路更不會走到。
   */
  protected override reflowInternal_(): void {
    this.workspace_.scale = this.getFlyoutScale();
    if (this.getWidth() === this.fixedWidth) return;
    this.width_ = this.fixedWidth;
    this.position();
    this.targetWorkspace.resizeContents();
    this.targetWorkspace.recordDragTargets();
  }

  /**
   * 按鈕撐成**與最寬的那顆積木同寬**（Scratch 的「製作積木」就是那樣）。
   *
   * 這一段是 hack，寫清楚：寬度是 `FlyoutButton` 量文字算出來、直接寫進 rect
   * 的 `width` 的，沒有任何宣告式的掛勾能改（`TEXT_MARGIN_X` 只加內距，
   * `web-class` 只能改顏色）。所以 layout 完之後回頭把 rect 撐開，並把
   * `<text>` 的 `x` 移到新的中線（它是 `text-anchor: middle`，座標寫的是
   * `width / 2`）。動的是 Blockly 畫好的 DOM，換版本要重看一次。
   *
   * 只動按鈕，不動標籤（分類名）——`isLabel()` 的那些沒有背景 rect。
   */
  override show(flyoutDef: Blockly.utils.toolbox.FlyoutDefinition | string): void {
    super.show(flyoutDef);
    this.stretchButtons();
  }

  /**
   * 撐開的目標寬度是 `reflowInternal_` 的**反函數**，不是「flyout 的寬度」。
   *
   * 積木不是從 `MARGIN` 開始排的，是從 `MARGIN + tabWidth_`
   * （`Flyout.layout_`），而 flyout 的右邊還要讓出 `MARGIN * 0.5 +
   * scrollbarThickness` 給捲軸。所以把那條式子倒著解一次，得到的是**面板裡
   * 一顆積木最寬能有多寬**，按鈕就用那個寬度——它與積木左右切齊，不必自己
   * 定義一套留白。
   *
   * 這裡以前還有一條「自己餵自己」的迴圈要防：`element.width` 曾經是
   * `reflowInternal_` 算寬度時 `Math.max` 的輸入之一，於是照 flyout 的寬度撐開
   * 按鈕會把 flyout 再撐寬 12px（只在不經過 `show()` 的 reflow 上看得到，例如
   * 視窗縮放）。**寬度改成固定之後那條迴圈不存在了**——`reflowInternal_` 不再
   * 讀任何內容的寬度。這段留著是因為它解釋了式子為什麼長這樣。
   */
  private stretchButtons(): void {
    const scale = this.getFlyoutScale();
    // `getWidth()` 是像素，rect 的座標是 flyout 工作區的單位。
    const full =
      (this.getWidth() - Blockly.Scrollbar.scrollbarThickness) / scale
      - this.MARGIN * 1.5
      - this.tabWidth_;
    if (!(full > 0)) return;

    for (const item of this.getContents()) {
      const element = item.getElement();
      if (!(element instanceof Blockly.FlyoutButton) || element.isLabel()) continue;
      // **兩個方向都要寫。** 這裡以前有一條「按鈕比 `full` 寬就不動它」的守衛，
      // 那時 `full` 是「最寬的那顆積木」，比按鈕的文字還窄是常有的事，硬寫回去
      // 只會把字擠掉。現在 `full` 是**使用者拉出來的面板寬度**，而按鈕要跟著
      // 面板走——留著那條守衛的症狀是「拉寬再拉窄，按鈕卡在最寬的那一次」。
      // 窄到文字放不下時字會被 flyout 裁掉，與一顆很長的積木同一個規則。
      const root = element.getSvgRoot();
      for (const rect of root.querySelectorAll('rect')) {
        rect.setAttribute('width', String(full));
      }
      const text = root.querySelector('text');
      if (text) placeButtonText(text, full, element.height);
      element.width = full;
    }
  }

  /**
   * **段落標題不是分類標題。**
   *
   * continuous-toolbox 認分類邊界的方式是掃 flyout 裡的 label，拿它的文字去
   * `getCategoryByName()`：對得上就把那個 y 記成該分類的捲動位置。§8.1 的段落
   * 標題（manifest 的 `section`）也是 label，於是一段叫「運算」的標題會被記成
   * 運算分類的起點——點分類捲錯地方，而捲動時左邊選取的分類也跟著跳。
   *
   * 修法是**擋在來源**，不是規定「標題不准跟分類同名」：後者要跨 manifest 才
   * 驗得了，而且它把一個實作細節變成積木包作者要記得的規則。`web-class` 是
   * 我們自己掛上去的（`toolbox.ts`），認它就好。
   */
  protected override toolboxItemIsLabel(
    item: Blockly.FlyoutItem,
  ): item is LabelFlyoutItem {
    const element = item.getElement();
    if (
      element instanceof Blockly.FlyoutButton
      && element.getSvgRoot().classList.contains('blocky-section-label')
    ) {
      return false;
    }
    return super.toolboxItemIsLabel(item);
  }

  /**
   * **點分類要「滑」過去，但要在固定時間內滑完。**
   *
   * plugin 的 `scrollTo` 是每幀補剩餘 30% 的漸近動畫，那個形狀壞了三件事：
   *
   * 1. **它把按鈕從游標底下移走。** 點分類**馬上**點那顆「創建積木」（最自然
   *    的順序）就是在打一個移動中的目標——實測同一顆按鈕的 `rect.y` 在幾秒內
   *    出現過 824 / 127 / 103 / 95 / 92，而 pointerdown 與 pointerup 落在不同
   *    元素上時那一下不算 click，按下去完全沒有反應。
   * 2. **動畫在跑的時候滾輪是死的**：plugin 寫的是
   *    `wheel_(e) { this.scrollTarget || super.wheel_(e) }`，而 `scrollTarget`
   *    只有在動畫收斂（差 < 1px）時才清掉。實測它卡在 `4507.125` 而 `scrollY`
   *    停在 `-4497`，期間往上滾五格 flyout 一動也不動。
   * 3. **分頁沒有焦點時 rAF 被節流到 ~1fps**，漸近動畫會慢到爬（實測 2.5 秒
   *    只走 11px）。
   *
   * 這三件事的成因都是**「幾幀才走完」沒有上限**，不是「會動」本身。所以改成
   * 以時間為準的定長動畫，三件事一起解決：
   *
   * - 動畫最多 `SCROLL_MS` 就結束，(1) 的移動靶只存在這麼久；
   * - `wheel_` 覆寫成一滾就取消動畫再交給 super，(2) 不會再卡死；
   * - 進度算的是 `performance.now()` 的比例，rAF 被節流成 1fps 時
   *   第一幀的 `elapsed` 就已經超過 `SCROLL_MS`，直接收在終點，(3) 退化成
   *   原本的「一次到位」。
   *
   * 動畫期間 `scrollTarget` 是有值的，plugin 的 `selectCategoryByScrollPosition`
   * 因此會短路——左邊選取的分類不會在飛過去的路上一個個跳。收斂那一下把它清
   * 掉，之後的選取就回到既有的捲動 listener，與使用者自己滾到那裡同一條路。
   */
  override scrollTo(position: number): void {
    const ws = this.getWorkspace();
    const metrics = ws.getMetrics();
    const target = Math.min(
      position * ws.scale,
      metrics.scrollHeight - metrics.viewHeight,
    );
    this.scrollTargetPx = target;

    if (prefersReducedMotion()) {
      this.finishScroll();
      return;
    }

    // 用世代編號而不是比對 `scrollTarget`：連點同一個分類兩次時目標是一樣的，
    // 比對值攔不住第二圈，兩圈 rAF 各自寫 setY 會抖。
    const generation = ++this.scrollGeneration;
    const from = -ws.scrollY;
    const startedAt = performance.now();
    const step = (): void => {
      // 這一輪動畫已經被取消或被下一次 scrollTo 接手了。
      if (this.scrollGeneration !== generation) return;
      const t = (performance.now() - startedAt) / SCROLL_MS;
      if (t >= 1) {
        this.finishScroll();
        return;
      }
      ws.scrollbar?.setY(from + (target - from) * easeOut(t));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private scrollGeneration = 0;

  /** 收在終點並清掉 `scrollTarget`（滾輪與分類選取都靠它解除短路）。 */
  private finishScroll(): void {
    this.scrollGeneration++;
    const target = this.scrollTargetPx;
    if (target === undefined) return;
    this.getWorkspace().scrollbar?.setY(target);
    this.scrollTargetPx = undefined;
  }

  private get scrollTargetPx(): number | undefined {
    return (this as unknown as ScrollTargetSlot).scrollTarget;
  }

  private set scrollTargetPx(value: number | undefined) {
    (this as unknown as ScrollTargetSlot).scrollTarget = value;
  }

  /**
   * **滾輪一律贏動畫。** plugin 的版本是在動畫期間把滾輪整個丟掉；這裡改成先
   * 把動畫收掉（停在終點，不是停在半路，免得左邊的分類對不上），再照常處理
   * 這一格滾動。
   */
  protected override wheel_(e: WheelEvent): void {
    this.finishScroll();
    super.wheel_(e);
  }
}

/**
 * **選取的分類一直留著。**
 *
 * Blockly 的 `Toolbox.onClick_` 對「點到已經選取的那一格」走的是
 * `clearSelection()`——它的分類本來就有「收起來」這個狀態（點一下開、再點一下
 * 關，flyout 收掉）。連續式工具箱沒有那個狀態：flyout 一直開著，捲軸停在哪裡
 * 就一定落在某個分類裡，「沒有分類被選取」在畫面上對應不到任何東西，看起來
 * 只像那塊灰底反饋壞掉。
 *
 * 攔在 `setSelectedItem(null)`（`clearSelection()` 與「點到工具箱空白處」都收
 * 斂到這一個入口，比覆寫 private 的 `onClick_` 穩），改成**捲回那個分類的
 * 開頭**：在一個分類裡面自己捲了一段之後再點它一次，回到段落開頭是預期中的
 * 事，也讓這一下點擊不是完全沒反應。
 */
class BlockyToolbox extends ContinuousToolbox {
  override setSelectedItem(newItem: Blockly.IToolboxItem | null): void {
    if (newItem === null) {
      const selected = this.getSelectedItem();
      if (selected) this.getFlyout().scrollToCategory(selected);
      return;
    }
    super.setSelectedItem(newItem);
  }
}

Blockly.registry.register(
  Blockly.registry.Type.FLYOUTS_VERTICAL_TOOLBOX,
  'BlockyFlyout',
  FixedScaleFlyout,
  true,
);

Blockly.registry.register(Blockly.registry.Type.TOOLBOX, 'BlockyToolbox', BlockyToolbox, true);

export const workspaceOptions: Partial<Blockly.BlocklyOptions> = {
  renderer: 'zelos',
  theme: blockyTheme,
  plugins: {
    toolbox: 'BlockyToolbox',
    flyoutsVerticalToolbox: 'BlockyFlyout',
    metricsManager: 'ContinuousMetrics',
  },
  media: 'media/',
  grid: { spacing: 40, length: 3, colour: '#e2e4ee', snap: false },
  zoom: { controls: true, wheel: true, startScale: DEFAULT_SCALE, minScale: 0.3, maxScale: 2 },
  move: { scrollbars: true, drag: true, wheel: true },
  trashcan: true,
  // 只擋得掉「載入那三個音效檔」（click / delete / disconnect）。**擋不掉
  // `playErrorBeep()`**，見下面的 `muteWorkspace`。
  sounds: false,
};

/**
 * 把一個工作區靜音。**`sounds: false` 不夠。**
 *
 * Blockly 的聲音有兩條路：一條是 `play('click')` 那種讀 `media/` 底下的音效檔，
 * `sounds: false` 關的是這一條；另一條是 `playErrorBeep()`，用 Web Audio 現合一個
 * 260Hz 的音，**不讀任何檔案，只看 `AudioManager` 的 `muted`**——而 `muted` 的預設
 * 是 `false`，`inject` 的選項裡沒有任何一個會動到它。
 *
 * 於是「按下走不動的方向鍵就叫一聲」是預設行為：左鍵已經在工具箱、右鍵已經到最
 * 裡面時，`NAVIGATE_LEFT` / `NAVIGATE_RIGHT` 找不到下一個節點就 `playErrorBeep()`。
 * 刪不掉的東西按 Delete、複製不了的東西按 Ctrl+C 也是同一聲。**實測**：掛住
 * `AudioContext.prototype.createOscillator` 之後，在工具箱上按一下左鍵就 +1。
 */
export function muteWorkspace(workspace: Blockly.WorkspaceSvg): void {
  workspace.getAudioManager().setMuted(true);
}

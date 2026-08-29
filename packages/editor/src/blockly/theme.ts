/**
 * 工作區外觀。
 *
 * 顏色**不放在這裡**：每顆積木的顏色來自它那份 manifest 的 `color`（§8.1），
 * 積木包自己決定要長什麼樣子。這份主題只管積木以外的東西——工作區背景、
 * 工具箱、flyout。
 */
import * as Blockly from 'blockly/core';
import { ContinuousFlyout, registerContinuousToolbox } from '@blockly/continuous-toolbox';
import { procIdFromType } from './procedures';

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

  override getFlyoutScale(): number {
    return DEFAULT_SCALE;
  }

  /**
   * **點分類就到，不做平滑捲動。**
   *
   * plugin 的 `scrollTo` 是一個 rAF 動畫（每幀補剩餘的 30%），而它壞了三件事：
   *
   * 1. **它把按鈕從游標底下移走。** 點分類**馬上**點那顆「創建積木」（最自然
   *    的順序）就是在打一個移動中的目標——實測同一顆按鈕的 `rect.y` 在幾秒內
   *    出現過 824 / 127 / 103 / 95 / 92，而 pointerdown 與 pointerup 落在不同
   *    元素上時那一下不算 click，按下去完全沒有反應。
   * 2. **動畫在跑的時候滾輪是死的**：plugin 寫的是
   *    `wheel_(e) { this.scrollTarget || super.wheel_(e) }`，而 `scrollTarget`
   *    只有在動畫收斂（差 < 1px）時才清掉。實測它卡在 `4507.125` 而 `scrollY`
   *    停在 `-4497`，期間往上滾五格 flyout 一動也不動。
   * 3. **分頁沒有焦點時 rAF 被節流到 ~1fps**，這段動畫會慢到爬（實測 2.5 秒
   *    只走 11px）。
   *
   * 覆寫成一次到位。`scrollTarget` 因此永遠是 `undefined`，(2) 那條短路自然
   * 就不會擋住滾輪。捲到位之後分類的選取由既有的捲動 listener 負責，與使用者
   * 自己滾到那裡是同一條路。
   */
  /**
   * 按鈕撐成**與 flyout 同寬**（Scratch 的「製作積木」就是那樣）。
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

    const scale = this.getFlyoutScale();
    // `getWidth()` 是像素，rect 的座標是 flyout 工作區的單位。
    const full = this.getWidth() / scale - this.MARGIN * 2;
    if (!(full > 0)) return;

    for (const item of this.getContents()) {
      const element = item.getElement();
      if (!(element instanceof Blockly.FlyoutButton) || element.isLabel()) continue;
      const root = element.getSvgRoot();
      for (const rect of root.querySelectorAll('rect')) {
        rect.setAttribute('width', String(full));
      }
      root.querySelector('text')?.setAttribute('x', String(full / 2));
      element.width = full;
    }
  }

  override scrollTo(position: number): void {
    const ws = this.getWorkspace();
    const metrics = ws.getMetrics();
    ws.scrollbar?.setY(
      Math.min(position * ws.scale, metrics.scrollHeight - metrics.viewHeight),
    );
  }
}

Blockly.registry.register(
  Blockly.registry.Type.FLYOUTS_VERTICAL_TOOLBOX,
  'BlockyFlyout',
  FixedScaleFlyout,
  true,
);

export const workspaceOptions: Partial<Blockly.BlocklyOptions> = {
  renderer: 'zelos',
  theme: blockyTheme,
  plugins: {
    toolbox: 'ContinuousToolbox',
    flyoutsVerticalToolbox: 'BlockyFlyout',
    metricsManager: 'ContinuousMetrics',
  },
  media: 'media/',
  grid: { spacing: 40, length: 3, colour: '#e2e4ee', snap: false },
  zoom: { controls: true, wheel: true, startScale: DEFAULT_SCALE, minScale: 0.3, maxScale: 2 },
  move: { scrollbars: true, drag: true, wheel: true },
  trashcan: true,
  sounds: false,
};

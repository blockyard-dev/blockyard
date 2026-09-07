/**
 * 啟動流程（§8.1）：拿 manifest → 註冊 → 產生工具箱。
 *
 * 這條路徑對內建與第三方是同一條（D21），所以這個檔案裡沒有任何一個 opcode
 * 的名字。
 */
import * as Blockly from 'blockly/core';
import * as en from 'blockly/msg/en';
import * as zhHant from 'blockly/msg/zh-hant';
import {
  buildDefinitions,
  defineManifest,
  defineShadowBlocks,
  type RegisteredBlock,
} from './define';
import {
  buildToolbox,
  groupByManifest,
  visibleGroups,
  type ToolboxGroup,
} from './toolbox';
import { isCallType } from './procedures';
import { markRedefined } from './redefined';
import './fields/FieldText';
// 匯入即註冊 §16 Q16 的字面值型別切換選單。
import './literals';
import type { Manifest } from '../types/manifest';
import type { Locale } from '../i18n';

let localeReady: Locale | null = null;

/**
 * Blockly 的三角 warning icon 回報 17×17；改成 8px 紅點後若不一起改這個
 * 尺寸，排版器仍會在左右各留 4.5px，看起來就像紅點自帶一大圈 padding。
 *
 * 紅點自己不再留內間距；它與下一個欄位的間隔由下面的 renderer spacing 單獨決定。
 * 圖案幾何在 `index.css` 用同一個尺寸畫。
 */
export const WARNING_DOT_BOX_SIZE = 8;
Blockly.icons.WarningIcon.prototype.getSize = () =>
  new Blockly.utils.Size(WARNING_DOT_BOX_SIZE, WARNING_DOT_BOX_SIZE);

/**
 * Zelos 預設會在每個 row element 之間加 `MEDIUM_PADDING` (8px)。這才是紅點
 * 右邊那大塊空白的來源，不是 SVG 本身的 padding。只收紅點與後面內容的
 * 這一格；其他 icon、field 與 input 之間的全局間距維持 Blockly 預設。
 */
export const WARNING_DOT_GAP = 4;
const zelosInfo = Blockly.zelos.RenderInfo.prototype;
const defaultZelosInRowSpacing = zelosInfo.getInRowSpacing_;
zelosInfo.getInRowSpacing_ = function (prev, next) {
  const icon = prev && 'icon' in prev
    ? (prev as Blockly.blockRendering.Icon).icon
    : null;
  if (next && icon instanceof Blockly.icons.WarningIcon) return WARNING_DOT_GAP;
  return defaultZelosInRowSpacing.call(this, prev, next);
};

export interface Registration {
  blocks: RegisteredBlock[];
  groups: ToolboxGroup[];
  toolbox: Record<string, unknown>;
}

/**
 * 專案的工具箱 = 靜態宣告 + 這個專案的函式（§4.6、§8.5）。
 *
 * 函式分類裡動態的只有 **`呼叫 X` 一顆**。
 *
 * **參數不上架**（Scratch 也一樣）：它們掛在定義帽子上，拖一下就有一份
 * （§4.6、`params.ts`），而那已經是取得它們的完整路徑。上架等於同一顆積木在
 * 兩個地方各有一份入口，而分類裡那一份還少了「它屬於哪個函式」這個資訊——
 * 畫面上就是一排沒有上下文的 `second` `minute`。
 *
 * 定義帽子也**不上架**：建立函式的入口是那顆按鈕（D25），拖一顆定義出來會產生
 * 一個沒有名字的函式。
 */
export function buildProjectToolbox(
  registration: Registration,
  procedureBlocks: RegisteredBlock[],
  /** 已經設定好的金鑰（`keyId`）——`open_config` 的按鈕設定完就不再上架。 */
  configured?: ReadonlySet<string>,
  /** 已經加進來的積木包（D31）。內建不看這份名單；`undefined` = 全部都上架。 */
  enabled?: ReadonlySet<string>,
): Record<string, unknown> {
  const calls = procedureBlocks.filter((block) => isCallType(block.type));
  const groups = groupByManifest([...registration.blocks, ...calls]);
  return buildToolbox(visibleGroups(groups, enabled), configured);
}

/**
 * 哪幾個命名空間跟上次不一樣（新的、或宣告改過的）。
 *
 * 純函數，所以「重問一次後端要不要重新註冊」這條規則測得到——而它真正在守的
 * 事情是**別去動沒有變的那些**：`defineBlocksWithJsonArray` 會覆蓋 Blockly 的
 * 全域註冊表，把 95 顆積木全部重定義一次不只吵（每一顆都印一行覆蓋警告），
 * 它還讓「畫布上那顆積木的定義被換掉了嗎」這個問題每次都要重新回答。
 *
 * 比的是整份宣告的 JSON 而不是版本號：改一句 `text` 不會有人記得動 `version`，
 * 而那正是開發時最常改的東西。
 */
export function changedManifestIds(
  previous: readonly Manifest[],
  next: readonly Manifest[],
): Set<string> {
  const before = new Map(previous.map((m) => [m.id, JSON.stringify(m)]));
  return new Set(next.filter((m) => before.get(m.id) !== JSON.stringify(m)).map((m) => m.id));
}

/**
 * 註冊一批宣告。
 *
 * `previous` 有給的時候只重新註冊**變過的**那幾個命名空間（見
 * `changedManifestIds`）；沒給就是全部註冊，也就是開場那一次。
 *
 * **消失的積木這裡不處理。** 後端拿掉一顆積木之後，畫布上那一顆仍然活著（它的
 * 定義早就套用過了），要到下次載入才會退化成 §13.3 的佔位符。這是知情的：
 * 在使用者沒有要求的時候把他畫布上的積木換成佔位符，比晚一點才說更糟。
 */
export function registerManifests(
  manifests: Manifest[],
  previous?: readonly Manifest[],
  locale: Locale = 'zh-TW',
): Registration {
  if (localeReady !== locale) {
    Blockly.setLocale((locale === 'en' ? en : zhHant) as unknown as Record<string, string>);
    localeReady = locale;
  }

  defineShadowBlocks();

  const changed = previous ? changedManifestIds(previous, manifests) : null;
  const blocks = manifests.flatMap((manifest) => {
    // 沒變的那些走純函數版本：拿得到一樣的 `blocks`，但不碰全域註冊表。
    if (changed !== null && !changed.has(manifest.id)) return buildDefinitions(manifest).blocks;
    const defined = defineManifest(manifest);
    // **換過定義的 type 要留名**（`redefined.ts`）：flyout 會依 type 回收上一批
    // 積木，而那假設同一個 type 永遠長同一個樣子。`changed === null` 是開場
    // 那一次，不算——那時候沒有任何東西畫出來過。
    if (changed !== null) markRedefined(defined.map((b) => b.type));
    return defined;
  });
  const groups = groupByManifest(blocks, manifests);
  return { blocks, groups, toolbox: buildToolbox(groups) };
}

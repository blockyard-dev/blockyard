/**
 * manifest → 工具箱分類（§8.1 第 3 步）。
 *
 * 一份 manifest 一個分類，順序照 `GET /api/extensions` 吐出來的順序——後端
 * 已經把內建排在積木包前面（`api/extensions.py`），前端不再重排。
 */
import type { RegisteredBlock } from './define';
import type { ButtonSpec } from '../types/manifest';

export interface ToolboxGroup {
  id: string;
  name: string;
  colour: string;
  builtin: boolean;
  blocks: RegisteredBlock[];
  /** 非積木條目（D25）。位置由 `before` / `after` 指名，見 `categoryEntries`。 */
  buttons: ButtonSpec[];
}

/**
 * 一顆按鈕在 Blockly 註冊表裡的 key。
 *
 * 帶命名空間，因為兩個積木包都可以有一顆 id 是 `docs` 的按鈕，而
 * `registerButtonCallback` 是**整個工作區共用一張表**。
 */
export function buttonCallbackKey(manifestId: string, buttonId: string): string {
  return `blocky:${manifestId}:${buttonId}`;
}

const DEFAULT_COLOUR = '#9966FF';

export function groupByManifest(blocks: RegisteredBlock[]): ToolboxGroup[] {
  const groups = new Map<string, ToolboxGroup>();
  for (const block of blocks) {
    const { manifest } = block;
    let group = groups.get(manifest.id);
    if (!group) {
      group = {
        id: manifest.id,
        name: manifest.name,
        colour: manifest.color ?? DEFAULT_COLOUR,
        builtin: manifest.builtin === true,
        blocks: [],
        buttons: manifest.buttons ?? [],
      };
      groups.set(manifest.id, group);
    }
    group.blocks.push(block);
  }
  return [...groups.values()];
}

/**
 * `deprecated: true` 的積木**註冊但不上架**：舊專案載得進來（不然會變成
 * §13.3 的未知積木），但沒有人能再拉出新的一顆。
 */
/**
 * 「讀一個變數」的那顆積木。**目前沒有人呼叫它**（見下）。
 *
 * 它是為了「函式分類要為每個參數各列一顆填好名字的 `取得 (參數名)`」而寫的
 * ——**不寫死 `data.get`**，讀的是 manifest 的 `reads` 宣告，與 `binds` 是同
 * 一條路線（D21：前端不認識任何一個 opcode）。一度想用推導（「reporter + 唯一
 * 參數是非 binds 的 variable」），但那條規則同時命中 `data.list_length`——
 * 宣告一模一樣，差別只在回傳的是值還是長度。所以它是一句宣告，不是一條猜測。
 *
 * **那個使用者沒了**：第五輪回饋把函式分類裡的參數改成與定義帽子上一樣的
 * `procedure.param` 膠囊（§4.6），不再是 `取得 (參數名)`。這個函式與它背後的
 * `reads` 宣告都留著——`reads` 說的仍然是一件真話，而「函式分類的介面之後還
 * 要改」——但它現在沒有消費者，記在 PROGRESS 第 2 節。
 */
export function findVariableReader(blocks: RegisteredBlock[]): { type: string; arg: string } | null {
  for (const block of blocks) {
    for (const [name, arg] of Object.entries(block.spec.args ?? {})) {
      if (arg.reads) return { type: block.type, arg: name };
    }
  }
  return null;
}

export function buildToolbox(groups: ToolboxGroup[]): Record<string, unknown> {
  return {
    kind: 'categoryToolbox',
    contents: groups
      .map((group) => ({
        kind: 'category',
        name: group.name,
        colour: group.colour,
        cssConfig: { container: 'blocky-category' },
        contents: categoryEntries(group),
      }))
      .filter((category) => category.contents.length > 0),
  };
}

/**
 * flyout 的三種垂直間隔，單位是工作區單位（螢幕上還要乘 flyout 的縮放，見
 * `theme.ts` 的 `DEFAULT_SCALE`）。
 *
 * Blockly 的預設對每個條目都是 `Flyout.GAP_Y`（`MARGIN * 3` = 24），對這份工具箱
 * 來說太鬆，而且它讓「同一組運算」與「換一組」看起來一樣遠。這裡把距離變成一句
 * 話：**近的是一段，遠的是換一段**。
 *
 * 版面數字只有這裡有。manifest 的 `section` 說的是語意（§7.2）——哪裡是一段的
 * 開頭；多遠、標題長什麼樣子是編輯器的事，不然每個積木包各自決定留白。
 *
 * `BLOCK_GAP` **不能寫 0**：`BlockFlyoutInflater.gapForItem` 是
 * `!gap ? default : gap`，0 會被當成沒設定而退回 24。`kind: 'sep'` 那兩個沒有這
 * 條（`SeparatorFlyoutInflater` 收得下 0）。
 */
export const BLOCK_GAP = 12;
const SECTION_GAP = 40;
const LABEL_GAP = 8;

/**
 * 一個分類的全部條目：積木與按鈕交錯（§7.2、D25）。
 *
 * 按鈕的位置由 manifest 的 `before` / `after` 指名一顆積木，沒寫的排在最上面
 * （Scratch 放「製作積木」的位置，也是這個欄位出現之前唯一的位置）。
 *
 * **`before: X` 是「緊貼在 X 上面」，在 X 的分段標題之下**：分段是「從這顆起是
 * 新的一段」，而指名 X 的按鈕屬於那一段——排到標題上面等於把它掛在上一段的尾巴。
 *
 * 錨點指到一顆不上架的積木（`deprecated` / `dynamic`）時退回最上面。載入期已經
 * 擋掉這種宣告（`manifest.py`），這裡是防守：畫不出來的宣告不該讓整個分類消失。
 */
function categoryEntries(group: ToolboxGroup): Record<string, unknown>[] {
  const blocks = group.blocks.filter((block) => !block.spec.deprecated);
  const visible = new Set(blocks.map((block) => block.spec.opcode));

  const before = new Map<string, ButtonSpec[]>();
  const after = new Map<string, ButtonSpec[]>();
  const top: ButtonSpec[] = [];
  for (const button of group.buttons) {
    const anchor = button.before ?? button.after;
    if (!anchor || !visible.has(anchor)) {
      top.push(button);
      continue;
    }
    // 同一顆積木上釘兩顆按鈕：依 manifest 的宣告順序。
    const bucket = button.before ? before : after;
    bucket.set(anchor, [...(bucket.get(anchor) ?? []), button]);
  }

  const asEntry = (button: ButtonSpec) => ({
    kind: 'button',
    text: button.label,
    callbackKey: buttonCallbackKey(group.id, button.id),
    // Blockly 把 `web-class` 原封不動放到那個 `<g>` 上（`FlyoutButton` 的
    // `this.cssClass`）。這是**唯一**能對按鈕下樣式的掛勾——它畫的三個 SVG
    // 元素都沒有我們認得的 class。
    'web-class': 'blocky-flyout-button',
  });

  return blockEntries(blocks, {
    top: top.map(asEntry),
    before: (opcode) => (before.get(opcode) ?? []).map(asEntry),
    after: (opcode) => (after.get(opcode) ?? []).map(asEntry),
  });
}

interface ButtonPlacement {
  top: Record<string, unknown>[];
  before(opcode: string): Record<string, unknown>[];
  after(opcode: string): Record<string, unknown>[];
}

/**
 * 把 `section` 宣告展開成 Blockly 的條目（§8.1）。
 *
 * 相鄰的兩個 sep 由 Blockly 的 `normalizeSeparators` 收成一個，而它 `splice` 掉的
 * 是**前面**那個——所以我們插的 sep 蓋掉上一顆積木自帶的 `BLOCK_GAP`，是取代不是
 * 相加。標題底下再補一個 `LABEL_GAP`，同樣蓋掉 label 自帶的預設 24：標題要貼近它
 * 說明的那一段，不然它看起來像上一段的結尾。
 *
 * 分類的第一顆不插 sep——分類標題本身已經是斷點。
 */
function blockEntries(
  blocks: RegisteredBlock[],
  buttons: ButtonPlacement,
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [...buttons.top];
  for (const block of blocks) {
    const { section, opcode } = block.spec;
    if (section && entries.length > 0) entries.push({ kind: 'sep', gap: SECTION_GAP });
    if (typeof section === 'string') {
      entries.push(
        // 這一行標題**不是分類標題**。continuous-toolbox 靠「文字比對得到分類名」
        // 認分類邊界，所以 `theme.ts` 用這個 class 把它排除掉——否則一段叫「運算」
        // 的標題會被當成運算分類的起點，捲動定位跟著錯。
        { kind: 'label', text: section, 'web-class': 'blocky-section-label' },
        { kind: 'sep', gap: LABEL_GAP },
      );
    }
    entries.push(...buttons.before(opcode), toToolboxBlock(block), ...buttons.after(opcode));
  }
  return entries;
}

/**
 * 影子積木只能掛在工具箱條目上（Blockly 的 JSON 積木定義沒有宣告影子的地方），
 * 所以 `define.ts` 算好的 `shadows` 在這裡才貼上去。
 */
function toToolboxBlock(block: RegisteredBlock): Record<string, unknown> {
  const entry: Record<string, unknown> = { kind: 'block', type: block.type, gap: BLOCK_GAP };
  if (Object.keys(block.fields).length > 0) entry.fields = block.fields;
  const inputs = Object.entries(block.shadows);
  if (inputs.length > 0) {
    entry.inputs = Object.fromEntries(
      inputs.map(([name, shadow]) => [
        name,
        { shadow: { type: shadow.type, fields: shadow.fields } },
      ]),
    );
  }
  return entry;
}

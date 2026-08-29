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
  /** 分類最上面的非積木條目（D25）。 */
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
        contents: [
          // 按鈕在分類**最上面**（Scratch 放「製作積木」的位置）。它不是積木：
          // 沒有輸入孔、沒有回傳值、不會出現在畫布上（D25）。
          ...group.buttons.map((button) => ({
            kind: 'button',
            text: button.label,
            callbackKey: buttonCallbackKey(group.id, button.id),
            // Blockly 把 `web-class` 原封不動放到那個 `<g>` 上
            // （`FlyoutButton` 的 `this.cssClass`）。這是**唯一**能對按鈕下
            // 樣式的掛勾——它畫的三個 SVG 元素都沒有我們認得的 class。
            'web-class': 'blocky-flyout-button',
          })),
          ...group.blocks.filter((block) => !block.spec.deprecated).map(toToolboxBlock),
        ],
      }))
      .filter((category) => category.contents.length > 0),
  };
}

/**
 * 影子積木只能掛在工具箱條目上（Blockly 的 JSON 積木定義沒有宣告影子的地方），
 * 所以 `define.ts` 算好的 `shadows` 在這裡才貼上去。
 */
function toToolboxBlock(block: RegisteredBlock): Record<string, unknown> {
  const entry: Record<string, unknown> = { kind: 'block', type: block.type };
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

/**
 * 「創建積木」對話框裡那顆**可編輯的預覽積木**（§8.5、D26）。
 *
 * 它是第三種 spec：`procedure.definition#` 是畫布上的帽子、`procedure.call#`
 * 是呼叫積木，而這一顆只活在 modal 的那個迷你工作區裡。理由與 Scratch 讓
 * `procedures_declaration` 成為獨立 block type 的理由一樣：**呼叫積木上沒有
 * 可編輯的參數名**——那顆積木把名字畫成 label、把值放在孔裡，而這裡要的正好
 * 相反。
 *
 * 但它仍然走 `define.ts::buildBlock`，與畫布上那兩顆**同一條產生路徑**。這是
 * 這個對話框的正確性保證：另寫一份預覽渲染，兩邊遲早會分岔，而使用者是看著
 * 預覽在做決定的。
 *
 * **這顆積木絕不進 IR。** 它不可拖曳、不可刪除，也不經過 `ir/serialize`——
 * 序列化進 `blocks` 就會變成一顆沒有 opcode 的積木。
 */
import * as Blockly from 'blockly/core';
import { SHADOW_FIELD, buildBlock, type BlockType } from './define';
import { FIELD_TEXT_TYPE } from './fields/FieldText';
import { callShape, PROCEDURE_COLOUR } from './procedures';
import { isParam, type Draft, type Segment } from '../procedures/draft';
import type { ArgSpec, BlockSpec, Manifest } from '../types/manifest';
import { t } from '../i18n';

/** 一段 = 一個欄位或一個孔。名字用**段的位置**，不是參數 id：標籤沒有 id。 */
export const SEGMENT_PREFIX = 's';

export const DECLARATION_TYPE = 'procedure.declaration#draft';

/** 參數名稱格：白色膠囊（一般孔）與白色六角（布林孔）。 */
const DECL_SHADOW_TEXT = 'blockyard.declaration.name';
const DECL_SHADOW_BOOLEAN = 'blockyard.declaration.name.boolean';
const SHADOW_COLOUR = '#FFFFFF';

/**
 * 參數名稱用 `mode: 'variable'`。
 *
 * 它不只是外觀：函式體讀參數用的是既有的 `取得 (名稱)`（§4.6），所以參數名
 * **就是**一個變數名，得套 §4.5 那組字元限制（`.` `[` `]` `{` `}` `$` 與首尾
 * 空白）。`FieldText` 的 variable 模式本來就在 `doClassValidation_` 做這件事
 * ——這裡只是把那條規則接上，而不是在對話框裡再寫一份。
 */
const NAME_FIELD = {
  type: FIELD_TEXT_TYPE,
  name: SHADOW_FIELD,
  text: '',
  mode: 'variable',
  // 這個工作區裡只有一顆預覽積木，「重新命名所有引用」永遠只會改到眼前這一格。
  standalone: true,
};

let shadowsDefined = false;

export function defineDeclarationShadows(): void {
  if (shadowsDefined) return;
  shadowsDefined = true;
  Blockly.common.defineBlocksWithJsonArray([
    { type: DECL_SHADOW_TEXT, message0: '%1', args0: [NAME_FIELD], output: null, colour: SHADOW_COLOUR },
    {
      // 布林參數在呼叫積木上是六角形孔，所以名稱格也是六角形——預覽不該在
      // 「這個參數長什麼樣」這件事上說謊。
      type: DECL_SHADOW_BOOLEAN,
      message0: '%1',
      args0: [NAME_FIELD],
      output: 'Boolean',
      colour: SHADOW_COLOUR,
    },
  ] as never);
}

export interface BuiltDeclaration {
  type: BlockType;
  /** 直接餵給 `Blockly.serialization.blocks.append`。 */
  state: Blockly.serialization.blocks.State;
}

/**
 * 一份 draft → 一顆預覽積木。
 *
 * **每次結構變動都重新註冊型別再重建積木**（加一格、刪一格、換型別）。打字
 * 不走這條路：那會把正在編輯的欄位關掉，所以文字的真相在積木上，只有結構要
 * 變之前才回讀一次（見 `readSegmentTexts`）。
 */
export function buildDeclaration(draft: Draft): BuiltDeclaration {
  const manifest: Manifest = {
    id: 'procedure',
    name: t('blockly.functionCategory'),
    version: '1.0.0',
    color: PROCEDURE_COLOUR,
  };

  const args: Record<string, ArgSpec> = {};
  draft.segments.forEach((segment, i) => {
    args[fieldName(i)] = argFor(segment);
  });

  const spec: BlockSpec = {
    opcode: 'declaration#draft',
    // 形狀跟著「有沒有回傳值」走，與呼叫積木用**同一個**函數算出來——預覽的
    // 形狀就是使用者之後會在畫布上拿到的形狀。
    type: callShape(draft.returns),
    text: draft.segments.map((_, i) => `%(${fieldName(i)})`).join(' '),
    args,
  };

  const built = buildBlock(manifest, spec);
  markLabelFields(built.definition, draft);
  // 每次結構變動都是同一個 type 換一份定義。先刪掉舊的再註冊：Blockly 允許
  // 覆寫，但會 `console.warn` 一次——而這裡的覆寫是**設計**，不是誰不小心
  // 註冊了兩次，那句警告只會讓真正的重複註冊更難被看見。
  delete Blockly.Blocks[built.definition.type as string];
  Blockly.common.defineBlocksWithJsonArray([built.definition] as never);

  const inputs: Record<string, unknown> = {};
  const fields: Record<string, string> = {};
  draft.segments.forEach((segment, i) => {
    if (segment.kind === 'label') {
      fields[fieldName(i)] = segment.text;
      return;
    }
    inputs[fieldName(i)] = {
      shadow: {
        type: segment.type === 'boolean' ? DECL_SHADOW_BOOLEAN : DECL_SHADOW_TEXT,
        fields: { [SHADOW_FIELD]: segment.name },
      },
    };
  });

  return {
    type: built.definition.type as string,
    state: { type: DECLARATION_TYPE, fields, inputs } as Blockly.serialization.blocks.State,
  };
}

/**
 * 標籤是**欄位**、參數是**孔**（孔裡是一顆白色的名稱格）。
 *
 * 這一對就是 Scratch 的作法：標籤直接畫在積木的顏色上，參數是一顆白色的東西
 * ——而白色在這套視覺文法裡一直都是「這一格的內容是資料」（字面值影子也是
 * 白的）。
 *
 * 標籤關掉插值：說明文字裡的 `${}` 不是插值，畫成 pill 只會誤導。
 */
function argFor(segment: Segment): ArgSpec {
  if (segment.kind === 'label') {
    return { type: 'string', field: true, interpolate: false, default: segment.text };
  }
  return segment.type === 'boolean' ? { type: 'boolean' } : { type: 'string' };
}

/**
 * 說明文字那幾格畫成「積木底色上的一格**深色矩形**（白字）」而不是白色膠囊
 * （`FieldText` 的 `bare`）。
 *
 * 為什麼在這裡改而不是宣告在 `ArgSpec` 上：`bare` 不是 manifest 的概念——沒有
 * 一顆積木包的積木需要它，它是這個對話框的視覺。把它加進 manifest schema 等於
 * 為了一個預覽多開一個公開欄位。
 *
 * 差別要看得出來，因為它就是「這一格會變成什麼」：白色膠囊會變成呼叫積木上的
 * 一個孔，深色矩形不會。
 */
function markLabelFields(definition: Record<string, unknown>, draft: Draft): void {
  const labels = new Set(
    draft.segments.flatMap((segment, i) => (segment.kind === 'label' ? [fieldName(i)] : [])),
  );
  for (let row = 0; definition[`args${row}`] !== undefined; row++) {
    for (const arg of definition[`args${row}`] as Record<string, unknown>[]) {
      if (arg.type === FIELD_TEXT_TYPE && labels.has(String(arg.name))) arg.bare = true;
    }
  }
}

export function fieldName(index: number): string {
  return `${SEGMENT_PREFIX}${index}`;
}

/**
 * 把積木上現在打的字讀回來（段的位置 → 文字）。
 *
 * 對話框的文字真相在積木上，這是回讀的那一半。標籤讀積木自己的欄位，參數讀
 * 孔裡那顆名稱格的欄位。
 */
export function readSegmentTexts(block: Blockly.Block, draft: Draft): Record<number, string> {
  const texts: Record<number, string> = {};
  draft.segments.forEach((segment, i) => {
    const name = fieldName(i);
    if (segment.kind === 'label') {
      const value = block.getFieldValue(name);
      if (typeof value === 'string') texts[i] = value;
      return;
    }
    const shadow = block.getInput(name)?.connection?.targetBlock();
    const value = shadow?.getFieldValue(SHADOW_FIELD);
    if (typeof value === 'string') texts[i] = value;
  });
  return texts;
}

/**
 * 被點到的是第幾段。
 *
 * 右鍵選單（刪掉這一格、換型別）要知道使用者指的是哪一格，而
 * `ContextMenuRegistry` 的 scope 只給得出積木——與 `literals.ts` / `FieldText`
 * 同一招：從原始事件的 target 反查。
 */
export function segmentIndexAt(block: Blockly.BlockSvg, target: EventTarget | null): number | null {
  if (!(target instanceof Element)) return null;

  for (const input of block.inputList) {
    const child = input.connection?.targetBlock() as Blockly.BlockSvg | null;
    if (child?.getSvgRoot().contains(target)) return indexOfName(input.name);
    for (const field of input.fieldRow) {
      const root = field.getSvgRoot();
      if (root && root.contains(target)) return indexOfName(field.name ?? '');
    }
  }
  return null;
}

function indexOfName(name: string): number | null {
  if (!name.startsWith(SEGMENT_PREFIX)) return null;
  const index = Number(name.slice(SEGMENT_PREFIX.length));
  return Number.isInteger(index) ? index : null;
}

/** draft 裡第 `index` 段是不是參數（右鍵選單要據此決定列哪幾項）。 */
export function segmentAt(draft: Draft, index: number | null): Segment | null {
  if (index === null) return null;
  return draft.segments[index] ?? null;
}

/**
 * 第 `index` 段畫在畫面上的位置（viewport 座標），給浮動工具列定位用。
 *
 * 標籤是積木自己的欄位，參數是孔裡那顆白色名稱格——與 `readSegmentTexts`
 * 同一對規則。**它是量出來的**（`getBoundingClientRect`），所以 jsdom 測不到：
 * 與半形單字置中、flyout 版面同一類，只有瀏覽器實測守得住。
 */
export function segmentRect(
  block: Blockly.BlockSvg,
  draft: Draft,
  index: number,
): DOMRect | null {
  const segment = draft.segments[index];
  if (!segment) return null;
  const name = fieldName(index);
  if (segment.kind === 'label') {
    const root = block.getField(name)?.getSvgRoot();
    return root ? root.getBoundingClientRect() : null;
  }
  const shadow = block.getInput(name)?.connection?.targetBlock() as Blockly.BlockSvg | null;
  return shadow ? shadow.getSvgRoot().getBoundingClientRect() : null;
}

export { isParam };

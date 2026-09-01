/**
 * manifest → Blockly block definition（§8.1 第 2～3 步）。
 *
 * 這個檔案是「新增積木不需要改前端一行程式碼」那句話的實作。它只認識
 * manifest 的欄位，不認識任何一個 opcode——`control.if` 與第三方的
 * `discord.send_message` 走的是同一段程式碼（D21）。
 *
 * 後端刻意不折成「前端好用的形狀」（見 `api/extensions.py`），所以 `%(name)`
 * → `%1` 的轉換在這裡。
 */
import * as Blockly from 'blockly/core';
import type {
  ArgSpec,
  BlockSpec,
  ButtonSpec,
  Manifest,
  Palette,
  SectionSpec,
} from '../types/manifest';

export type PaletteEntry = Palette[number];
import { FIELD_TEXT_TYPE, type FieldTextOptions } from './fields/FieldText';
import { FIELD_DYNAMIC_DROPDOWN_TYPE } from './fields/FieldDynamicDropdown';

/** Blockly 的積木型別名稱 = IR 的 opcode，一字不差。 */
export type BlockType = string;

/**
 * 事件積木的帽子。
 *
 * **不能寫成 `definition.style = { hat: 'cap' }`**，雖然那是官方文件的寫法。
 * Blockly 的 `jsonInit` 讀完會把定義物件上的 `style` 設成 `null`：
 *
 * ```js
 * a.style && typeof a.style === 'object' && ((this.hat = a.style.hat), (a.style = null));
 * ```
 *
 * 而那份定義物件是**所有同型別積木共用的同一個物件**。於是只有第一顆拿得到
 * 帽子，第二顆之後 `a.style` 已經是 null——工具箱先生一顆，畫布上那顆就沒有
 * 帽子了。症狀是「帽子偶爾會有」，而它取決於誰先被建立，非常難查。
 *
 * extension 沒有這個問題：它在**每一顆**積木的 init 時跑。
 */
const HAT_EXTENSION = 'blocky_start_hat';

function registerHatExtension(): void {
  if (Blockly.Extensions.isRegistered(HAT_EXTENSION)) return;
  Blockly.Extensions.register(HAT_EXTENSION, function (this: Blockly.Block) {
    this.hat = 'cap';
  });
}

/**
 * C 型積木的堆疊在 `text` 裡的位置記號。
 *
 * `stack` 參數不出現在 `%(name)` 裡（Blockly 把堆疊畫在文字**下方**而不是
 * 文字裡），但兩個堆疊的積木需要知道文字怎麼分段：`if_else` 的「否則」要落在
 * 第一個堆疊後面。`⋯` 就是那個分界。
 */
const STACK_MARK = '⋯';

/** `text` 裡的參數參照。 */
const ARG_REF = /%\((\w+)\)/g;

/**
 * 字面值的影子積木（shadow）型別（§16 Q16）。
 *
 * 四種，一種一個 JSON 型別。`text` 與 `number` 從第 3 步就有；`boolean` 與
 * `null` 是 Q16 的答案——`data.set`、`operator.eq` 這類宣告成通用 `type: string`
 * 的孔，編輯器原本只給得出字串，打 `99` 拿到 `"99"`，而布林與 `null` 根本沒有
 * 入口。**解法不是改宣告**（manifest 的 `type: string` 說的是「這個孔用文字框
 * 編輯」，不是「這裡只能是字串」），而是讓影子的型別跟著**值**走，再給一個
 * 右鍵切換（見 `fields/FieldText.ts` 的 `LITERAL_ITEMS`）。
 */
export const SHADOW_TEXT = 'blocky.shadow.text';
export const SHADOW_NUMBER = 'blocky.shadow.number';
export const SHADOW_BOOLEAN = 'blocky.shadow.boolean';
export const SHADOW_NULL = 'blocky.shadow.null';
/** 動態下拉的影子（D22）。永遠帶 `#${blockType}.${name}` 後綴，見 `shadowFor`。 */
export const SHADOW_DROPDOWN = 'blocky.shadow.dropdown';

/** 一顆字面值影子代表的 JSON 型別。 */
export type ShadowKind = 'text' | 'number' | 'boolean' | 'null';

/**
 * 影子的 Blockly type → 它代表的型別。認不得就回 `null`（不是字面值影子）。
 *
 * 用 `startsWith` 是因為宣告了修飾欄位的參數會拿到專屬影子
 * （`blocky.shadow.number#control.repeat.times`，見 `shadowFor`）——那仍然是
 * 一顆數字影子。
 */
export function shadowKindOf(type: string): ShadowKind | null {
  if (type.startsWith(SHADOW_TEXT)) return 'text';
  if (type.startsWith(SHADOW_NUMBER)) return 'number';
  // 下拉存出去的就是一個字串——widget 只是「這一格怎麼編輯」，不是它的型別。
  // 漏掉這一行的後果是**存檔重新整理之後下拉變成文字框**：`buildShadowState`
  // 拿 `kindOfValue(值)`（'text'）跟這裡回的 null 比，對不上就退回通用文字
  // 影子。值會留著，所以只驗「值還在」是驗不出來的。
  if (type.startsWith(SHADOW_DROPDOWN)) return 'text';
  if (type === SHADOW_BOOLEAN) return 'boolean';
  if (type === SHADOW_NULL) return 'null';
  return null;
}

/**
 * 這一格的型別**可不可以被使用者改掉**（§16 Q16 的右鍵切換）。
 *
 * 跟 `shadowKindOf` 是兩個不同的問題，所以是兩個函式：前者問「它存出去是哪種
 * JSON 型別」，這個問「換一種型別是不是一件合法的事」。下拉兩邊的答案相反——
 * 它存出去是字串，但它的選項是**封閉的一組**（D22），把它換成一個自由的數字
 * 框等於做出一顆再也選不回合法值的積木。那正是 D27「文字影子撞數字比較」那類
 * 坑的形狀。
 */
export function isSwitchableShadow(type: string): boolean {
  return shadowKindOf(type) !== null && !type.startsWith(SHADOW_DROPDOWN);
}

/** 一個 IR 字面值 → 它該用哪一種影子。**值說了算**，不是宣告。 */
export function kindOfValue(value: unknown): ShadowKind {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value === null) return 'null';
  return 'text';
}

/** 布林影子那個下拉的兩個選項。Blockly 的欄位值一律是字串。 */
export const BOOLEAN_TRUE = 'TRUE';
export const BOOLEAN_FALSE = 'FALSE';
/** 影子積木上那個欄位的名字。第 4 步的 IR 轉換靠它取字面值。 */
export const SHADOW_FIELD = 'VALUE';
/** 字面值格子的底色。Scratch 的字面值是白的，讓外面那顆積木的顏色去說話。 */
const SHADOW_COLOUR = '#FFFFFF';

/** 共用文字影子帶的欄位設定：沒有宣告任何修飾欄位的 `string` 參數就長這樣。 */
const DEFAULT_TEXT_OPTIONS: FieldTextOptions = {
  mode: 'text',
  interpolate: true,
  multiline: false,
};

/** 一顆積木在工具箱與 IR 轉換時都要用到的衍生資訊。 */
export interface RegisteredBlock {
  type: BlockType;
  spec: BlockSpec;
  manifest: Manifest;
  /** 需要影子積木的輸入孔：孔名 → 影子的定義。 */
  shadows: Record<string, ShadowSpec>;
  /** 從工具箱拉出來時要預設好的欄位值（目前只有下拉，見 `fieldDefaults`）。 */
  fields: Record<string, string>;
}

export interface ShadowSpec {
  type: BlockType;
  fields: Record<string, string | number>;
}

/**
 * `type: variable` / `type: expression` 的值存在 IR 的 `fields` 而不是
 * `inputs`——直譯器讀它們用的是 `t.field(b, "name")` 與 `t.expression(b, "expr")`
 * （見 `interpreter/builtins/control.py`、`operator.py`）。
 *
 * manifest 沒有在這些參數上寫 `field: true`，因為型別本身已經蘊含了：變數綁的
 * 是名字不是值，運算式是那顆積木自己的內容——一個能被別的積木蓋掉的運算式，
 * 等於同一個值有兩個來源（D22、§4.7b）。這裡把那條蘊含寫出來，免得它變成只有
 * 讀過直譯器原始碼的人才知道的事。
 */
function isField(arg: ArgSpec): boolean {
  return arg.field === true || arg.type === 'variable' || arg.type === 'expression';
}

/**
 * `palette` 的三種條目怎麼分（§7.2）。
 *
 * manifest 的 `palette` 是**一份清單、三種條目**：一顆積木、一顆按鈕、一個分段。
 * 寫的人只寫一次，而讀的人各拿各的 view——後端那一側是 `Manifest.blocks`
 * （pydantic 的 property），前端這一側就是這三個函式。
 *
 * 用「有沒有那個 key」認種類，與後端同一條規則（`manifest.py::_entry_shape`）。
 */
export function isBlockEntry(entry: PaletteEntry): entry is BlockSpec {
  return 'opcode' in entry;
}

export function isButtonEntry(entry: PaletteEntry): entry is ButtonSpec {
  return 'button' in entry;
}

export function isSectionEntry(entry: PaletteEntry): entry is SectionSpec {
  return 'section' in entry;
}

/** 純積木的 view。註冊、IR 轉換與型別檢查看到的是這一份。 */
export function blocksOf(manifest: Manifest): BlockSpec[] {
  return (manifest.palette ?? []).filter(isBlockEntry);
}

/**
 * 把一份 manifest 轉成 Blockly 的定義並註冊。
 *
 * `dynamic: true` 的積木（`procedure.definition` / `procedure.call`）**不在
 * 這裡註冊**：它們的參數來自 `project.procedures` 而不是 manifest，形狀也隨
 * 函式有沒有宣告回傳型別而變（D22）。那是第 7 步的 mutator 的事。
 */
export function defineManifest(manifest: Manifest): RegisteredBlock[] {
  registerHatExtension();
  const { definitions, blocks } = buildDefinitions(manifest);
  Blockly.common.defineBlocksWithJsonArray(definitions as never);
  return blocks;
}

/**
 * 純函數版本：算出定義但不註冊。
 *
 * 分出來是為了讓測試吃得到——`defineBlocksWithJsonArray` 會寫進 Blockly 的全域
 * 註冊表，一個測試檔裡跑兩次就會互相汙染。轉換邏輯本身沒有一行需要 Blockly。
 */
export function buildDefinitions(manifest: Manifest): {
  definitions: Record<string, unknown>[];
  blocks: RegisteredBlock[];
} {
  const blocks: RegisteredBlock[] = [];
  const definitions: Record<string, unknown>[] = [];

  for (const spec of blocksOf(manifest)) {
    if (spec.dynamic) continue;
    const built = buildBlock(manifest, spec);
    definitions.push(built.definition, ...built.shadowDefinitions);
    blocks.push(built.registered);
  }

  return { definitions, blocks };
}

/**
 * 字面值的影子積木。
 *
 * 大多數的孔共用這兩顆；**宣告了修飾欄位的參數例外**——`multiline` / `rows` /
 * `interpolate` / `min` / `max` 是掛在欄位上的設定，一顆共用的影子帶不動它們
 * （見 `shadowFor`）。
 */
export function defineShadowBlocks(): void {
  Blockly.common.defineBlocksWithJsonArray([
    {
      type: SHADOW_TEXT,
      message0: '%1',
      args0: [
        {
          type: FIELD_TEXT_TYPE,
          name: SHADOW_FIELD,
          text: '',
          // 寫明而不是靠 FieldText 的預設值：`isDefaultTextOptions` 用「與這裡
          // 相同」來判斷一個參數要不要專屬影子，兩邊的預設值一旦分岔，判斷就
          // 會挑錯影子。
          ...DEFAULT_TEXT_OPTIONS,
        },
      ],
      output: null,
      // 影子積木沒有自己的顏色——Scratch 的字面值格子跟著外面那顆積木走。
      colour: SHADOW_COLOUR,
    },
    {
      type: SHADOW_NUMBER,
      message0: '%1',
      args0: [{ type: 'field_number', name: SHADOW_FIELD, value: 0 }],
      output: null,
      colour: SHADOW_COLOUR,
    },
    {
      // 下拉而不是 checkbox：白色影子裡的一個勾勾看不出「沒勾 = false」還是
      // 「這格是別的東西」，而兩個字直接說出目前的值。順帶它自己就是切換
      // 介面，不必為了改 true/false 去開右鍵選單。
      type: SHADOW_BOOLEAN,
      message0: '%1',
      args0: [
        {
          type: 'field_dropdown',
          name: SHADOW_FIELD,
          options: [
            ['真', BOOLEAN_TRUE],
            ['假', BOOLEAN_FALSE],
          ],
        },
      ],
      output: null,
      colour: SHADOW_COLOUR,
    },
    {
      // `null` 沒有東西可以編輯，所以它是一個標籤而不是欄位。要換回別的型別
      // 走右鍵——這也是為什麼那個選單不能只掛在 `FieldText` 上。
      type: SHADOW_NULL,
      message0: '%1',
      args0: [{ type: 'field_label', text: '空值' }],
      output: null,
      colour: SHADOW_COLOUR,
    },
  ] as never);
}

export interface BuiltBlock {
  definition: Record<string, unknown>;
  /** 這顆積木專屬的影子積木（參數宣告了修飾欄位時才有）。 */
  shadowDefinitions: Record<string, unknown>[];
  registered: RegisteredBlock;
}

export function buildBlock(manifest: Manifest, spec: BlockSpec): BuiltBlock {
  const type = `${manifest.id}.${spec.opcode}`;
  const args = spec.args ?? {};
  const shadows: Record<string, ShadowSpec> = {};
  const shadowDefinitions: Record<string, unknown>[] = [];

  const definition: Record<string, unknown> = {
    type,
    colour: manifest.color ?? '#9966FF',
    tooltip: tooltipOf(manifest, spec),
    // inline 是 Scratch 的樣子：輸入孔長在文字那一行上，不是各自一列。
    inputsInline: true,
  };

  // 文字依 `⋯` 分段，段與段之間插一個堆疊；沒有 `⋯` 就是「文字在上、堆疊在下」。
  const chunks = spec.text.split(STACK_MARK);
  const stackNames = Object.keys(args).filter((name) => args[name]?.type === 'stack');
  const consumed = new Set<string>();

  let messageIndex = 0;
  const rowCount = Math.max(chunks.length, stackNames.length);

  for (let row = 0; row < rowCount; row++) {
    const chunk = chunks[row];
    if (chunk !== undefined) {
      // 只有第一段可以是空的（`try_catch` 的「嘗試 ⋯」之後接的是堆疊）；
      // 空字串的 message 會讓 Blockly 產出一列什麼都沒有的東西。
      const isLast = row === rowCount - 1;
      const built = buildMessage(type, chunk, args, consumed, isLast);
      if (built) {
        definition[`message${messageIndex}`] = built.message;
        definition[`args${messageIndex}`] = built.args;
        collectShadows(
          type,
          built.inputs,
          args,
          shadows,
          shadowDefinitions,
          definition.colour as string,
        );
        messageIndex++;
      }
    }

    const stackName = stackNames[row];
    if (stackName !== undefined) {
      definition[`message${messageIndex}`] = '%1';
      definition[`args${messageIndex}`] = [{ type: 'input_statement', name: stackName }];
      messageIndex++;
    }
  }

  if (messageIndex === 0) {
    // 純文字、沒有參數也沒有堆疊的積木（`forever` 之類）仍然要有 message0。
    definition.message0 = escapePercent(spec.text);
    definition.args0 = [];
  }

  applyShape(definition, spec);
  return {
    definition,
    shadowDefinitions,
    registered: { type, spec, manifest, shadows, fields: fieldDefaults(args) },
  };
}

/**
 * `field` 型參數的初始值，貼在工具箱條目上。
 *
 * 只有下拉需要：`FieldText` / `FieldNumber` / `FieldCheckbox` 的預設值寫得進
 * 積木定義（`text:` / `value:` / `checked:`），但 `FieldDropdown` 的 JSON 只
 * 收 `options`，不收「選哪一個」——不補這一手，`debug.log` 的 level 會停在
 * 選項列的第一個（除錯）而不是宣告的 `info`。
 */
function fieldDefaults(args: Record<string, ArgSpec>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, arg] of Object.entries(args)) {
    if (arg.type === 'dropdown' && isField(arg) && arg.default != null) {
      out[name] = String(arg.default);
    }
  }
  return out;
}

/**
 * 積木的四種形狀（§4.2）。
 *
 * `terminal` 不是第五種形狀，是 command 的一個修飾（§4.6）：cap block 在連接
 * 語意上仍然是 command——它插得進堆疊、是 `next` 的合法目標、放得進 C 型積木
 * ——只是自己沒有 `next`。
 *
 * `reporter` 一律 `output: null` 而不是照 `returns` 給 check——§8.5 說得很
 * 明白：型別提示用警告，不用形狀。`null` 在 Blockly 裡是「與任何孔相容」，
 * 所以 reporter 插得進 boolean 孔，與 §4.2 的載入期規則（`kind: block` 的
 * 目標只要是 reporter 或 boolean 即可）完全一致。
 *
 * 反過來 `boolean` 積木給 `output: 'Boolean'`，是為了讓 `if` 的孔畫成六角形：
 * 孔的 check 是 `['Boolean']`，而形狀由 check 決定。六角形的**視覺文法**留住
 * 了，連接的**限制**沒有跟著來——那正是 §8.5 想要的組合。
 */
function applyShape(definition: Record<string, unknown>, spec: BlockSpec): void {
  switch (spec.type) {
    case 'command':
      definition.previousStatement = null;
      // cap block（§4.6 的 `回傳`）：接得上、下面接不了。少了這一行，形狀在
      // 說謊——使用者接得上一顆下一步，按存檔才被後端打回來。
      if (!spec.terminal) definition.nextStatement = null;
      break;
    case 'reporter':
      definition.output = null;
      break;
    case 'boolean':
      definition.output = 'Boolean';
      break;
    case 'hat':
      // hat 只有下方接點，且畫成帽子（見 `registerHatExtension` 為什麼不用
      // 官方文件那個 `style: { hat: 'cap' }`）。
      definition.nextStatement = null;
      definition.extensions = [HAT_EXTENSION];
      break;
  }
}

interface BuiltMessage {
  message: string;
  args: Record<string, unknown>[];
  inputs: string[];
}

/**
 * 把一段 `text` 轉成 `messageN` / `argsN`。
 *
 * 最後一段負責收尾：沒有在 `text` 裡被 `%(name)` 參照到的參數（`debug.log`
 * 的 `level` 就是）接在後面。積木作者少寫一個 `%()` 不該讓那個參數在畫面上
 * 消失——消失的欄位使用者永遠設不到，而它照樣會被送進直譯器。
 */
function buildMessage(
  blockType: string,
  chunk: string,
  args: Record<string, ArgSpec>,
  consumed: Set<string>,
  appendLeftovers: boolean,
): BuiltMessage | null {
  const parts: Record<string, unknown>[] = [];
  const inputs: string[] = [];

  const message = escapePercent(chunk).replace(ARG_REF, (whole, name: string) => {
    const arg = args[name];
    if (!arg) {
      // manifest 參照了不存在的參數。後端的 §8.1 一致性測試守的是參數名對不
      // 上，這裡守的是 `text` 對不上——原樣印出來比默默吞掉好查。
      console.warn(`[blocky] ${blockType} 的 text 參照了未宣告的參數 ${name}`);
      return whole;
    }
    consumed.add(name);
    parts.push(toBlocklyArg(name, arg));
    if (!isField(arg)) inputs.push(name);
    return `%${parts.length}`;
  });

  // **在 replace 之後**才算誰沒被參照到：`consumed` 是在上面那段 replace 裡
  // 才填起來的，先算會把 `%(condition)` 這種明明有參照的參數也算成漏網之魚，
  // 於是同一個參數被畫兩次。
  if (appendLeftovers) {
    for (const name of unreferencedArgs(args, consumed)) {
      const arg = args[name];
      if (!arg) continue;
      consumed.add(name);
      parts.push(toBlocklyArg(name, arg));
      if (!isField(arg)) inputs.push(name);
    }
  }

  const text = message.trim();
  if (!text && parts.length === 0) return null;

  return { message: appendPlaceholders(text, parts), args: parts, inputs };
}

/** 宣告了、但整份 `text` 都沒有 `%(name)` 參照到的非堆疊參數。 */
function unreferencedArgs(args: Record<string, ArgSpec>, consumed: Set<string>): string[] {
  return Object.keys(args).filter(
    (name) => args[name]?.type !== 'stack' && !consumed.has(name),
  );
}

/**
 * `text` 走完 `ARG_REF` 之後已經含有 `%1…%n`；extras 是在那之後才推進 `parts`
 * 的，號碼還沒有人給，補在最後面。
 */
function appendPlaceholders(text: string, parts: unknown[]): string {
  const used = (text.match(/%\d+/g) ?? []).length;
  if (used >= parts.length) return text;
  const tail = Array.from({ length: parts.length - used }, (_, i) => `%${used + i + 1}`);
  return text ? `${text} ${tail.join(' ')}` : tail.join(' ');
}

/**
 * Blockly 的 message 字串裡 `%` 有意義，manifest 的文字裡沒有。先把裸的 `%`
 * 跳脫掉，`%(name)` 才不會在有裸 `%` 的積木上錯位。
 */
function escapePercent(text: string): string {
  return text.replace(/%(?!\(|\d)/g, '%%');
}

/**
 * 一個參數 → 一個 Blockly 欄位或輸入孔。
 *
 * 分岔點只有一個：`field` 的值存在 IR 的 `fields`（屬於積木自己），其餘存在
 * `inputs`（是孔，可以插別的積木）。這條線與 §4.2 的 IR 結構是同一條。
 */
function toBlocklyArg(name: string, arg: ArgSpec): Record<string, unknown> {
  if (!isField(arg)) {
    return {
      type: 'input_value',
      name,
      // 只有 boolean 孔帶 check，而且只為了畫成六角形——見 applyShape 的註解。
      ...(arg.type === 'boolean' ? { check: 'Boolean' } : {}),
      ...(arg.help ? { tooltip: arg.help } : {}),
    };
  }

  switch (arg.type) {
    case 'dropdown':
      return {
        type: 'field_dropdown',
        name,
        // `field: true` 的下拉一定有靜態 `options`（D22：動態的 `source` 是
        // 積木包的路，而積木包不能用 `field`）。
        options: (arg.options ?? []).map((o) => [o.label ?? o.value, o.value]),
      };
    case 'boolean':
      return { type: 'field_checkbox', name, checked: arg.default === true };
    case 'number':
      return {
        type: 'field_number',
        name,
        value: typeof arg.default === 'number' ? arg.default : 0,
        ...(typeof arg.min === 'number' ? { min: arg.min } : {}),
        ...(typeof arg.max === 'number' ? { max: arg.max } : {}),
      };
    default:
      return { type: FIELD_TEXT_TYPE, name, text: String(arg.default ?? ''), ...fieldTextOptions(arg) };
  }
}

/** manifest 的修飾欄位 → `FieldText` 的能力開關（§7.2、§8.5）。 */
function fieldTextOptions(arg: ArgSpec): FieldTextOptions {
  return {
    mode: TEXT_MODES[arg.type] ?? 'text',
    // §4.7 的預設：`string` 開、`code` 關；manifest 的 `interpolate` 覆寫它。
    // 運算式一律開：裡面的 `${a.b[1]}` 走的就是 §4.7 那個 parser（§4.7b），
    // 所以第 6 步的 pill 渲染對它同樣適用。
    interpolate: arg.interpolate ?? arg.type !== 'code',
    multiline: arg.multiline ?? false,
    ...(typeof arg.rows === 'number' ? { rows: arg.rows } : {}),
  };
}

/** 型別本身決定的 `FieldText` 模式。其餘型別都是一格普通文字。 */
const TEXT_MODES: Partial<Record<ArgSpec['type'], FieldTextOptions['mode']>> = {
  variable: 'variable',
  expression: 'expression',
};

/**
 * 輸入孔的影子積木。
 *
 * Blockly 的 JSON 積木定義放不了影子，只有工具箱條目可以——所以這裡先算好，
 * 由 `toolbox.ts` 貼進工具箱。boolean 孔**沒有影子**：Scratch 的六角形孔本來
 * 就是空的，塞一顆預設的 `false` 進去會讓「還沒填」與「填了 false」看起來
 * 一模一樣。
 *
 * 使用者真正打字的地方是**影子上的欄位**，不是外面那顆積木——所以 §7.2 的修飾
 * 欄位（`multiline` `rows` `interpolate` `min` `max`）必須跟著送到影子上。共用
 * 的 `SHADOW_TEXT` / `SHADOW_NUMBER` 帶不動它們，於是宣告了修飾欄位的參數會
 * 拿到一顆專屬的影子。
 *
 * 這不是可有可無的細節：`interpolate` 錯掉會讓 §4.7 的「`${HOME}` 是 shell 的
 * 東西不是插值」失守，而那正是 D9 把插值鎖在路徑上想避免的事。
 */
function collectShadows(
  blockType: string,
  inputs: string[],
  args: Record<string, ArgSpec>,
  out: Record<string, ShadowSpec>,
  definitions: Record<string, unknown>[],
  blockColour: string,
): void {
  for (const name of inputs) {
    const arg = args[name];
    if (!arg || arg.type === 'boolean') continue;
    out[name] = shadowFor(blockType, name, arg, definitions, blockColour);
  }
}

function shadowFor(
  blockType: string,
  name: string,
  arg: ArgSpec,
  definitions: Record<string, unknown>[],
  blockColour: string,
): ShadowSpec {
  if (arg.type === 'number') {
    const value = typeof arg.default === 'number' ? arg.default : 0;
    const bounded = typeof arg.min === 'number' || typeof arg.max === 'number';
    if (!bounded) return { type: SHADOW_NUMBER, fields: { [SHADOW_FIELD]: value } };

    const type = `${SHADOW_NUMBER}#${blockType}.${name}`;
    definitions.push({
      type,
      message0: '%1',
      args0: [
        {
          type: 'field_number',
          name: SHADOW_FIELD,
          value,
          ...(typeof arg.min === 'number' ? { min: arg.min } : {}),
          ...(typeof arg.max === 'number' ? { max: arg.max } : {}),
        },
      ],
      output: null,
      colour: SHADOW_COLOUR,
    });
    return { type, fields: { [SHADOW_FIELD]: value } };
  }

  // `dropdown` 走到這裡代表它是動態的（`source` 指向積木包的 `@dropdown`
  // 函式，D22）。選項要打 `POST /api/extensions/{extId}/dropdown/{source}` 才
  // 問得到，`extId` 是 `blockType` 的第一段——`buildBlock` 把它組成
  // `${manifest.id}.${opcode}`，跟後端 `opcode.split('.', 1)[0]` 是同一條規則。
  if (arg.type === 'dropdown' && arg.source) {
    const value = String(arg.default ?? '');
    const extId = blockType.split('.')[0];
    const type = `${SHADOW_DROPDOWN}#${blockType}.${name}`;
    definitions.push({
      type,
      message0: '%1',
      args0: [
        {
          type: FIELD_DYNAMIC_DROPDOWN_TYPE,
          name: SHADOW_FIELD,
          value,
          extId,
          source: arg.source,
          // manifest 的 `depends`：這份選項要吃同一顆積木上哪幾格的值
          // （`discord.channels` 要先知道是哪個伺服器）。
          ...(arg.depends ? { depends: arg.depends } : {}),
          // 值還空著時顯示的字。從 `label` 導出而不是讓積木包自己寫一句：
          // 會忘記的包就是大多數，而忘記的代價是畫布上一格看不見的東西。
          placeholder: arg.label ? `選擇${arg.label}` : '選擇…',
        },
      ],
      output: null,
      // **不是 `SHADOW_COLOUR`（白）**，這一顆跟父積木同色。
      //
      // 白色膠囊在這套視覺文法裡一直都是「這一格的內容是資料、可以打字」
      // （網址、提示詞都是）。下拉正好相反：值是封閉的一組（D22），只能挑。
      // Scratch 對這兩件事用的就是兩種樣子。
      //
      // 深色是**免費的**：Blockly 畫影子積木時本來就會用一個從 `colour` 推導
      // 出來的深色版，所以這裡給它包的顏色，畫出來就是「積木底色的深色版」。
      // 原本給白色，推出來就是一格灰——那正是它先前難看的原因，不是少了一層
      // CSS。（實測過：這顆欄位的群組裡連 `rect.blocklyFieldRect` 都沒有，
      // 想靠 CSS 壓底色是壓不到東西的；文字與箭頭也本來就是白的。）
      //
      // 顏色來自 manifest（§8.1），所以不寫死也不在 JS 裡算：寫死一個綠色會在
      // discord 那種紫色的包上壞掉。
      colour: blockColour,
    });
    return { type, fields: { [SHADOW_FIELD]: value } };
  }

  const value = String(arg.default ?? '');
  const options = fieldTextOptions(arg);
  if (isDefaultTextOptions(options)) {
    return { type: SHADOW_TEXT, fields: { [SHADOW_FIELD]: value } };
  }

  const type = `${SHADOW_TEXT}#${blockType}.${name}`;
  definitions.push({
    type,
    message0: '%1',
    args0: [{ type: FIELD_TEXT_TYPE, name: SHADOW_FIELD, text: value, ...options }],
    output: null,
    colour: SHADOW_COLOUR,
  });
  return { type, fields: { [SHADOW_FIELD]: value } };
}

/** `SHADOW_TEXT` 那顆共用影子帶的設定。與它相同就不必再生一顆。 */
function isDefaultTextOptions(options: FieldTextOptions): boolean {
  return (
    options.mode === DEFAULT_TEXT_OPTIONS.mode &&
    options.interpolate === DEFAULT_TEXT_OPTIONS.interpolate &&
    options.multiline === DEFAULT_TEXT_OPTIONS.multiline &&
    options.rows === undefined
  );
}

function tooltipOf(manifest: Manifest, spec: BlockSpec): string {
  const opcode = `${manifest.id}.${spec.opcode}`;
  const parts = [opcode];
  if (spec.returns) parts.push(`回傳 ${spec.returns}`);
  if (spec.deprecated) parts.push('已淘汰');
  return parts.join(' · ');
}

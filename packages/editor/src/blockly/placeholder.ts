/**
 * 認不得的 opcode → 佔位符積木（§13.3）。
 *
 * §13.3 承諾的是：專案用到未安裝的積木包時「**保留該積木為佔位符**（灰色、
 * 顯示原 opcode 與參數），不刪除、不報廢整個專案」。後端那一半早就成立了
 * （形狀驗證跳過認不得的 opcode，執行期給 `unknown_block`）；前端這一半一直
 * 是空的，而**它的實際行為是整個編輯器消失**：
 *
 *     TypeError: Invalid block definition for type: xxx
 *       at Blockly.serialization.blocks.append (deserialize.ts)
 *       at WorkspaceView
 *
 * `append` 對認不得的 type 直接丟例外，例外穿過 React 樹，畫面變成一片白，
 * 而且沒有任何訊息。這條路不只「改名 opcode」會走到——**開一份用了某個積木包
 * 的專案、而那個包沒裝**，就是 §13.3 明講要支援的那個情境。
 *
 * ## 形狀從**用法**推，不是從宣告
 *
 * 佔位符沒有宣告可查（那正是它是佔位符的原因），但 IR 說得出它被**怎麼用**：
 * 被誰的 `kind: block` 指到就是 reporter，被 `next` 或 `kind: stack` 指到就是
 * command。猜錯的代價很實際——形狀不合的積木接不回原來的位置，於是「保留」就
 * 變成了「掉在旁邊」。預設是 command：頂層的落單堆疊是合法 IR（§4.1）。
 *
 * ## 孔與欄位取這份專案裡的**聯集**
 *
 * Blockly 的 type 是全域的，而同一個 opcode 可能在專案裡出現好幾次、各自填了
 * 不同的孔。少宣告一個孔，`append` 會拋「missing a(n) X connection」——又是一份
 * 打不開的專案。多宣告一個孔的代價只是畫面上多一個空洞。
 *
 * ## 存回去必須一模一樣
 *
 * 佔位符最重要的性質不是長相，是**它存回去不能掉東西**。三個地方：
 *
 *   - `fields` 用 `field_label_serializable`，所以它們照樣進 `state.fields`。
 *   - `mutation` 進 `extraState`（Blockly 不認識它，只有這條路）。
 *   - `extensions` 宣告由 `serialize.ts` 特別處理——那份宣告的來源是「畫布上
 *     用到哪些包」，而佔位符的包**照定義就是查不到的那一個**。
 */
import * as Blockly from 'blockly/core';
import type { Block as IRBlock, BlockyardProjectIR as ProjectIR } from '../types/project';
import type { ConversionContext } from '../ir/context';
import { t } from '../i18n';

/** 佔位符把原始 `mutation` 藏在這個 key 底下（`extraState`）。 */
export const PLACEHOLDER_MUTATION = 'blockyardUnknownMutation';

/** 佔位符積木身上的警告 id（與 `checks.ts` 的 `CHECK_PREFIX` 分開）。 */
export const PLACEHOLDER_WARNING = 'blockyard-unknown';

/**
 * 這一輪註冊過的佔位符 type。
 *
 * 用一份名單而不是問積木身上有沒有某個屬性：後者要等 `loadExtraState` 跑過才
 * 成立，而一顆沒有 `mutation` 的佔位符根本不會走到那裡——那種「大部分時候會對」
 * 的判斷正是這個專案一直在拆的東西。
 *
 * 換一份專案就重算（`definePlaceholders` 開頭清空）：`Blockly.Blocks` 是全域的，
 * 而「哪些 opcode 認不得」是**這一份專案**的問題。
 */
const placeholderTypes = new Set<string>();

/**
 * **曾經**被註冊成佔位符的 type，永不清空。
 *
 * `Blockly.Blocks` 是全域的，所以「這個 type 註冊過了」不等於「這個 runtime
 * 認得它」——上一份專案留下的佔位符還在那裡。少了這份名單，換一份專案時
 * `isUnknown` 會說「認得」，於是那顆積木**不會**依新專案的用法重新註冊，而它的
 * 孔是上一份專案的：`append` 拋「missing a(n) X connection」，又是一份打不開的
 * 專案。這是實測（同一個 opcode 在兩份專案裡填了不同的孔）抓到的。
 */
const everDefined = new Set<string>();

/**
 * 佔位符所屬的包 → 載入那份專案時它宣告的版本。
 *
 * `serialize.ts::usedExtensions` 要它：那份宣告的來源是「畫布上用到哪些包」，
 * 而佔位符的包**照定義就查不到 manifest**（它沒裝）。照一般規則走的話宣告會在
 * 存檔時安靜消失，於是那份專案從此忘了自己需要哪個包——「一鍵安裝」沒有東西
 * 可以裝，而在裝了那個包的機器上打開也不會載入它（`open_registry(only=declared)`）。
 *
 * 版本原封不動帶回去：我們沒有第二個來源，而**猜一個版本比留著原本那個危險**。
 */
const placeholderVersions = new Map<string, string>();

/** 這個 type 是不是這一輪建出來的佔位符。 */
export function isPlaceholderType(type: string): boolean {
  return placeholderTypes.has(type);
}

/** 佔位符所屬的包在載入時宣告的版本。沒宣告過就是 undefined。 */
export function placeholderVersion(extensionId: string): string | undefined {
  return placeholderVersions.get(extensionId);
}

/** §13.3：灰色。它刻意不像任何一個命名空間的顏色。 */
const PLACEHOLDER_COLOUR = '#8f9296';

/** 這一次載入建出來的佔位符：opcode → 它原本宣告在哪個包（`extensions` 用）。 */
export interface PlaceholderInfo {
  opcode: string;
  /** 從 opcode 的命名空間推的包 id。`http.get` → `http`。 */
  extensionId: string;
}

interface Usage {
  shape: 'value' | 'command';
  /** 孔名 → 是不是 stack。 */
  inputs: Map<string, boolean>;
  fields: Map<string, string>;
}

/**
 * 掃過整份 IR，把認不得的 opcode 註冊成佔位符。回傳它們的資訊。
 *
 * **在 `loadProject` 之前呼叫**——`append` 需要 type 已經存在。
 */
export function definePlaceholders(
  project: ProjectIR,
  ctx: ConversionContext,
): Map<string, PlaceholderInfo> {
  const blocks = project.blocks ?? {};
  const unknown = new Map<string, Usage>();
  placeholderTypes.clear();
  placeholderVersions.clear();
  for (const ref of project.extensions ?? []) {
    if (ref?.id) placeholderVersions.set(ref.id, ref.version);
  }

  // 「認不得」= 宣告裡沒有，而且 Blockly 那邊也沒有**真的**定義——上一輪自己
  // 留下的佔位符不算數，它要依這份專案的用法重新註冊。
  const isUnknown = (type: string) =>
    ctx.blockOf(type) === undefined &&
    (Blockly.Blocks[type] === undefined || everDefined.has(type));

  for (const block of Object.values(blocks)) {
    const opcode = block.opcode;
    // `procedure.*` 走 `procedures.ts` 動態產生的 type，不是 opcode 本身，
    // 而那些 type 在這裡一定查得到（專案自己帶著 `procedures`）。
    if (!opcode || opcode.startsWith('procedure.') || !isUnknown(opcode)) continue;
    const usage = unknown.get(opcode) ?? {
      shape: 'command',
      inputs: new Map(),
      fields: new Map(),
    };
    collect(block, usage);
    unknown.set(opcode, usage);
  }
  if (unknown.size === 0) return new Map();

  // 形狀要看**別人怎麼指它**，所以要再掃一遍：一顆積木自己的 IR 說不出它插在
  // 哪裡。
  const shapes = inferShapes(blocks);
  for (const [opcode, usage] of unknown) {
    for (const [id, block] of Object.entries(blocks)) {
      if (block.opcode === opcode && shapes.get(id) === 'value') usage.shape = 'value';
    }
    define(opcode, usage);
    placeholderTypes.add(opcode);
    everDefined.add(opcode);
  }

  return new Map(
    [...unknown.keys()].map((opcode) => [
      opcode,
      { opcode, extensionId: opcode.split('.', 1)[0]! },
    ]),
  );
}

function collect(block: IRBlock, usage: Usage): void {
  for (const [name, input] of Object.entries(block.inputs ?? {})) {
    usage.inputs.set(name, (input as { kind?: string }).kind === 'stack');
  }
  for (const [name, value] of Object.entries(block.fields ?? {})) {
    usage.fields.set(name, String(value ?? ''));
  }
}

/** blockId → 它被怎麼指。沒有人指它就不在表裡（頂層積木）。 */
function inferShapes(blocks: Record<string, IRBlock>): Map<string, 'value' | 'command'> {
  const out = new Map<string, 'value' | 'command'>();
  for (const block of Object.values(blocks)) {
    if (block.next) out.set(block.next, 'command');
    for (const input of Object.values(block.inputs ?? {})) {
      const ref = input as { kind?: string; id?: string };
      if (!ref.id) continue;
      out.set(ref.id, ref.kind === 'stack' ? 'command' : 'value');
    }
  }
  return out;
}

function define(opcode: string, usage: Usage): void {
  Blockly.Blocks[opcode] = {
    init(this: Blockly.Block) {
      this.setColour(PLACEHOLDER_COLOUR);
      this.setTooltip(t('blockly.unknownTooltip', { opcode }));

      // **不自己畫驚嘆號**：`setWarningText` 已經在積木左上角放了一個，而且那個
      // 點得下去、說得出原因。兩個並排（`⚠ ⚠ ghost.send`）只是看起來壞掉。
      this.appendDummyInput().appendField(
        new Blockly.FieldLabel(opcode, 'blockyard-unknown-opcode'),
      );

      // 欄位用 serializable 的 label：**畫面上讀得到、存回去也還在**，但不能
      // 編輯——使用者不知道那顆積木的規則，讓他改一個看不出意義的值不會有好結果。
      for (const [name, value] of usage.fields) {
        this.appendDummyInput()
          .appendField(`${name}:`)
          .appendField(new Blockly.FieldLabelSerializable(value), name);
      }

      for (const [name, isStack] of usage.inputs) {
        const input = isStack ? this.appendStatementInput(name) : this.appendValueInput(name);
        input.appendField(name);
      }

      if (usage.shape === 'value') {
        this.setOutput(true);
      } else {
        this.setPreviousStatement(true);
        this.setNextStatement(true);
      }
    },

    /** `mutation` Blockly 不認識，只有 `extraState` 這條路存得回去。 */
    saveExtraState(this: Blockly.Block) {
      const kept = (this as unknown as { blockyardMutation?: unknown }).blockyardMutation;
      return kept == null ? null : { [PLACEHOLDER_MUTATION]: kept };
    },

    loadExtraState(this: Blockly.Block, state: unknown) {
      const kept = (state as Record<string, unknown> | null)?.[PLACEHOLDER_MUTATION];
      (this as unknown as { blockyardMutation?: unknown }).blockyardMutation = kept ?? null;
    },
  };
}

/** 把「這個 runtime 不認得它」畫到積木上（§13.3：灰色 + 說得出是哪一顆）。 */
export function markPlaceholders(workspace: Blockly.Workspace): void {
  for (const block of workspace.getAllBlocks(false)) {
    if (!isPlaceholderType(block.type)) continue;
    block.setWarningText(t('blockly.unknownWarning', { opcode: block.type }), PLACEHOLDER_WARNING);
  }
}

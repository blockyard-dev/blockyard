/**
 * 可重複參數群組的編輯器那一半（§16 Q19）。
 *
 * 積木右下角兩顆 `+` `−`，按了長出（或收回）一份「否則如果 ⋯ 那麼」。
 *
 * ## 為什麼是 mutator 而不是別的
 *
 * `define.ts` 把 manifest 編成一份**靜態**的 Blockly JSON 定義：一個 type 一份
 * 定義，所有實例共用。可重複群組是這件事的第一個例外——同一個 type 的兩顆積木
 * 可以有不同數量的孔。Blockly 給這種東西的名字就是 mutator，而它的現代形式是
 * `saveExtraState` / `loadExtraState` 加一個自己重建輸入孔的函式。
 *
 * **不用官方的 mutator 對話框**（那個會彈出一個小工作區讓你拖積木進去）。
 * Scratch 沒有那種東西，而 §8.5 對「多一種視覺文法」的態度一路是拒絕的。
 * `block-plus-minus` 那一招——把 mutator 換成積木上的兩顆按鈕——是同樣的效果
 * 而且不引入新的介面概念。我們的積木是動態產生的，所以那個 plugin 的註冊方式
 * 用不上，但招式是同一個。
 *
 * ## 按 `−` 不會刪掉裡面的積木
 *
 * 收回一份時，那一份的孔裡如果有東西，它們**留在畫布上成為孤兒**——與
 * `reshape.ts` 對「積木包改了宣告」的處理同一條規則（§8.5）。靜默刪除是這個
 * 專案一路在避免的那種事：使用者按了一下 `−`，半個流程消失，而 undo 之外沒有
 * 任何線索。
 *
 * ## 為什麼份數存在積木上而不是欄位裡
 *
 * 存成欄位的話，一顆積木的孔數會由它自己的一格值決定，而那一格是使用者可以
 * 打字改的——一個打成 `999` 的欄位會當場生出兩千個孔。`extraState` 只有 `+`
 * `−` 改得動，而它的上下限在宣告裡（`RepeatSpec.min` / `max`）。
 */
import * as Blockly from 'blockly/core';
import type { ArgSpec, BlockSpec, Manifest, RepeatSpec } from '../types/manifest';

/** IR 的 `mutation` 用這個 key 記份數（後端 `blocky/repeat.py` 的 `REPEAT_KEY`）。 */
export const REPEAT_KEY = 'repeat';

/** 展開後第 `index` 份的參數叫什麼（0-based）。**與後端同一條規則。** */
export function repeatArgName(arg: string, index: number): string {
  return `${arg}_${index + 1}`;
}

interface RepeatBlock extends Blockly.Block {
  repeatCount_: number;
  repeatSpec_: RepeatSpec;
  updateRepeatShape_(): void;
}

/**
 * 一顆積木上某個參數的宣告——**展開過的**（§16 Q19）。
 *
 * 靜態的 `spec.args` 只有基底那一份，`body_1` 在裡面查不到。凡是「這一格是什麼
 * 型別」的問題都得走這裡，否則展開出來的孔會被當成沒宣告過：序列化時
 * `body_1` 會從 `kind: stack` 掉成 `kind: block`，而那份專案再讀回來就接錯位置。
 *
 * **與後端 `BlockSpec.repeat_args` 是同一條規則**，兩邊都要認得 `<名字>_<n>`。
 */
export function argSpecOf(spec: BlockSpec | undefined, name: string): ArgSpec | undefined {
  const direct = spec?.args?.[name];
  if (direct) return direct;
  if (!spec?.repeat) return undefined;
  const match = /^(.*)_(\d+)$/.exec(name);
  const base = match?.[1];
  const index = Number(match?.[2]);
  if (base === undefined || !Number.isInteger(index) || index < 1) return undefined;
  const arg = spec.repeat.args[base];
  // D29：`scope` 指的是**這一份**的那一疊。原樣回傳的話，第 2 份 catch 綁的
  // 名字會宣稱自己在第 1 份 catch 裡有效——祖先鏈於是標錯一顆積木，而兩顆
  // 長得一模一樣。與後端 `repeat_args` 的同一句改寫。
  if (!arg?.scope) return arg;
  return { ...arg, scope: repeatArgName(arg.scope, index - 1) };
}

/** 一個 block type 要用的 extension 名字。一個 type 一個，因為宣告不一樣。 */
export function repeatExtensionName(type: string): string {
  return `blocky_repeat_${type.replace(/\W/g, '_')}`;
}

/**
 * 幫一個有 `repeat` 宣告的積木註冊它的 mutator extension。
 *
 * 回傳 extension 名字給 `define.ts` 掛進 JSON 定義的 `extensions`；沒有
 * `repeat` 宣告就回 `null`，呼叫端因此不必自己判斷。
 */
export function registerRepeatExtension(manifest: Manifest, spec: BlockSpec): string | null {
  const repeat = spec.repeat;
  if (!repeat) return null;

  const type = `${manifest.id}.${spec.opcode}`;
  const name = repeatExtensionName(type);
  // 重新註冊會拋——熱重載與測試裡同一份 manifest 會被註冊很多次。
  if (Blockly.Extensions.isRegistered(name)) return name;

  Blockly.Extensions.registerMutator(
    name,
    {
      saveExtraState(this: RepeatBlock) {
        // 0 份就不寫：**沒按過 `+` 的積木，IR 必須跟以前一模一樣**。不然這次
        // 改版會讓每一顆既有的 `如果⋯否則` 在存檔時長出一個 mutation，而
        // round-trip 等價（§4.1）當場破掉。
        return this.repeatCount_ > 0 ? { [REPEAT_KEY]: this.repeatCount_ } : null;
      },

      loadExtraState(this: RepeatBlock, state: Record<string, unknown> | null) {
        const raw = state?.[REPEAT_KEY];
        const n = typeof raw === 'number' && Number.isInteger(raw) ? raw : 0;
        this.repeatCount_ = clamp(n, repeat);
        this.updateRepeatShape_();
      },

      updateRepeatShape_(this: RepeatBlock) {
        updateShape(this, repeat);
      },
    } as unknown as Parameters<typeof Blockly.Extensions.registerMutator>[1],
    function (this: RepeatBlock) {
      // 初始化：宣告的 `min` 是「這顆積木至少要有幾份」，所以一顆剛從工具箱
      // 拖出來的積木就該長成那個樣子。
      this.repeatCount_ = repeat.min ?? 0;
      this.repeatSpec_ = repeat;
      appendControls(this, repeat);
      updateShape(this, repeat);
    },
  );

  return name;
}

function clamp(n: number, repeat: RepeatSpec): number {
  const min = repeat.min ?? 0;
  const max = repeat.max ?? 20;
  return Math.max(min, Math.min(max, n));
}

/**
 * `+` `−` 兩顆按鈕。
 *
 * 放在積木的**最後一列**：那是「還可以再多一份」在視覺上該在的位置，也是
 * Scratch 的 `+` 在自訂積木上的位置。放在第一列的話，一顆有五份的積木要
 * 一路捲到頂才按得到下一顆。
 */
function appendControls(block: RepeatBlock, repeat: RepeatSpec): void {
  const row = block.appendDummyInput(CONTROL_INPUT);
  row.appendField(
    new Blockly.FieldImage(PLUS_SVG, 16, 16, '+', () => changeBy(block, +1, repeat)),
    PLUS_FIELD,
  );
  row.appendField(
    new Blockly.FieldImage(MINUS_SVG, 16, 16, '−', () => changeBy(block, -1, repeat)),
    MINUS_FIELD,
  );
}

function changeBy(block: RepeatBlock, delta: number, repeat: RepeatSpec): void {
  const next = clamp(block.repeatCount_ + delta, repeat);
  if (next === block.repeatCount_) return;

  const before = extraStateJson(block);
  // 包成一個 group：一次 `+` 在 undo 裡是**一步**，不是「加一個孔、再加一個
  // 孔、再重畫」三步。
  Blockly.Events.setGroup(true);
  try {
    block.repeatCount_ = next;
    block.updateRepeatShape_();
    // **必須自己發 mutation 事件。** 改 `repeatCount_` 與加孔都不會產生它，
    // 而 undo 對 mutator 的還原就是靠它——少了這一行，按 `+` 之後按 undo
    // 會把孔裡的積木一顆一顆退回去，卻永遠退不掉那一份本身。
    Blockly.Events.fire(
      new (Blockly.Events.get(Blockly.Events.BLOCK_CHANGE) as typeof Blockly.Events.BlockChange)(
        block,
        'mutation',
        null,
        before,
        extraStateJson(block),
      ),
    );
  } finally {
    Blockly.Events.setGroup(false);
  }
}

/** Blockly replay mutation 事件時吃的是 JSON 字串（`JSON.parse(value || "{}")`）。 */
function extraStateJson(block: RepeatBlock): string {
  const state = block.repeatCount_ > 0 ? { [REPEAT_KEY]: block.repeatCount_ } : null;
  return state ? JSON.stringify(state) : '';
}

const CONTROL_INPUT = 'REPEAT_CONTROLS';
const PLUS_FIELD = 'REPEAT_PLUS';
const MINUS_FIELD = 'REPEAT_MINUS';

/** 把孔的數量對齊到 `repeatCount_`。多的收掉、少的補上。 */
function updateShape(block: RepeatBlock, repeat: RepeatSpec): void {
  const want = block.repeatCount_;
  const argNames = Object.keys(repeat.args);

  // 先收多的。**由後往前**，否則後面那幾份的索引會在中途位移。
  //
  // `removeInput` 對插在裡面的積木是**斷開**不是刪除（shadow 才會被丟掉），
  // 所以那些積木留在畫布上成為孤兒——那正是 §8.5 要的：靜默刪除是這個專案
  // 一路在避免的事，使用者按了一下 `−` 不該讓半個流程消失。
  for (let i = (repeat.max ?? 20) - 1; i >= want; i--) {
    for (const arg of argNames) {
      const name = repeatArgName(arg, i);
      if (block.getInput(name)) block.removeInput(name, true);
    }
    for (const name of [repeatTailName(i)]) {
      if (block.getInput(name)) block.removeInput(name, true);
    }
  }

  // 再補少的。
  for (let i = 0; i < want; i++) {
    appendGroup(block, repeat, i);
  }

  // **位置由宣告說。** `否則如果` 要落在 `否則` 之前，而 append 一律接在最後
  // ——猜法（例如「插在最後一個 stack 前面」）對 `try_catch` 的多個 catch
  // 立刻就錯了，所以 `repeat.before` 是宣告的一部分。
  const anchor = insertionPoint(block, repeat.before ?? null);
  if (anchor) {
    for (let i = 0; i < want; i++) {
      for (const name of groupInputNames(block, repeat, i)) {
        const from = block.inputList.findIndex((input) => input.name === name);
        const to = block.inputList.indexOf(anchor);
        // **`moveNumberedInputBefore` 而不是 `moveInputBefore`。** 後者只吃
        // 名字，而錨點（`否則` 那一列）根本沒有名字——用名字找就只能退回
        // `else` 本身，而那正是這個函式要避開的位置。
        if (from >= 0 && to >= 0 && from !== to) block.moveNumberedInputBefore(from, to);
      }
    }
  }

  // `+` `−` 那一列永遠在最後：那是「還可以再多一份」在視覺上該在的位置。
  if (block.getInput(CONTROL_INPUT)) block.moveInputBefore(CONTROL_INPUT, null);
}

/**
 * `repeat.before` 指的那一格，實際上該插在**它那一列的前面**。
 *
 * `define.ts` 把 `如果 %(condition) 那麼 ⋯ 否則` 編成四列：文字＋孔、堆疊、
 * 「否則」、堆疊。而「否則」那兩個字是一個**沒有名字的 dummy 列**，`else` 是
 * 它後面那個堆疊。直接 `moveInputBefore(x, 'else')` 就會落在「否則」與它的堆疊
 * 之間——`inputsInline` 讓它們擠成同一行，畫面上是「否則 否則如果 ◇ 那麼」，
 * 讀起來完全不知道在說什麼。
 *
 * 所以往回走過緊鄰的無名 dummy 列：那些是**那一格的標籤**，不是獨立的一列。
 */
function insertionPoint(block: RepeatBlock, before: string | null): Blockly.Input | null {
  if (!before || !block.getInput(before)) return null;
  const list = block.inputList;
  let at = list.findIndex((input) => input.name === before);
  while (at > 0) {
    const previous = list[at - 1];
    // 「沒有名字」＋「沒有連接點」＝ 一列純文字。不比對 `input.type`：那個
    // 欄位在 Blockly 的版本之間換過表示法，而「有沒有 connection」是這件事的
    // 定義本身。
    if (previous?.name !== '' || previous.connection != null) break;
    at--;
  }
  return list[at] ?? null;
}

/** 第 `index` 份實際建出來的孔，**照它們該有的順序**。 */
function groupInputNames(block: RepeatBlock, repeat: RepeatSpec, index: number): string[] {
  const ordered: string[] = [];
  for (const segment of (repeat.label ?? '').split(/%\((\w+)\)/g).filter((_, i) => i % 2 === 1)) {
    const argSpec = repeat.args[segment];
    if (argSpec && argSpec.type !== 'stack') ordered.push(repeatArgName(segment, index));
  }
  ordered.push(repeatTailName(index));
  for (const [arg, argSpec] of Object.entries(repeat.args)) {
    if (argSpec.type === 'stack') ordered.push(repeatArgName(arg, index));
  }
  return ordered.filter((name) => block.getInput(name));
}

/**
 * 一份群組：`label` 那一行（含它引用到的參數），加上 stack 型參數各自一列。
 *
 * 排版規則跟 `define.ts::buildBlock` 是同一條——`%(名字)` 就地插孔，stack 另起
 * 一列。沒有複用那個函式，因為它產的是 JSON 定義而這裡要動一顆**活的**積木。
 *
 * 文字的擺法要照 Blockly 的規矩：欄位只能長在連接點**之前**，所以
 * `否則如果 %(condition) 那麼` 會變成「值孔（前面掛著『否則如果』）」＋「一個
 * 只有『那麼』的 dummy 列」。`inputsInline` 讓它們渲染成同一行。
 */
function appendGroup(block: RepeatBlock, repeat: RepeatSpec, index: number): void {
  const segments = (repeat.label ?? '').split(/%\((\w+)\)/g);
  let pending = '';

  segments.forEach((segment, i) => {
    if (i % 2 === 0) {
      pending = segment.trim();
      return;
    }
    const argSpec = repeat.args[segment];
    // stack 型參數不在文字行上——它自己是一列（見下面）。
    if (!argSpec || argSpec.type === 'stack') return;

    const name = repeatArgName(segment, index);
    if (!block.getInput(name)) {
      const input = block.appendValueInput(name);
      if (pending) input.appendField(pending);
      // 六角形由 check 決定（§8.5：形狀是視覺文法，不是連接限制）——
      // 這一格與 `如果` 那一格長得一模一樣，因為它們是同一件事。
      if (argSpec.type === 'boolean') input.setCheck('Boolean');
    }
    pending = '';
  });

  // 最後一段文字（`那麼`）：欄位掛不到連接點後面，所以自己一列。
  const tailName = repeatTailName(index);
  if (pending && !block.getInput(tailName)) {
    block.appendDummyInput(tailName).appendField(pending);
  }

  for (const [arg, argSpec] of Object.entries(repeat.args)) {
    if (argSpec.type !== 'stack') continue;
    const name = repeatArgName(arg, index);
    if (!block.getInput(name)) block.appendStatementInput(name);
  }
}

function repeatTailName(index: number): string {
  return `REPEAT_TAIL_${index}`;
}

/**
 * 積木上那兩顆按鈕的圖案。
 *
 * 內嵌而不是外部檔案：打包後的路徑不一定對得上，而一顆看不見的按鈕比沒有按鈕
 * 更糟。**用 base64 而不是 `;utf8,`**——後者是一個流傳很廣但不在規格裡的寫法，
 * `<svg>` 裡的 `#` 與 `"` 在某些渲染路徑上會把 URI 截斷，而症狀就是「按鈕在，
 * 但畫面上什麼都沒有」。
 */
function svgIcon(body: string): string {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
    '<circle cx="8" cy="8" r="7.5" fill="rgba(255,255,255,0.9)"/>' +
    body +
    '</svg>';
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const STROKE = 'stroke="rgba(0,0,0,0.55)" stroke-width="2" stroke-linecap="round"';
const PLUS_SVG = svgIcon(`<path d="M8 4.5v7M4.5 8h7" ${STROKE}/>`);
const MINUS_SVG = svgIcon(`<path d="M4.5 8h7" ${STROKE}/>`);

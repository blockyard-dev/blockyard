/**
 * `project.procedures` → Blockly block definition（§8.4）。
 *
 * `procedure.definition` / `procedure.call` 是 manifest 裡**唯一** `dynamic:
 * true` 的積木（`procedure.yaml`）：參數來自這份專案的 `procedures`，不是
 * manifest，形狀也隨函式有沒有宣告回傳型別而變（D22）。第 7 步的 mutator 才
 * 要處理「使用者互動編輯參數列表」；這裡只需要「给定一份 `procedures`，能
 * 註冊出對得上、轉得回去的 Blockly 積木」——足夠 IR ↔ Blockly 轉換層跑
 * 過題庫。
 *
 * 做法是**每個函式各自一組積木類型**（`procedure.definition#p_sum`、
 * `procedure.call#p_sum`），而不是一顆共用積木 + Blockly 原生 mutator。
 * 好處是完全複用 `define.ts` 的 `buildBlock`——形狀、影子、`%()` 展開都不必
 * 重寫一份。壞處（也是刻意留給第 7 步的債）：換函式名稱或參數必須整組重新
 * 註冊，而不是原地變形。第 7 步接手時，這裡多半會被换成真正的 mutator，
 * 屆時這份檔案的重點會從「怎麼註冊」搬到「怎麼原地改形狀」。
 *
 * proc id 直接嵌在 Blockly 的 `type` 字串裡（`#` 之後），所以序列化不需要
 * 額外的 `mutation` 或欄位——從 `type` 就能反查是哪個函式（見
 * `procIdFromType`）。IR 的 `fields.proc` / `mutation.proc` 由 `ir/serialize`
 * 在讀出 proc id 之後另外補上，不是 Blockly 積木自己的欄位。
 */
import * as Blockly from 'blockly/core';
import type { ArgSpec, BlockSpec, Manifest } from '../types/manifest';
import type { Procedure, ProcParam, Returns } from '../types/project';
import { buildBlock, type RegisteredBlock } from './define';
import { callText, definitionText, displayName, paramsOf } from './signature';

const NAMESPACE = 'procedure';
const PARAM_PREFIX = `${NAMESPACE}.param#`;

/**
 * 定義帽子**永遠刪不掉**（§4.6）。
 *
 * 刪掉定義 = 刪掉函式，而「還有人在用就不准刪」需要一個講得出理由的地方。
 * Blockly 的刪除有三條路（Delete 鍵、右鍵選單、拖進垃圾桶），而
 * `BLOCK_DELETE` 事件是**刪完才發**的，攔不住；`setDeletable(false)` 攔得住
 * 三條，代價是它一句話都不說。所以三條全部關掉，刪除只走我們自己的右鍵項目
 * （`App.tsx` 的「刪除這個積木…」）——**入口只有一個，才有地方講話**，與
 * 「建立只走按鈕」（D25）是同一個形狀的決定。
 *
 * 程式仍然刪得掉（`dispose()` 不看這個旗標）：它擋的是使用者，不是我們。
 */
const UNDELETABLE_EXTENSION = 'blocky_procedure_definition';

function registerUndeletableExtension(): void {
  if (Blockly.Extensions.isRegistered(UNDELETABLE_EXTENSION)) return;
  Blockly.Extensions.register(UNDELETABLE_EXTENSION, function (this: Blockly.Block) {
    this.setDeletable(false);
  });
}
const DEFINITION_PREFIX = `${NAMESPACE}.definition#`;
const CALL_PREFIX = `${NAMESPACE}.call#`;

/** 與 `procedure.yaml` 的 `color` 一致，函式積木視覺上仍是同一個命名空間。 */
export const PROCEDURE_COLOUR = '#FF6680';

export function definitionType(id: string): string {
  return `${DEFINITION_PREFIX}${id}`;
}

export function callType(id: string): string {
  return `${CALL_PREFIX}${id}`;
}

export function isDefinitionType(type: string): boolean {
  return type.startsWith(DEFINITION_PREFIX);
}

export function isCallType(type: string): boolean {
  return type.startsWith(CALL_PREFIX);
}

/**
 * 帽子上那顆參數（§4.6）。**一個參數一組型別**，與 `definition#` / `call#`
 * 同一條路：名字寫在型別裡而不是欄位裡，所以改一次參數名不必去找那些積木，
 * 重新註冊就換了一份文字。
 */
export function paramType(procId: string, paramId: string): string {
  return `${PARAM_PREFIX}${procId}.${paramId}`;
}

export function isParamType(type: string): boolean {
  return type.startsWith(PARAM_PREFIX);
}

/** `procedure.param#p_x.a1` → `{ procId: 'p_x', paramId: 'a1' }`。 */
export function paramRefFromType(type: string): { procId: string; paramId: string } | null {
  if (!isParamType(type)) return null;
  const rest = type.slice(PARAM_PREFIX.length);
  // proc id 由 `procedures.ts` 產生（`p_` + nanoid），不含 `.`；參數 id 同理。
  const dot = rest.lastIndexOf('.');
  if (dot <= 0) return null;
  return { procId: rest.slice(0, dot), paramId: rest.slice(dot + 1) };
}

/** 從 Blockly 的 `type` 反查函式 id；不是函式積木就回 `null`。 */
export function procIdFromType(type: string): string | null {
  if (isDefinitionType(type)) return type.slice(DEFINITION_PREFIX.length);
  if (isCallType(type)) return type.slice(CALL_PREFIX.length);
  return paramRefFromType(type)?.procId ?? null;
}

/**
 * 把一份 `procedures` 轉成 Blockly 定義並註冊，回傳每顆積木的 `RegisteredBlock`
 * ——與 `defineManifest` 回傳的形狀完全一樣，讓 `ir/context.ts` 能把兩者併進
 * 同一份查表，`ir/serialize.ts` / `ir/deserialize.ts` 不必分辨一顆積木是不是
 * 動態產生的。
 */
export function registerProcedures(procedures: Record<string, Procedure>): RegisteredBlock[] {
  // `builtin: true` 不是裝飾：§13.3 的 `extensions` 宣告是從畫布上的積木算出來的
  // （`serialize.ts::usedExtensions`），而函式積木沒有資料夾、也沒有 main.py
  // ——一份用了自訂函式的專案不該宣告自己需要一個叫「procedure」的積木包。
  const manifest: Manifest = {
    id: NAMESPACE,
    name: '函式',
    version: '1.0.0',
    color: PROCEDURE_COLOUR,
    builtin: true,
  };
  const definitions: Record<string, unknown>[] = [];
  const registered: RegisteredBlock[] = [];
  registerUndeletableExtension();

  for (const [id, proc] of Object.entries(procedures)) {
    const specs = [
      definitionSpec(id, proc),
      callSpec(id, proc),
      ...paramsOf(proc).map((param) => paramSpec(id, param)),
    ];
    for (const spec of specs) {
      const built = buildBlock(manifest, spec);
      // `buildBlock` 的 tooltip 是 opcode，而函式的 opcode 裡嵌著 proc id
      // （`procedure.definition#p_sum`）——那是 IR 的 key，畫面上一個字都不
      // 該出現。換成簽章本身。
      built.definition.tooltip = displayName(proc);
      if (isDefinitionType(built.registered.type)) makeUndeletable(built.definition);
      definitions.push(built.definition, ...built.shadowDefinitions);
      registered.push(built.registered);
    }
  }

  // 改一次簽章就是同一組 type 換一份定義（見 `reshape.ts`）。先刪掉舊的再
  // 註冊：Blockly 允許覆寫，但每次都 `console.warn` 一句——而這裡的覆寫是
  // 設計，那句警告只會讓真正的重複註冊更難被看見。
  for (const definition of definitions) delete Blockly.Blocks[definition.type as string];
  Blockly.common.defineBlocksWithJsonArray(definitions as never);
  return registered;
}

/**
 * 定義積木是一個帶標籤的帽子。`body` 走 `next`，與其他 hat 積木相同（§5.1）。
 *
 * 文字與呼叫積木**同一份簽章**（D26）：`定義 跳 (次數) 次 到 (方向)`。括號裡
 * 是真的輸入孔，但裡面放的不是值——是一顆拖得出去的參數晶片
 * （`blockly/params.ts`）。孔的內容**不進 IR**：`procedures[].params` 已經是
 * 那份資料的唯一來源。
 *
 * 孔一律宣告成 `string`：型別在這裡沒有意義（沒有人會往裡面填值），而
 * `string` 給的是一般的橢圓孔——`boolean` 會畫成六角形，那在帽子上讀起來像
 * 是「這一格要填一個條件」。
 */
function definitionSpec(id: string, proc: Procedure): BlockSpec {
  const args: Record<string, ArgSpec> = {};
  for (const param of paramsOf(proc)) args[param.id] = { type: 'string' };
  return {
    opcode: `definition#${id}`,
    type: 'hat',
    text: definitionText(proc),
    args,
  };
}

/**
 * 帽子上那顆參數：**一顆光禿禿的膠囊，上面只有名字**（§4.6）。
 *
 * 這是 Scratch 的 `argument_reporter_string_number`，不是 `取得 (名稱)`。差別
 * 不只是少兩個字：`取得` 是一個動詞，它說的是「去查一個變數」，而參數不是
 * 變數——它是這次呼叫傳進來的值，唯讀、只活在這個 frame 裡（後端的
 * `procedure.param` handler 只讀 frame，不落到 §5.4 的變數層）。
 *
 * 名字**只在型別字串裡**，沒有欄位：改一次參數名，`reshape.ts` 重新註冊就換了
 * 一份文字，不必去找函式體裡那幾顆積木。也因此使用者改不動它——要改名字得回
 * 對話框，那正是唯一該改的地方。
 *
 * 形狀一律 reporter，連 `type: boolean` 的參數也是。六角形是「這裡要一個條件」
 * 的意思，而一顆參數插得進哪裡由它的值決定，不由宣告決定（§8.5：型別提示用
 * 警告不用形狀）。
 */
function paramSpec(procId: string, param: ProcParam): BlockSpec {
  return {
    opcode: `param#${procId}.${param.id}`,
    type: 'reporter',
    returns: 'any',
    // 空白的名字畫不出積木（`message0` 會是空字串）。對話框擋得住空名字，
    // 但手寫的 IR 擋不住。
    text: param.name.trim() || '參數',
  };
}

/** 定義帽子的 JSON 定義要多掛一個 extension（見 `UNDELETABLE_EXTENSION`）。 */
function makeUndeletable(definition: Record<string, unknown>): void {
  const existing = (definition.extensions as string[] | undefined) ?? [];
  definition.extensions = [...existing, UNDELETABLE_EXTENSION];
}

/**
 * 呼叫積木的形狀隨 `returns` 而定（D22）：沒有回傳值是 command，宣告
 * `boolean` 是六角形（與 `applyShape` 對一般積木的規則一致），其餘是
 * output:null 的 reporter（§8.5：型別提示用警告不用形狀）。
 *
 * 每個參數一個輸入孔，孔名是 `param.id`——不是 `param.name`：IR 範例
 * （`procedure.call` 的 `inputs`）用的就是 id，函式體內部才用名稱
 * （`data.get` 的 `fields.name`），兩者是不同的參照方式。
 */
function callSpec(id: string, proc: Procedure): BlockSpec {
  const args: Record<string, ArgSpec> = {};
  for (const param of paramsOf(proc)) args[param.id] = paramArgSpec(param);
  return {
    opcode: `call#${id}`,
    type: callShape(proc.returns),
    text: callText(proc),
    args,
  };
}

/**
 * `returns` → 呼叫積木的形狀（§4.6）。
 *
 * 對話框的預覽積木也走這一個函數：預覽的形狀就是使用者之後會拿到的形狀，
 * 兩邊各寫一次 `returns == null ? …` 遲早會分岔。
 */
export function callShape(returns: Returns | undefined): BlockSpec['type'] {
  if (returns == null) return 'command';
  return returns === 'boolean' ? 'boolean' : 'reporter';
}

/**
 * 參數型別只用來選「這個孔長什麼樣」（六角形 vs 一般孔、要不要影子），不是
 * 執行期的型別檢查——那件事本來就不是 Blockly 的形狀能做的（§8.5）。
 */
function paramArgSpec(param: ProcParam): ArgSpec {
  if (param.type === 'boolean') return { type: 'boolean' };
  if (param.type === 'number') return { type: 'number' };
  return { type: 'string' };
}

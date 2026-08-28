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
import type { Procedure, ProcParam } from '../types/project';
import { buildBlock, type RegisteredBlock } from './define';

const NAMESPACE = 'procedure';
const DEFINITION_PREFIX = `${NAMESPACE}.definition#`;
const CALL_PREFIX = `${NAMESPACE}.call#`;

/** 與 `procedure.yaml` 的 `color` 一致，函式積木視覺上仍是同一個命名空間。 */
const PROCEDURE_COLOUR = '#FF6680';

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

/** 從 Blockly 的 `type` 反查函式 id；不是函式積木就回 `null`。 */
export function procIdFromType(type: string): string | null {
  if (isDefinitionType(type)) return type.slice(DEFINITION_PREFIX.length);
  if (isCallType(type)) return type.slice(CALL_PREFIX.length);
  return null;
}

/**
 * 把一份 `procedures` 轉成 Blockly 定義並註冊，回傳每顆積木的 `RegisteredBlock`
 * ——與 `defineManifest` 回傳的形狀完全一樣，讓 `ir/context.ts` 能把兩者併進
 * 同一份查表，`ir/serialize.ts` / `ir/deserialize.ts` 不必分辨一顆積木是不是
 * 動態產生的。
 */
export function registerProcedures(procedures: Record<string, Procedure>): RegisteredBlock[] {
  const manifest: Manifest = { id: NAMESPACE, name: '函式', version: '1.0.0', color: PROCEDURE_COLOUR };
  const definitions: Record<string, unknown>[] = [];
  const registered: RegisteredBlock[] = [];

  for (const [id, proc] of Object.entries(procedures)) {
    for (const spec of [definitionSpec(id, proc), callSpec(id, proc)]) {
      const built = buildBlock(manifest, spec);
      definitions.push(built.definition, ...built.shadowDefinitions);
      registered.push(built.registered);
    }
  }

  Blockly.common.defineBlocksWithJsonArray(definitions as never);
  return registered;
}

/**
 * 定義積木只是一個帶標籤的帽子——參數不是可編輯的輸入孔（那些是 `call` 的
 * 事），這裡純粹讓使用者在畫布上認得出「這是哪個函式」。`body` 走 `next`，
 * 與其他 hat 積木相同（§5.1）。
 */
function definitionSpec(id: string, proc: Procedure): BlockSpec {
  const paramList = proc.params ?? [];
  const params = paramList.length > 0 ? ` (${paramList.map((p) => p.name).join('、')})` : '';
  return {
    opcode: `definition#${id}`,
    type: 'hat',
    text: `定義函式 ${proc.name}${params}`,
  };
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
  const paramList = proc.params ?? [];
  const args: Record<string, ArgSpec> = {};
  const text = [`呼叫 ${proc.name}`, ...paramList.map((p) => `${p.name}: %(${p.id})`)].join(' ');
  for (const param of paramList) args[param.id] = paramArgSpec(param);
  return {
    opcode: `call#${id}`,
    type: proc.returns == null ? 'command' : proc.returns === 'boolean' ? 'boolean' : 'reporter',
    text,
    args,
  };
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

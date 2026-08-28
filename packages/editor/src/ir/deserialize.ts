/**
 * IR → Blockly（§8.4）。
 *
 * Blockly 原生的序列化格式是**巢狀**的（一顆積木的 `inputs`/`next` 直接內嵌
 * 子積木的完整狀態），IR 的 `blocks` 是**扁平** map（§4.1）。這個檔案只做
 * 「把 IR 攤平的樹重新捲成 Blockly 要的巢狀狀態」，剩下的交給 Blockly 自己
 * 的 `serialization.blocks.append`——連線、影子、undo 事件都不必自己管。
 *
 * blockId **原樣帶進 Blockly**（`state.id = <IR 的 key>`）：Blockly 的
 * `append` 尊重顯式 id，所以之後 `serialize.ts` 存回去、或後端 422 回傳
 * `blockId` 要標紅哪一顆，都是同一個 id，不需要一張對照表。
 */
import * as Blockly from 'blockly/core';
import { SHADOW_FIELD, SHADOW_NUMBER, SHADOW_TEXT, type RegisteredBlock } from '../blockly/define';
import { callType, definitionType, isCallType, isDefinitionType } from '../blockly/procedures';
import type { ConversionContext } from './context';
import type {
  Block as IRBlock,
  BlockyProjectIR as ProjectIR,
} from '../types/project';

type BlockState = Blockly.serialization.blocks.State;
type ConnectionState = Blockly.serialization.blocks.ConnectionState;

export function loadProject(
  project: ProjectIR,
  workspace: Blockly.Workspace,
  ctx: ConversionContext,
): void {
  for (const script of project.scripts ?? []) {
    const state = buildBlockState(script.top, project, ctx);
    state.x = script.x ?? 0;
    state.y = script.y ?? 0;
    state.data = script.id;
    if (script.enabled === false) state.enabled = false;
    Blockly.serialization.blocks.append(state, workspace);
  }

  for (const proc of Object.values(project.procedures ?? {})) {
    if (proc.definitionBlock == null) continue;
    Blockly.serialization.blocks.append(
      buildBlockState(proc.definitionBlock, project, ctx),
      workspace,
    );
  }
}

function buildBlockState(id: string, project: ProjectIR, ctx: ConversionContext): BlockState {
  const block = requireBlock(project, id);
  const type = blocklyTypeOf(block);
  const state: BlockState = { type, id };

  const fields = buildFields(block, type, ctx);
  if (fields) state.fields = fields;

  const inputs = buildInputs(block, project, ctx, type);
  if (inputs) state.inputs = inputs;

  if (block.next) state.next = { block: buildBlockState(block.next, project, ctx) };

  return state;
}

/**
 * `procedure.definition` / `procedure.call` 的 Blockly type 帶著 proc id
 * （`procedures.ts`），其餘積木的 type 就是 opcode 本身——「積木型別 = opcode，
 * 一字不差」（`define.ts` 的著力點，第 4 步直接吃到）。
 */
function blocklyTypeOf(block: IRBlock): string {
  if (block.opcode === 'procedure.definition') {
    const id = block.fields?.proc;
    if (typeof id !== 'string') {
      throw new Error('procedure.definition 缺少 fields.proc');
    }
    return definitionType(id);
  }
  if (block.opcode === 'procedure.call') {
    const id = block.mutation?.proc;
    if (typeof id !== 'string') {
      throw new Error('procedure.call 缺少 mutation.proc');
    }
    return callType(id);
  }
  return block.opcode;
}

/**
 * `proc` 是函式 id，嵌在 Blockly 的 `type` 字串裡，不是真的欄位（見
 * `blocklyTypeOf`）——所以這裡要把它從要寫進 Blockly 的 fields 裡濾掉，否則
 * `append` 會去找一個不存在的欄位。
 *
 * `boolean` 型別的欄位（`field: true` 的 boolean 參數，如 `object.to_json` 的
 * `pretty`）在 IR 存的是 JSON 布林，但 Blockly 的 `FieldCheckbox` 序列化出來
 * 一律是 `'TRUE'` / `'FALSE'` 字串——這裡做那個轉換。
 *
 * IR 省略一個 dropdown 欄位代表「用 manifest 宣告的預設值」（§4.2 的省略即
 * 預設慣例，`debug.log` 的題庫從不寫 `fields.level` 就是這樣）。但 Blockly
 * 的 `field_dropdown` JSON 定義本身不記得哪個選項是預設——沒有明講的話它
 * 只會选第一個（`define.ts` 的 `fieldDefaults()` 就是為了補這個洞，本來給
 * 工具箱用）。這裡借同一份資料：IR 沒寫的 dropdown 欄位，用它把 manifest
 * 的預設值明講出來，讓「沒存」和「存了預設值」在 Blockly 裡長一樣。
 */
function buildFields(
  block: IRBlock,
  type: string,
  ctx: ConversionContext,
): Record<string, unknown> | undefined {
  const raw = block.fields ?? {};
  const isProcBlock = isDefinitionType(type) || isCallType(type);
  const registered = ctx.blockOf(type);
  const out: Record<string, unknown> = {};

  if (registered) {
    for (const [key, fallback] of Object.entries(registered.fields)) {
      if (!(key in raw)) out[key] = fallback;
    }
  }

  for (const key of Object.keys(raw)) {
    if (isProcBlock && key === 'proc') continue;
    const value = raw[key];
    const argType = registered?.spec.args?.[key]?.type;
    out[key] = argType === 'boolean' ? (value ? 'TRUE' : 'FALSE') : value;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function buildInputs(
  block: IRBlock,
  project: ProjectIR,
  ctx: ConversionContext,
  type: string,
): Record<string, ConnectionState> | undefined {
  const raw = block.inputs ?? {};
  const names = Object.keys(raw);
  if (names.length === 0) return undefined;

  const registered = ctx.blockOf(type);
  const out: Record<string, ConnectionState> = {};
  for (const name of names) {
    const input = raw[name]!;
    switch (input.kind) {
      case 'block':
        out[name] = { block: buildBlockState(input.id, project, ctx) };
        break;
      case 'stack':
        // 空堆疊（if 沒接東西的那一半）：不放任何 key，與 Blockly「這個
        // statement 孔沒接東西」的表示法一致。
        if (input.id != null) out[name] = { block: buildBlockState(input.id, project, ctx) };
        break;
      case 'literal':
      case 'template':
        out[name] = { shadow: buildShadowState(registered, name, input.value) };
        break;
      default:
        throw new Error(`未知的 input kind：${String((input as { kind: unknown }).kind)}（${type}.${name}）`);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 字面值/插值都落在影子積木上那個共用欄位（`SHADOW_FIELD`，見 `define.ts`）。
 * 影子的**類型**（要不要 multiline、min/max）本該由 manifest 決定，但**只有
 * 在宣告的型別（數字影子 vs 文字影子）跟這個值實際的 JSON 型別一致時**才
 * 套用宣告——manifest 的 `type: string` 常常只是「這個孔用文字框編輯」的
 * 通用宣告（`data.set` 的 `value`、`operator.eq` 的 `a`/`b`），不代表存進去
 * 的值只能是字串；手寫 IR（或未來 AI 生成）完全可能塞一個數字進去。
 *
 * 兩者不一致時**一律信任值本身**：數字用數字影子、字串用文字影子。這是唯一
 * 能讓「載入再存回去」不失真的做法——反過來信任宣告的話，`data.set 為 99`
 * 存回去會變成 `"99"`（字串），而 `operator.eq` 用來測「"5" 不等於 5」的那
 * 兩顆字面值會被同一份宣告（`type: string`）套成同一種影子，量出真正的差異
 * 反而消失。代價只是：這格會顯示成通用文字框而不是 manifest 原本想給的
 * spinner，但那正是這個值現在真正的樣子。
 */
function buildShadowState(
  registered: RegisteredBlock | undefined,
  name: string,
  value: unknown,
): BlockState {
  const isNumber = typeof value === 'number';
  const spec = registered?.shadows[name];
  const specIsNumber = spec ? typeof spec.fields[SHADOW_FIELD] === 'number' : undefined;

  if (spec && specIsNumber === isNumber) {
    return { type: spec.type, fields: { [SHADOW_FIELD]: value } };
  }
  return {
    type: isNumber ? SHADOW_NUMBER : SHADOW_TEXT,
    fields: { [SHADOW_FIELD]: isNumber ? value : String(value ?? '') },
  };
}

function requireBlock(project: ProjectIR, id: string): IRBlock {
  const block = project.blocks?.[id];
  if (!block) throw new Error(`找不到積木 ${id}`);
  return block;
}

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
import {
  BOOLEAN_FALSE,
  BOOLEAN_TRUE,
  SHADOW_BOOLEAN,
  SHADOW_FIELD,
  SHADOW_NULL,
  SHADOW_NUMBER,
  SHADOW_TEXT,
  kindOfValue,
  shadowKindOf,
  type RegisteredBlock,
  type ShadowKind,
} from '../blockly/define';
import { FieldText } from '../blockly/fields/FieldText';
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

  applyUi(project, workspace);
}

/**
 * `blocks[].ui.multiline` → 欄位的第 3 層強制多行（§4.2、§8.5）。
 *
 * **在全部 append 完之後才跑**，不是跟著 `buildBlockState` 一起：`ui` 不是
 * Blockly 認識的東西，塞進 state 只會被忽略；而欄位要等積木真的建出來才存在。
 *
 * 認不得的 key 一律跳過（§4.2「validator 允許 `ui` 內出現任意未知 key」的
 * 前向相容規則，在讀的這一端也要成立）——新版後端存的 `ui` 不該讓舊版編輯器
 * 打不開專案。
 */
function applyUi(project: ProjectIR, workspace: Blockly.Workspace): void {
  for (const [id, block] of Object.entries(project.blocks ?? {})) {
    const names = block.ui?.multiline;
    if (!Array.isArray(names)) continue;
    const target = workspace.getBlockById(id);
    if (!target) continue;
    for (const name of names) {
      textFieldOf(target, String(name))?.setForcedMultiline(true);
    }
  }
}

/** 一個名字可能指到積木自己的欄位，也可能指到那個孔的影子上的欄位。 */
function textFieldOf(block: Blockly.Block, name: string): FieldText | null {
  const own = block.getField(name);
  if (own instanceof FieldText) return own;
  const shadow = block.getInput(name)?.connection?.targetBlock();
  if (!shadow?.isShadow()) return null;
  const field = shadow.getField(SHADOW_FIELD);
  return field instanceof FieldText ? field : null;
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
 * 在宣告的型別跟這個值實際的 JSON 型別一致時**才套用宣告——manifest 的
 * `type: string` 常常只是「這個孔用文字框編輯」的通用宣告（`data.set` 的
 * `value`、`operator.eq` 的 `a`/`b`），不代表存進去的值只能是字串；手寫 IR
 * （或未來 AI 生成、或使用者用右鍵切過型別）完全可能塞一個數字進去。
 *
 * 兩者不一致時**一律信任值本身**：數字用數字影子、布林用布林影子、`null` 用
 * 空值影子、其餘用文字影子。這是唯一能讓「載入再存回去」不失真的做法——反過來
 * 信任宣告的話，`data.set 為 99` 存回去會變成 `"99"`（字串），而 `operator.eq`
 * 用來測「"5" 不等於 5」的那兩顆字面值會被同一份宣告套成同一種影子，量出真正的
 * 差異反而消失。代價只是：這格會顯示成通用文字框而不是 manifest 原本想給的
 * spinner，但那正是這個值現在真正的樣子。
 *
 * 這一半從第 4 步就是這樣寫的，所以 §16 Q16 的右鍵切換接上來時，**讀的方向
 * 一行都不必改**——切完存出去的 JSON 型別，下次載入就會挑到同一種影子。
 */
function buildShadowState(
  registered: RegisteredBlock | undefined,
  name: string,
  value: unknown,
): BlockState {
  const kind = kindOfValue(value);
  const spec = registered?.shadows[name];
  if (spec && shadowKindOf(spec.type) === kind) {
    return { type: spec.type, fields: shadowFields(kind, value) };
  }
  return shadowStateFor(kind, value);
}

/**
 * 共用的（沒有 min/max、沒有 multiline）字面值影子。
 *
 * §16 Q16 的右鍵切換共用這個函式（`blockly/literals.ts`）——切完之後那一格會
 * 失去 manifest 宣告的 spinner 上下界，但**存檔重新載入就會回來**：上面那段
 * 「宣告與值的型別一致時才套用宣告」正是在做這件事。與其在選單那邊複製一份
 * 找 `registered` 的邏輯，不如讓它自己修好。
 */
export function shadowStateFor(kind: ShadowKind, value: unknown): BlockState {
  return { type: DEFAULT_SHADOWS[kind], fields: shadowFields(kind, value) };
}

const DEFAULT_SHADOWS: Record<ShadowKind, string> = {
  text: SHADOW_TEXT,
  number: SHADOW_NUMBER,
  boolean: SHADOW_BOOLEAN,
  null: SHADOW_NULL,
};

/** 空值影子沒有可編輯的欄位（只有一個標籤），所以它的 `fields` 是空的。 */
function shadowFields(kind: ShadowKind, value: unknown): Record<string, unknown> | undefined {
  switch (kind) {
    case 'null':
      return undefined;
    case 'number':
      return { [SHADOW_FIELD]: value };
    case 'boolean':
      return { [SHADOW_FIELD]: value ? BOOLEAN_TRUE : BOOLEAN_FALSE };
    default:
      return { [SHADOW_FIELD]: String(value ?? '') };
  }
}

function requireBlock(project: ProjectIR, id: string): IRBlock {
  const block = project.blocks?.[id];
  if (!block) throw new Error(`找不到積木 ${id}`);
  return block;
}

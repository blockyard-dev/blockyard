/**
 * Blockly → IR（§8.4）。`deserialize.ts` 的反方向。
 *
 * 走的是同一條巢狀 ↔ 扁平的橋，只是方向相反：`Blockly.serialization.blocks
 * .save()` 給出巢狀狀態，這裡把它攤平回 IR 的 `blocks` map，`parent` 就是
 * 「這顆積木是被哪一次遞迴呼叫發現的」——不管是透過 `next`、輸入孔還是
 * C 型堆疊，规则一致（見 `flattenBlock`）。
 *
 * `procedures` 的 `name` / `params` / `returns` 這一步**沒有編輯介面**
 * （mutator 是第 7 步的事），所以當成與 `meta` / `extensions` 同等的
 * passthrough：呼叫端把載入時的原始 `procedures` 傳進來，這裡只重新掃描
 * `definitionBlock` / `body`（那兩個會隨使用者編輯函式體而變，不能 passthrough）。
 */
import * as Blockly from 'blockly/core';
import { SHADOW_FIELD, type RegisteredBlock } from '../blockly/define';
import { isCallType, isDefinitionType, procIdFromType } from '../blockly/procedures';
import type { ConversionContext } from './context';
import { hasInterpolation, isWholeTemplate } from './template';
import type {
  Block as IRBlock,
  BlockInput,
  BlockyProjectIR as ProjectIR,
  LiteralInput,
  Procedure,
  Script,
  StackInput,
  TemplateInput,
} from '../types/project';

type BlockState = Blockly.serialization.blocks.State;
type IRInput = LiteralInput | TemplateInput | BlockInput | StackInput;

export interface SerializeOptions {
  formatVersion?: number;
  meta?: ProjectIR['meta'];
  extensions?: ProjectIR['extensions'];
  /** 載入時的 `project.procedures`，見檔案頂端的說明。 */
  procedures?: Record<string, Procedure>;
}

export function serializeWorkspace(
  workspace: Blockly.Workspace,
  ctx: ConversionContext,
  opts: SerializeOptions = {},
): ProjectIR {
  const blocks: Record<string, IRBlock> = {};
  const scripts: Script[] = [];
  const procedures: Record<string, Procedure> = {};
  const seenProcIds = new Set<string>();
  const passthrough = opts.procedures ?? {};

  for (const top of workspace.getTopBlocks(true)) {
    const state = Blockly.serialization.blocks.save(top, {
      addCoordinates: true,
      addInputBlocks: true,
      addNextBlocks: true,
      doFullSerialization: true,
    });
    if (!state) continue;

    const procId = procIdFromType(state.type);
    if (procId != null && isDefinitionType(state.type)) {
      flattenBlock(state, null, blocks, ctx);
      const meta = passthrough[procId];
      procedures[procId] = {
        name: meta?.name ?? procId,
        params: meta?.params ?? [],
        returns: meta?.returns ?? null,
        definitionBlock: state.id ?? null,
        body: state.next?.block?.id ?? null,
      };
      seenProcIds.add(procId);
      continue;
    }

    // 不是函式定義的頂層積木一律當腳本：形狀對不對是後端存檔時的事
    // （D20），轉換層不重複那份規則（§8.4）。
    flattenBlock(state, null, blocks, ctx);
    scripts.push({
      id: state.data ?? `sc_${Blockly.utils.idGenerator.genUid()}`,
      top: state.id!,
      x: state.x ?? 0,
      y: state.y ?? 0,
      // 省略等於 true（IR 的預設），只在真的停用時才寫這個 key——與題庫的
      // 慣例一致，也讓存出來的 project.json 少一堆雜訊。
      ...(state.enabled === false ? { enabled: false } : {}),
    });
  }

  // 函式還在 `procedures` 裡宣告，但畫布上已經找不到定義積木（被刪了）——
  // 保留這筆記錄而不是默默丟掉，第 7 步的 mutator UI 還需要知道它存在過。
  for (const [id, meta] of Object.entries(passthrough)) {
    if (seenProcIds.has(id)) continue;
    procedures[id] = {
      name: meta.name,
      params: meta.params ?? [],
      returns: meta.returns ?? null,
      definitionBlock: null,
      body: null,
    };
  }

  return {
    formatVersion: opts.formatVersion ?? 1,
    meta: opts.meta ?? {},
    extensions: opts.extensions ?? [],
    // §4.5：只是索引，刪掉重新產生不影響執行語意。變數監看面板要用到之前
    // 都先留空——比起算出一份跟語意無關、卻可能跟這裡的規則慢慢漂移的索引，
    // 空值更誠實。
    variables: {},
    procedures,
    scripts,
    blocks,
  };
}

function flattenBlock(
  state: BlockState,
  parent: string | null,
  out: Record<string, IRBlock>,
  ctx: ConversionContext,
): void {
  const id = state.id;
  if (!id) throw new Error(`Blockly 積木（type=${state.type}）缺少 id`);

  const procId = procIdFromType(state.type);
  const opcode =
    procId != null ? (isDefinitionType(state.type) ? 'procedure.definition' : 'procedure.call') : state.type;
  const registered = ctx.blockOf(state.type);

  const fields = readFields(state, registered);
  if (procId != null && isDefinitionType(state.type)) fields.proc = procId;

  const inputs = readInputs(state, registered, ctx, out, id);

  let next: string | null = null;
  if (state.next?.block) {
    next = state.next.block.id ?? null;
    flattenBlock(state.next.block, id, out, ctx);
  }

  out[id] = {
    opcode,
    parent,
    next,
    inputs,
    fields,
    mutation: procId != null && isCallType(state.type) ? { proc: procId } : null,
    ui: null,
  };
}

/**
 * `field_checkbox` 的序列化值一律是 `'TRUE'` / `'FALSE'` 字串（Blockly 的
 * `FieldCheckbox.getValue()` 從來不回真的布林），但 IR 的 `boolean` 型別是
 * JSON 布林（§4.3）——這裡是唯一需要知道「這個欄位是不是宣告成 boolean」
 * 的地方，所以才需要 `registered.spec.args`。
 */
function readFields(state: BlockState, registered: RegisteredBlock | undefined): Record<string, unknown> {
  const raw = state.fields ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const argType = registered?.spec.args?.[key]?.type;
    out[key] = argType === 'boolean' ? value === 'TRUE' || value === true : value;
  }
  return out;
}

function readInputs(
  state: BlockState,
  registered: RegisteredBlock | undefined,
  ctx: ConversionContext,
  out: Record<string, IRBlock>,
  parentId: string,
): Record<string, IRInput> {
  const raw = state.inputs ?? {};
  const result: Record<string, IRInput> = {};

  for (const [name, conn] of Object.entries(raw)) {
    if (conn.block) {
      const isStack = registered?.spec.args?.[name]?.type === 'stack';
      result[name] = isStack
        ? { kind: 'stack', id: conn.block.id! }
        : { kind: 'block', id: conn.block.id! };
      flattenBlock(conn.block, parentId, out, ctx);
    } else if (conn.shadow) {
      result[name] = readShadowValue(conn.shadow, registered, name);
    }
  }
  return result;
}

/**
 * 影子上那個值該存成 `literal` 還是 `template`，取決於這格是不是數字影子
 * （數字永遠不插值，§4.7 的生效範圍表）以及 manifest 對這個參數的
 * `interpolate` 設定（`code` 型別預設關閉）。
 */
function readShadowValue(
  shadow: BlockState,
  registered: RegisteredBlock | undefined,
  name: string,
): IRInput {
  const raw = shadow.fields?.[SHADOW_FIELD];

  if (typeof raw === 'number') {
    return { kind: 'literal', value: raw };
  }

  const text = String(raw ?? '');
  const arg = registered?.spec.args?.[name];
  const interpolate = arg ? (arg.interpolate ?? arg.type !== 'code') : true;

  if (interpolate && hasInterpolation(text)) {
    return { kind: 'template', value: text, refs: [], whole: isWholeTemplate(text) };
  }
  return { kind: 'literal', value: text };
}

/**
 * Blockly → IR（§8.4）。`deserialize.ts` 的反方向。
 *
 * 走的是同一條巢狀 ↔ 扁平的橋，只是方向相反：`Blockly.serialization.blocks
 * .save()` 給出巢狀狀態，這裡把它攤平回 IR 的 `blocks` map，`parent` 就是
 * 「這顆積木是被哪一次遞迴呼叫發現的」——不管是透過 `next`、輸入孔還是
 * C 型堆疊，规则一致（見 `flattenBlock`）。
 *
 * `procedures` 的 `name` / `params` / `returns` 這一步**沒有編輯介面**
 * （mutator 是第 7 步的事），所以當成與 `meta` 同等的 passthrough：呼叫端把
 * 載入時的原始 `procedures` 傳進來，這裡只重新掃描 `definitionBlock` / `body`
 * （那兩個會隨使用者編輯函式體而變，不能 passthrough）。
 *
 * **`extensions` 不是 passthrough，是從畫布上的積木算出來的**（§13.3）。它曾經
 * 是 passthrough，症狀是 P1 第一個積木包當天就撞到的那件事：從工具箱拉一顆
 * `http.get` 出來、按下執行，後端說「這個版本不認得積木 http.get」——因為
 * 執行只載入專案**宣告過**的包（`conformance.py`、`api/validation.py` 的
 * `only=declared`），而畫布上多了一顆積木從來不會改到那份宣告。使用者做對了
 * 每一步，錯誤卻指著積木。
 */
import * as Blockly from 'blockly/core';
import { REPEAT_KEY, argSpecOf } from '../blockly/repeat';
import { BOOLEAN_TRUE, SHADOW_FIELD, shadowKindOf, type RegisteredBlock } from '../blockly/define';
import { FieldText } from '../blockly/fields/FieldText';
import {
  isCallType,
  isDefinitionType,
  paramRefFromType,
  procIdFromType,
} from '../blockly/procedures';
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
      // **定義帽子的孔是畫面，不是內容**（§4.6）。裡面那幾顆是參數晶片
      // （`blockly/params.ts`），存進 IR 就等於把 `procedures[].params` 存兩份
      // ——兩份遲早會漂移，而其中一份沒有人在讀。與 §4.5 把 `variables` 索引
      // 留空是同一個判斷。
      delete state.inputs;
      flattenBlock(state, null, blocks, ctx, workspace);
      const meta = passthrough[procId];
      procedures[procId] = {
        name: meta?.name ?? procId,
        params: meta?.params ?? [],
        returns: meta?.returns ?? null,
        definitionBlock: state.id ?? null,
        body: state.next?.block?.id ?? null,
        // 位置跟著函式走，不是跟著 `scripts` 走——定義帽子不是腳本（§5.1 的
        // 觸發條件是 top 的 opcode，而它永遠不會被觸發）。不存的話存檔重開
        // 之後每一顆定義帽子都疊在原點。
        x: state.x ?? 0,
        y: state.y ?? 0,
      };
      seenProcIds.add(procId);
      continue;
    }

    // 不是函式定義的頂層積木一律當腳本：形狀對不對是後端存檔時的事
    // （D20），轉換層不重複那份規則（§8.4）。
    flattenBlock(state, null, blocks, ctx, workspace);
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

  // 函式還在 `procedures` 裡宣告，但畫布上已經找不到定義積木——**保留這筆
  // 記錄**而不是默默丟掉。
  //
  // 正常操作已經產不出這種狀態：定義帽子是 `deletable: false` 的，刪除只走
  // 「刪除這個積木…」，而那條路會把宣告一起刪掉（§4.6、`App.tsx` 的
  // `deleteRef`）。剩下的來源是舊專案。丟掉它等於在存檔時安靜地刪掉使用者的
  // 東西，而工具箱照樣列得出它的呼叫積木——讓使用者自己決定要不要用對話框
  // 重建一顆定義帽子，比替他決定好。
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
    extensions: usedExtensions(workspace, ctx),
    // §4.5：只是索引，刪掉重新產生不影響執行語意。變數監看面板要用到之前
    // 都先留空——比起算出一份跟語意無關、卻可能跟這裡的規則慢慢漂移的索引，
    // 空值更誠實。
    variables: {},
    procedures,
    scripts,
    blocks,
  };
}

/**
 * 畫布上真的用到哪幾個積木包（§13.3）。
 *
 * 版本取的是**現在裝著的那一份**，不是載入時宣告的那一份：宣告的意思是
 * 「這份專案需要這個包」，而使用者存檔的當下需要的就是他現在正在用的版本。
 *
 * 用完最後一顆積木、把它刪掉之後宣告也跟著消失——這是刻意的。留著一筆沒有人
 * 用的宣告，代價是「那個包後來被移除」時一份根本用不到它的專案會打不開。
 */
function usedExtensions(
  workspace: Blockly.Workspace,
  ctx: ConversionContext,
): ProjectIR['extensions'] {
  const used = new Map<string, string>();
  for (const block of workspace.getAllBlocks(false)) {
    const manifest = ctx.blockOf(block.type)?.manifest;
    // 內建沒有 `main.py` 也沒有資料夾，不進宣告（`manifest.py` 的 `builtin`）。
    if (!manifest || manifest.builtin) continue;
    used.set(manifest.id, manifest.version);
  }
  return [...used]
    .map(([id, version]) => ({ id, version }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function flattenBlock(
  state: BlockState,
  parent: string | null,
  out: Record<string, IRBlock>,
  ctx: ConversionContext,
  workspace: Blockly.Workspace,
): void {
  const id = state.id;
  if (!id) throw new Error(`Blockly 積木（type=${state.type}）缺少 id`);

  // 函式的三種積木把 id 嵌在 Blockly 的 type 字串裡（`procedures.ts`），IR 的
  // opcode 則是不帶 id 的那一個——反查表就是這三行。
  const paramRef = paramRefFromType(state.type);
  const procId = procIdFromType(state.type);
  const opcode =
    paramRef != null
      ? 'procedure.param'
      : procId != null
        ? isDefinitionType(state.type)
          ? 'procedure.definition'
          : 'procedure.call'
        : state.type;
  const registered = ctx.blockOf(state.type);

  const fields = readFields(state, registered);
  if (procId != null && isDefinitionType(state.type)) fields.proc = procId;

  const inputs = readInputs(state, registered, ctx, out, id, workspace);

  let next: string | null = null;
  if (state.next?.block) {
    next = state.next.block.id ?? null;
    flattenBlock(state.next.block, id, out, ctx, workspace);
  }

  out[id] = {
    opcode,
    parent,
    next,
    inputs,
    fields,
    // 參數以 **id** 記，不是名字：改一次參數名不該讓函式體裡那幾顆積木失聯
    // （`procedures[].params` 是名字的唯一來源）。
    // §16 Q19：可重複群組的份數。`saveExtraState` 在 0 份時回 null，所以
    // **沒按過 `+` 的積木存出來與以前一模一樣**——round-trip 等價（§4.1）沒有
    // 因為這次改版而破掉。
    mutation:
      paramRef != null
        ? { proc: paramRef.procId, param: paramRef.paramId }
        : procId != null && isCallType(state.type)
          ? { proc: procId }
          : repeatMutationOf(state),
    ui: readUi(workspace, id),
  };
}

/**
 * Blockly 的 `extraState` → IR 的 `mutation`（§16 Q19）。
 *
 * 只認得份數那一個 key。`extraState` 是 Blockly 的通用出口，將來有別的東西也
 * 走那裡；這裡**明確只挑出來一個**，而不是整包倒進 `mutation`——後者會讓
 * Blockly 內部的欄位悄悄變成 IR 的一部分，而 IR 是要能手寫的（D1）。
 */
function repeatMutationOf(state: BlockState): Record<string, unknown> | null {
  const raw = (state.extraState as Record<string, unknown> | undefined)?.[REPEAT_KEY];
  return typeof raw === 'number' && raw > 0 ? { [REPEAT_KEY]: raw } : null;
}

/**
 * §8.5 多行的第 3 層（強制切換）→ `blocks[].ui.multiline`（§4.2）。
 *
 * 這是 IR 裡**唯一**的 `ui` key，列的是「要渲染成多行的 input／field 名稱」。
 * 值只從**活的欄位**讀，不從 `blocks.save()` 的狀態讀——`forcedMultiline` 是
 * 欄位的呈現狀態，Blockly 的欄位序列化只存值不存它。
 *
 * 只有「強制打開」存得下來：這個 key 是一份名單，講不出「強制關掉」。第 1 層
 * （manifest 宣告）與第 2 層（值裡有換行）都是每次重算的純函數，本來就不必存。
 */
function readUi(workspace: Blockly.Workspace, id: string): Record<string, unknown> | null {
  const block = workspace.getBlockById(id);
  if (!block) return null;

  const multiline: string[] = [];
  for (const input of block.inputList) {
    for (const field of input.fieldRow) {
      if (field instanceof FieldText && field.getForcedMultiline() && field.name) {
        multiline.push(field.name);
      }
    }
    // 使用者真正打字的地方是**影子上的欄位**（見 define.ts 的 shadowFor），
    // 所以孔的那一筆記的是孔名，不是影子的 blockId——影子換一顆，設定還在。
    const target = input.connection?.targetBlock();
    if (target?.isShadow()) {
      const field = target.getField(SHADOW_FIELD);
      if (field instanceof FieldText && field.getForcedMultiline()) multiline.push(input.name);
    }
  }

  return multiline.length > 0 ? { multiline } : null;
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
    const argType = argSpecOf(registered?.spec, key)?.type;
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
  workspace: Blockly.Workspace,
): Record<string, IRInput> {
  const raw = state.inputs ?? {};
  const result: Record<string, IRInput> = {};

  for (const [name, conn] of Object.entries(raw)) {
    if (conn.block) {
      const isStack = argSpecOf(registered?.spec, name)?.type === 'stack';
      result[name] = isStack
        ? { kind: 'stack', id: conn.block.id! }
        : { kind: 'block', id: conn.block.id! };
      flattenBlock(conn.block, parentId, out, ctx, workspace);
    } else if (conn.shadow) {
      result[name] = readShadowValue(conn.shadow, registered, name);
    }
  }
  return result;
}

/**
 * 影子上那個值該存成什麼（§16 Q16、§4.7）。
 *
 * **型別由影子的種類決定，不由孔的宣告決定**。manifest 的 `type: string` 常常
 * 只是「這個孔用文字框編輯」的通用宣告（`data.set` 的 `value`、`operator.eq`
 * 的 `a`/`b`），不代表存進去的只能是字串——所以使用者把一格切成數字之後，存出
 * 去的就是 JSON number。這與 `deserialize.ts::buildShadowState` 是同一條規則的
 * 兩個方向：**值說了算**。
 *
 * 只有文字影子會走到 `template`：數字、布林、空值都不插值（§4.7 的生效範圍表）。
 */
function readShadowValue(
  shadow: BlockState,
  registered: RegisteredBlock | undefined,
  name: string,
): IRInput {
  const kind = shadowKindOf(shadow.type);
  const raw = shadow.fields?.[SHADOW_FIELD];

  if (kind === 'null') return { kind: 'literal', value: null };
  if (kind === 'boolean') return { kind: 'literal', value: raw === BOOLEAN_TRUE || raw === true };
  // `typeof raw === 'number'` 是給手寫／舊資料的保險：影子種類認不出來、但欄位
  // 裡躺著一個數字時，仍然存成數字而不是 "0"。
  if (kind === 'number' || typeof raw === 'number') {
    return { kind: 'literal', value: typeof raw === 'number' ? raw : Number(raw ?? 0) };
  }

  const text = String(raw ?? '');
  const arg = argSpecOf(registered?.spec, name);
  const interpolate = arg ? (arg.interpolate ?? arg.type !== 'code') : true;

  if (interpolate && hasInterpolation(text)) {
    return { kind: 'template', value: text, refs: [], whole: isWholeTemplate(text) };
  }
  return { kind: 'literal', value: text };
}

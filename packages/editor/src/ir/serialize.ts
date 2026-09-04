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
import {
  PLACEHOLDER_MUTATION,
  isPlaceholderType,
  placeholderVersion,
} from '../blockly/placeholder';
import type { ConversionContext } from './context';
import { hasInterpolation, isWholeTemplate } from './template';
import type {
  Block as IRBlock,
  BlockInput,
  BlockyardProjectIR as ProjectIR,
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
  const seenScriptIds = new Set<string>();
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
      id: scriptIdOf(top, state, seenScriptIds),
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
    extensions: usedExtensions(workspace.getAllBlocks(false), ctx),
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
 * 工具箱裡那一顆積木自己的一小段 IR（§5.1 的「點一下就跑」）。
 *
 * `POST /api/runs` 的 `scratch`，後端那一側是 `runs/scratch.py`。形狀是一份
 * 專案 IR 的**三個 key**，因為它就是那三個 key：這顆積木、它掛的那條腳本、
 * 以及它用到的積木包。剩下的（`variables`、`procedures`、`meta`）一律以存檔
 * 那一份為準——工具箱裡的一顆積木沒有資格改專案的宣告。
 */
export interface ScratchIR {
  blocks: Record<string, IRBlock>;
  scripts: Script[];
  extensions: ProjectIR['extensions'];
}

/**
 * 一顆**不在畫布上**的積木 → 一段跑得動的 IR（§5.1）。
 *
 * 與 `serializeWorkspace` 走同一條 `flattenBlock`，所以工具箱裡那一顆與拉出來
 * 之後的那一顆存出來一模一樣——兩條路各寫一份攤平的話，「拉出來會動、在工具箱
 * 裡點卻不會」這種 bug 就有地方住了。
 *
 * `workspace` 傳的是**這顆積木自己的**工作區（flyout 有它自己的一個），
 * `readUi` 才查得到它。
 */
export function serializeBlock(block: Blockly.Block, ctx: ConversionContext): ScratchIR {
  const state = Blockly.serialization.blocks.save(block, {
    addCoordinates: false,
    addInputBlocks: true,
    addNextBlocks: true,
    doFullSerialization: true,
  });
  if (!state?.id) throw new Error(`積木（type=${block.type}）存不出來`);

  const blocks: Record<string, IRBlock> = {};
  flattenBlock(state, null, blocks, ctx, block.workspace);

  return {
    blocks,
    // **每次點都是一個新的 id，而且不寫回 `block.data`。** 寫回去的話那個 id
    // 會跟著「從工具箱拖出去」複製到畫布上的那一顆身上（`data` 是會被複製
    // 的，見 `scriptIdOf`），於是畫布上憑空多出一條宣稱自己叫 `sc_…` 的腳本
    // ——而那個 id 這輩子只活過一次 Run。
    scripts: [{ id: `sc_${Blockly.utils.idGenerator.genUid()}`, top: state.id, x: 0, y: 0 }],
    extensions: usedExtensions(block.getDescendants(false), ctx),
  };
}

/**
 * 這條腳本的 id。**保證在這份專案裡唯一。**
 *
 * id 記在 Blockly 的 `data` 上（`deserialize.ts` 載入時寫進去），而
 * **`data` 會跟著複製走**——把一條腳本整個複製一份，兩條就有同一個 id。那不是
 * 一個看得出來的錯：兩條腳本都在、都跑得動，但 `thread.start` 的 `scriptId`、
 * 後端的 `_script_of()` 與前端的執行高亮全部拿它當 key，於是兩條 thread 會宣稱
 * 自己是同一條腳本。實測在一份真實專案裡撞到過兩列 `sc_1`。
 *
 * **順手把新 id 寫回 `data`**：不寫的話每次存檔都重配一個，而執行紀錄與高亮
 * 都是照 id 認人的——那會讓「同一條腳本」每存一次就換一次身分。這是這個函式
 * 唯一的副作用，而它修的正是工作區自己的狀態。
 */
function scriptIdOf(top: Blockly.Block, state: BlockState, seen: Set<string>): string {
  const claimed = state.data;
  const id =
    claimed && !seen.has(claimed) ? claimed : `sc_${Blockly.utils.idGenerator.genUid()}`;
  if (id !== claimed) top.data = id;
  seen.add(id);
  return id;
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
  blocks: Blockly.Block[],
  ctx: ConversionContext,
): ProjectIR['extensions'] {
  const used = new Map<string, string>();
  for (const block of blocks) {
    // §13.3：佔位符**照定義就查不到 manifest**（那個包沒裝）。照一般規則走的
    // 話它的宣告會在存檔時安靜消失，於是那份專案從此忘了自己需要哪個包——
    // 「一鍵安裝」沒有東西可以裝，而在裝了那個包的機器上打開也不會載入它。
    // 版本用載入時宣告的那一份，因為我們沒有第二個來源——而猜一個版本比
    // 留著原本那個危險。
    if (isPlaceholderType(block.type)) {
      const id = block.type.split('.', 1)[0]!;
      if (!used.has(id)) used.set(id, placeholderVersion(id) ?? '0.0.0');
      continue;
    }
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
  const extra = state.extraState as Record<string, unknown> | undefined;

  // §13.3：佔位符原封不動把它帶回去。這裡刻意**不看內容**——那個 mutation 是
  // 某個我們不認得的積木包的東西，看得懂它的只有那個包。
  if (isPlaceholderType(state.type)) {
    const kept = extra?.[PLACEHOLDER_MUTATION];
    return kept && typeof kept === 'object' ? (kept as Record<string, unknown>) : null;
  }

  const raw = extra?.[REPEAT_KEY];
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
      const isStack = isStackInput(state, name, registered, workspace);
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
/**
 * 這個孔是 C 型積木的嘴巴（`kind: stack`）還是可求值的孔（`kind: block`）？
 *
 * 一般積木問宣告就好。**佔位符沒有宣告**（那正是它是佔位符的原因），所以改問
 * 那顆積木身上真的接線是什麼型——而那條線是 `placeholder.ts` 依原本的 IR 建出
 * 來的，答案因此仍然來自那份 IR。
 *
 * 少了這一段，一顆認不得的 C 型積木存回去會變成 `kind: block`，於是那疊積木
 * 下次載入時掛在一個求值的孔上——**存檔本身把專案改壞了**，而畫面上什麼都沒說。
 */
function isStackInput(
  state: BlockState,
  name: string,
  registered: RegisteredBlock | undefined,
  workspace: Blockly.Workspace,
): boolean {
  if (registered) return argSpecOf(registered.spec, name)?.type === 'stack';
  if (!isPlaceholderType(state.type)) return false;
  const input = state.id ? workspace.getBlockById(state.id)?.getInput(name) : null;
  return input?.connection?.type === Blockly.ConnectionType.NEXT_STATEMENT;
}

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

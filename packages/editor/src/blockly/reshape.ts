/**
 * 改了簽章之後，畫布上那些積木怎麼跟著變（§8.5）。
 *
 * 函式的每一份簽章各自註冊一組 Blockly 型別（`procedures.ts`），所以改簽章
 * 就是換掉那組定義——但**已經在畫布上的積木不會跟著變**：Blockly 的積木在
 * `init` 的當下就把輸入孔與欄位長好了，重新註冊只影響之後新建的那些。
 *
 * 所以這裡的作法是「存下來、丟掉、照新定義再建一次」，而它必須守住兩件事：
 *
 * - **積木的 id 不變。** IR 的 `scripts[].top`、`procedures[].body` 都指著 id，
 *   換一個 id 等於把使用者的腳本接到別的地方去。
 * - **斷掉的積木留在原地成為孤兒，不刪除**（§8.5 明講靜默刪掉使用者的積木
 *   不可接受）。參數少一個，插在那個孔裡的東西就沒有地方去了——它會被搬到
 *   旁邊當一顆頂層積木並標上警告，而不是消失。
 */
import * as Blockly from 'blockly/core';
import { isDefinitionType, paramRefFromType, procIdFromType } from './procedures';
import { paramsOf } from './signature';
import type { ConversionContext } from '../ir/context';
import type { Procedure } from '../types/project';

type BlockState = Blockly.serialization.blocks.State;

/** 孤兒警告的 id。清除一律帶 id——不帶的 `setWarningText(null)` 是拆掉整顆圖示。 */
export const ORPHAN_WARNING_ID = 'blocky-orphan';

const ORPHAN_MESSAGE = '這顆積木原本插在被改掉的那一格裡。它沒有被刪除——接到別的地方，或自己刪掉它。';

/** 孤兒被放到原位的右下角，免得整整齊齊疊在一起看不出有幾顆。 */
const ORPHAN_OFFSET = 28;

export interface ReshapeResult {
  /** 重建過的積木（含呼叫積木與定義帽子）。 */
  rebuilt: string[];
  /** 被擠出來的積木 id。 */
  orphans: string[];
}

/**
 * 把畫布上屬於這個函式的積木照新簽章重建一次。
 *
 * 包在一個 Blockly event group 裡：改一次簽章在使用者眼裡是一個動作，undo
 * 也該是一次。
 */
export function reshapeProcedure(
  workspace: Blockly.WorkspaceSvg,
  procId: string,
  proc: Procedure,
  ctx: ConversionContext,
): ReshapeResult {
  const keep = new Set(paramsOf(proc).map((param) => param.id));

  // **記 id，不記積木物件。** 重建一顆積木是「丟掉再建一顆」，而 `dispose` 會
  // 連子孫一起收掉——重建帽子的那一下，清單裡排在後面的每一顆都變成了指向死物
  // 的參照。實測回饋抓到的就是這個：改一次參數名，`dispose` 在一顆已經死掉的
  // 積木上炸開（「The block associated with the block move event could not be
  // found」），例外從這裡漏到 `applyProcedure`，於是 `fillDefinitionParams` 與
  // `setState` 都沒跑到——症狀是「帽子上的 reporter 整個不見了」。
  const targetIds = workspace
    .getAllBlocks(false)
    .filter((block) => procIdFromType(block.type) === procId)
    .map((block) => block.id);

  const result: ReshapeResult = { rebuilt: [], orphans: [] };

  Blockly.Events.setGroup(true);
  try {
    for (const id of targetIds) {
      const block = workspace.getBlockById(id) as Blockly.BlockSvg | null;
      // 已經不在了 = 上一次重建把它連帶收掉。帽子孔裡那幾顆參數積木就是這樣
      // 消失的（`'discard'`），而它們由 `fillDefinitionParams` 重新長出來。
      if (!block) continue;

      const ref = paramRefFromType(block.type);
      if (ref !== null) {
        if (!keep.has(ref.paramId)) {
          // 這個參數被刪掉了。**不重建、也不刪除**：留著那顆積木，它上面寫的
          // 是舊名字，而那正是使用者需要看到的線索。與 §8.5 一樣——靜默刪掉
          // 使用者的積木不可接受。
          markOrphan(block);
          result.orphans.push(block.id);
          continue;
        }
        // 改名字了：型別已經重新註冊成新的文字，但畫布上這顆是舊的。
        rebuild(block, 'discard', result, ctx);
        continue;
      }

      if (isDefinitionType(block.type)) {
        rebuildDefinitionHat(block, result, ctx);
        continue;
      }

      const dropped = rebuild(block, keep, result, ctx);
      result.orphans.push(...dropped);
    }
  } finally {
    Blockly.Events.setGroup(false);
  }
  return result;
}

/**
 * 帽子的文字就是簽章，所以它一樣要重建——但**不能把函式體一起帶走**。
 *
 * `rebuild` 是「存下來、`dispose`、照新定義再建一次」，而 `dispose(false)` 連
 * `next` 整條都收掉。函式體跟著被存進帽子的 state、再跟著被重建出來，聽起來沒
 * 問題，但那一份是**照新定義生的、卻帶著舊的孔名**：函式體裡如果有一顆遞迴呼叫
 * 積木，而這次簽章剛好刪掉一個參數，那顆積木的 `inputs` 就指著一個已經不存在的
 * 孔，整個 append 會壞掉——而且壞在使用者看不見的地方。
 *
 * 所以先把函式體摘下來，只重建帽子那一顆，再接回去。摘下來的那些積木**從頭到尾
 * 都是活的**，於是外層迴圈照樣一顆一顆處理得到它們（呼叫積木還要走 `keep` 那條
 * 孤兒規則）。
 *
 * 孔一律 `'discard'`：帽子孔裡是參數積木，是畫面不是內容——丟掉，由
 * `fillDefinitionParams` 照新簽章重新長出來。它們不該變成孤兒。
 */
function rebuildDefinitionHat(
  hat: Blockly.BlockSvg,
  result: ReshapeResult,
  ctx: ConversionContext,
): void {
  const workspace = hat.workspace as Blockly.WorkspaceSvg;
  const id = hat.id;
  const body = hat.nextConnection?.targetBlock() ?? null;
  body?.previousConnection?.disconnect();

  rebuild(hat, 'discard', result, ctx);

  // `rebuild` 保住 id（IR 的 `scripts[].top` / `procedures[].body` 都指著它）。
  const rebuilt = workspace.getBlockById(id) as Blockly.BlockSvg | null;
  if (body && !body.isDisposed() && rebuilt?.nextConnection && body.previousConnection) {
    rebuilt.nextConnection.connect(body.previousConnection);
  }
}

/**
 * 一顆積木：存 → 丟 → 照新定義再建。
 *
 * `keep` 是還留著的孔名。不在名單裡的孔，**只有真的積木**會變成孤兒——影子是
 * 那個孔的一部分，跟著孔一起消失是對的。`'discard'` 是定義帽子那條路：整組孔
 * 連同內容一起丟掉，一顆孤兒都不留（見呼叫端）。
 */
function rebuild(
  block: Blockly.BlockSvg,
  keep: Set<string> | 'discard',
  result: ReshapeResult,
  ctx: ConversionContext,
): string[] {
  const workspace = block.workspace as Blockly.WorkspaceSvg;
  const state = Blockly.serialization.blocks.save(block, {
    addCoordinates: true,
    addInputBlocks: true,
    addNextBlocks: true,
    doFullSerialization: true,
  }) as BlockState | null;
  if (!state) return [];

  const position = block.getRelativeToSurfaceXY();
  const parent = block.outputConnection?.targetConnection
    ?? block.previousConnection?.targetConnection
    ?? null;

  const orphanStates: BlockState[] = [];
  if (keep === 'discard') {
    delete state.inputs;
  } else if (state.inputs) {
    for (const [name, input] of Object.entries(state.inputs)) {
      if (keep.has(name)) continue;
      const child = (input as { block?: BlockState }).block;
      if (child) orphanStates.push(child);
      delete state.inputs[name];
    }
  }

  if (keep !== 'discard') fillNewInputs(state, ctx);

  block.dispose(false);

  // `addCoordinates` 存的是絕對座標，所以重建出來的那顆**落在原來的位置**
  // ——不必再搬一次。接回父積木時 Blockly 自己會把它移過去。
  const rebuilt = Blockly.serialization.blocks.append(state, workspace) as Blockly.BlockSvg;
  result.rebuilt.push(rebuilt.id);

  // 形狀可能變了（command ↔ reporter ↔ boolean），原本那個接點就未必收得下
  // 它。**接不回去不是錯誤**：積木留在原地，使用者看得到它還在哪裡。
  if (parent) {
    const own = rebuilt.outputConnection ?? rebuilt.previousConnection;
    const checker = workspace.connectionChecker;
    if (own && !parent.getSourceBlock().isDisposed() && checker.canConnect(parent, own, false)) {
      parent.connect(own);
    } else {
      markOrphan(rebuilt);
      result.orphans.push(rebuilt.id);
    }
  }

  const orphans: string[] = [];
  orphanStates.forEach((child, index) => {
    // 座標寫進 state 而不是 append 完再搬：孤兒是**被擠出來**的，出現在原本那
    // 顆積木的右下角才看得出它從哪裡來。
    const offset = ORPHAN_OFFSET * (index + 1);
    const restored = Blockly.serialization.blocks.append(
      { ...child, x: position.x + offset, y: position.y + offset },
      workspace,
    ) as Blockly.BlockSvg;
    markOrphan(restored);
    orphans.push(restored.id);
  });
  return orphans;
}

/**
 * 新長出來的孔要補上**預設影子**，不然它是一個打不了字的洞。
 *
 * 症狀（實測回饋）：定義好一顆積木之後回去編輯、加一個參數，畫布上原本那顆
 * 呼叫積木就多一格深色的膠囊——點不進去、也打不了字。
 *
 * 成因是 Blockly 的 JSON 積木定義**沒有地方宣告影子**：影子只能掛在工具箱條目
 * 上（`toolbox.ts::toToolboxBlock`）或序列化狀態裡（`deserialize.ts::shadowUnder`）。
 * 而重塑走的是第三條路——把舊的 state 照新定義 append 一次，那份舊 state 裡當然
 * 沒有新孔的任何東西，於是新孔就空著生出來。
 *
 * 補的是**同一份資料**（`registered.shadows`，manifest 算出來的那份），所以三條
 * 路長出來的積木一致：從工具箱拉的、從檔案載入的、改完簽章重塑的。
 *
 * 只補「這個孔在舊 state 裡完全沒有東西」的那些：孔裡本來插著積木的不動它
 * （那是使用者的內容），宣告成 `boolean` 的孔本來就沒有影子（六角孔是空的），
 * `shadows` 查不到，正是對的。
 */
function fillNewInputs(state: BlockState, ctx: ConversionContext): void {
  const shadows = ctx.blockOf(state.type)?.shadows;
  if (!shadows) return;
  for (const [name, spec] of Object.entries(shadows)) {
    if (state.inputs?.[name]) continue;
    state.inputs ??= {};
    state.inputs[name] = { shadow: { type: spec.type, fields: { ...spec.fields } } };
  }
}

/**
 * 標記一顆孤兒。
 *
 * 這**不是** `ir/checks.ts` 的那種警告。靜態檢查是從工作區推導得出來的結論
 * （少一顆「設定」就會有那個警告，補回去它就消失），而「這顆積木是被重塑踢
 * 出來的」推導不出來——落單堆疊本身完全合法（§4.1）。所以它是**狀態**，得自
 * 己記帳、自己決定什麼時候清掉。
 */
export function markOrphan(block: Blockly.BlockSvg): void {
  block.setWarningText(ORPHAN_MESSAGE, ORPHAN_WARNING_ID);
}

/**
 * 使用者一碰那顆積木就把警告清掉。
 *
 * `inert.ts` 就是死在「標得上、清不掉」（它只掃頂層積木，積木一被接起來就再
 * 也清不到那顆圖示）。這裡反過來：**寧可太早清，也不要留下一個拆不掉的圖示**
 * ——孤兒警告要說的是「這顆積木剛剛被擠出來了」，使用者一旦動到它，那句話就
 * 已經說完了。
 */
export function watchOrphans(workspace: Blockly.WorkspaceSvg): () => void {
  const listener = (event: Blockly.Events.Abstract) => {
    if (
      event.type !== Blockly.Events.BLOCK_MOVE
      && event.type !== Blockly.Events.BLOCK_CHANGE
      && event.type !== Blockly.Events.CLICK
    ) {
      return;
    }
    const id = (event as { blockId?: string }).blockId;
    if (!id) return;
    const block = workspace.getBlockById(id);
    // 連根一起清：使用者拖的可能是孤兒裡面的某一顆子積木。
    let cursor: Blockly.Block | null = block;
    while (cursor) {
      cursor.setWarningText(null, ORPHAN_WARNING_ID);
      cursor = cursor.getParent();
    }
  };

  workspace.addChangeListener(listener);
  return () => workspace.removeChangeListener(listener);
}

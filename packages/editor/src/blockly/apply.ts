/**
 * 對話框按下確定：建立或改一個函式（§8.5、D26）。
 *
 * **這裡是那件事唯一的順序。** 以前它寫在 `App.tsx` 的 callback 裡，而
 * `params.test.ts` 抄了一份同樣的三步——兩份會漂移，而漂移的那天測試仍然是綠
 * 的：`reshapeProcedure` 有 9 題、`fillDefinitionParams` 有 6 題，全綠，而第七輪
 * 那個 bug 出在「把它們接起來」的那條縫上（PROGRESS §2.4）。順序本身要有一個家，
 * 測試才驗得到真的那一份。
 *
 * 順序有講究——**先註冊型別，再動畫布**。`reshapeProcedure` 是「存下來、丟掉、
 * 照新定義再建一次」，而「新定義」要在那之前就已經註冊好，不然重建出來的還是
 * 舊形狀。
 *
 * 存檔不在這裡：新的 `procedures` 回給呼叫端進 React state，下一次 `save()` 自然
 * 帶著走（`serializeWorkspace` 的 `procedures` passthrough）。按下確定就送 PUT 會
 * 讓「改個名字」變成一次網路往返，而使用者可能只是在試。
 */
import * as Blockly from 'blockly/core';
import { fillDefinitionParams } from './params';
import { definitionType, registerProcedures } from './procedures';
import { reshapeProcedure } from './reshape';
import { buildContext, type ConversionContext } from '../ir/context';
import type { RegisteredBlock } from './define';
import type { Procedure } from '../types/project';

export interface ApplyProcedureOptions {
  workspace: Blockly.WorkspaceSvg;
  /** 目前這份專案的全部函式（**還沒改的**那一版）。 */
  procedures: Record<string, Procedure>;
  /** 要改的那一個；`null` = 建立一個新的。 */
  procId: string | null;
  /** 對話框交出來的簽章。`body` / `definitionBlock` 不在裡面，見下。 */
  edited: Pick<Procedure, 'name' | 'params' | 'returns'>;
  /** manifest 註冊出來的那些積木——`ctx` 要把它們與函式積木併起來。 */
  blocks: readonly RegisteredBlock[];
  /** 定義帽子拖進垃圾桶時走的那條路（`App.tsx` 的 `deleteRef`）。 */
  onTrash?: (procId: string) => void;
}

export interface ApplyProcedureResult {
  /** 這次動到的函式；新建時是剛生出來的那個 id。 */
  procId: string;
  /** 新的那一份 `procedures`，給呼叫端進 state。 */
  procedures: Record<string, Procedure>;
  /** 重新註冊出來的函式積木，給呼叫端重建工具箱。 */
  procedureBlocks: RegisteredBlock[];
  ctx: ConversionContext;
}

export function applyProcedure(options: ApplyProcedureOptions): ApplyProcedureResult {
  const { workspace, edited, blocks, onTrash } = options;
  const isNew = options.procId === null;
  const procId = options.procId ?? newProcId(options.procedures);
  const previous = options.procedures[procId];

  const procedures: Record<string, Procedure> = {
    ...options.procedures,
    // `body` / `definitionBlock` 由 `serializeWorkspace` 從畫布重新算出來
    // （§8.4），這裡只是把上一版的值帶著走，不是它們的真實來源。
    [procId]: {
      ...edited,
      body: previous?.body ?? null,
      definitionBlock: previous?.definitionBlock ?? null,
    },
  };
  const proc = procedures[procId]!;

  const procedureBlocks = registerProcedures(procedures);
  const ctx = buildContext([...blocks, ...procedureBlocks]);

  if (isNew) {
    placeDefinition(workspace, procId);
    // 新帽子的孔是空的——照簽章長回去。改簽章那條不必在這裡補：重塑自己收尾。
    fillDefinitionParams(workspace, { [procId]: proc }, onTrash);
  } else {
    // `ctx` 要新的那一份：重塑要照**新簽章**補影子（新長出來的孔沒有影子就是
    // 一個打不了字的洞），而那份資料在 `procedureBlocks` 裡。
    reshapeProcedure(workspace, procId, proc, ctx, onTrash);
  }

  return { procId, procedures, procedureBlocks, ctx };
}

/**
 * 新函式的 id。
 *
 * `genUid()` 的字元集裡有 `#` `|` `=` 這些東西，而函式 id 會出現在兩個看得見
 * 的地方：`project.json` 的 key（人會讀它）與 Blockly 的型別字串
 * （`procedure.call#p_x`）。留下英數字就好——它只需要唯一，不需要熵。
 */
function newProcId(existing: Record<string, Procedure>): string {
  for (;;) {
    const id = `p_${Blockly.utils.idGenerator.genUid().replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)}`;
    if (id.length >= 6 && !(id in existing)) return id;
  }
}

/**
 * 新函式的定義帽子放上畫布。
 *
 * 放在**視野的左上角附近**而不是 (0,0)：使用者按下確定的當下正在看某個地方，
 * 而一顆出現在畫布外的積木等於沒有出現——他會以為按鈕壞了。
 */
function placeDefinition(workspace: Blockly.WorkspaceSvg, procId: string): void {
  const block = workspace.newBlock(definitionType(procId)) as Blockly.BlockSvg;
  block.initSvg();
  block.render();
  const view = workspace.getMetricsManager().getViewMetrics(true);
  block.moveTo(new Blockly.utils.Coordinate(view.left + 48, view.top + 48));
  block.select();
}

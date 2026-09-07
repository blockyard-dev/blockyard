/**
 * 把畫布重畫一次，用**新的積木定義**（`docs/extension-design.md` §4）。
 *
 * 更新一個積木包會把 `Blockly.Blocks[type]` 換掉，但**已經在畫布上的那幾顆是
 * 用舊定義建出來的**——Blockly 沒有「重新 init 一顆積木」這種東西。所以要讓
 * 使用者看到新的字、新的孔，唯一的路是把它們整批重建：導出成 IR，再用新的
 * `ctx` 讀回來。那正是「打開一個專案」走的那條路，而它已經測過（`roundtrip`）。
 *
 * **這件事只在使用者親手更新之後做。** 背景那條（切回瀏覽器時重問一次後端）
 * 一個字都不動畫布——那條規則沒有變，變的是「使用者剛剛按下更新」不再屬於
 * 「他沒有要求」。
 *
 * ## 為什麼要先空跑一次
 *
 * 新版少了一格參數的時候，舊的 IR 裡那個孔的名字在新定義上不存在，而
 * `serialization.blocks.append` 對這種狀況是**丟例外**。如果那一下發生在
 * `workspace.clear()` 之後，使用者的畫布就空了——而那是這整條路上唯一一件
 * 真的會弄丟東西的事。
 *
 * 所以先在一個**沒有畫面的暫時工作區**上讀一次：讀得起來才動真的那一個，讀
 * 不起來就一個字都不碰、回 `false`，讓呼叫端說一句老實話。空跑的成本是把同
 * 一份 IR 建兩次，而那發生在使用者按下更新之後的那一刻——他本來就在等。
 */
import * as Blockly from 'blockly/core';
import { loadProject } from '../ir/deserialize';
import type { ConversionContext } from '../ir/context';
import type { BlockyardProjectIR as ProjectIR } from '../types/project';

export interface RebuildOptions {
  /**
   * **要的是 `Workspace` 不是 `WorkspaceSvg`**：這個函式只動積木那一層。
   * 「捲到哪裡、放多大」是畫面的事，由呼叫端（`App`）在外面收——它才知道
   * 使用者現在在看什麼，而這裡收的話這條路就只能在有畫面的地方測。
   */
  workspace: Blockly.Workspace;
  /** 現在這份畫布導出來的 IR（用**舊的** ctx 導，因為畫布上還是舊的那幾顆）。 */
  project: ProjectIR;
  /** 新的轉換 context（用**新的**宣告建的）。 */
  ctx: ConversionContext;
  /** 載入之後要補的東西（帽子上的參數晶片那些）。與開專案那條路同一份。 */
  after?: (workspace: Blockly.Workspace) => void;
}

/** 重畫成功回 `true`；讀不起來就什麼都沒動，回 `false`。 */
export function rebuildCanvas({ workspace, project, ctx, after }: RebuildOptions): boolean {
  if (!dryRun(project, ctx)) return false;

  workspace.clear();
  loadProject(project, workspace, ctx);
  after?.(workspace);

  // **undo 從這裡重新開始。** 不清的話，堆疊裡那些步驟指著的是剛剛被 dispose
  // 掉的積木——按下 Ctrl+Z 會得到一個沒有人能解釋的畫面。更新本來就不是一個
  // 可以復原的動作（磁碟上那份已經換了），所以誠實地斷在這裡。
  workspace.clearUndo();
  return true;
}

/**
 * 在一個沒有畫面的工作區上讀一次，看讀不讀得起來。
 *
 * `Blockly.Workspace`（不是 `WorkspaceSvg`）不需要 DOM，建立與丟棄都很便宜，
 * 而 `append` 該丟的例外一個都不會少——它是在連接那一層丟的，跟有沒有畫面
 * 無關。
 */
function dryRun(project: ProjectIR, ctx: ConversionContext): boolean {
  const scratch = new Blockly.Workspace();
  try {
    loadProject(project, scratch, ctx);
    return true;
  } catch {
    return false;
  } finally {
    scratch.dispose();
  }
}

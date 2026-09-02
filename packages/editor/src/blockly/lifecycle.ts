/**
 * 刪掉一個函式跨了**兩本帳**，而 Ctrl+Z 只退得回其中一本。
 *
 * 定義帽子在 Blockly 的工作區上（§8.2：uncontrolled，Blockly 自己管 undo），
 * 那筆 `procedures` 宣告在 React 的 state 裡。`App.tsx` 的 `deleteRef` 一次動
 * 兩邊，但 undo 只認得 Blockly 那一邊——於是按下 Ctrl+Z 之後帽子回到畫布上，
 * 而那個函式**已經不存在了**。實測回饋的兩句話是同一件事的兩個切面：
 *
 * - 「定義 function 會回來但是工作區積木不會」——工具箱的「函式」分類裡少了
 *   那顆呼叫積木（它是從 `procedures` 算出來的），`ctx` 也查不到那個型別，
 *   所以那顆帽子存出去會退化成 `{ name: <proc id>, params: [] }`
 *   （`ir/serialize.ts` 的 passthrough 補洞路徑）。
 * - 「定義那個還原之後還會遇到刪除不了」——帽子是 `deletable: false` 的
 *   （`procedures.ts`），唯一的刪除入口是右鍵與拖進垃圾桶，而垃圾桶那條靠
 *   `TrashAwareDragStrategy`（`params.ts`）。拖曳策略**存不進序列化狀態**，
 *   所以還原出來的帽子拖到垃圾桶上什麼事都不會發生。
 *
 * 修法不是「讓刪除不進 undo 堆疊」（那只會讓帽子刪不回來），而是**讓宣告跟著
 * 帽子走**：帽子在畫布上就該有那筆宣告，不在就不該有。這裡是那條規則，
 * `App.tsx` 負責在 `BLOCK_CREATE` / `BLOCK_DELETE` 時問它一次，redo 因此也免費
 * 對了——它問的是「現在畫布上有沒有」，不是「剛剛發生了什麼」。
 *
 * **只管我們自己刪過的那幾個**（`trashed`）。畫布上有帽子、宣告裡沒有，另一個
 * 來源是壞掉的舊專案；而宣告裡有、畫布上沒有，`ir/serialize.ts` 明講要**保留**
 * （舊專案，讓使用者自己決定要不要重建一顆帽子）。沒有這道閘，這個模組會在載
 * 入舊專案時安靜地刪掉那些宣告。
 */
import type * as Blockly from 'blockly/core';
import { definitionType } from './procedures';
import type { Procedure } from '../types/project';

/**
 * 把 `declared` 對齊「畫布上現在有哪些定義帽子」，回傳新的一份；沒有差異就
 * 回 `null`——呼叫端靠它決定要不要 `setState`，而這個函式在每一次
 * `BLOCK_CREATE` / `BLOCK_DELETE` 都會被問到（補孔自己也會發 `BLOCK_CREATE`）。
 *
 * `archive` 是「每個看過的函式的最後一份簽章，含已經刪掉的」。宣告要放回去時
 * 名稱、參數、回傳型別都得從那裡來——被刪掉的那一刻它們就從 state 裡消失了，
 * 而 IR 說不出它們（帽子的孔是畫面不是內容，§4.6）。查不到就**不動**：寧可
 * 留一顆孤兒帽子，也不要生一個名字是亂碼的函式。
 */
export function syncTrashedProcedures(
  workspace: Blockly.Workspace,
  trashed: Iterable<string>,
  declared: Record<string, Procedure>,
  archive: Record<string, Procedure>,
): Record<string, Procedure> | null {
  const next = { ...declared };
  let changed = false;

  for (const procId of trashed) {
    const onCanvas = workspace.getBlocksByType(definitionType(procId), false).length > 0;
    if (onCanvas === procId in next) continue;

    if (onCanvas) {
      const archived = archive[procId];
      if (!archived) continue;
      next[procId] = archived;
    } else {
      delete next[procId];
    }
    changed = true;
  }

  return changed ? next : null;
}

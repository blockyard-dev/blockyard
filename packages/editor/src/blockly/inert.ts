/**
 * 落單堆疊的警告圖示（§4.1）。
 *
 * §4.1 決定了「沒有 hat 的頂層堆疊是合法 IR」，所以編輯器不能擋它——但也不能
 * 什麼都不說：那條堆疊按綠旗永遠不會跑，而畫面上看不出這件事。做法是一個
 * warning icon（§4.5 既有的機制），**不阻擋任何操作**。
 *
 * 文案順帶把 §5.1 的「點一下就跑」講出來。這是使用者最可能第一次遇到落單堆疊
 * 的時刻——他剛拉出幾顆積木想試試看，而「點它就能單獨執行」正是他要的答案。
 */
import type * as Blockly from 'blockly/core';
import type { ConversionContext } from '../ir/context';

/**
 * 警告的 id。Blockly 的 warning 可以有多筆，各自一個 id——這條與存檔失敗時
 * 標在積木上的 422 訊息（用預設 id）互不覆蓋。
 */
export const INERT_WARNING_ID = 'blocky-inert';

/**
 * 存檔驗證（422）標在積木上的訊息用的 id。
 *
 * 它必須與 `INERT_WARNING_ID` 分開，而且**清除時一定要帶 id**：Blockly 的
 * `setWarningText(null)` 不帶 id 是「把整顆警告圖示拆掉」，會順手清掉落單堆疊
 * 的警告——症狀是存一次檔，畫布上的 ⚠ 全部消失，直到下一次改動才回來。
 */
export const SAVE_WARNING_ID = 'blocky-save';

const STACK_HINT = '這個堆疊最上面沒有事件積木，按 ▶ 執行不會跑到它。點它就能單獨執行。';
const VALUE_HINT = '這顆積木沒有接在任何地方，按 ▶ 執行不會用到它。點它就能單獨求值。';

/**
 * 掃一遍頂層積木，替沒有 hat 的堆疊掛上警告、替其餘的拆掉。
 *
 * 形狀來自 manifest（`ctx`），與後端載入期驗證的來源是同一份宣告（D21）。
 * 查不到宣告的積木**不標**：那是 §13.3 的佔位符，它已經有自己的錯誤了。
 */
export function markInertStacks(workspace: Blockly.WorkspaceSvg, ctx: ConversionContext): void {
  for (const top of workspace.getTopBlocks(false)) {
    const shape = ctx.blockOf(top.type)?.spec.type;
    const hint = shape === 'hat' || shape === undefined
      ? null
      : shape === 'command'
        ? STACK_HINT
        : VALUE_HINT;
    top.setWarningText(hint, INERT_WARNING_ID);
  }
}

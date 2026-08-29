/**
 * 對話框的鍵盤路徑（§8.5 第 8 步）：Esc 關、Enter 確定、Tab 走不出去。
 *
 * 決定寫成純函數而不是散在 handler 裡，理由是這裡每一條都是**「這一下該歸誰」**
 * 的判斷，而錯的那一半不會壞掉、只會很難用：Esc 在欄位編輯器開著的時候關掉整
 * 個對話框，使用者就是打到一半按了取消。所以「欄位編輯器開著時什麼都不接」是
 * 這個檔案的第一條規則——Blockly 的 `WidgetDiv` 自己接 Esc 與 Enter（還有
 * autocomplete 的上下鍵），那些鍵在那一刻已經有主人了。
 *
 * DOM 那一半（誰是 focusable、focus 給誰）留在 `ProcedureModal`，這裡只回答
 * 「該做什麼」與「下一個是第幾個」。
 */

/** 這一下鍵盤該做什麼。`null` = 不歸對話框管，讓它照原本的路走。 */
export type ModalKeyAction = 'cancel' | 'submit' | 'focus-next' | 'focus-prev' | null;

export interface ModalKeyContext {
  key: string;
  shiftKey: boolean;
  /** Blockly 的欄位編輯器（`WidgetDiv`）開著。 */
  editing: boolean;
  /**
   * 焦點在預覽工作區裡（但沒有欄位在編輯）。
   *
   * 只擋 Enter：Blockly 自己的鍵盤導覽用 Enter 進入一顆積木／打開一格欄位，
   * 而使用者在那一刻想的是「編輯這一格」不是「這個對話框確定了」。Esc 與
   * Tab 仍然是對話框的——一個關不掉的 modal 比一次誤送嚴重。
   */
  inWorkspace: boolean;
  /** 事件落在哪一種元素上（`tagName` 小寫）。 */
  target: string | null;
}

/**
 * 焦點在這幾種元素上時 **Enter 不是「確定」**。
 *
 * 按鈕與連結上的 Enter 本來就是「按下它」——取消鍵上按 Enter 變成確定，是這
 * 條規則能造成的最糟的一種結果。`select` 是因為展開中的下拉自己要吃 Enter，
 * `textarea` 是因為那裡的 Enter 是換行。
 */
const ENTER_BELONGS_TO = new Set(['button', 'a', 'select', 'textarea']);

export function modalKeyAction(ctx: ModalKeyContext): ModalKeyAction {
  // 欄位編輯器開著的時候，鍵盤是 Blockly 的（Esc 取消這一格的編輯、Enter 提交、
  // 上下鍵選 autocomplete）。對話框在這一刻一個鍵都不接。
  if (ctx.editing) return null;

  switch (ctx.key) {
    case 'Escape':
      return 'cancel';
    case 'Tab':
      return ctx.shiftKey ? 'focus-prev' : 'focus-next';
    case 'Enter':
      if (ctx.inWorkspace) return null;
      return ENTER_BELONGS_TO.has(ctx.target ?? '') ? null : 'submit';
    default:
      return null;
  }
}

/**
 * focus trap 的算術那一半：`count` 個可聚焦元素裡，從第 `current` 個往哪走。
 *
 * `current` 是 −1（焦點不在對話框裡，例如剛開啟）時往前走到第一個、往後走到
 * 最後一個——「Tab 進來就落在第一個」與「Shift+Tab 進來就落在最後一個」是同
 * 一條規則的兩半。
 */
export function nextFocusIndex(count: number, current: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return (current + (backwards ? -1 : 1) + count) % count;
}

/**
 * 對話框裡現在可以聚焦的元素，照 DOM 順序。
 *
 * `disabled` 的「確定」（簽章還不能存的時候）要跳過——不然 Tab 會停在一顆按不
 * 下去的按鈕上。`tabIndex < 0` 的也跳過：浮動工具列那三顆是滑鼠專用的（它們
 * 只在點進一格時才存在，而那一刻焦點屬於那一格的欄位）。
 *
 * **Blockly 畫出來的東西也跳過**，判準是「不是 HTMLElement」——預覽工作區是
 * 一個帶 tabindex 的 SVG `<g>`，而它是清單裡唯一的非 HTML 元素。實測不篩會壞
 * 掉整個 trap：Tab 到那個 `<g>` 時 Blockly 自己把焦點移到別的 SVG 節點上，於是
 * 下一次 Tab 找不到「現在在第幾個」、永遠回到第一個——`×` 與工作區之間來回
 * 彈，後面的按鈕一個都到不了。代價是鍵盤走不進預覽積木（記在 PROGRESS）。
 */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  const selector = 'button, [href], input, select, textarea, [tabindex]';
  return [...root.querySelectorAll<HTMLElement>(selector)].filter(
    (el) => el instanceof HTMLElement && !el.hasAttribute('disabled') && el.tabIndex >= 0,
  );
}

/**
 * 對話框的鍵盤路徑（§8.5 第 8 步）。
 *
 * 測的是**「這一下歸誰」**，不是「按下去發生什麼」——後者要 DOM，而這裡每一
 * 條錯的方式都一樣：把一個已經有主人的鍵搶過來。
 */
import { describe, expect, it } from 'vitest';
import { modalKeyAction, nextFocusIndex, type ModalKeyContext } from './modalKeys';

function key(over: Partial<ModalKeyContext> & { key: string }): ModalKeyContext {
  return { shiftKey: false, editing: false, inWorkspace: false, target: 'div', ...over };
}

describe('這一下歸誰（modalKeyAction）', () => {
  it('Esc 關、Enter 確定', () => {
    expect(modalKeyAction(key({ key: 'Escape' }))).toBe('cancel');
    expect(modalKeyAction(key({ key: 'Enter' }))).toBe('submit');
  });

  it('欄位編輯器開著時一個鍵都不接', () => {
    // 那一刻 Esc 是「取消這一格的編輯」、Enter 是「提交這一格」、上下鍵是
    // autocomplete 的——搶過來等於使用者打到一半按了取消。
    for (const k of ['Escape', 'Enter', 'Tab']) {
      expect(modalKeyAction(key({ key: k, editing: true }))).toBeNull();
    }
  });

  it('按鈕與下拉上的 Enter 是那顆按鈕的', () => {
    // 「取消」上按 Enter 變成「確定」是這條規則能造成的最糟的一種結果。
    expect(modalKeyAction(key({ key: 'Enter', target: 'button' }))).toBeNull();
    expect(modalKeyAction(key({ key: 'Enter', target: 'select' }))).toBeNull();
    expect(modalKeyAction(key({ key: 'Enter', target: 'textarea' }))).toBeNull();
  });

  it('焦點在預覽工作區裡時只讓出 Enter', () => {
    // Blockly 的鍵盤導覽用 Enter 打開一格欄位。Esc 與 Tab 仍然是對話框的：
    // 一個關不掉的 modal 比一次誤送嚴重。
    expect(modalKeyAction(key({ key: 'Enter', inWorkspace: true }))).toBeNull();
    expect(modalKeyAction(key({ key: 'Escape', inWorkspace: true }))).toBe('cancel');
    expect(modalKeyAction(key({ key: 'Tab', inWorkspace: true }))).toBe('focus-next');
  });

  it('Tab 與 Shift+Tab 是兩個方向', () => {
    expect(modalKeyAction(key({ key: 'Tab' }))).toBe('focus-next');
    expect(modalKeyAction(key({ key: 'Tab', shiftKey: true }))).toBe('focus-prev');
  });

  it('其他鍵一律放行', () => {
    expect(modalKeyAction(key({ key: 'a' }))).toBeNull();
    expect(modalKeyAction(key({ key: 'ArrowDown' }))).toBeNull();
  });
});

describe('focus trap 的算術（nextFocusIndex）', () => {
  it('走到底會繞回來', () => {
    expect(nextFocusIndex(3, 2, false)).toBe(0);
    expect(nextFocusIndex(3, 0, true)).toBe(2);
  });

  it('焦點還不在對話框裡（−1）時進到頭或尾', () => {
    expect(nextFocusIndex(3, -1, false)).toBe(0);
    expect(nextFocusIndex(3, -1, true)).toBe(2);
  });

  it('一個可聚焦元素都沒有時不動', () => {
    expect(nextFocusIndex(0, -1, false)).toBe(-1);
  });
});

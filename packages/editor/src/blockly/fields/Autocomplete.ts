/**
 * 欄位編輯中的自動完成清單（§8.5）。
 *
 * 這個檔案**不認識 `FieldText`**，也不認識變數：它只知道「一份字串清單、一個
 * 選中的索引、使用者按了哪個鍵」。`FieldText` 負責決定什麼時候開、清單從哪
 * 來、選中之後怎麼改字。分開的理由很實際——popup 的定位與鍵盤處理是這一步
 * 最容易寫錯的地方，把它關在一個沒有其他責任的檔案裡才試得出對錯。
 *
 * **掛在 `WidgetDiv` 底下**，不是 `document.body`：
 *
 * - `WidgetDiv` 已經被 Blockly 定位在那顆欄位上，而且會隨畫布捲動與縮放一起
 *   移動。自己算座標的話就要重做一次 `RunBubbles.tsx` 那個 rAF 迴圈，而那是
 *   為了「HTML 疊在 SVG 旁邊」才需要的；這裡疊的對象是 HTML，不必。
 * - `WidgetDiv.hide()` 會清空 innerHTML，所以欄位一收起來 popup 就跟著消失，
 *   不需要另外記得關。這條省掉的是「編輯器關了 popup 還留在畫面上」那類
 *   只有在特定順序下才重現的 bug。
 *
 * 字級寫死 px：`WidgetDiv` 的 `font-size` 是 Blockly 依畫布縮放算出來的 pt
 * （見 `widgetCreate_`），繼承它會讓清單在放大的畫布上變成巨大的字。
 */
import * as Blockly from 'blockly/core';

const CLASS = 'blockyard-autocomplete';

export interface AutocompleteHandle {
  /** 目前選中的項目，沒有就是 `null`。 */
  current(): string | null;
  /** 上下移動選取。 */
  move(delta: number): void;
  /** 換一份清單；空清單等於關掉。 */
  update(items: string[]): void;
  close(): void;
  isOpen(): boolean;
}

export interface AutocompleteOptions {
  /** 使用者點了某一項（鍵盤的 Enter/Tab 由呼叫端自己處理）。 */
  onPick(item: string): void;
}

/**
 * 開一份清單。回傳的 handle 是**唯一**的操作入口——`FieldText` 不碰 DOM。
 *
 * 傳空清單也會回一個 handle（`isOpen()` 為 false），呼叫端因此不需要在每個
 * 分支上分辨「有沒有開成」。
 */
export function openAutocomplete(
  items: string[],
  options: AutocompleteOptions,
): AutocompleteHandle {
  const host = Blockly.WidgetDiv.getDiv();
  let list: HTMLDivElement | null = null;
  let entries: string[] = [];
  let index = 0;

  const render = () => {
    if (!list) return;
    list.textContent = '';
    entries.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = i === index ? `${CLASS}-item ${CLASS}-item-on` : `${CLASS}-item`;
      row.textContent = item;
      // mousedown 而不是 click：click 之前欄位已經因為失焦而提交，那時候再改
      // 值就是改到一個已經關掉的編輯器上。preventDefault 同時擋掉失焦本身。
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        options.onPick(item);
      });
      list!.appendChild(row);
    });
  };

  const close = () => {
    list?.remove();
    list = null;
    entries = [];
  };

  const update = (next: string[]) => {
    entries = next;
    index = 0;
    if (entries.length === 0) {
      close();
      return;
    }
    if (!list) {
      if (!host) return;
      list = document.createElement('div');
      list.className = CLASS;
      host.appendChild(list);
    }
    render();
  };

  update(items);

  return {
    isOpen: () => list !== null,
    current: () => (list ? (entries[index] ?? null) : null),
    move: (delta) => {
      if (!list || entries.length === 0) return;
      index = (index + delta + entries.length) % entries.length;
      render();
      list.children[index]?.scrollIntoView({ block: 'nearest' });
    },
    update,
    close,
  };
}

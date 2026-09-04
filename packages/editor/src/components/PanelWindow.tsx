/**
 * 彈出視窗（§8.3）。同源的 about:blank + `createPortal`。
 *
 * **為什麼是按鈕開，不是積木開。** `window.open` 需要使用者手勢，而那個授權會
 * 過期（transient activation，Chrome 大約 5 秒）。按下執行是一個點擊沒錯，但一顆
 * 畫圖積木跑到第 30 秒才執行時授權早就用掉了——視窗會被擋掉，**而且是靜默
 * 的**。所以積木只說「想畫到哪」（`target`），開窗是這顆按鈕的事；視窗沒開時
 * `target: window` 的面板退回右側，不報錯。
 *
 * **同源同 realm 是它便宜的原因**：zustand 的 store 直接讀得到，不必為這扇窗
 * 另開一條資料通道。而同源同 realm 也正是它**絕對不能拿來跑積木包程式碼**的
 * 原因——這裡畫的永遠是編輯器自己的 React，積木包送進來的是資料（`ctx.panel()`
 * 走 `panels.py` 的封頂字彙表），不是 UI。
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { readPref, writePref } from '../prefs';

const SIZE_PREF = 'panelWindowSize';
const DEFAULT_SIZE = { w: 900, h: 640 };

export interface PanelWindowProps {
  onClose: () => void;
  children: React.ReactNode;
}

export function PanelWindow({ onClose, children }: PanelWindowProps) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const size = readPref(SIZE_PREF, DEFAULT_SIZE);
    const win = window.open(
      '',
      'blockyard-panels',
      `popup=yes,width=${size.w},height=${size.h}`,
    );
    // 被擋掉就是被擋掉——沒有第二條路（再試一次也一樣沒有手勢）。回報給呼叫端，
    // 它會把狀態切回去，面板留在右側。
    if (!win) {
      onClose();
      return;
    }

    win.document.title = '面板 — Blockyard Workflow';
    // 樣式不會跟著 portal 走：新 document 的 head 是空的。dev 是 Vite 注入的
    // `<style>`、build 是 `<link>`，所以兩種都抄。抄的是節點的複本，原本那些
    // 留在主視窗上。
    for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) {
      win.document.head.appendChild(node.cloneNode(true));
    }
    // 那扇窗的 body 自己管住捲動與邊界。**不靠編輯器那條 `html, body, #root`
    // 恰好也適用**——它是為了主視窗寫的，哪天有人改它，這裡會安靜地多出一條
    // 捲軸，而症狀是「圖被切掉一點」。
    win.document.body.classList.add('panel-window-body');
    const mount = win.document.createElement('div');
    mount.className = 'panel-window';
    win.document.body.appendChild(mount);
    setHost(mount);

    // 使用者自己關掉那扇窗（右上角的 ✕）也要讓狀態跟上，不然按鈕會一直說
    // 「關閉視窗」而那扇窗已經不在了。
    win.addEventListener('pagehide', onClose);
    // 尺寸記在偏好：他拉一次，以後每次都是那個大小（§16 Q15）。
    win.addEventListener('resize', () => {
      writePref(SIZE_PREF, { w: win.outerWidth, h: win.outerHeight });
    });
    // **主視窗重整時要把它一起關掉。** 不關的話那扇窗會留著，而它的 React root
    // 已經死了——使用者盯著一個永遠不再更新的畫面。
    const closeIt = () => win.close();
    window.addEventListener('beforeunload', closeIt);

    return () => {
      window.removeEventListener('beforeunload', closeIt);
      win.removeEventListener('pagehide', onClose);
      win.close();
    };
    // onClose 是呼叫端每次 render 都新的一個函式也沒關係：這條 effect 只跑一次
    // （開一扇窗是一次性的動作），所以依賴刻意留空。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return host ? createPortal(children, host) : null;
}

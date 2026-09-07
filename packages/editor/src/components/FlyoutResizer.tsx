/**
 * 積木面板右緣的那條把手：拖曳改寬度，拉到 0 就整條收起來。
 *
 * 面板的寬度**不由內容決定**（見 `theme.ts` 的 `FLYOUT_DEFAULT_WIDTH`：一顆很
 * 長的積木不該吃掉半個畫布），代價是「那一顆在面板裡看不完整」。這條把手是那
 * 個代價的出口——想看完整就拉寬，不看了就拉掉。
 *
 * **寬度的真相在 React 這一側**，Blockly 那邊只是跟著（`setFlyoutWidth`）。
 * 反過來做（讀 Blockly 的寬度來畫把手）會變成兩本帳，而它們在 reflow 的那一
 * 幀一定會對不上。
 *
 * 收到 0 之後唯一的出口是**點左邊的分類欄**。那個手勢不是隨便挑的：面板收起來
 * 之後，畫面上唯一還看得見、而且與「我想要積木」有關的東西就是那一欄。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type * as Blockly from 'blockly/core';
import { FLYOUT_DEFAULT_WIDTH, FLYOUT_MIN_WIDTH, setFlyoutWidth } from '../blockly/theme';
import { readPref, writePref } from '../prefs';
import { t } from '../i18n';

/** 偏好的 key（§16 Q15 未定案；出入口只有 `prefs.ts` 那兩個函式）。 */
const PREF_KEY = 'flyoutWidth';

/**
 * 拉到這麼窄就當成「收起來了」，點分類欄會重置。
 *
 * 不用 `=== 0`：把手有寬度，使用者拉到剩兩三個 px 的時候心裡想的是「關掉」，
 * 而那時面板已經什麼都看不到了。
 */
const COLLAPSED_PX = 12;

/** 拉太寬就不是「面板」了。畫布至少要留這麼多。 */
const CANVAS_MIN_PX = 240;

export function FlyoutResizer({ workspace }: { workspace: Blockly.WorkspaceSvg | null }) {
  const [width, setWidth] = useState(() => readPref(PREF_KEY, FLYOUT_DEFAULT_WIDTH));
  /** 分類欄的寬度：把手的位置是「分類欄 + 面板」。 */
  const [toolboxWidth, setToolboxWidth] = useState(0);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const apply = useCallback(
    (next: number) => {
      const max = Math.max(FLYOUT_MIN_WIDTH, window.innerWidth - toolboxWidth - CANVAS_MIN_PX);
      const clamped = Math.round(Math.min(Math.max(next, FLYOUT_MIN_WIDTH), max));
      setWidth(clamped);
      setFlyoutWidth(workspace, clamped);
      return clamped;
    },
    [workspace, toolboxWidth],
  );

  // 工作區好了之後把存下來的寬度套上去。`updateToolbox` 之後 Blockly 會自己
  // 再 reflow 一次，而那一次讀的是 flyout 自己記著的值，所以只需要在這裡交代
  // 一次。
  useEffect(() => {
    if (!workspace) return;
    setFlyoutWidth(workspace, width);
    // width 不進依賴：那是拖曳時每一幀都會變的東西，而拖曳自己已經套用過了。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  /**
   * 分類欄有多寬。
   *
   * **量，不要假設。** 那一欄的寬度是 Blockly 依**最長的分類名**算出來的
   * （§2.5 記著這件事：分類名從「函式」改成「函式積木」就會把它撐寬），所以
   * 寫死一個 60 只是在等它哪天不對。用 `ResizeObserver` 而不是量一次：`observe`
   * 本來就會立刻回報一次現值，而之後改分類名也免費跟上。
   */
  useEffect(() => {
    if (!workspace) return;
    const toolbox = document.querySelector('.blocklyToolbox');
    if (!toolbox) return;
    const observer = new ResizeObserver(() => {
      setToolboxWidth(toolbox.getBoundingClientRect().width);
    });
    observer.observe(toolbox);
    return () => observer.disconnect();
  }, [workspace]);

  /**
   * 收起來之後點分類欄 → 回到預設寬度。
   *
   * 掛在 document 的 capture 上而不是那一欄自己身上：分類欄是 Blockly 畫的
   * DOM，React 沒有它的 ref，而它裡面的東西（分類、圖示）都會吃掉自己的事件。
   * capture 讓這一下一定先到我們手上——而且它**不擋**原本的行為：點的那個分類
   * 照樣被選取，只是面板同時長回來。
   */
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (width > COLLAPSED_PX) return;
      const target = event.target;
      if (target instanceof Element && target.closest('.blocklyToolbox')) {
        apply(FLYOUT_DEFAULT_WIDTH);
        writePref(PREF_KEY, FLYOUT_DEFAULT_WIDTH);
      }
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [width, apply]);

  if (!workspace) return null;

  return (
    <div
      className="flyout-resizer"
      style={{ left: toolboxWidth + width }}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('flyout.resize')}
      title={t('flyout.resizeHelp')}
      onPointerDown={(event) => {
        // pointer capture：拖出把手之外（甚至拖到畫布上）也還收得到 move。
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: width };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        apply(start.startWidth + (event.clientX - start.startX));
      }}
      onPointerUp={(event) => {
        if (!drag.current) return;
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        // 只在放開時寫偏好：拖曳中每一幀都寫 localStorage 是同步 I/O。
        writePref(PREF_KEY, width);
      }}
      // 雙擊回到預設寬度。收起來之後的出口是分類欄（見上），這一條是給
      // 「拉歪了想回到原本那樣」用的——兩個手勢，兩種意圖。
      onDoubleClick={() => {
        writePref(PREF_KEY, apply(FLYOUT_DEFAULT_WIDTH));
      }}
    />
  );
}

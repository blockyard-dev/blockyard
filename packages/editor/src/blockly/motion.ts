/**
 * 「滑過去」而不是「跳過去」。
 *
 * 畫布自己動的時候有一個問題：**使用者沒有按方向鍵，畫面卻換了一批積木**。
 * 一次瞬間位移說不出「你原本在這裡、現在到那裡」，而那正是使用者需要知道的
 * 唯一一件事——他要回得去。中間那幾幀就是那句話。
 *
 * 這裡是 flyout 的捲動動畫（`theme.ts::FixedScaleFlyout.scrollTo`）與畫布的
 * `glideToBlock` 共用的那三個東西。**共用的理由是「看起來要一樣」**：同一個
 * 編輯器裡兩種「滑到定位」用不同的時間或曲線，是那種說不出哪裡怪的怪。
 *
 * 動畫一律**以時間為準、有長度上限**，不是「每幀補剩餘的 30%」那種漸近形狀。
 * 理由在 `theme.ts` 那段長註解裡（移動靶、滾輪卡死、分頁失焦時 rAF 被節流到
 * 1fps）——而定長動畫對第三件事的退化剛好是對的：第一幀的 `elapsed` 就超過
 * `SCROLL_MS`，直接收在終點，等於「一次到位」。
 */
import type * as Blockly from 'blockly/core';

/** 捲到定位的時間上限。夠短到不會變成移動靶，夠長到看得出是「滑」過去。 */
export const SCROLL_MS = 350;

export function prefersReducedMotion(): boolean {
  // jsdom（單元測試）沒有 matchMedia。
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** ease-out cubic：一開始就快，尾巴收得慢，看起來是「滑到定位」。 */
export function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * 世代編號，不是比對座標。
 *
 * 連按兩次「刪除這個積木…」的目標是**同一顆**呼叫積木，比對值攔不住第二圈，
 * 而兩圈 rAF 各自寫 `scroll()` 會抖。與 flyout 那條動畫同一個寫法。
 */
let generation = 0;

/**
 * 把畫布**滑**到某顆積木上，而不是瞬間跳過去。
 *
 * 目的地由 Blockly 自己算：`centerOnBlock` 的公式（積木寬高、RTL、縮放、
 * viewport 中心）不該在這裡抄第二份——抄了就是 PROGRESS §3.3 那份「依賴
 * Blockly 內部行為」的名單再長一條，而它壞掉的樣子是「滑到旁邊一點點」，
 * 沒有人查得出來。所以做法是**先讓它跳到定位、把落點記下來、再跳回原處**，
 * 然後在兩點之間補間。
 *
 * 這一趟來回是無損的：`scroll(x, y)` 的最後兩行就是 `this.scrollX = x;
 * this.scrollY = y`，而讀回來的值已經夾在合法範圍裡了——再餵回去夾到同一個點。
 */
export function glideToBlock(workspace: Blockly.WorkspaceSvg, blockId: string): void {
  const from = { x: workspace.scrollX, y: workspace.scrollY };
  workspace.centerOnBlock(blockId);
  const to = { x: workspace.scrollX, y: workspace.scrollY };

  // 上一趟（如果有）就到此為止。**放在所有 early return 之前**：不論這一次
  // 要不要動畫，舊的那一圈都不該繼續往它自己的目標走。
  const mine = ++generation;

  // 已經在定位上，或使用者要求少一點動態效果——`centerOnBlock` 已經把畫面
  // 放在終點了，什麼都不必再做。
  if (prefersReducedMotion() || (from.x === to.x && from.y === to.y)) return;

  // **使用者一碰就停。** 350ms 很短，但那 350ms 裡滾輪與拖曳寫的也是
  // `scroll()`，而動畫每一幀都寫、所以永遠贏——症狀是「滾一下被拉回去」。
  // flyout 那邊是覆寫 `wheel_`，畫布這裡沒有可以覆寫的方法，改成聽一次 DOM。
  const surface = workspace.getParentSvg().parentElement;
  const stop = (): void => {
    if (generation === mine) generation++;
    release();
  };
  const release = (): void => {
    surface?.removeEventListener('wheel', stop);
    surface?.removeEventListener('pointerdown', stop);
  };
  surface?.addEventListener('wheel', stop, { passive: true });
  surface?.addEventListener('pointerdown', stop);

  workspace.scroll(from.x, from.y);
  const startedAt = performance.now();
  const step = (): void => {
    if (generation !== mine) return; // 被取消，或被下一次 `glideToBlock` 接手
    const t = (performance.now() - startedAt) / SCROLL_MS;
    if (t >= 1) {
      workspace.scroll(to.x, to.y);
      release();
      return;
    }
    const k = easeOut(t);
    workspace.scroll(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

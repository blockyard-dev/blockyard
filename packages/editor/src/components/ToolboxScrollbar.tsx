/**
 * 分類欄那一根捲軸，自己畫的。
 *
 * **為什麼不用原生的**：那一欄的寬度是寫死的 60px（`index.css` 有整段理由），
 * 而原生捲軸沒有「不佔位」的開關——`overflow: overlay` 已經廢掉，只要動了
 * `::-webkit-scrollbar`，WebKit 就會從系統的浮動捲軸切回佔位那種。於是清單一長
 * 到要捲，它就從內容寬度裡扣走 6~15px，整排置中的圓點與分類名往左跳一下，而
 * 那個偏移在一個寫死寬度的欄上沒有地方吸收。純 CSS 的替代版（清單撐滿整欄、
 * 溢出的部分切掉）在「被選取那一格有整條灰底」上破功，切掉的正是灰底的右端。
 *
 * **它只是指示器，不能拖。** 捲動照舊靠滾輪、觸控板與鍵盤——原生捲軸只是不畫
 * 出來，不是不能捲。要能拖就得自己接 pointer capture 並把 `scrollTop` 換算回
 * 去，那是另一件事，現在不值得。
 *
 * 位置每次捲動直接寫進 DOM 的 style，不進 state：這跟 `RunBubbles` 是同一個理
 * 由——一次捲動會連續發很多個事件，每一個都重跑一次元件只是白費。
 */
import { useEffect, useRef } from 'react';
import type * as Blockly from 'blockly/core';

/** thumb 再短也要看得出來是一根 thumb。 */
const MIN_THUMB_PX = 24;

/** 捲完之後還亮著多久（沒有滑鼠停在上面的話）。 */
const FADE_DELAY_MS = 700;

export function ToolboxScrollbar({ workspace }: { workspace: Blockly.WorkspaceSvg | null }) {
  const bar = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // `workspace` 不是拿來讀的，是拿來等的：分類欄是 Blockly 在 inject 時才畫
    // 出來的 DOM，工作區還沒好就 querySelector 一定是 null。
    if (!workspace) return;
    const toolbox = document.querySelector<HTMLElement>('.blocklyToolbox');
    const barNode = bar.current;
    const thumbNode = thumb.current;
    if (!toolbox || !barNode || !thumbNode) return;

    let hovering = false;
    let timer = 0;

    /** 捲得動嗎、thumb 該多高、該在哪。捲不動就整根不畫。 */
    const measure = () => {
      const { scrollHeight, clientHeight, scrollTop } = toolbox;
      // 1px 的寬容：clientHeight 是整數而 scrollHeight 常常差一點點，嚴格比大小
      // 會讓一個其實捲不動的欄一直掛著一根滿高的 thumb。
      if (scrollHeight - clientHeight <= 1) {
        barNode.style.display = 'none';
        return;
      }
      barNode.style.display = '';
      const height = Math.max(MIN_THUMB_PX, (clientHeight * clientHeight) / scrollHeight);
      const top = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - height);
      thumbNode.style.height = `${height}px`;
      thumbNode.style.transform = `translateY(${top}px)`;
    };

    /** 亮起來；沒有滑鼠停著的話過一會兒自己淡掉。 */
    const show = () => {
      barNode.classList.add('toolbox-scrollbar-visible');
      window.clearTimeout(timer);
      if (hovering) return;
      timer = window.setTimeout(() => {
        barNode.classList.remove('toolbox-scrollbar-visible');
      }, FADE_DELAY_MS);
    };

    const onScroll = () => {
      measure();
      show();
    };
    const onEnter = () => {
      hovering = true;
      measure();
      show();
    };
    const onLeave = () => {
      hovering = false;
      show();
    };

    toolbox.addEventListener('scroll', onScroll, { passive: true });
    toolbox.addEventListener('pointerenter', onEnter);
    toolbox.addEventListener('pointerleave', onLeave);

    // 兩件事都會改「捲得動嗎」：欄自己變高（視窗縮放）、清單變長（裝了一個積木
    // 包）。第二件在 Blockly 那邊是重畫整個分類清單，尺寸不一定跟著變，所以
    // ResizeObserver 兩個都要看。
    const observer = new ResizeObserver(measure);
    observer.observe(toolbox);
    const group = toolbox.querySelector('.blocklyToolboxCategoryGroup');
    if (group) observer.observe(group);

    measure();

    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      toolbox.removeEventListener('scroll', onScroll);
      toolbox.removeEventListener('pointerenter', onEnter);
      toolbox.removeEventListener('pointerleave', onLeave);
    };
  }, [workspace]);

  return (
    <div className="toolbox-scrollbar" ref={bar} aria-hidden="true">
      <div className="toolbox-thumb" ref={thumb} />
    </div>
  );
}

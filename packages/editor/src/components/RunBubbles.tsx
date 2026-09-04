/**
 * §8.3：`block.exit` 的值氣泡（2 秒後淡出）、`block.error` 的錯誤氣泡、
 * `block.hot` 的「持續執行中 ×N」。
 *
 * 氣泡是 HTML 疊在 Blockly 的 SVG 上，不是 Blockly 的 `Bubble`。理由是內容：
 * §8.3 要求 object / list 渲染成**可展開的 JSON tree**，而 Blockly 的 bubble
 * 裡放 React 元件要自己接一層 portal 與生命週期，比疊一層 HTML 貴得多。
 *
 * 代價是位置要自己算。做法是每個 animation frame 讀一次積木的
 * `getBoundingClientRect()` 直接寫進 `style.transform`——縮放、捲動、拖曳全部
 * 免費跟上，而且不經過 React 的重繪。氣泡只有幾顆，這比訂閱 Blockly 的
 * viewport 事件再自己換算座標簡單且不會漏。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type * as Blockly from 'blockly/core';
import { blockRect, speaks } from '../run/decorate';
import { useRunStore, type BlockState } from '../run/store';
import { JsonTree } from './JsonTree';

/**
 * §8.3：氣泡 2 秒後淡出（最後 400ms 淡）。
 *
 * **錯誤氣泡也淡**（第九輪回饋）。它原本是 `Infinity`，理由是「錯誤要留著讓
 * 人看」——而回饋說的正是那個代價：一顆改好了的積木身上還掛著上一次的紅氣
 * 泡。改這條的前提是錯誤在別處留得住：輸出面板的 log 與 topbar 的「執行失
 * 敗：⋯」都不會淡出，紅框那半在 `index.css`（同一組 2 秒 + 400ms）。
 */
const VALUE_TTL_MS = 2000;

interface Bubble {
  blockId: string;
  seq: number;
  state: BlockState;
  /** 到期時間。滑鼠停在上面時每一幀往後推（§8.3）。 */
  until: number;
}

export function RunBubbles({ workspace }: { workspace: Blockly.WorkspaceSvg | null }) {
  const blocks = useRunStore((s) => s.blocks);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  // 滑鼠正停在哪一顆氣泡上（§8.3）。放 ref 不放 state：讀它的只有下面那個
  // rAF 迴圈，進 state 只會為了一次 hover 重跑整個元件。
  const hovered = useRef<string | null>(null);

  // 哪些積木「現在有話要說」。用 seq 判斷是不是新的一次——同一顆積木在迴圈裡
  // 回同一個值時，計時器也該重新開始，不然第二次的氣泡會提早消失。
  useLayoutEffect(() => {
    const now = performance.now();
    setBubbles((prev) => {
      const before = new Map(prev.map((b) => [b.blockId, b]));
      const next: Bubble[] = [];
      for (const [blockId, state] of blocks) {
        if (!speaks(state, workspace, blockId)) continue;
        const old = before.get(blockId);
        const fresh = old === undefined || old.seq !== state.seq;
        next.push({
          blockId,
          seq: state.seq,
          state,
          until: fresh ? now + VALUE_TTL_MS : old.until,
        });
      }
      return same(prev, next) ? prev : next;
    });
  }, [blocks, workspace]);

  // 一個 rAF 迴圈同時做兩件事：跟著積木移動、把到期的氣泡收掉。
  useEffect(() => {
    if (!workspace || bubbles.length === 0) return;
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      let expired = false;
      for (const bubble of bubbles) {
        const node = nodes.current.get(bubble.blockId);
        if (!node) continue;
        // §8.3：滑鼠在上面就把倒數推到現在之後，移開才重新開始。每一幀都推，
        // 所以「停住」不需要記住是什麼時候進來的；離開時剩下的正好是完整的
        // 2 秒，跟第一次冒出來時一樣。
        if (hovered.current === bubble.blockId) {
          bubble.until = now + VALUE_TTL_MS;
        }
        if (now > bubble.until) {
          expired = true;
          continue;
        }
        const rect = blockRect(workspace, bubble.blockId);
        if (!rect) {
          node.style.visibility = 'hidden';
          continue;
        }
        node.style.visibility = 'visible';
        // §8.3：對齊積木的**中央**，不是左緣。原本的理由是「reporter 常常插在
        // 一顆很寬的積木的某個孔裡」，而那個理由在「只有落單的才冒泡」之後就
        // 不存在了（見 `speaks`）。留著中央的新理由比較單純：冒泡的是一整顆
        // 積木，而靠左的氣泡在一顆很寬的積木上會偏到它的一端，看起來像在說
        // 那一格的事——值氣泡唯一的工作是「說清楚是誰回了什麼」。
        //
        // 錨的是**下緣**：氣泡帶尖角、長在積木底下往上指，像積木把值說出來。
        // 往左收半個氣泡寬、讓開尖角那一段、滑出來的動畫都在 CSS 的
        // `.bubble-box`——這裡只給那一個點。
        node.style.transform = `translate(${rect.left + rect.width / 2}px, ${rect.bottom}px)`;
        // 最後 400ms 淡出
        const left = bubble.until - now;
        node.style.opacity = left < 400 ? String(Math.max(0, left) / 400) : '1';
      }
      if (expired) setBubbles((prev) => prev.filter((b) => performance.now() <= b.until));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bubbles, workspace]);

  if (!workspace) return null;

  return (
    <div className="bubble-layer">
      {bubbles.map((bubble) => (
        <div
          key={bubble.blockId}
          ref={(el) => {
            if (el) nodes.current.set(bubble.blockId, el);
            else nodes.current.delete(bubble.blockId);
          }}
          className={`bubble bubble-${bubble.state.phase}`}
          style={{ visibility: 'hidden' }}
          onMouseEnter={() => { hovered.current = bubble.blockId; }}
          onMouseLeave={() => {
            if (hovered.current === bubble.blockId) hovered.current = null;
          }}
        >
          <div className="bubble-box">
            <div className="bubble-content">
              <BubbleBody state={bubble.state} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function BubbleBody({ state }: { state: BlockState }) {
  if (state.phase === 'error' && state.error) {
    return (
      <>
        <div className="bubble-error-message">{state.error.message}</div>
        {state.error.hint && <div className="bubble-hint">{state.error.hint}</div>}
      </>
    );
  }
  return (
    <>
      {state.phase === 'hot' && (
        <div className="bubble-count">持續執行中 ×{state.count?.toLocaleString()}</div>
      )}
      {state.value !== undefined && <JsonTree value={state.value} />}
      {state.truncated && <div className="bubble-hint">值太長，已截斷（§6.2）</div>}
    </>
  );
}

function same(a: Bubble[], b: Bubble[]): boolean {
  return a.length === b.length && a.every((x, i) => {
    const y = b[i];
    return y !== undefined && x.blockId === y.blockId && x.seq === y.seq;
  });
}

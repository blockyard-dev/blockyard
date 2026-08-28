/**
 * §8.3 的左半：把 `useRunStore` 的積木狀態畫到 Blockly 的積木上。
 *
 * 做法是**在積木的 SVG group 上掛 class**，樣式寫在 `index.css`。不用 Blockly
 * 的 `setHighlighted` / `addSelect`，因為那兩個是「選取」的語意，會跟使用者
 * 自己點選積木打架——執行中的高亮與選取必須能同時存在。
 *
 * 這一步能直接站在 `ir/deserialize.ts` 已經建立的對應關係上：IR 的 blockId
 * 就是 Blockly 的 block id，所以 `workspace.getBlockById(event.blockId)` 就是
 * 全部的對照表（第 4 步刻意留的著力點）。
 */
import type * as Blockly from 'blockly/core';
import type { BlockState } from './store';

const CLASS: Record<BlockState['phase'], string | null> = {
  running: 'blocky-run-running',
  hot: 'blocky-run-hot',
  error: 'blocky-run-error',
  // 跑完的積木不留痕跡——值氣泡才是「它剛剛回傳了什麼」的表現。
  done: null,
};

const ALL = ['blocky-run-running', 'blocky-run-hot', 'blocky-run-error'];

/**
 * 把狀態同步到工作區。記得上一次掛過哪些 class，才知道要拆掉哪些——
 * 每次全掃工作區的話，一份幾百顆積木的專案每 50ms 就要走一遍。
 */
export class RunDecorator {
  private applied = new Map<string, string>();

  constructor(private readonly workspace: Blockly.WorkspaceSvg) {}

  sync(blocks: Map<string, BlockState>): void {
    for (const [blockId, state] of blocks) {
      const want = CLASS[state.phase];
      if (this.applied.get(blockId) === want) continue;
      this.setClass(blockId, want);
    }
    // 這一輪不見了的（換專案、重新載入）也要清乾淨
    for (const blockId of this.applied.keys()) {
      if (!blocks.has(blockId)) this.setClass(blockId, null);
    }
  }

  /** 離開執行狀態時把所有 class 拆掉。工作區還在，只是不再發光。 */
  clear(): void {
    for (const blockId of [...this.applied.keys()]) this.setClass(blockId, null);
  }

  private setClass(blockId: string, want: string | null): void {
    // 積木可能已經被刪掉（執行中拖走一顆）。那不是錯誤，忽略就好。
    const root = this.workspace.getBlockById(blockId)?.getSvgRoot();
    if (root) {
      root.classList.remove(...ALL);
      if (want) root.classList.add(want);
    }
    if (want) this.applied.set(blockId, want);
    else this.applied.delete(blockId);
  }
}

/** 積木在畫面上的位置（viewport 座標），給值氣泡定位用。 */
export function blockRect(
  workspace: Blockly.WorkspaceSvg,
  blockId: string,
): DOMRect | null {
  const root = workspace.getBlockById(blockId)?.getSvgRoot();
  return root ? root.getBoundingClientRect() : null;
}

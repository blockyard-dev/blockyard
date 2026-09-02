/**
 * 一個積木包的右鍵選單（D31）。
 *
 * **兩個地方叫得起它**：工具箱分類欄上那顆色圓點（主要入口——那是使用者每天
 * 看得到這個包的地方，也是 Scratch 的心智模型裡「這個分類」的所在），以及擴充
 * 功能面板上那張卡。兩邊同一份選單、同一組條目，因為它們指的是同一個東西。
 *
 * 條目就是一個包在「加進來之後」的兩種命運：**刪掉**與**換一版**。第二個現在
 * 是暗的（P3 第 2 步），但它站在這裡有意義——它讓「更新一個積木包」在畫面上
 * 有位置，而不是一個只存在於文件裡的計畫（§16 Q24）。
 *
 * 不用 Blockly 的 `ContextMenu`：那一套是給積木與畫布用的（它的座標、生命週期
 * 都綁著工作區），而這裡兩個入口有一個是純 HTML 的面板。
 */
import { useEffect, useState } from 'react';
import { RotateCw, Trash2 } from 'lucide-react';
import type { ToolboxGroup } from '../blockly/toolbox';

export interface ExtensionMenuTarget {
  group: ToolboxGroup;
  x: number;
  y: number;
}

/**
 * 選單的開關，連同「畫面上任何一下都先收掉它」。
 *
 * 那條收掉的規則是原生選單的行為，而使用者不會為了關掉一個選單去找關閉鍵——
 * 所以它跟著選單本身走，不是每個叫用它的地方各寫一次。
 */
export function useExtensionMenu() {
  const [menu, setMenu] = useState<ExtensionMenuTarget | null>(null);

  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    // capture：捲動的是內層的容器（面板的格子、工具箱那一欄），而 scroll
    // 事件不冒泡。
    document.addEventListener('scroll', dismiss, true);
    document.addEventListener('keydown', onEscape);
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') dismiss();
    }
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('keydown', onEscape);
    };
  }, [menu]);

  return {
    menu,
    openMenu: (group: ToolboxGroup, x: number, y: number) => setMenu({ group, x, y }),
    closeMenu: () => setMenu(null),
  };
}

export function ExtensionMenu({
  target,
  installed,
  onDelete,
}: {
  target: ExtensionMenuTarget;
  /** 這個包現在在工具箱上。不在的話「刪除」沒有意義（面板上那張卡才會遇到）。 */
  installed: boolean;
  onDelete(group: ToolboxGroup): void;
}) {
  const WIDTH = 240;
  const HEIGHT = 96;
  // 夾在視窗內：在最後一排卡片、或分類欄最底下按右鍵時，選單本來會有一半長到
  // 畫面外面去。
  const left = Math.min(target.x, window.innerWidth - WIDTH - 8);
  const top = Math.min(target.y, window.innerHeight - HEIGHT - 8);

  return (
    <div
      className="ext-menu"
      role="menu"
      aria-label={`${target.group.name} 的動作`}
      style={{ left, top, width: WIDTH }}
      // 選單自己身上那一下不該關掉自己（window 的 `pointerdown` 會先收到）。
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        className="ext-menu-item"
        disabled={!installed}
        title={installed ? undefined : '這個擴充功能還沒加進來'}
        onClick={() => onDelete(target.group)}
      >
        <Trash2 size={14} strokeWidth={2.5} /> 刪除這個擴充功能
      </button>
      <button
        type="button"
        role="menuitem"
        className="ext-menu-item"
        disabled
        title="還沒接上：要先有 .zip 匯入那條路，以及「新版少了一顆積木怎麼辦」的答案（§16 Q24、P3 第 2 步）"
      >
        <RotateCw size={14} strokeWidth={2.5} /> 更新／替換這個擴充功能…
      </button>
    </div>
  );
}

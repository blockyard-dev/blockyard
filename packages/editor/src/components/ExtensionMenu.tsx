/**
 * 一個積木包的右鍵選單（D31、`docs/extension-design.md` §5）。
 *
 * **兩個地方叫得起它**：工具箱分類欄上那顆色圓點（主要入口——那是使用者每天
 * 看得到這個包的地方，也是 Scratch 的心智模型裡「這個分類」的所在），以及擴充
 * 功能面板上那張卡。兩邊同一份選單、同一組條目，因為它們指的是同一個東西。
 *
 * **四個條目，而其中兩個都曾經叫「刪除」。** §1 的三層帳說「這個包在不在」
 * 其實是三個問題，而這份選單是它在畫面上的樣子：
 *
 * | 選單上的字 | 動的是 | 問不問 | 誰看得到 |
 * |---|---|---|---|
 * | 從工具箱移除 | 瀏覽器裡那份名單 | 不問 | 每一個包 |
 * | 更新／替換⋯ | 磁碟 | 審閱畫面 | 每一個包 |
 * | 匯出 ZIP | 下載一份安裝包 | 不問 | 每一個包 |
 * | 解除安裝⋯ | 磁碟 | 要（把收據攤出來） | **只有有收據的** |
 *
 * 用字要說出動的是哪一層。「刪除這個擴充功能」聽起來像最後一條，做的卻是第
 * 一條——而那個歧義正是 §0 那個洞的成因：使用者按下他以為的「解除安裝」，
 * 得到的是「收起來」，於是他去開檔案總管。
 *
 * **沒有收據的包看不到「解除安裝⋯」**（`canUninstall`）：那個資料夾是使用者
 * 自己放的，很可能就是他正在編輯的東西。畫面上說「你自己放進資料夾的」、
 * 選單卻給得出解除安裝，是最糟的那一種不一致。
 *
 * 不用 Blockly 的 `ContextMenu`：那一套是給積木與畫布用的（它的座標、生命週期
 * 都綁著工作區），而這裡兩個入口有一個是純 HTML 的面板。
 */
import { useEffect, useState } from 'react';
import { Download, EyeOff, RotateCw, Trash2 } from 'lucide-react';
import type { ToolboxGroup } from '../blockly/toolbox';
import type { ExtensionReceipt } from '../api/client';
import { canUninstall } from './extensionsSource';
import { t } from '../i18n';

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
  receipt,
  onRemove,
  onUpdate,
  onExport,
  onUninstall,
}: {
  target: ExtensionMenuTarget;
  /** 這個包現在在工具箱上。不在的話「移除」沒有意義（面板上那張卡才會遇到）。 */
  installed: boolean;
  /** 這個資料夾是誰搬進來的。`undefined` = 沒有收據 = 我們不碰它。 */
  receipt: ExtensionReceipt | undefined;
  onRemove(group: ToolboxGroup): void;
  onUpdate(group: ToolboxGroup): void;
  onExport(group: ToolboxGroup): void;
  onUninstall(group: ToolboxGroup): void;
}) {
  const removable = canUninstall(receipt);
  const WIDTH = 260;
  const HEIGHT = removable ? 160 : 128;
  // 夾在視窗內：在最後一排卡片、或分類欄最底下按右鍵時，選單本來會有一半長到
  // 畫面外面去。
  const left = Math.min(target.x, window.innerWidth - WIDTH - 8);
  const top = Math.min(target.y, window.innerHeight - HEIGHT - 8);

  return (
    <div
      className="ext-menu"
      role="menu"
      aria-label={t('extensions.actions', { name: target.group.name })}
      style={{ left, top, width: WIDTH }}
      // 選單自己身上那一下不該關掉自己（window 的 `pointerdown` 會先收到）。
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* **第一條不問「你確定嗎」**：它只把這一格從工具箱收起來，畫布上已經
          有的積木照樣跑，下次打開這個專案還會自己回來。它弄不壞任何東西。 */}
      <button
        type="button"
        role="menuitem"
        className="ext-menu-item"
        disabled={!installed}
        title={installed ? undefined : t('extensions.notAdded')}
        onClick={() => onRemove(target.group)}
      >
        <EyeOff size={14} strokeWidth={2.5} /> {t('extensions.remove')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="ext-menu-item"
        onClick={() => onUpdate(target.group)}
      >
        <RotateCw size={14} strokeWidth={2.5} /> {t('extensions.update')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="ext-menu-item"
        onClick={() => onExport(target.group)}
      >
        <Download size={14} strokeWidth={2.5} /> {t('extensions.exportZip')}
      </button>
      {/* **沒有收據就沒有這一條。** 不是畫成灰的——一條永遠按不動的條目是一個
          需要解釋的東西，而這裡要說的話（「那是你自己放的」）卡片上已經寫了。 */}
      {removable && (
        <button
          type="button"
          role="menuitem"
          className="ext-menu-item is-danger"
          onClick={() => onUninstall(target.group)}
        >
          <Trash2 size={14} strokeWidth={2.5} /> {t('extensions.uninstall')}
        </button>
      )}
    </div>
  );
}

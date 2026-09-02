/**
 * 擴充功能面板（§8.1、D31）。Scratch／TurboWarp 的「選擇擴充功能」那一頁：
 * 一張一張的卡，點下去那個積木包才上工具箱。
 *
 * **為什麼是整頁而不是一個下拉**：這一頁是「這個工具能接上什麼」的目錄，而目錄
 * 是拿來逛的——一張卡上要放得下名字、顏色、一句說明與「加了沒」。塞進 15rem 寬
 * 的浮動小面板裡，那四樣只剩下名字。
 *
 * **卡片上的圖案是從 manifest 長出來的**，不是每個包配一張圖：色底來自
 * `color`（工具箱分類色，所以卡片與分類欄是同一個顏色記號），中間那個字是名字
 * 的第一個字。D21 的同一條線——前端不認識任何一個積木包的 id，所以這裡不會有
 * 一張 `if (id === 'discord')` 的圖片表；積木包想長什麼樣子，說話的是它自己的
 * manifest。哪天 manifest 多一個 `icon`，換掉的只有這一格。
 *
 * 清單的來源是**已註冊的分類**（`registration.groups`）：`GET /api/extensions`
 * 給了什麼就有什麼。所以這一頁誠實地只列「後端手邊有的包」——「去某個地方下載
 * 一個新的」是另一件事（P3 第 2 步的 `.zip`），它在右上角，而且現在是暗的。
 *
 * **左鍵加，右鍵刪**（D31）。刪除不是「再點一次就收起來」的理由與函式定義完全
 * 相同：它會讓畫布上已經存在的積木失去來源，而那種動作不該與「加進來」共用同一
 * 下點擊——右鍵選單是使用者在這個編輯器裡刪掉一個函式時走的同一條路（§8.5），
 * 而「刪掉之前先看看還有誰在用」也是那條路上已經有的規則。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Plus, Search } from 'lucide-react';
import type { ToolboxGroup } from '../blockly/toolbox';
import { focusableIn, modalKeyAction, nextFocusIndex } from './modalKeys';
import { matchesQuery } from './extensionsFilter';
import { ExtensionMenu, useExtensionMenu } from './ExtensionMenu';
import { useExtensionsUi } from './extensionsStore';

export interface ExtensionsGalleryProps {
  /** 全部已註冊的分類（含內建，內建在這一頁不列——見下）。 */
  groups: ToolboxGroup[];
  /** 加了什麼，由 `App` 說一句（它管畫布上那條提示）。 */
  onChanged(message: string): void;
  /**
   * 「刪除這個擴充功能」。
   *
   * 規則（還有誰在用、捲到那一顆）住在 `App`——它手上才有工作區，而**畫布在
   * 這一頁底下**，所以那條路一定要先把這一頁關掉才看得見自己做了什麼。這個元件
   * 只負責把「使用者在這張卡上按了刪除」講出去。
   */
  onDelete(group: ToolboxGroup): void;
}

export function ExtensionsGallery({ groups, onChanged, onDelete }: ExtensionsGalleryProps) {
  const enabled = useExtensionsUi((s) => s.enabled);
  const add = useExtensionsUi((s) => s.add);
  const close = useExtensionsUi((s) => s.closeGallery);

  const [query, setQuery] = useState('');
  const { menu, openMenu, closeMenu } = useExtensionMenu();
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // 開場焦點落在搜尋框：這一頁唯一要打字的地方，而十幾張卡之後找東西一定從
  // 這裡開始。
  useEffect(() => searchRef.current?.focus(), []);

  /**
   * **內建不列。** 它們不是「擴充功能」，是這個語言本身——「控制」「運算」沒有
   * 「要不要裝」這個問題，列出來只會讓這一頁的九成內容是不能點的卡。
   */
  const packs = useMemo(() => groups.filter((group) => !group.builtin), [groups]);
  const shown = packs.filter((group) => matchesQuery(group, query));

  /**
   * 點一張卡 = 加進來，然後**關掉這一頁**（Scratch 與 TurboWarp 都是這樣）。
   *
   * 留在原地也說得通——卡片上的勾當場就變了——但那句「加到哪裡去了」只有回到
   * 工具箱才看得見，而它正是使用者按下去想知道的事。畫布上那條提示也在這一頁
   * 底下（面板是整頁的），留著等於讓它自己倒數完給空氣看。
   *
   * 已經加進來的卡**點下去不做事**：這一下唯一可能的意思是「拿掉它」，而拿掉
   * 走的是右鍵（見檔頭）。讓同一個位置在不同狀態下做兩件相反的事，是那種按下去
   * 之前得先想一秒的介面。
   */
  const addPack = (group: ToolboxGroup) => {
    if (enabled.has(group.id)) return;
    add(group.id);
    onChanged(`已加入「${group.name}」，工具箱的分類欄最下面多了一格。`);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const action = modalKeyAction({
      key: e.key,
      shiftKey: e.shiftKey,
      editing: false,
      inWorkspace: false,
      target: (e.target as HTMLElement).tagName.toLowerCase(),
    });
    if (action === 'cancel') {
      e.preventDefault();
      // 選單開著時 Esc 先收選單——那是使用者心裡的「上一步」（同
      // `HistoryPanel` 在細節頁的 Esc）。選單自己也接 Esc（`useExtensionMenu`），
      // 兩邊都收得掉，而這一行擋的是「順便把整頁也關了」。
      menu ? closeMenu() : close();
    } else if (action === 'focus-next' || action === 'focus-prev') {
      if (!dialogRef.current) return;
      const items = focusableIn(dialogRef.current);
      if (items.length === 0) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[nextFocusIndex(items.length, at, action === 'focus-prev')]?.focus();
    }
  };

  return (
    <div
      className="gallery"
      role="dialog"
      aria-modal="true"
      aria-label="選擇擴充功能"
      ref={dialogRef}
      onKeyDown={onKeyDown}
    >
      <header className="gallery-head">
        <button type="button" className="gallery-back" onClick={close}>
          <ArrowLeft size={20} strokeWidth={2.5} /> 返回
        </button>
        <h2>選擇擴充功能</h2>
        {/* 位置留著、按不下去（P3 第 2 步）。從電腦裝一個包要的不只是解壓：
            §12.1 的審閱確認、`requirements` 的 venv、壞掉的 manifest 會讓整個
            `GET /api/extensions` 500——那條路整條還沒有。畫一顆按下去什麼都
            沒發生的按鈕，比一顆明說自己還沒接上的暗按鈕更糟。 */}
        <button
          type="button"
          className="button gallery-import"
          disabled
          title="還沒接上：從電腦裝一個包要先有後端的解壓與審閱那條路（P3 第 2 步）"
        >
          <Plus size={14} strokeWidth={2.5} /> 從電腦(.zip)
        </button>
      </header>

      <div className="gallery-filters">
        <div className="gallery-search">
          <Search size={16} strokeWidth={2.5} />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="搜尋"
            aria-label="搜尋擴充功能"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {/* 只有一顆膠囊。分類（誰做的、哪一類）要等包多到一個畫面裝不下才有
            意義，而現在是四個——那時候第二顆膠囊該寫什麼，也是那時候才問得
            出來的事。 */}
        <div className="gallery-chips">
          <span className="gallery-chip is-on">全部</span>
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="gallery-empty">
          {packs.length === 0
            ? '後端還沒有任何積木包。放一個資料夾進 extensions/ 再重啟後端，它就會出現在這裡。'
            : `沒有符合「${query}」的積木包。`}
        </p>
      ) : (
        <ul className="gallery-grid">
          {shown.map((group) => (
            <li key={group.id}>
              <button
                type="button"
                className={`ext-card${enabled.has(group.id) ? ' is-on' : ''}`}
                aria-pressed={enabled.has(group.id)}
                onClick={() => addPack(group)}
                // 鍵盤也到得了：卡片是一顆 button，所以 ContextMenu 鍵（與
                // Shift+F10）發的是同一個事件，落在有焦點的那一張卡上。
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenu(group, e.clientX, e.clientY);
                }}
              >
                <span className="ext-card-art" style={{ background: group.colour }}>
                  <span className="ext-card-initial">{[...group.name][0] ?? '?'}</span>
                  {enabled.has(group.id) && (
                    <span className="ext-card-check">
                      <Check size={16} strokeWidth={3} />
                    </span>
                  )}
                </span>
                <span className="ext-card-body">
                  <span className="ext-card-name">{group.name}</span>
                  <span className="ext-card-desc">{group.description ?? group.id}</span>
                  <span className="ext-card-foot">
                    <span className="ext-card-meta">
                      v{group.version} · {group.blocks.length} 顆積木
                    </span>
                    <span className="ext-card-action">
                      {enabled.has(group.id) ? '已加入 · 右鍵可刪除' : '＋ 加入'}
                    </span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {menu && (
        <ExtensionMenu
          target={menu}
          installed={enabled.has(menu.group.id)}
          onDelete={(group) => {
            closeMenu();
            onDelete(group);
          }}
        />
      )}
    </div>
  );
}

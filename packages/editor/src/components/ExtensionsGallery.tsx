/**
 * 擴充功能面板（§8.1、D31）。Scratch／TurboWarp 的「選擇擴充功能」那一頁：
 * 一張一張的卡，點下去那個積木包才上工具箱。
 *
 * **為什麼是整頁而不是一個下拉**：這一頁是「這個工具能接上什麼」的目錄，而目錄
 * 是拿來逛的——一張卡上要放得下名字、顏色、一句說明與「加了沒」。塞進 15rem 寬
 * 的浮動小面板裡，那四樣只剩下名字。
 *
 * **卡片上那塊 16:9 的預覽圖是從 manifest 長出來的**，不是前端配一張圖：manifest
 * 宣告 `cover`（包目錄內的相對路徑）就畫那張圖，沒宣告就畫名字的第一個字。D21
 * 的同一條線——前端不認識任何一個積木包的 id，所以這裡不會有一張
 * `if (id === 'discord')` 的圖片表；積木包想長什麼樣子，說話的是它自己的 manifest。
 *
 * **色記號落在最下面那行 meta 上**（`v0.1.0 · N 顆積木`，用 manifest 的 `color`）：
 * 卡片與工具箱分類欄因此是同一個顏色。名字與預覽圖都不上色——一整塊色底、或一
 * 顆彩色標題乘上五張卡，這一頁就變成五種調子，而色記號一行小字就說得完。
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
import { AlertTriangle, ArrowLeft, Check, Loader2, Plus, Search } from 'lucide-react';
import {
  cancelExtensionImport,
  fetchExtensionProblems,
  inspectExtensionZip,
  installExtension,
  type ExtensionProblem,
  type ImportReview,
} from '../api/client';
import { ImportReviewScreen } from './ImportReview';
import { isRemovable, type ToolboxGroup } from '../blockly/toolbox';
import { focusableIn, modalKeyAction, nextFocusIndex } from './modalKeys';
import { matchesQuery } from './extensionsFilter';
import { coverUrl } from './extensionsCovers';
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
  /**
   * 裝好了一個包。**由 `App` 去重問 `/api/extensions`**——註冊表在那裡，而
   * 匯入這條路刻意不自己註冊：`POST /api/extensions/import/{token}` 回的只是
   * 「它叫什麼」，形狀與 `GET /api/extensions` 不同（後者是 `exclude_defaults`
   * 的 manifest）。走同一條路的好處是「裝一個包」與「重啟後端之後切回分頁」
   * 在前端是同一段程式碼，不會有一條只在匯入時走的註冊分支。
   */
  onInstalled(id: string): Promise<void>;
}

export function ExtensionsGallery({
  groups,
  onChanged,
  onDelete,
  onInstalled,
}: ExtensionsGalleryProps) {
  const enabled = useExtensionsUi((s) => s.enabled);
  const add = useExtensionsUi((s) => s.add);
  const close = useExtensionsUi((s) => s.closeGallery);

  const [query, setQuery] = useState('');
  const { menu, openMenu, closeMenu } = useExtensionMenu();
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 匯入的三個狀態：還沒選檔案（`review === null`）、審閱中、安裝中。
  const [review, setReview] = useState<ImportReview | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [problems, setProblems] = useState<ExtensionProblem[]>([]);

  // 開場焦點落在搜尋框：這一頁唯一要打字的地方，而十幾張卡之後找東西一定從
  // 這裡開始。
  useEffect(() => searchRef.current?.focus(), []);

  /**
   * **內建不列。** 它們不是「擴充功能」，是這個語言本身——「控制」「運算」沒有
   * 「要不要裝」這個問題，列出來只會讓這一頁的九成內容是不能點的卡。
   */
  // 內建不列——它們沒有「要不要裝」這個問題，列出來只是給每個人幾張永遠按不動
  // 的卡片。
  const packs = useMemo(() => groups.filter(isRemovable), [groups]);
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
  /**
   * 讀不進來的積木包（`GET /api/extensions/problems`）。
   *
   * **在這一頁問，不在開場問。** 這一頁就是「這台機器上有哪些包」的目錄，而一個
   * 讀不進來的包唯一該被提起的地方就是它本來會出現的那個位置。開場問等於為一個
   * 幾乎永遠是空陣列的東西，讓每個人的每一次啟動多一趟請求。
   */
  useEffect(() => {
    const controller = new AbortController();
    void fetchExtensionProblems(controller.signal)
      .then(setProblems)
      .catch(() => {});
    return () => controller.abort();
  }, []);

  /** 選了一個 `.zip`：上傳、解開、拿回審閱資料。**這一步還沒裝任何東西。** */
  const pickFile = async (file: File) => {
    setImportError(null);
    setImporting(true);
    try {
      setReview(await inspectExtensionZip(file));
    } catch (e) {
      // 讀不進來的 `.zip` 停在這一頁，不開審閱畫面：使用者要做的事是「換一個
      // 檔案」，而那顆按鈕就在他剛剛按的地方。
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const install = async () => {
    if (!review) return;
    setImportError(null);
    setImporting(true);
    try {
      await installExtension(review.token);
      // **先讓 `App` 重新註冊，再關掉這一頁**：反過來的話，工具箱上那一格會晚
      // 一拍才出現，而使用者的眼睛正停在他剛剛按下安裝的位置。
      await onInstalled(review.id);
      // 裝一個包就是要用它——刻意加進工具箱名單（D31 的「加進來」）。一個裝完
      // 之後還要自己再點一次卡片的流程，會讓人以為安裝沒有成功。
      add(review.id);
      onChanged(`已裝好「${review.name}」，工具箱的分類欄最下面多了一格。`);
      setReview(null);
      close();
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  /** 取消審閱。**要告訴後端**，不然那份解開的暫存目錄要等到下一次有人匯入才被收掉。 */
  const cancelImport = () => {
    if (review) cancelExtensionImport(review.token);
    setReview(null);
    setImportError(null);
  };

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

  // **審閱畫面是這一頁的另一個狀態，不是另一條路。** 早退而不是疊一層：這兩頁
  // 同時只有一個有意義，而搜尋框那個字留在 state 裡——按下取消就回到原來那一頁。
  if (review) {
    return (
      <ImportReviewScreen
        review={review}
        busy={importing}
        error={importError}
        onInstall={() => void install()}
        onCancel={cancelImport}
      />
    );
  }

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
        {/* **檔案挑選器藏在按鈕後面**，不是畫面上一格 `<input type="file">`。
            那一格長什麼樣子由瀏覽器決定，而這一列上另外兩個東西是我們自己畫的
            ——三個不同的調子擠在同一行。 */}
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          className="visually-hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // **選完就把值清掉**：不清的話，同一個檔案選第二次不會發事件——而
            // 「改一行程式碼、重新壓縮、再裝一次」正是寫包的人最常做的事，症狀
            // 會是「按了沒反應」。
            e.target.value = '';
            if (file) void pickFile(file);
          }}
        />
        <button
          type="button"
          className="button gallery-import"
          onClick={() => fileRef.current?.click()}
          disabled={importing}
        >
          {importing ? (
            <Loader2 size={14} strokeWidth={2.5} className="import-spin" />
          ) : (
            <Plus size={14} strokeWidth={2.5} />
          )}
          {importing ? '讀取中…' : '從電腦(.zip)'}
        </button>
      </header>

      {importError && (
        // 停在這一頁：使用者要做的事是「換一個檔案」，而那顆按鈕就在上面。
        <p className="gallery-alert" role="alert">
          <AlertTriangle size={14} strokeWidth={2.5} /> {importError}
        </p>
      )}

      {problems.length > 0 && (
        // **一個讀不進來的包會安靜地消失**（後端的 `scan()` 跳過它，不再讓整個
        // `GET /api/extensions` 500）。這一區就是那句話的出口：這一頁是「這台
        // 機器上有哪些包」的目錄，而它本來會出現在這裡。
        <div className="gallery-alert is-problems">
          <p>
            <AlertTriangle size={14} strokeWidth={2.5} /> 有 {problems.length}{' '}
            個資料夾讀不進來，所以它們不在下面：
          </p>
          <ul>
            {problems.map((p) => (
              <li key={p.dir}>
                <code>{p.dir}</code> — {p.message}
              </li>
            ))}
          </ul>
        </div>
      )}

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
                <ExtCardArt group={group} added={enabled.has(group.id)} />
                <span className="ext-card-body">
                  <span className="ext-card-name">{group.name}</span>
                  <span className="ext-card-desc">{group.description ?? group.id}</span>
                  <span className="ext-card-foot">
                    <span className="ext-card-meta" style={{ color: group.colour }}>
                      v{group.version} · {group.blocks.length} 顆積木
                    </span>
                    <span className="ext-card-action">
                      {enabled.has(group.id) ? '已加入 · 右鍵可刪除' : '加入'}
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

/**
 * 卡片上那格 16:9。
 *
 * **圖載不出來就是「沒有圖」，不是一個錯誤狀態。** 兩者畫同一個東西（名字的第一
 * 個字加那層同心圓），因為使用者能對這件事做的動作完全一樣——什麼都不做。多畫一
 * 個破圖圖示、一句「載入失敗」，只是把一個包作者的疏漏搬到使用者眼前。
 *
 * 檔案在不在載入期就驗過（`_check_cover`），所以走到 `onError` 的只剩「宣告的是
 * `.png`、放進去的其實不是圖」這種。它罕見，也正是它該安靜的理由。
 *
 * 字永遠在 DOM 裡、圖疊在上面：圖還在下載的那段時間畫的是字，而不是一格空白。
 * 正常情況下那段時間是零——封面在積木包清單一到手時就預載過了
 * （`extensionsCovers.ts`），這一頁掛載時圖已經在快取裡。
 */
function ExtCardArt({ group, added }: { group: ToolboxGroup; added: boolean }) {
  const [failed, setFailed] = useState(false);

  return (
    <span className="ext-card-art">
      <span className="ext-card-initial">{[...group.name][0] ?? '?'}</span>
      {group.cover && !failed && (
        <img
          className="ext-card-cover"
          // 與 `prefetchCovers` 共用同一個字串——差一個字元就是兩筆快取，預載
          // 也就白做了。
          src={coverUrl(group.id)}
          alt=""
          onError={() => setFailed(true)}
        />
      )}
      {added && (
        <span className="ext-card-check">
          <Check size={16} strokeWidth={3} />
        </span>
      )}
    </span>
  );
}

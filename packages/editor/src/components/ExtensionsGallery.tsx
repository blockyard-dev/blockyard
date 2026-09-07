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
 * 給了什麼就有什麼。所以這一頁誠實地只列「後端手邊有的包」——「去某個地方拿
 * 一個新的」是另一件事，而它是右上角那兩顆按鈕：`.zip` 與 GitHub（§3 的兩個
 * 入口，之後的登記處是第三個，而它們共用同一條管線與同一頁審閱）。
 *
 * **左鍵加，右鍵是管理動作**（D31、`docs/extension-design.md` §5）：從工具箱
 * 移除、更新／替換、匯出 ZIP、解除安裝。它們都不該與「加進來」共用同一下點擊——右鍵選單
 * 是使用者在這個編輯器裡刪掉一個函式時走的同一條路（§8.5），而「動它之前先看看
 * 還有誰在用」也是那條路上已經有的規則。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check, GitBranch, Loader2, Plus, Search, X } from 'lucide-react';
import {
  cancelExtensionImport,
  fetchExtensionProblems,
  inspectExtensionGithub,
  inspectExtensionZip,
  installExtension,
  downloadExtension,
  type ExtensionProblem,
  type ImportReview,
} from '../api/client';
import { useReceipts } from './receiptsStore';
import { ImportReviewScreen } from './ImportReview';
import { isRemovable, type ToolboxGroup } from '../blockly/toolbox';
import { focusableIn, modalKeyAction, nextFocusIndex } from './modalKeys';
import { matchesQuery } from './extensionsFilter';
import { coverUrl } from './extensionsCovers';
import { ExtensionMenu, useExtensionMenu } from './ExtensionMenu';
import { useExtensionsUi } from './extensionsStore';
import { ModalActions } from './ModalActions';
import { number, t } from '../i18n';

export interface ExtensionsGalleryProps {
  /** 全部已註冊的分類（含內建，內建在這一頁不列——見下）。 */
  groups: ToolboxGroup[];
  editorPlugins?: { id: string; name: string }[];
  disabledPlugins?: ReadonlySet<string>;
  pluginProblems?: { id: string; message: string }[];
  onTogglePlugin?(id: string): void;
  /** 加了什麼，由 `App` 說一句（它管畫布上那條提示）。 */
  onChanged(message: string): void;
  /**
   * 「從工具箱移除」與「解除安裝⋯」（`docs/extension-design.md` §5）。
   *
   * **兩個動詞，兩條路**：前者只動瀏覽器裡那份名單，後者把那個資料夾從磁碟上
   * 搬進垃圾桶。規則（還有誰在用、捲到那一顆、把收據攤出來）住在 `App`——它
   * 手上才有工作區，而**畫布在這一頁底下**，所以那兩條路一定要先把這一頁關掉
   * 才看得見自己做了什麼。這個元件只負責把「使用者在這張卡上按了什麼」講出去。
   */
  onRemove(group: ToolboxGroup): void;
  onUninstall(group: ToolboxGroup): void;
  /**
   * 「這幾種積木，畫布上各有幾顆」——更新那條路上的差集要它（§4）。
   *
   * 後端說得出「這一版少了 `http.head`」，數得出「而你正在用它 3 次」的只有
   * `App`：那份工作區還沒存檔，後端手上那一份可能是十分鐘前的。
   */
  countOpcodes(opcodes: string[]): Record<string, number>;
  /** 「滑到那幾顆去」。被擋下來的更新要一樣可解（§4）。 */
  onGlideTo(opcode: string): void;
  /**
   * 按下更新之前問一句。回 `false` 就是使用者反悔了，**這一步要停在原地**。
   *
   * 現在唯一會問的是「這個包正在被監聽」（`App` 的 `confirmUpdate`）：正在
   * 聽著的那一組子行程早就把舊的 `main.py` 載進去了，不先停掉的話更新完跑的
   * 還是舊的。規則住在 `App`——監聽狀態在那裡，而這一頁不該認識 trigger。
   */
  confirmUpdate(extId: string): Promise<boolean>;
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
  editorPlugins = [], disabledPlugins = new Set(), pluginProblems = [], onTogglePlugin,
  onChanged,
  onRemove,
  onUninstall,
  onInstalled,
  countOpcodes,
  onGlideTo,
  confirmUpdate,
}: ExtensionsGalleryProps) {
  const enabled = useExtensionsUi((s) => s.enabled);
  const add = useExtensionsUi((s) => s.add);
  const close = useExtensionsUi((s) => s.closeGallery);
  const updating = useExtensionsUi((s) => s.updating);
  const clearUpdate = useExtensionsUi((s) => s.clearUpdate);
  /** 收據，`extId` → 那一張（§2）。**不在這份表裡 = 使用者自己放的**。 */
  const receipts = useReceipts((s) => s.receipts);
  const reloadReceipts = useReceipts((s) => s.reload);

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
  /** 「從 GitHub」網址對話框開著。 */
  const [githubOpen, setGithubOpen] = useState(false);
  const [githubUrl, setGithubUrl] = useState('');
  const githubRef = useRef<HTMLInputElement>(null);

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

  /**
   * 收據（`GET /api/extensions/receipts`）。
   *
   * 掛在 `groups` 上：那份清單一變，就代表這台機器上的包變了——裝好了、更新了
   * 或拔掉了，而這三件事都可能改動收據的答案。
   *
   * 收據寫進共用的 store 而不是這裡的 state：工具箱那顆色圓點的右鍵選單讀的是
   * 同一份（`receiptsStore.ts`），而**兩邊給不出同一個答案是最糟的那一種不
   * 一致**——一邊說「你自己放的」、另一邊卻給得出「解除安裝⋯」。
   */
  useEffect(() => {
    const controller = new AbortController();
    void reloadReceipts(controller.signal);
    return () => controller.abort();
  }, [groups, reloadReceipts]);

  /**
   * 有人在工具箱上按了「更新／替換⋯」（`extensionsStore` 的 `updating`）。
   *
   * **這一頁不另外長一個「更新」流程**：更新與第一次安裝是同一條管線（§3），
   * 所以這裡做的只是替使用者按下他本來要按的那顆按鈕——差別只有從哪裡拿 bytes：
   *
   * * 收據說它從 GitHub 來，而且記得網址 → **直接去抓同一個 repo 的最新一份**。
   *   使用者要做的事是零，而那正是「更新」這個字該有的樣子。
   * * 其餘（`.zip`、官方、登記處） → 開檔案挑選器。我們沒有第二份 bytes 的
   *   來源，而**猜一個是最糟的選項**。
   *
   * 意圖收下就清掉：留著的話，取消之後再打開這一頁又會從同一個流程開始。
   */
  useEffect(() => {
    if (!updating) return;
    clearUpdate();
    const receipt = receipts.get(updating);
    if (receipt?.origin === 'github' && receipt.url) {
      void fromGithub(receipt.ref ? `${receipt.url}@${receipt.ref}` : receipt.url);
    } else {
      fileRef.current?.click();
    }
    // `receipts` 不進相依：這條 effect 的觸發者是「使用者按了那條選單」，而不是
    // 「收據重新載入了」。放進去的話，一次背景重載就會再開一次檔案挑選器。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updating]);

  /** 貼一個 GitHub 網址：後端去抓，拿回**同一份**審閱資料（§6）。 */
  const fromGithub = async (url: string) => {
    setImportError(null);
    setImporting(true);
    try {
      setReview(await inspectExtensionGithub(url));
      setGithubOpen(false);
      setGithubUrl('');
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const openGithub = () => {
    setImportError(null);
    setGithubOpen(true);
    // 對話框出現後立刻把游標放進網址欄。
    setTimeout(() => githubRef.current?.focus(), 0);
  };

  const closeGithub = () => {
    if (importing) return;
    setGithubOpen(false);
    setImportError(null);
  };

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
    // **問在做任何事之前。** 這是這條路上最後一個「還可以反悔」的位置——
    // 下一行就會把磁碟上那個資料夾換掉。
    if (review.installed && !(await confirmUpdate(review.id))) return;
    setImportError(null);
    setImporting(true);
    try {
      const done = await installExtension(review.token);
      // **先讓 `App` 重新註冊，再關掉這一頁**：反過來的話，工具箱上那一格會晚
      // 一拍才出現，而使用者的眼睛正停在他剛剛按下安裝的位置。
      await onInstalled(review.id);
      // 裝一個包就是要用它——刻意加進工具箱名單（D31 的「加進來」）。一個裝完
      // 之後還要自己再點一次卡片的流程，會讓人以為安裝沒有成功。
      add(review.id);
      onChanged(
        done.replaced
          // 舊的那一份去了哪裡要說出口：**那是「更新完發現更糟」唯一的退路**，
          // 而現在還沒有一頁 UI 在看那個垃圾桶（§8 的未答項）。
          ? t('extensions.updated', {
              name: done.name,
              from: done.replaced.version,
              to: done.version,
              trash: done.replaced.trash,
            })
          : t('extensions.installed', { name: done.name }),
      );
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
    onChanged(t('extensions.added', { name: group.name }));
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
        countOpcodes={countOpcodes}
        onGlideTo={onGlideTo}
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
      aria-label={t('extensions.choose')}
      ref={dialogRef}
      onKeyDown={onKeyDown}
    >
      <header className="gallery-head">
        <button type="button" className="gallery-back" onClick={close}>
          <ArrowLeft size={20} strokeWidth={2.5} /> {t('extensions.back')}
        </button>
        <h2>{t('extensions.choose')}</h2>
        <div className="gallery-head-actions">
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
            className="button gallery-import is-secondary"
            onClick={() => fileRef.current?.click()}
            disabled={importing}
          >
            {importing ? (
              <Loader2 size={14} strokeWidth={2.5} className="import-spin" />
            ) : (
              <Plus size={14} strokeWidth={2.5} />
            )}
            {importing ? t('common.loading') : t('extensions.fromComputer')}
          </button>
          {/* **第三個入口，同一條管線**（§3）。兩顆按鈕並排而不是一個下拉：
              它們是同一階的兩個來源，而一個只有兩項的下拉多要一次點擊。 */}
          <button
            type="button"
            className="button gallery-import"
            onClick={openGithub}
            disabled={importing}
            aria-haspopup="dialog"
          >
            <GitBranch size={14} strokeWidth={2.5} /> {t('extensions.fromGithub')}
          </button>
        </div>
      </header>

      {githubOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => e.target === e.currentTarget && closeGithub()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
              e.preventDefault();
              closeGithub();
            }
          }}
        >
          <div className="modal gallery-github-modal" role="dialog" aria-modal="true" aria-label={t('extensions.githubImport')}>
            <header className="modal-head">
              <h2><GitBranch size={16} strokeWidth={2.5} /> {t('extensions.githubImport')}</h2>
              <button type="button" className="modal-close" onClick={closeGithub} aria-label={t('common.close')} disabled={importing}>
                <X size={16} />
              </button>
            </header>
            <form
              className="gallery-github"
              onSubmit={(e) => {
                e.preventDefault();
                if (githubUrl.trim()) void fromGithub(githubUrl);
              }}
            >
              <label htmlFor="github-url">{t('extensions.githubUrl')}</label>
              <input
                id="github-url"
                ref={githubRef}
                type="text"
                value={githubUrl}
                placeholder="https://github.com/someone/my-blocks"
                onChange={(e) => setGithubUrl(e.target.value)}
                disabled={importing}
              />
              {/* §6 第 4 點：顯示編輯器將下載的來源網址。 */}
              <p>
                {t('extensions.githubHelp')}
              </p>
              {importError && <p className="gallery-github-error" role="alert">{importError}</p>}
              <ModalActions
                confirmLabel={t('common.confirm')}
                busyLabel={t('extensions.fetching')}
                busy={importing}
                disabled={!githubUrl.trim()}
                onConfirm={() => githubUrl.trim() && void fromGithub(githubUrl)}
                onCancel={closeGithub}
              />
            </form>
          </div>
        </div>
      )}

      {importError && !githubOpen && (
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
            <AlertTriangle size={14} strokeWidth={2.5} /> {t('extensions.problems', { count: number(problems.length) })}
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
            placeholder={t('extensions.search')}
            aria-label={t('extensions.searchAria')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {/* 只有一顆膠囊。分類（誰做的、哪一類）要等包多到一個畫面裝不下才有
            意義，而現在是四個——那時候第二顆膠囊該寫什麼，也是那時候才問得
            出來的事。 */}
        <div className="gallery-chips">
          <span className="gallery-chip is-on">{t('extensions.all')}</span>
        </div>
      </div>

        {(editorPlugins.length > 0 || pluginProblems.length > 0) && (
          <section className="plugin-manager" aria-label={t('extensions.plugins')}>
            {editorPlugins.length > 0 && <h3>{t('extensions.plugins')}</h3>}
            {editorPlugins.map((plugin) => <div key={plugin.id}>
              <span>{plugin.name}</span>
              <button className="button" onClick={() => onTogglePlugin?.(plugin.id)}>{disabledPlugins.has(plugin.id) ? t('extensions.enablePlugin') : t('extensions.disablePlugin')}</button>
            </div>)}
            {pluginProblems.map((problem) => <p role="alert" key={problem.id}>{problem.id}：{problem.message}</p>)}
          </section>
        )}

      {shown.length === 0 ? (
        <p className="gallery-empty">
          {packs.length === 0
            ? t('extensions.empty')
            : t('extensions.noMatch', { query })}
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
          receipt={receipts.get(menu.group.id)}
          onRemove={(group) => {
            closeMenu();
            onRemove(group);
          }}
          onUpdate={(group) => {
            closeMenu();
            // 這一頁已經開著，所以「更新」在這裡就是直接開始那條流程——不必
            // 再繞一次 `startUpdate`（那是給工具箱那一側用的，它得先開這一頁）。
            const receipt = receipts.get(group.id);
            if (receipt?.origin === 'github' && receipt.url) {
              void fromGithub(receipt.ref ? `${receipt.url}@${receipt.ref}` : receipt.url);
            } else {
              fileRef.current?.click();
            }
          }}
          onExport={(group) => {
            closeMenu();
            downloadExtension(group.id);
            onChanged(t('extensions.exporting', { name: group.name }));
          }}
          onUninstall={(group) => {
            closeMenu();
            onUninstall(group);
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

/**
 * 主選單：`/projects`（`docs/project-storage-design.md` §4、`project/routes.ts`）。
 *
 * **這一頁是家，所以它沒有「返回」。** 它上面沒有東西——左上角那一格放的是這個
 * 工具的名字。返回那顆按鈕在編輯器那一側（「← 專案」），而它的目標是這裡：一個
 * 永遠存在的地方。反過來（列表疊在畫布上、返回回到畫布）的問題是，剛刪掉一份
 * 或正要切走的時候，「我剛剛那張畫布」根本不存在。
 *
 * **與擴充功能面板同一套 class**（`.gallery*`／`.ext-card*`），因為它們是同一種
 * 東西：一頁「這台機器上有什麼」的目錄。共用不是為了少寫 CSS，是為了讓使用者在
 * 兩頁之間不必重新學一次「卡片按下去會怎樣」。（那一頁仍然是疊在畫布上的浮層，
 * 而它的「返回」是回到那張還在的畫布——兩顆返回不會同時出現在畫面上，因為這一頁
 * 根本沒有那顆。）
 *
 * **左鍵打開，右鍵是那幾個動詞**：改名、複製、匯出、刪除。會改變東西的動作不跟
 * 「打開它」共用同一下點擊。
 *
 * 右上角是**新專案**（一顆加號 + 一個問名字的對話框）與**從電腦匯入**——這一頁
 * 唯二會產生新東西的動作。
 */
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Copy, Download, Ear, Loader2, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import {
  copyProject,
  createProject,
  deleteProject,
  inspectBundle,
  renameProject,
  type BundleReview,
  type ProjectSummary,
} from '../api/projects';
import { activateProject, deactivateProject } from '../api/triggers';
import { LIST_PATH, go, missingProjectId, projectPath } from '../project/routes';
import { useProjectsUi, whenText } from './projectsStore';
import { copyEnabledPref } from './extensionsStore';
import { ProjectNameModal } from './ProjectNameModal';
import { ProjectImport } from './ProjectImport';
import { ExportDialog } from './ExportDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { Toast } from './Toast';
import { focusableIn, modalKeyAction, nextFocusIndex } from './modalKeys';
import { t } from '../i18n';

export function ProjectsPage() {
  const projects = useProjectsUi((s) => s.projects);
  const listening = useProjectsUi((s) => s.listening);
  const loading = useProjectsUi((s) => s.loading);
  const listError = useProjectsUi((s) => s.error);
  const reload = useProjectsUi((s) => s.reload);
  const setProjectListening = useProjectsUi((s) => s.setListening);

  const [menu, setMenu] = useState<{ project: ProjectSummary; x: number; y: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null);
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);
  const [exporting, setExporting] = useState<ProjectSummary | null>(null);
  /** 收下的那一份 bundle，還沒開出專案（§7）。 */
  const [bundle, setBundle] = useState<BundleReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [listeningBusy, setListeningBusy] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  /**
   * 剛剛做完的那件事（改完名、複製完、刪完、匯出完）。**與編輯器裡那條是同一個
   * 元件**（`Toast`）：使用者在兩邊看到的「做完了」長得一樣、活得一樣久。
   *
   * 它不是 `.gallery-notice`——那一條是留在原地的話（見 `missing`）。一句回執
   * 講的是已經過去的事，讓它一直佔著標頭底下那一行，下一次進這一頁還會看到
   * 「已刪掉⋯」，而那件事使用者早就知道了。
   */
  const [toast, setToast] = useState<string | null>(null);
  /**
   * 被踢回來的那一次：網址指到一份不存在的專案。**這一句留在原地**，不做成
   * 會自己消失的提示——它不是回執，是「你為什麼會在這裡」，而使用者可能正在
   * 想「那份專案呢」，還沒開始讀。
   */
  const [missing, setMissing] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  /**
   * 被踢回來的那一次：那個網址指到一份不存在的專案（`App` 的載入那一段）。
   *
   * **要說出口。** 不說的話，使用者按了一個書籤、或只是開了 `/`，看到的是主選單
   * ——而他要的是那份專案，畫面上卻沒有任何東西說它去哪了。
   *
   * 說完把網址上那一格擦掉（`replaceState`，不留歷史）：這句話描述的是剛剛那一次
   * 導覽，重新整理一次之後它就不再是真的了。
   */
  useEffect(() => {
    const gone = missingProjectId();
    if (!gone) return;
    setMissing(t('projects.missing', { id: gone }));
    history.replaceState(null, '', LIST_PATH);
  }, []);

  // 收掉選單的那幾條路，與 `useExtensionMenu` 一模一樣：按在別處、視窗失焦、
  // 捲動、Esc。抄一份而不是共用，是因為那個 hook 的 state 型別綁著
  // `ToolboxGroup`——而把它泛型化換來的只有一個多一層的簽章。
  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', dismiss, true);
    document.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('keydown', onEscape);
    };
  }, [menu]);

  /**
   * 打開一份。**這一頁不必先存檔**——會不會有沒存的改動是編輯器那一側的問題，
   * 而使用者能走到這裡，就代表他已經過了那一關（`App` 的「← 專案」）。
   */
  const open = (project: ProjectSummary) => go(projectPath(project.id));

  const create = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      // 新專案的意思就是「我現在要做這一個」——開完停在列表上，等於要求使用者
      // 再點一次他剛剛已經表達過的意圖。
      go(projectPath((await createProject(name)).id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const rename = async (project: ProjectSummary, name: string) => {
    setBusy(true);
    setError(null);
    try {
      await renameProject(project.id, name);
      setRenaming(null);
      await reload();
      setToast(t('projects.renamed', { name: name || t('projects.untitled') }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 複製一份。**做完停在這一頁**——與「新專案」相反。
   *
   * 新專案的意思是「我現在要做這一個」，而複製的意思常常是「先留一份再改」：
   * 把使用者送進副本的畫布，等於替他決定了他要動的是哪一份。留在列表上，兩張
   * 卡都在他眼前，那句話由他自己說。
   *
   * 沒有對話框：名字由後端取（撞名往下數），而想改的話「改名⋯」就在同一個選單上。
   */
  const duplicate = async (project: ProjectSummary) => {
    setBusy(true);
    setError(null);
    try {
      const copy = await copyProject(project.id);
      copyEnabledPref(project.id, copy.id);
      await reload();
      // 說出**沒有**跟著複製的那些：它們都掛在專案 id 上，而副本是另一個 id
      // （§3）。不說的話，使用者打開副本會看到一排「未設定」，而他昨天才填過。
      setToast(t('projects.copied', { name: copy.name }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (project: ProjectSummary) => {
    setBusy(true);
    setError(null);
    try {
      await deleteProject(project.id);
      setDeleting(null);
      await reload();
      setToast(t('projects.deleted', { name: project.name }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleListening = async (project: ProjectSummary) => {
    if (listeningBusy.has(project.id)) return;
    const turnOn = !listening.has(project.id);
    setListeningBusy((ids) => new Set(ids).add(project.id));
    setError(null);
    try {
      if (turnOn) {
        const state = await activateProject(project.id);
        setProjectListening(project.id, state.active);
        setToast(
          state.hats.length === 0
            ? t('projects.listenOnEmpty', { name: project.name })
            : t('projects.listenOn', { name: project.name }),
        );
      } else {
        await deactivateProject(project.id);
        setProjectListening(project.id, false);
        setToast(t('projects.listenOff', { name: project.name }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setListeningBusy((ids) => {
        const next = new Set(ids);
        next.delete(project.id);
        return next;
      });
    }
  };

  const pickBundle = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      setBundle(await inspectBundle(file));
    } catch (e) {
      // 讀不進來的檔案停在這一頁：使用者要做的事是「換一個檔案」，而那顆按鈕
      // 就在他剛剛按的地方。
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const action = modalKeyAction({
      key: e.key,
      shiftKey: e.shiftKey,
      editing: false,
      inWorkspace: false,
      target: (e.target as HTMLElement).tagName.toLowerCase(),
    });
    // **Esc 在這一頁只收選單。** 它是家，沒有「上一層」可以退到——而一個按了
    // 沒反應的 Esc 好過一個把使用者送去某個猜出來的地方的 Esc。
    if (action === 'cancel') {
      if (menu) {
        e.preventDefault();
        setMenu(null);
      }
    } else if (action === 'focus-next' || action === 'focus-prev') {
      if (!pageRef.current) return;
      const items = focusableIn(pageRef.current);
      if (items.length === 0) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[nextFocusIndex(items.length, at, action === 'focus-prev')]?.focus();
    }
  };

  // **匯入是這一頁的另一個狀態，不是另一條路**（同擴充功能面板與審閱畫面）。
  if (bundle) {
    return (
      <ProjectImport
        review={bundle}
        onOpened={(projectId) => go(projectPath(projectId))}
        onCancel={() => setBundle(null)}
      />
    );
  }

  return (
    <div className="gallery" aria-label={t('projects.label')} ref={pageRef} onKeyDown={onKeyDown}>
      <header className="gallery-head">
        {/* 左上角那一格沒有返回——這一頁是家。放的是這個工具的名字，因為那正是
            「我在哪裡」的答案，而編輯器那一側的標頭上也是它。 */}
        <span className="brand gallery-brand">
          <img className="brand-icon" src="/icon.svg" alt="" />
          blockyard
        </span>
        <h2>{t('projects.label')}</h2>
        <div className="gallery-head-actions">
          {/* 檔案挑選器藏在按鈕後面（同擴充功能面板）：`<input type="file">` 長
              什麼樣子由瀏覽器決定，而這一列上的東西是我們自己畫的。 */}
          <input
            ref={fileRef}
            type="file"
            accept=".blockyard,.zip,application/zip"
            className="visually-hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // 選完就清值：不清的話，同一個檔案選第二次不會發事件，而症狀是
              // 「按了沒反應」。
              e.target.value = '';
              if (file) void pickBundle(file);
            }}
          />
          <button
            type="button"
            className="button gallery-import is-secondary"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            {busy ? (
              <Loader2 size={14} strokeWidth={2.5} className="import-spin" />
            ) : (
              <Upload size={14} strokeWidth={2.5} />
            )}
            {t('projects.import')}
          </button>
          <button
            type="button"
            className="button gallery-import"
            onClick={() => {
              setError(null);
              setCreating(true);
            }}
            disabled={busy}
          >
            <Plus size={14} strokeWidth={2.5} /> {t('projects.new')}
          </button>
        </div>
      </header>

      {(error ?? listError) && (
        <p className="gallery-alert" role="alert">
          <AlertTriangle size={14} strokeWidth={2.5} /> {error ?? listError}
        </p>
      )}
      {missing && <p className="gallery-notice">{missing}</p>}

      {projects.length === 0 ? (
        <p className="gallery-empty">
          {loading ? t('projects.loading') : t('projects.empty')}
        </p>
      ) : (
        <ul className="gallery-grid">
          {projects.map((project) => (
            <li key={project.id} className="project-card-item">
              <button
                type="button"
                className="ext-card project-card"
                onClick={() => open(project)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ project, x: e.clientX, y: e.clientY });
                }}
              >
                <ProjectCardArt project={project} />
                <span className="ext-card-body">
                  <span className="ext-card-name">{project.name}</span>
                  <span className="ext-card-desc">{whenText(project.updatedAt)}</span>
                </span>
              </button>
              <button
                type="button"
                className={`project-card-live${listening.has(project.id) ? ' is-on' : ''}`}
                aria-label={t('projects.listenToggle', { name: project.name, on: listening.has(project.id) })}
                aria-pressed={listening.has(project.id)}
                title={t('projects.listenToggle', { name: project.name, on: listening.has(project.id) })}
                disabled={listeningBusy.has(project.id)}
                onClick={() => void toggleListening(project)}
              >
                {listeningBusy.has(project.id) ? (
                  <Loader2 size={13} strokeWidth={2.5} className="import-spin" aria-hidden="true" />
                ) : (
                  <Ear size={13} strokeWidth={2.5} aria-hidden="true" />
                )}
                {listening.has(project.id) ? t('projects.listening') : t('projects.listen')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {menu && (
        <div
          className="ext-menu"
          role="menu"
          aria-label={t('projects.actions', { name: menu.project.name })}
          // 夾在視窗內：在最後一排卡片上按右鍵時，選單本來會有一半長到畫面外面。
          style={{
            left: Math.min(menu.x, window.innerWidth - 268),
            top: Math.min(menu.y, window.innerHeight - 172),
            width: 260,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="ext-menu-item"
            onClick={() => {
              setRenaming(menu.project);
              setError(null);
              setMenu(null);
            }}
          >
            <Pencil size={14} strokeWidth={2.5} /> {t('projects.rename')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="ext-menu-item"
            onClick={() => {
              const project = menu.project;
              setMenu(null);
              void duplicate(project);
            }}
          >
            <Copy size={14} strokeWidth={2.5} /> {t('projects.copy')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="ext-menu-item"
            onClick={() => {
              setExporting(menu.project);
              setError(null);
              setMenu(null);
            }}
          >
            <Download size={14} strokeWidth={2.5} /> {t('projects.export')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="ext-menu-item is-danger"
            onClick={() => {
              setDeleting(menu.project);
              setError(null);
              setMenu(null);
            }}
          >
            <Trash2 size={14} strokeWidth={2.5} /> {t('projects.delete')}
          </button>
        </div>
      )}

      {creating && (
        <ProjectNameModal
          title={t('projects.new')}
          confirmLabel={t('projects.createAndOpen')}
          busy={busy}
          error={error}
          onSubmit={(name) => void create(name)}
          onCancel={() => setCreating(false)}
        />
      )}

      {renaming && (
        <ProjectNameModal
          title={t('projects.renameTitle', { name: renaming.name })}
          confirmLabel={t('projects.renameAction')}
          initial={renaming.name}
          busy={busy}
          error={error}
          onSubmit={(name) => void rename(renaming, name)}
          onCancel={() => setRenaming(null)}
        />
      )}

      {exporting && (
        <ExportDialog
          projectId={exporting.id}
          projectName={exporting.name}
          onClose={() => setExporting(null)}
          onDone={setToast}
        />
      )}

      {toast !== null && <Toast text={toast} onDismiss={() => setToast(null)} page />}

      {deleting && (
        <ConfirmDialog
          title={t('projects.deleteTitle', { name: deleting.name })}
          confirmLabel={t('projects.deleteAction')}
          busy={busy}
          onConfirm={() => void remove(deleting)}
          onCancel={() => setDeleting(null)}
        >
          {/* 說**會發生什麼事**，不是「你確定嗎」。這三樣東西都掛在專案 id 上
              （§3），而它們沒有一樣是回得來的。 */}
          <p>{t('projects.deleteWarning1')}</p>
          <p>{t('projects.deleteWarning2')}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * 卡片上那一格圖。監聽開關是它的兄弟元素，疊在這格右上角。
 *
 * **為什麼這一頁需要它。** active 是後端的持久狀態：關掉瀏覽器它照樣跑、後端
 * 重啟它自己回來。而在這一頁之前，那件事只有「打開那一份、看工具列那顆耳朵」
 * 才問得到——於是「我昨天到底把哪幾份開著」得一份一份點進去才數得出來，而那正
 * 是一份在背景送 Discord 訊息的流程最不該有的性質。
 *
 * 開關不能放進這顆卡片按鈕裡（互動元素不可巢狀），所以由 `ProjectsPage` 放成兄弟
 * 按鈕；視覺上仍壓在預覽圖的右上角。
 */
function ProjectCardArt({ project }: { project: ProjectSummary }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="ext-card-art">
      <span className="ext-card-initial">{[...project.name][0] ?? '?'}</span>
      {project.preview && !failed && (
        <img
          className="ext-card-cover"
          src={project.preview}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

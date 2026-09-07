/**
 * 匯出一份專案（`docs/project-storage-design.md` §5、§6、§9）。
 *
 * 三件事，而它們的份量刻意不一樣：
 *
 * 1. **存到哪。** 那一格是**唯讀的回執**，不是輸入框——路徑只能來自後端自己
 *    開的那個原生對話框（§9 的 token 規則）。沒有 tkinter 的機器上那顆
 *    「瀏覽…」不畫，匯出落到瀏覽器的下載資料夾，而那條路永遠成立。
 * 2. **要不要一併匯出金鑰**，而旁邊列著**這次會走出去哪幾把**。沒有那份清單，
 *    這個勾選框是在要求使用者對一件他看不見的事負責（§6）。
 * 3. **這份 bundle 會帶幾個積木包的原始碼**。它回答的是「我寄出去的到底是
 *    什麼」——一份專案檔不只是一份 IR，它帶著別人寫的程式碼。
 *
 * 金鑰是**第二個檔案**（`我的專案.env`），不是同一個檔案裡的一個旗標：一份帶
 * 金鑰的 bundle 與一份不帶的如果長得一樣，它就會被轉寄、被丟上 GitHub——而那
 * 一刻沒有人記得三天前勾過什麼。
 */
import { useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import {
  downloadExport,
  exportToPath,
  fetchDialogAvailable,
  fetchExportPlan,
  openSaveDialog,
  type ProjectSecret,
} from '../api/projects';
import { focusableIn, modalKeyAction, nextFocusIndex } from './modalKeys';
import { ModalActions } from './ModalActions';
import { list, number, t } from '../i18n';

export interface ExportDialogProps {
  projectId: string;
  projectName: string;
  onClose(): void;
  /** 匯出完了說一句（畫布上那條提示）。 */
  onDone(message: string): void;
}

export function ExportDialog({ projectId, projectName, onClose, onDone }: ExportDialogProps) {
  const [packs, setPacks] = useState<{ id: string; name: string; version: string }[]>([]);
  const [secrets, setSecrets] = useState<ProjectSecret[]>([]);
  const [withSecrets, setWithSecrets] = useState(false);
  const [canBrowse, setCanBrowse] = useState(false);
  /** 「瀏覽…」選過的位置。`null` = 還沒選 = 走瀏覽器下載。 */
  const [target, setTarget] = useState<{ token: string; display: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchExportPlan(projectId, controller.signal)
      .then((plan) => {
        setPacks(plan.packs);
        setSecrets(plan.secrets);
      })
      .catch(() => {});
    void fetchDialogAvailable(controller.signal).then(setCanBrowse);
    return () => controller.abort();
  }, [projectId]);

  /** 已經設定過、而且 `.env` 帶得走的那幾把。**只有它們會走出去。** */
  const going = secrets.filter((s) => s.configured && s.exportable);
  /** 設定過、但沒有 `envVar`——寫出去也餵不回來。說出來，不是安靜地少一行。 */
  const stuck = secrets.filter((s) => s.configured && !s.exportable);

  const browse = async () => {
    setError(null);
    try {
      const picked = await openSaveDialog(`${projectName}.blockyard`);
      if (!picked.available) {
        setCanBrowse(false);
        return;
      }
      // 按了取消 = 這件事沒發生，不是錯誤。上一次選好的位置**留著**——使用者
      // 開了對話框又關掉，最不該發生的事是他剛剛挑的路徑被清空。
      if (picked.token && picked.display) {
        setTarget({ token: picked.token, display: picked.display });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (target) {
        const done = await exportToPath(projectId, target.token, withSecrets);
        onDone(
          done.envPath
            ? t('export.savedWithSecrets', { path: done.path, envPath: done.envPath })
            : t('export.saved', { path: done.path }),
        );
      } else {
        downloadExport(projectId, 'bundle');
        if (withSecrets) {
          // 兩個檔案就是兩次下載。**分開一拍**：連著兩個 `a.click()` 有些瀏覽器
          // 只會收下第一個（第二個被當成「網頁自己在連續下載」擋掉）。
          setTimeout(() => downloadExport(projectId, 'env'), 400);
        }
        onDone(
          withSecrets
            ? t('export.downloadedWithSecrets')
            : t('export.downloaded'),
        );
      }
      onClose();
    } catch (e) {
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
    if (action === 'cancel') {
      e.preventDefault();
      if (!busy) onClose();
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
    <div className="modal-backdrop" onKeyDown={onKeyDown}>
      <div
        className="modal export-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('export.title')}
        ref={dialogRef}
      >
        <header className="modal-head">
          <h2>{t('export.namedTitle', { name: projectName })}</h2>
        </header>

        <div className="export-body">
          <div className="export-row">
            <span className="export-label">{t('export.destination')}</span>
            {/* **唯讀**：它是給人看的回執，不是一個輸入框（§9）。 */}
            <span className="export-path" title={target?.display ?? undefined}>
              {target ? target.display : t('export.downloads')}
            </span>
            {canBrowse && (
              <button type="button" className="button" onClick={() => void browse()} disabled={busy}>
                <FolderOpen size={13} strokeWidth={2.5} /> {t('export.browse')}
              </button>
            )}
          </div>

          <label className="export-check">
            <input
              type="checkbox"
              checked={withSecrets}
              onChange={(e) => setWithSecrets(e.target.checked)}
              disabled={busy || going.length === 0}
            />
            <span>
              {t('export.withSecrets', { file: `${projectName}.env` })}
            </span>
          </label>

          {going.length === 0 ? (
            <p className="export-note">{t('export.noSecrets')}</p>
          ) : (
            <ul className="export-secrets">
              {going.map((s) => (
                <li key={`${s.extId}.${s.key}`}>
                  <code>
                    {s.extId}.{s.key}
                  </code>
                  <span>{s.suffix ? `····${s.suffix}` : t('keys.configured')}</span>
                </li>
              ))}
            </ul>
          )}

          {stuck.length > 0 && (
            <p className="export-note">
              {t('export.stuckSecrets', { count: number(stuck.length) })}
            </p>
          )}

          {withSecrets && (
            // 這句話是那個勾選框的代價，而它要在按下去**之前**說。
            <p className="export-warn">
              {t('export.secretWarning')}
            </p>
          )}

          {/* 「我寄出去的到底是什麼」。**列出名字，不只是一個數字**：使用者對
              「這份檔案帶著別人寫的程式碼」這件事的判斷，靠的是那幾個名字。 */}
          <p className="export-note">
            {packs.length === 0
              ? t('export.noPacks')
              : t('export.packs', {
                  count: number(packs.length),
                  names: list(packs.map((p) => p.name)),
                })}
          </p>
        </div>

        {error && (
          <p className="modal-hint project-name-error" role="alert">
            {error}
          </p>
        )}

        <ModalActions confirmLabel={t('export.action')} busy={busy} onConfirm={() => void run()} onCancel={onClose} />
      </div>
    </div>
  );
}

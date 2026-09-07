/**
 * 「解除安裝⋯」按下去之後那一格（`docs/extension-design.md` §5）。
 *
 * **它不是一句「你確定嗎」，是把收據攤出來。** 那句話沒有給使用者任何新資訊
 * ——他按下去的時候就已經確定了；他不確定的是**這一下會動到什麼**。所以這一
 * 格上只有三個數字：這個包是什麼時候、從哪裡裝的，版本是多少，畫布上有幾顆
 * 它的積木。那三個就是他需要的全部。
 *
 * 「畫布上有幾顆」在這裡永遠是 0——還有積木在用時根本走不到這一格（`App`
 * 會先擋下來、捲到那一顆）。仍然要寫出來，因為**使用者要看到我們檢查過**：
 * 一句「畫布上沒有它的積木」是這一格唯一在說「拔掉之後不會有東西壞掉」的話。
 *
 * **搬進垃圾桶，不是刪掉**，而那句話要說出口：它是使用者按錯之後唯一的退路，
 * 而那個路徑現在還沒有一頁 UI 在看（§8 的未答項）。
 */
import { useEffect, useRef } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import type { ExtensionReceipt } from '../api/client';
import { sourceLine } from './extensionsSource';
import { focusableIn, modalKeyAction, nextFocusIndex } from './modalKeys';
import { ModalActions } from './ModalActions';
import { number, t } from '../i18n';

export interface UninstallConfirmProps {
  name: string;
  extId: string;
  version: string;
  receipt: ExtensionReceipt | undefined;
  /** 畫布上有幾顆它的積木。走到這一格時是 0（見檔頭）。 */
  used: number;
  busy: boolean;
  error: string | null;
  onConfirm(): void;
  onCancel(): void;
}

export function UninstallConfirm({
  name,
  extId,
  version,
  receipt,
  used,
  busy,
  error,
  onConfirm,
  onCancel,
}: UninstallConfirmProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // **開場焦點落在「取消」**，與審閱畫面刻意相反：那一頁的主要動作是安裝，
  // 而這一格唯一的動作會從磁碟上搬走東西。一個鍵盤使用者的 Enter 不該預設
  // 指著它。
  useEffect(() => cancelRef.current?.focus(), []);

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
      if (!busy) onCancel();
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
        className="uninstall"
        role="dialog"
        aria-modal="true"
        aria-label={t('uninstall.aria', { name })}
        ref={dialogRef}
      >
        <h2>
          <Trash2 size={16} strokeWidth={2.5} /> {t('uninstall.title', { name })}
        </h2>
        <dl className="uninstall-facts">
          <div>
            <dt>{t('uninstall.version')}</dt>
            <dd>
              v{version} <span className="uninstall-id">{extId}</span>
            </dd>
          </div>
          <div>
            <dt>{t('uninstall.source')}</dt>
            <dd>{sourceLine(receipt)}</dd>
          </div>
          <div>
            <dt>{t('uninstall.canvas')}</dt>
            <dd>{used === 0 ? t('uninstall.noneUsed') : t('uninstall.used', { count: number(used) })}</dd>
          </div>
        </dl>
        <p className="uninstall-note">
          {t('uninstall.note')}
        </p>
        {error && (
          <p className="uninstall-error" role="alert">
            <AlertTriangle size={14} strokeWidth={2.5} /> {error}
          </p>
        )}
        <ModalActions
          className="uninstall-actions"
          confirmLabel={t('uninstall.action')}
          busyLabel={t('uninstall.busy')}
          confirmClassName="is-danger"
          busy={busy}
          cancelRef={cancelRef}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </div>
    </div>
  );
}

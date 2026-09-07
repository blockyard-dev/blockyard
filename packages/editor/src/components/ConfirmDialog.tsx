/**
 * 一句話、兩顆按鈕。
 *
 * **與「解除安裝⋯」那一格刻意不是同一個元件**（`UninstallConfirm`）：那一格上
 * 沒有一句要使用者判斷的話，它攤的是一張收據——三個事實，而使用者按下去之前
 * 要讀的就是那三個。這裡相反：它問的是一個真的問題（「這件事會停掉你正在跑的
 * 東西，還要做嗎」），所以主體是那句話本身。
 *
 * 一個元件同時做兩件事的話，第一個參數就會是 `mode`，而那正是它們該分開的訊號。
 *
 * **開場焦點在「取消」**，與審閱畫面相反：這一格上的主要動作有副作用，而鍵盤
 * 使用者的 Enter 不該預設指著它。
 */
import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { focusableIn, modalKeyAction, nextFocusIndex } from './modalKeys';
import { ModalActions } from './ModalActions';
import { t } from '../i18n';

export interface ConfirmDialogProps {
  title: string;
  /** 主體。要說的是**會發生什麼事**，不是「你確定嗎」。 */
  children?: React.ReactNode;
  icon?: React.ReactNode;
  confirmIcon?: React.ReactNode;
  cancelIcon?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busyLabel?: string;
  busy?: boolean;
  confirmClassName?: string;
  /** 個別確認框可調整共用頁尾的版面，不影響按鈕行為。 */
  actionsClassName?: string;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = t('common.cancel'),
  busyLabel,
  icon,
  confirmIcon,
  cancelIcon,
  busy = false,
  confirmClassName = 'is-danger',
  actionsClassName = '',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

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
      <div className="uninstall" role="dialog" aria-modal="true" aria-label={title} ref={dialogRef}>
        <h2>
          {icon ?? <AlertTriangle size={16} strokeWidth={2.5} />} {title}
        </h2>
        {children && <div className="confirm-body">{children}</div>}
        <ModalActions
          className={`uninstall-actions ${actionsClassName}`.trim()}
          confirmLabel={confirmLabel}
          busyLabel={busyLabel}
          cancelLabel={cancelLabel}
          confirmClassName={confirmClassName}
          busy={busy}
          cancelRef={cancelRef}
          confirmIcon={confirmIcon}
          cancelIcon={cancelIcon}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </div>
    </div>
  );
}

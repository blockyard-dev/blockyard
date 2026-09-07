/**
 * 有「取消／確認」兩個出口的 modal 共用頁尾。
 *
 * 外層對話框各自處理焦點與鍵盤：有些是表單、有些是危險操作，不能把那些規則
 * 假裝成同一件事。這裡只收斂它們相同的視覺與 busy 行為。
 */
import { Loader2 } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { t } from '../i18n';

export interface ModalActionsProps {
  confirmLabel?: string;
  busyLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  confirmClassName?: string;
  className?: string;
  cancelRef?: Ref<HTMLButtonElement>;
  confirmIcon?: ReactNode;
  cancelIcon?: ReactNode;
  onConfirm(): void;
  onCancel(): void;
}

export function ModalActions({
  confirmLabel = t('common.confirm'),
  busyLabel,
  cancelLabel = t('common.cancel'),
  busy = false,
  disabled = false,
  confirmClassName = 'button-primary',
  className = '',
  cancelRef,
  confirmIcon,
  cancelIcon,
  onConfirm,
  onCancel,
}: ModalActionsProps) {
  return (
    <footer className={`modal-foot ${className}`.trim()}>
      <button type="button" className="button" ref={cancelRef} onClick={onCancel} disabled={busy}>
        {cancelIcon}
        {cancelLabel}
      </button>
      <button
        type="button"
        className={`button ${confirmClassName}`}
        onClick={onConfirm}
        disabled={busy || disabled}
      >
        {busy && <Loader2 size={13} strokeWidth={2.5} className="import-spin" />}
        {!busy && confirmIcon}
        {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
      </button>
    </footer>
  );
}

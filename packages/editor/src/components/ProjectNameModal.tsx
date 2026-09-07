/**
 * 一格名字、兩顆按鈕。**新專案與改名共用**（`docs/project-storage-design.md` §3）。
 *
 * 兩者在後端是兩條不同的路（`POST` 開一個新的 opaque id、`PATCH` 只改名字），
 * 但在使用者眼裡是同一個動作：打一個名字。分成兩個對話框只會讓同一格輸入框
 * 有兩種樣子。
 *
 * **名字可以留空。** 空的意思是「隨便」，不是「這個表單填錯了」——後端會給
 * 「未命名專案」。所以確定那顆按鈕永遠按得下去，而這一格永遠不會紅。
 */
import { useEffect, useRef, useState } from 'react';
import { focusableIn, modalKeyAction, nextFocusIndex } from './modalKeys';
import { ModalActions } from './ModalActions';
import { t } from '../i18n';

export interface ProjectNameModalProps {
  title: string;
  confirmLabel: string;
  /** 改名時是舊名字；新專案時是空的。 */
  initial?: string;
  busy?: boolean;
  error?: string | null;
  onSubmit(name: string): void;
  onCancel(): void;
}

export function ProjectNameModal({
  title,
  confirmLabel,
  initial = '',
  busy = false,
  error = null,
  onSubmit,
  onCancel,
}: ProjectNameModalProps) {
  const [name, setName] = useState(initial);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 開場焦點在輸入框，而且**選起來**：改名時使用者多半是要整個換掉，而不是
  // 在舊名字後面接一段。
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    if (!busy) onSubmit(name.trim());
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
      if (!busy) onCancel();
    } else if (action === 'submit') {
      e.preventDefault();
      submit();
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
        className="modal project-name-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialogRef}
      >
        <header className="modal-head">
          <h2>{title}</h2>
        </header>
        <div className="project-name-body">
          <label htmlFor="project-name-input">{t('project.name')}</label>
          <input
            id="project-name-input"
            ref={inputRef}
            className="keys-input"
            type="text"
            value={name}
            maxLength={80}
            placeholder={t('projects.untitled')}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </div>
        {error && (
          <p className="modal-hint project-name-error" role="alert">
            {error}
          </p>
        )}
        <ModalActions confirmLabel={confirmLabel} busy={busy} onConfirm={submit} onCancel={onCancel} />
      </div>
    </div>
  );
}

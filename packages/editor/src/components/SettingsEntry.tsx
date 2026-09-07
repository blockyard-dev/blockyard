import { useEffect, useId, useRef, useState } from 'react';
import { Check, History, Languages, Save, Settings, X } from 'lucide-react';
import { currentLocale, LOCALE_NAMES, selectLocale, SUPPORTED_LOCALES, t, tFor, type Locale } from '../i18n';
import { ConfirmDialog } from './ConfirmDialog';
import { focusableIn, nextFocusIndex } from './modalKeys';

export function SettingsEntry({
  historyEnabled,
  onOpenHistory,
  onSave,
  reload,
}: {
  historyEnabled: boolean;
  onOpenHistory(): void;
  onSave(): Promise<boolean>;
  reload?: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [position, setPosition] = useState({ right: 8, top: 44 });

  const restoreFocus = () => buttonRef.current?.focus();
  const closeMenu = (restore = true) => {
    setMenuOpen(false);
    if (restore) queueMicrotask(restoreFocus);
  };

  const openMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      setPosition({
        right: Math.max(8, window.innerWidth - rect.right),
        top: Math.max(8, Math.min(window.innerHeight - 104, rect.bottom + 6)),
      });
    }
    setMenuOpen(true);
  };

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const dismiss = () => closeMenu();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (menuRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', dismiss, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : nextFocusIndex(items.length, at, event.key === 'ArrowUp');
    items[next]?.focus();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="button button-icon"
        aria-label={t('settings.label')}
        title={t('settings.label')}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuId}
        onClick={() => (menuOpen ? closeMenu() : openMenu())}
      >
        <Settings size={15} strokeWidth={2.5} />
      </button>
      {menuOpen && (
        <div
          ref={menuRef}
          id={menuId}
          className="ext-menu settings-menu"
          role="menu"
          aria-label={t('settings.menuLabel')}
          style={{ right: position.right, top: position.top }}
          onKeyDown={onMenuKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            className="ext-menu-item"
            disabled={!historyEnabled}
            onClick={() => {
              closeMenu(false);
              onOpenHistory();
            }}
          >
            <History size={14} strokeWidth={2.5} /> {t('settings.history')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="ext-menu-item"
            onClick={() => {
              closeMenu(false);
              setLanguageOpen(true);
            }}
          >
            <Languages size={14} strokeWidth={2.5} /> {t('settings.language')}
          </button>
        </div>
      )}
      {languageOpen && (
        <LanguageModal
          onSave={onSave}
          reload={reload}
          onClose={() => {
            setLanguageOpen(false);
            queueMicrotask(restoreFocus);
          }}
        />
      )}
    </>
  );
}

function LanguageModal({
  onClose,
  onSave,
  reload,
}: {
  onClose(): void;
  onSave(): Promise<boolean>;
  reload?: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const locale = currentLocale();
  const [pendingLocale, setPendingLocale] = useState<Locale | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const items = focusableIn(dialogRef.current);
    if (items.length === 0) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[nextFocusIndex(items.length, at, event.shiftKey)]?.focus();
  };

  const choose = (next: Locale) => {
    if (next === locale) onClose();
    else setPendingLocale(next);
  };

  const saveAndSwitch = async () => {
    if (!pendingLocale || saving) return;
    setSaving(true);
    const saved = await onSave();
    if (saved) selectLocale(pendingLocale, reload);
    else setSaving(false);
  };

  if (pendingLocale) {
    return (
      <ConfirmDialog
        title={tFor(pendingLocale, 'settings.saveBeforeLanguageChange')}
        icon={<Save size={16} strokeWidth={2.5} />}
        confirmIcon={<Check size={14} strokeWidth={2.5} />}
        cancelIcon={<X size={14} strokeWidth={2.5} />}
        confirmLabel={tFor(pendingLocale, 'common.confirm')}
        cancelLabel={tFor(pendingLocale, 'common.cancel')}
        busyLabel={tFor(pendingLocale, 'editor.saving')}
        busy={saving}
        confirmClassName="button-primary"
        actionsClassName="language-save-actions"
        onConfirm={() => void saveAndSwitch()}
        onCancel={() => setPendingLocale(null)}
      />
    );
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} className="modal language-modal" role="dialog" aria-modal="true" aria-labelledby="language-title" onKeyDown={onKeyDown}>
        <header className="modal-head">
          <h2 id="language-title"><Languages size={16} strokeWidth={2.5} /> {t('settings.languageDialog')}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </header>
        <div className="language-options">
          {SUPPORTED_LOCALES.map((item) => (
            <button
              key={item}
              type="button"
              className="language-option"
              aria-current={item === locale ? 'true' : undefined}
              onClick={() => choose(item)}
            >
              <span>{LOCALE_NAMES[item]}</span>
              {item === locale && <Check size={17} strokeWidth={2.5} aria-hidden="true" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

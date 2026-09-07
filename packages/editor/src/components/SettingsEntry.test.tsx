// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initializeLocale } from '../i18n';
import { SettingsEntry } from './SettingsEntry';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  initializeLocale();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(
  historyEnabled = true,
  onOpenHistory = vi.fn(),
  onSave = vi.fn(async () => true),
  reload = vi.fn(),
) {
  await act(async () => root.render(
    <SettingsEntry historyEnabled={historyEnabled} onOpenHistory={onOpenHistory} onSave={onSave} reload={reload} />,
  ));
  return {
    gear: container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!,
    onOpenHistory,
    onSave,
    reload,
  };
}

it('opens the accessible menu and moves through enabled items with the keyboard', async () => {
  const { gear } = await render();
  await act(async () => gear.click());
  const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
  const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  expect(gear.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(items[0]);
  await act(async () => items[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  expect(document.activeElement).toBe(items[1]);
  await act(async () => items[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  expect(document.activeElement).toBe(items[0]);
});

it('keeps language available while history is disabled', async () => {
  const { gear } = await render(false);
  await act(async () => gear.click());
  const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  expect(items[0]!.disabled).toBe(true);
  expect(items[1]!.disabled).toBe(false);
  await act(async () => items[1]!.click());
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.querySelector('[aria-current="true"]')?.textContent).toContain('中文（繁體）');
});

it('opens existing history and closes the menu', async () => {
  const opened = vi.fn();
  const { gear } = await render(true, opened);
  await act(async () => gear.click());
  const history = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  await act(async () => history.click());
  expect(opened).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="menu"]')).toBeNull();
});

it('closes on Escape and restores focus to the gear', async () => {
  const { gear } = await render();
  await act(async () => gear.click());
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await act(async () => Promise.resolve());
  expect(container.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(gear);
});

it('asks in the target language and does not save or switch when cancelled', async () => {
  const { gear, onSave } = await render();
  await act(async () => gear.click());
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.language-option')]
    .find((button) => button.textContent?.includes('English'))!.click());

  const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain('Save the current file');
  expect(dialog.textContent).toContain('Confirm');
  expect(dialog.textContent).toContain('Cancel');
  expect(dialog.querySelectorAll('svg')).toHaveLength(3);
  expect(dialog.querySelector('.language-save-actions')).not.toBeNull();

  await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.includes('Cancel'))!.click());
  expect(onSave).not.toHaveBeenCalled();
  expect(container.querySelector('.language-options')).not.toBeNull();
  expect(localStorage.getItem('blockyard.pref.locale')).toBeNull();
});

it('keeps the confirmation open when saving fails', async () => {
  const onSave = vi.fn(async () => false);
  const { gear } = await render(true, vi.fn(), onSave);
  await act(async () => gear.click());
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.language-option')]
    .find((button) => button.textContent?.includes('English'))!.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((button) => button.textContent?.includes('Confirm'))!.click());

  expect(onSave).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Save the current file');
  expect(localStorage.getItem('blockyard.pref.locale')).toBeNull();
});

it('saves before persisting the target language and reloading', async () => {
  const order: string[] = [];
  const onSave = vi.fn(async () => {
    order.push('save');
    return true;
  });
  const reload = vi.fn(() => order.push('reload'));
  const { gear } = await render(true, vi.fn(), onSave, reload);
  await act(async () => gear.click());
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.language-option')]
    .find((button) => button.textContent?.includes('English'))!.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((button) => button.textContent?.includes('Confirm'))!.click());

  expect(order).toEqual(['save', 'reload']);
  expect(JSON.parse(localStorage.getItem('blockyard.pref.locale')!)).toBe('en');
});

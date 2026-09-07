// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentLocale, date, initializeLocale, list, number, plural, preferredLocale, relative, selectLocale, t, tFor } from '.';
import { translatedError, translatedErrorParts } from '../api/client';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    clear: () => values.clear(),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('locale preference', () => {
  it('defaults missing and damaged values to zh-TW', () => {
    expect(preferredLocale()).toBe('zh-TW');
    localStorage.setItem('blockyard.pref.locale', JSON.stringify('fr'));
    expect(preferredLocale()).toBe('zh-TW');
    localStorage.setItem('blockyard.pref.locale', '{');
    expect(preferredLocale()).toBe('zh-TW');
  });

  it('defaults safely when storage access is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('blocked'); },
      setItem: () => { throw new DOMException('blocked'); },
    });
    expect(preferredLocale()).toBe('zh-TW');
    initializeLocale();
    expect(() => selectLocale('en', vi.fn())).not.toThrow();
  });

  it('initializes the shared locale, html language, and title before render', () => {
    localStorage.setItem('blockyard.pref.locale', JSON.stringify('en'));
    expect(initializeLocale()).toBe('en');
    expect(currentLocale()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(document.title).toBe('blockyard');
    expect(t('settings.history')).toBe('Run history');
    expect(t('format.itemCount', { count: number(1), category: plural(1) })).toBe('1 item');
    expect(t('format.itemCount', { count: number(2), category: plural(2) })).toBe('2 items');
  });

  it('persists and reloads only when the locale really changes', () => {
    initializeLocale();
    const reload = vi.fn();
    expect(selectLocale('zh-TW', reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(selectLocale('en', reload)).toBe(true);
    expect(JSON.parse(localStorage.getItem('blockyard.pref.locale')!)).toBe('en');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('formats values with the active locale', () => {
    localStorage.setItem('blockyard.pref.locale', JSON.stringify('en'));
    initializeLocale();
    expect(number(1234, { useGrouping: false })).toBe('1234');
    expect(date(new Date('2024-01-02T00:00:00Z'), { timeZone: 'UTC', year: 'numeric' })).toBe('2024');
    expect(list(['one', 'two'])).toBe('one and two');
    expect(relative(-1, 'day', { numeric: 'auto' })).toBe('yesterday');
    expect(plural(1)).toBe('one');
    expect(translatedError({
      code: 'undefined_variable',
      params: { name: 'total' },
      message: '未知變數 total',
    })).toBe('Variable “total” was not found');
    expect(translatedErrorParts({ code: 'future.error', message: 'legacy text' }).message)
      .toBe('legacy text');
  });

  it('can translate pre-switch UI without changing the active locale', () => {
    initializeLocale();
    expect(tFor('en', 'settings.saveBeforeLanguageChange')).toBe('Save the current file');
    expect(t('settings.saveBeforeLanguageChange')).toBe('保存目前檔案');
    expect(currentLocale()).toBe('zh-TW');
  });
});

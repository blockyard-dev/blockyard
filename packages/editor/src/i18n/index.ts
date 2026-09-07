import { readPref, writePref } from '../prefs';
import { en, type MessageKey, zhTW } from './catalogs';

export const SUPPORTED_LOCALES = ['zh-TW', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  'zh-TW': '中文（繁體）',
  en: 'English',
};

const catalogs = { 'zh-TW': zhTW, en } as const;
let activeLocale: Locale = 'zh-TW';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function preferredLocale(): Locale {
  const value = readPref<unknown>('locale', 'zh-TW');
  return isLocale(value) ? value : 'zh-TW';
}

/** Run once before React mounts. Keeping this synchronous avoids a second locale state in React. */
export function initializeLocale(): Locale {
  activeLocale = preferredLocale();
  document.documentElement.lang = activeLocale;
  document.title = t('app.title');
  return activeLocale;
}

export function currentLocale(): Locale {
  return activeLocale;
}

type MessageParams<K extends MessageKey> = (typeof zhTW)[K] extends (
  params: infer P,
) => string
  ? [params: P]
  : [];

export function t<K extends MessageKey>(key: K, ...args: MessageParams<K>): string {
  return tFor(activeLocale, key, ...args);
}

/** Translate without changing the active locale (for UI shown before a locale switch). */
export function tFor<K extends MessageKey>(locale: Locale, key: K, ...args: MessageParams<K>): string {
  const message = catalogs[locale][key] ?? zhTW[key];
  if (typeof message === 'function') {
    return (message as (params: unknown) => string)(args[0]);
  }
  return message;
}

export function number(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(activeLocale, options).format(value);
}

export function date(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(activeLocale, options).format(value);
}

export function list(
  values: readonly string[],
  options?: Intl.ListFormatOptions,
): string {
  return new Intl.ListFormat(activeLocale, options).format(values);
}

export function relative(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  options?: Intl.RelativeTimeFormatOptions,
): string {
  return new Intl.RelativeTimeFormat(activeLocale, options).format(value, unit);
}

export function plural(value: number): Intl.LDMLPluralRule {
  return new Intl.PluralRules(activeLocale).select(value);
}

/** Returns false for the active locale so callers never perform a meaningless reload. */
export function selectLocale(locale: Locale, reload: () => void = () => location.reload()): boolean {
  if (locale === activeLocale) return false;
  writePref('locale', locale);
  reload();
  return true;
}

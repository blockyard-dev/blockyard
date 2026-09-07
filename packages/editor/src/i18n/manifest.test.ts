import { describe, expect, it } from 'vitest';
import type { Manifest } from '../types/manifest';
import { localizeManifest, type TranslatableManifest } from './manifest';

const original = (): TranslatableManifest => ({
  manifestVersion: 1,
  id: 'demo',
  name: '示範',
  version: '1',
  defaultLocale: 'zh-TW',
  config: [{ key: 'token', label: '金鑰' }],
  panels: [{ id: 'chart', name: '圖表', entry: 'ui/index.html' }],
  palette: [
    { opcode: 'say', type: 'command', text: '說 %(text)', args: { text: { type: 'dropdown', options: [{ value: 'a', label: '甲' }] } } },
    { section: '工具', id: 'tools' },
    { button: 'docs', label: '說明', action: 'open_url', url: 'https://example.com' },
  ],
  locales: {
    en: {
      name: 'Demo',
      blocks: { say: { text: 'say %(text)', args: { text: { label: 'Text', options: { a: 'A' } } } } },
      sections: { tools: { title: 'Tools' } },
      buttons: { docs: { label: 'Docs' } },
      config: { token: { label: 'Key' } },
      panels: { chart: { name: 'Chart' } },
    },
  },
} as TranslatableManifest);

describe('localizeManifest', () => {
  it('localizes every supported surface without changing stable ids', () => {
    const raw = original();
    const view = localizeManifest(raw, raw.locales, 'en');
    expect(view.name).toBe('Demo');
    expect(view.palette?.[0]).toMatchObject({ opcode: 'say', text: 'say %(text)' });
    expect(view.palette?.[1]).toMatchObject({ id: 'tools', section: 'Tools' });
    expect(view.palette?.[2]).toMatchObject({ button: 'docs', label: 'Docs' });
    expect(view.config?.[0]?.label).toBe('Key');
    expect(view.panels?.[0]?.name).toBe('Chart');
    expect((view.palette?.[0] as { args: Record<string, { options: Array<{ label: string }> }> }).args.text!.options[0]?.label).toBe('A');
    expect(raw.name).toBe('示範');
    expect(raw.palette?.[0]).toMatchObject({ text: '說 %(text)' });
  });

  it('falls back field-by-field through default locale and then original', () => {
    const raw = original();
    raw.defaultLocale = 'en';
    raw.locales!.ja = { name: 'デモ' };
    const view: Manifest = localizeManifest(raw, raw.locales, 'ja');
    expect(view.name).toBe('デモ');
    expect((view.palette?.[0] as { text: string }).text).toBe('say %(text)');
    expect(view.description).toBeUndefined();
  });
});

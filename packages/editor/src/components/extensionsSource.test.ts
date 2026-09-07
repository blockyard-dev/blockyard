import { describe, expect, it } from 'vitest';
import { canUninstall, sourceLine } from './extensionsSource';
import type { ExtensionReceipt } from '../api/client';
import { date } from '../i18n';

function receipt(over: Partial<ExtensionReceipt> = {}): ExtensionReceipt {
  return {
    extId: 'greet',
    origin: 'zip',
    label: 'greet.zip',
    url: null,
    ref: null,
    commit: null,
    version: '0.1.0',
    digest: 'sha256:abc',
    installedAt: '2026-09-04T16:59:12Z',
    ...over,
  };
}

describe('sourceLine', () => {
  it('沒有收據就說出那件事，不畫空白', () => {
    expect(sourceLine(undefined)).toBe('你自己放進資料夾的');
  });

  it('.zip 裝的說得出日期與檔名', () => {
    const line = sourceLine(receipt());
    expect(line).toContain('greet.zip');
    expect(line).toContain(date(new Date('2026-09-04T16:59:12Z')));
  });

  it('官方包不寫日期——使用者沒有裝過它', () => {
    expect(sourceLine(receipt({ origin: 'official', label: '隨 Blockyard 出貨' })))
      .toBe('隨 Blockyard 出貨');
  });

  it('壞掉的日期就不畫日期，不畫 Invalid Date', () => {
    expect(sourceLine(receipt({ installedAt: '前天' }))).toBe('從 greet.zip 裝的');
  });
});

describe('canUninstall', () => {
  it('沒有收據 = 使用者自己放的 = 不碰', () => {
    expect(canUninstall(undefined)).toBe(false);
  });

  it('有收據的才動得了——官方包也算', () => {
    expect(canUninstall(receipt())).toBe(true);
    expect(canUninstall(receipt({ origin: 'official' }))).toBe(true);
  });
});

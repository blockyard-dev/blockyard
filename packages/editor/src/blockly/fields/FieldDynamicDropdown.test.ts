/**
 * `FieldDynamicDropdown`（D22、§8.1）的非渲染行為。
 *
 * 三件事：①存檔讀回一個不在目前清單裡的值，欄位要接受它，不能被驗證悄悄
 * 改回舊值；②抓到清單之後，顯示的文字要換成對應的 label；③60 秒內重用
 * 快取，不重新打 API（快取本身在 `dropdownCache.ts` 測，這裡只驗證欄位真的
 * 透過那層快取，不繞過它）。不測畫面（箭頭、選單開闔）——那是 `FieldDropdown`
 * 自己的責任，這裡只測換掉的那兩件事。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldDynamicDropdown } from './FieldDynamicDropdown';

function makeField(value: string, extId = 'http', source = 'methods'): FieldDynamicDropdown {
  return new FieldDynamicDropdown(value, undefined, { extId, source, value });
}

function stubFetchOnce(options: { label: string; value: string }[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => options }) as unknown as Response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('初始值與放寬的驗證', () => {
  it('建構時的值就是目前的值，即使清單還沒抓回來', () => {
    const f = makeField('GET');
    expect(f.getValue()).toBe('GET');
    expect(f.getText()).toBe('GET');
  });

  it('doClassValidation_ 接受任何字串，不檢查是不是在目前的選項裡', () => {
    const f = makeField('GET');
    f.setValue('gpt-5.6-sol');
    expect(f.getValue()).toBe('gpt-5.6-sol');
  });
});

describe('抓選項（fetchDropdownOptions，見 dropdownCache.ts）', () => {
  beforeEach(() => {
    stubFetchOnce([
      { label: 'GET', value: 'GET' },
      { label: 'POST', value: 'POST' },
    ]);
  });

  it('refresh() 抓回來之後，cachedOptions 換成清單、getText 顯示對應的 label', async () => {
    const f = makeField('POST', 'http', 'methods-a');
    await f.refresh();
    expect(f.cachedOptions).toEqual([
      ['GET', 'GET'],
      ['POST', 'POST'],
    ]);
    expect(f.getText()).toBe('POST');
  });

  it('目前的值不在抓回來的清單裡，getText 落回原始值，不會噴錯', async () => {
    const f = makeField('DELETE', 'http', 'methods-b');
    await f.refresh();
    expect(f.getValue()).toBe('DELETE');
    expect(f.getText()).toBe('DELETE');
  });

  it('抓失敗就維持原本的選項，值還在、不會壞掉', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, statusText: 'boom' }) as unknown as Response),
    );
    const f = makeField('GET', 'http', 'methods-c');
    const before = f.cachedOptions;
    await f.refresh();
    expect(f.cachedOptions).toEqual(before);
    expect(f.getValue()).toBe('GET');
  });

  it('60 秒內同一個 extId/source 重用快取，不重新打 API', async () => {
    const f1 = makeField('GET', 'http', 'methods-d');
    await f1.refresh();
    const f2 = makeField('GET', 'http', 'methods-d');
    // @ts-expect-error 私有方法，測試直接觸發非強制的那條路（跟 initView 一樣）
    await f2.load(false);
    expect(f2.cachedOptions).toEqual([
      ['GET', 'GET'],
      ['POST', 'POST'],
    ]);
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });
});

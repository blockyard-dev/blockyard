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

/**
 * 依賴別格的欄位，外加一個假的積木圖。
 *
 * 這顆欄位住在**影子積木**上，而依賴的那一格是**父積木**的另一個輸入孔，所以
 * 假的那一份至少要有這三層：影子 → 父 → 那個孔裡的影子的 `VALUE` 欄位。層數
 * 少一層，測到的就是別的東西。
 */
function makeDependentField(
  deps: Record<string, string | null>,
  source = 'channels',
): FieldDynamicDropdown {
  const f = new FieldDynamicDropdown('', undefined, {
    extId: 'discord',
    source,
    value: '',
    depends: Object.keys(deps),
  });
  const parent = {
    getInput: (name: string) => {
      const value = deps[name];
      // `null` = 那個孔裡插的是真的 reporter，不是影子——值要執行才知道。
      const target =
        value === null
          ? { isShadow: () => false, getField: () => null }
          : { isShadow: () => true, getField: () => ({ getValue: () => value }) };
      return name in deps ? { connection: { targetBlock: () => target } } : null;
    },
  };
  attachTo(f, parent);
  return f;
}

/** 直接換掉 `getSourceBlock`，不走 `setSourceBlock`——後者會去碰真的 Block
 * 的欄位（`field.ts` 讀 `block.type`），而這幾題要的只是「往上一層再往旁邊
 * 找」那條路走不走得通。 */
function attachTo(f: FieldDynamicDropdown, parent: unknown): void {
  (f as unknown as { getSourceBlock: () => unknown }).getSourceBlock = () => ({
    getParent: () => parent,
  });
}

function stubFetchOnce(options: { label: string; value: string }[]) {
  // 簽章要寫出來：這幾題斷言的是**送出去的 body**，而 `mock.calls` 的型別
  // 是從這裡推出來的——寫成 `async ()` 的話第二個參數在 TS 眼裡不存在。
  const fn = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      ({ ok: true, json: async () => options }) as unknown as Response,
  );
  vi.stubGlobal('fetch', fn);
  return fn;
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


describe('吃同一顆積木上其他已填參數的下拉（manifest 的 depends）', () => {
  it('把父積木上那一格的值送進請求', async () => {
    const fn = stubFetchOnce([{ label: '#一般', value: '10' }]);
    const f = makeDependentField({ server: '777' }, 'dep-a');

    // @ts-expect-error 私有方法，測試直接觸發非強制的那條路（跟 initView 一樣）
    await f.load(false);

    expect(fn.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ args: { server: '777' } }),
    });
  });

  it('依賴的那一格還空著也照送，讓積木包自己決定回什麼', async () => {
    // 「還沒選伺服器」是使用者從左往右填的正常中間狀態，不是錯誤。積木包回一
    // 份空清單；前端在這裡替它決定「不要問」的話，那個決定會散在兩邊。
    const fn = stubFetchOnce([]);
    const f = makeDependentField({ server: '' }, 'dep-b');

    // @ts-expect-error 私有方法
    await f.load(false);

    expect(fn.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ args: { server: '' } }),
    });
  });

  it('那個孔裡插的是真的 reporter 時，讀不出值就當空的', async () => {
    // 值要執行才知道。一份空清單比一份錯的清單好。
    const fn = stubFetchOnce([]);
    const f = makeDependentField({ server: null }, 'dep-c');

    // @ts-expect-error 私有方法
    await f.load(false);

    expect(fn.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ args: { server: '' } }),
    });
  });

  it('依賴的那一格變了，重抓的是新的那一份', async () => {
    const fn = stubFetchOnce([{ label: '#一般', value: '10' }]);
    const deps: Record<string, string> = { server: 'A' };
    const f = new FieldDynamicDropdown('', undefined, {
      extId: 'discord',
      source: 'dep-d',
      value: '',
      depends: ['server'],
    });
    const parent = {
      getInput: () => ({
        connection: {
          targetBlock: () => ({
            isShadow: () => true,
            getField: () => ({ getValue: () => deps.server }),
          }),
        },
      }),
    };
    attachTo(f, parent);

    // @ts-expect-error 私有方法
    await f.load(false);
    deps.server = 'B';
    // @ts-expect-error 私有方法
    await f.load(false);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ args: { server: 'B' } }),
    });
  });

  it('重抓不會把這一格已經選好的值清掉', async () => {
    // 換伺服器之後舊的頻道 id 確實不再屬於新的伺服器，但「幫使用者清掉」要判
    // 斷這次變動是不是使用者造成的，而載入專案、undo、拖動走的是同一條事件
    // 路——那是「規則對、時機錯」，代價是默默弄丟一個存過的值。
    stubFetchOnce([{ label: '#別的', value: '99' }]);
    const f = makeDependentField({ server: 'A' }, 'dep-e');
    f.setValue('10');

    // @ts-expect-error 私有方法
    await f.load(false);

    expect(f.getValue()).toBe('10');
    expect(f.getText()).toBe('10');
  });
});


describe('值還空著的時候（`default: \"\"` 的下拉）', () => {
  it('顯示提示字而不是留白', () => {
    // 留白的後果不只是「少一行字」：寬度縮到最小，Blockly 的下拉箭頭排在文字
    // 後面所以也跟著不見，整格看起來不像可以點的東西。
    const f = new FieldDynamicDropdown('', undefined, {
      extId: 'discord',
      source: 'servers',
      value: '',
      placeholder: '選擇伺服器',
    });
    expect(f.getValue()).toBe('');
    expect(f.getText()).toBe('選擇伺服器');
  });

  it('提示字只影響顯示，不會變成值', () => {
    const f = new FieldDynamicDropdown('', undefined, {
      extId: 'discord',
      source: 'servers',
      value: '',
      placeholder: '選擇伺服器',
    });
    expect(f.getValue()).toBe('');
  });

  it('沒給 placeholder 就用通用的那句', () => {
    const f = new FieldDynamicDropdown('', undefined, { extId: 'x', source: 'y', value: '' });
    expect(f.getText()).toBe('選擇…');
  });

  it('有值就顯示值，不顯示提示字', () => {
    const f = new FieldDynamicDropdown('123', undefined, {
      extId: 'discord',
      source: 'servers',
      value: '123',
      placeholder: '選擇伺服器',
    });
    expect(f.getText()).toBe('123');
  });
});

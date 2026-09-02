/**
 * `FieldDynamicDropdown`（D22、§8.1）的非渲染行為。
 *
 * 四件事：①存檔讀回一個不在目前清單裡的值，欄位要接受它，不能被驗證悄悄
 * 改回舊值；②抓到清單之後，顯示的文字要換成對應的 label；③60 秒內重用
 * 快取，不重新打 API（快取本身在 `dropdownCache.ts` 測，這裡只驗證欄位真的
 * 透過那層快取，不繞過它）；④**沒有選項的那三種狀態各說各的話**，不是同一
 * 格空白。不測畫面（箭頭、選單開闔）——那是 `FieldDropdown` 自己的責任，
 * 這裡只測換掉的那幾件事。
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

describe('沒有選項的時候，選單裡那一行話（notice）', () => {
  /** 選單真正會畫出來的東西。走 `getOptions(false)` 而不是直接讀 `notice()`，
   * 因為壞掉的話壞的是**選單**，而選單問的是這個。 */
  function menu(f: FieldDynamicDropdown): string[] {
    return f.getOptions(false).map((opt) => String((opt as [string, string])[0]));
  }

  it('還在抓的時候是「載入中…」，不是一格空白', async () => {
    stubFetchOnce([{ label: '我的伺服器', value: '777' }]);
    const f = new FieldDynamicDropdown('', undefined, {
      extId: 'discord',
      source: 'notice-a',
      value: '',
      placeholder: '選擇伺服器',
    });

    // @ts-expect-error 私有方法，測試直接觸發非強制的那條路（跟 initView 一樣）
    const pending = f.load(false) as Promise<void>;
    expect(menu(f)).toEqual(['載入中…']);
    // 關起來的那一格也要說同一件事——這一格點開來只有一行話，使用者有權在點
    // 下去之前就知道。
    expect(f.getText()).toBe('載入中…');

    await pending;
    expect(menu(f)).toEqual(['我的伺服器']);
    expect(f.getText()).toBe('選擇伺服器');
  });

  it('抓失敗的時候顯示後端那句話——空白說不出 token 還沒設定', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 422,
        json: async () => ({ detail: { message: '還沒設定「Discord」的 Bot Token' } }),
      }) as unknown as Response),
    );
    const f = new FieldDynamicDropdown('', undefined, {
      extId: 'discord',
      source: 'notice-b',
      value: '',
    });

    // @ts-expect-error 私有方法
    await f.load(false);

    expect(menu(f)).toEqual(['還沒設定「Discord」的 Bot Token']);
  });

  it('依賴的那一格還空著，說的是下一步（「先選擇伺服器」）而不是「沒有東西」', async () => {
    // 「還沒選伺服器」是使用者從左往右填的正常中間狀態。說「沒有可以選的項目」
    // 會讓人以為自己的伺服器裡真的一個頻道都沒有。
    stubFetchOnce([]);
    const f = new FieldDynamicDropdown('', undefined, {
      extId: 'discord',
      source: 'notice-c',
      value: '',
      depends: ['server'],
      dependsLabels: { server: '伺服器' },
    });
    attachTo(f, {
      getInput: () => ({
        connection: {
          targetBlock: () => ({ isShadow: () => true, getField: () => ({ getValue: () => '' }) }),
        },
      }),
    });

    // @ts-expect-error 私有方法
    await f.load(false);

    expect(menu(f)).toEqual(['先選擇伺服器']);
  });

  it('該填的都填了、答案還是空的，才說「沒有可以選的項目」', async () => {
    stubFetchOnce([]);
    const f = makeDependentField({ server: '777' }, 'notice-d');

    // @ts-expect-error 私有方法
    await f.load(false);

    expect(menu(f)).toEqual(['沒有可以選的項目']);
  });

  it('那一行選不中：點下去不會變成這一格的值', async () => {
    // 它在 `FieldDropdown` 眼裡是一個正常的選項，點下去就是一次 setValue。
    // 不擋的話，一個使用者從來沒選過的哨兵字串會被存進 IR。
    stubFetchOnce([]);
    const f = makeDependentField({ server: '777' }, 'notice-e');
    f.setValue('10');

    // @ts-expect-error 私有方法
    await f.load(false);
    const [, sentinel] = f.getOptions(false)[0] as [string, string];
    f.setValue(sentinel);

    expect(f.getValue()).toBe('10');
  });

  it('換了伺服器，上一個伺服器的頻道清單立刻不見（不是留著給人挑）', async () => {
    // 一份屬於別人的頻道清單看起來完全正常——使用者會從裡面挑一個，然後拿到
    // 「找不到這個頻道」。
    stubFetchOnce([{ label: '#一般', value: '10' }]);
    const deps: Record<string, string> = { server: 'A' };
    const f = new FieldDynamicDropdown('', undefined, {
      extId: 'discord',
      source: 'notice-f',
      value: '',
      depends: ['server'],
      dependsLabels: { server: '伺服器' },
    });
    attachTo(f, {
      getInput: () => ({
        connection: {
          targetBlock: () => ({
            isShadow: () => true,
            getField: () => ({ getValue: () => deps.server }),
          }),
        },
      }),
    });

    // @ts-expect-error 私有方法
    await f.load(false);
    expect(menu(f)).toEqual(['#一般']);

    deps.server = 'B';
    // 這一次還在飛的時候，舊清單就該已經不見了。
    // @ts-expect-error 私有方法
    const pending = f.load(false) as Promise<void>;
    expect(menu(f)).toEqual(['載入中…']);
    await pending;
  });
});

/**
 * **每個專案一份工具箱名單**（`docs/project-storage-design.md` §4）。
 *
 * 這一份測的是那個 bug 本身，不是 API：名單原本是整台機器一份，而
 * `initEnabled` 做的是聯集，所以多專案時它變成一個只進不出的桶子——
 *
 *     打開 A（用 discord）→ {discord}
 *     打開 B（用 openai） → {discord, openai}
 *     回到 A             → 還是 {discord, openai}
 *
 * 於是分類欄上永遠留著你在**別的專案**裡用過的包，而 D31 擋的正是這件事。
 *
 * 「現在是哪一個專案」現在從**網址**讀（`project/routes.ts`），所以這裡插的是
 * 一個假的 `location`——換一個專案在真實世界裡就是換一個網址。`localStorage`
 * 在這個測試環境裡也不存在（見 `extensionsStore.test.ts`），而這份測試問的正是
 * 「寫到哪一格去了」，所以它也要一個。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 假裝我們正站在這個網址上。 */
function at(pathname: string): Map<string, string> {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { pathname },
  });
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  return store;
}

beforeEach(() => {
  vi.resetModules();
});

describe('工具箱名單的 localStorage key', () => {
  it('帶著專案 id——兩個專案不會共用同一份名單', async () => {
    at('/p/prj_aaa');
    const a = (await import('./extensionsStore')).enabledPrefKey();

    vi.resetModules();
    at('/p/prj_bbb');
    const b = (await import('./extensionsStore')).enabledPrefKey();

    expect(a).not.toBe(b);
  });

  it('加進 A 的包不會出現在 B 的名單裡', async () => {
    const storeA = at('/p/prj_aaa');
    const a = await import('./extensionsStore');
    a.useExtensionsUi.getState().add('discord');
    const keyA = a.enabledPrefKey();

    // 換一個專案 = 換一個網址 = 整頁載入，所以 B 是從零開始的一份 module。
    vi.resetModules();
    at('/p/prj_bbb');
    const b = await import('./extensionsStore');
    b.useExtensionsUi.getState().initEnabled(['openai']);

    expect(JSON.parse(storeA.get(`blockyard.pref.${keyA}`) ?? '[]')).toEqual(['discord']);
    expect([...b.useExtensionsUi.getState().enabled]).toEqual(['openai']);
  });

  it('多專案之前那份「整台機器一份」的名單，只有舊的那個專案接得到', async () => {
    at('/p/prj_local').set('blockyard.pref.extensions.enabled', JSON.stringify(['http']));
    const legacy = await import('./extensionsStore');
    expect([...legacy.useExtensionsUi.getState().enabled]).toEqual(['http']);

    // 而一個新開的專案是乾淨的——不然「工具箱上多了我沒加過的東西」只是從
    // 跨專案搬到新專案身上。
    vi.resetModules();
    at('/p/prj_new').set('blockyard.pref.extensions.enabled', JSON.stringify(['http']));
    const fresh = await import('./extensionsStore');
    expect([...fresh.useExtensionsUi.getState().enabled]).toEqual([]);
  });
});

describe('網址是身分，偏好只是記憶', () => {
  it('網址上的專案覆蓋「上次那一份」——兩個分頁各開一份才不會互相蓋掉', async () => {
    at('/p/prj_from_url').set('blockyard.pref.project.current', JSON.stringify('prj_remembered'));
    const { currentProjectId } = await import('../project/current');
    expect(currentProjectId()).toBe('prj_from_url');
  });

  it('不在編輯器那條路徑上時，讀的是上次那一份', async () => {
    at('/projects').set('blockyard.pref.project.current', JSON.stringify('prj_remembered'));
    const { currentProjectId } = await import('../project/current');
    expect(currentProjectId()).toBe('prj_remembered');
  });

  it('打開一份專案就把它記起來——`/` 要靠它決定導去哪裡', async () => {
    const store = at('/p/prj_opened');
    await import('../project/current');
    expect(JSON.parse(store.get('blockyard.pref.project.current') ?? '""')).toBe('prj_opened');
  });
});

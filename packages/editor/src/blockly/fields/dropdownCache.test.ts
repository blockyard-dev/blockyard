/**
 * 60 秒快取（§8.1、附錄 A）：同一個 extId/source 在窗口內重用，`force` 繞過。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDropdownOptions } from './dropdownCache';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubFetch(options: { label: string; value: string }[]) {
  const fn = vi.fn(async () => ({ ok: true, json: async () => options }) as unknown as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('fetchDropdownOptions', () => {
  it('打對的端點，把 {label,value} 轉成 [label, value] 元組', async () => {
    const fn = stubFetch([{ label: 'GET', value: 'GET' }]);
    const options = await fetchDropdownOptions('http', 'cache-a');
    expect(fn).toHaveBeenCalledWith('/api/extensions/http/dropdown/cache-a', { method: 'POST' });
    expect(options).toEqual([['GET', 'GET']]);
  });

  it('60 秒內重用快取，不重新打 API', async () => {
    vi.useFakeTimers();
    const fn = stubFetch([{ label: 'GET', value: 'GET' }]);
    await fetchDropdownOptions('http', 'cache-b');
    vi.advanceTimersByTime(59_000);
    await fetchDropdownOptions('http', 'cache-b');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('超過 60 秒重新打 API', async () => {
    vi.useFakeTimers();
    const fn = stubFetch([{ label: 'GET', value: 'GET' }]);
    await fetchDropdownOptions('http', 'cache-c');
    vi.advanceTimersByTime(61_000);
    await fetchDropdownOptions('http', 'cache-c');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('force 繞過快取', async () => {
    const fn = stubFetch([{ label: 'GET', value: 'GET' }]);
    await fetchDropdownOptions('http', 'cache-d');
    await fetchDropdownOptions('http', 'cache-d', { force: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('不同 source 各自有各自的快取', async () => {
    const fn = stubFetch([{ label: 'GET', value: 'GET' }]);
    await fetchDropdownOptions('http', 'cache-e1');
    await fetchDropdownOptions('http', 'cache-e2');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('沒有 args 就不帶 body', async () => {
    const fn = stubFetch([{ label: 'GET', value: 'GET' }]);
    await fetchDropdownOptions('http', 'cache-g', { args: {} });
    expect(fn).toHaveBeenCalledWith('/api/extensions/http/dropdown/cache-g', { method: 'POST' });
  });

  it('有 args 就送進 body', async () => {
    const fn = stubFetch([{ label: '#一般', value: '10' }]);
    await fetchDropdownOptions('discord', 'cache-h', { args: { server: '1' } });
    expect(fn).toHaveBeenCalledWith('/api/extensions/discord/dropdown/cache-h', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: { server: '1' } }),
    });
  });

  it('args 不同就是不同的快取', async () => {
    // **這一題釘住的是「樣子」而不是「值」。** 少了它，選 A 伺服器、再選 B，
    // B 的頻道下拉會在 60 秒內拿到 A 的頻道——那份清單看起來完全正常，只是
    // 屬於另一個伺服器，而使用者選中的值一直都是他自己點的那一個。
    const fn = stubFetch([{ label: '#一般', value: '10' }]);
    await fetchDropdownOptions('discord', 'cache-i', { args: { server: 'A' } });
    await fetchDropdownOptions('discord', 'cache-i', { args: { server: 'B' } });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('args 的 key 順序不影響快取（同一次查詢就是同一格）', async () => {
    const fn = stubFetch([{ label: '#一般', value: '10' }]);
    await fetchDropdownOptions('discord', 'cache-j', { args: { a: '1', b: '2' } });
    await fetchDropdownOptions('discord', 'cache-j', { args: { b: '2', a: '1' } });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('回應不是 2xx、body 也讀不出東西時，錯誤裡至少有狀態碼', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, statusText: 'boom' }) as unknown as Response),
    );
    await expect(fetchDropdownOptions('http', 'cache-f')).rejects.toThrow(/500/);
  });

  it('後端說了為什麼，就丟那句話——它會被原樣顯示在下拉選單裡', async () => {
    // 「還沒設定「Discord」的 Bot Token」是這條路上最常見的失敗，而它是一句
    // 使用者照著做就能解決的話。換成 `POST … → 422` 的話，畫面上剩下的只有
    // 一格空白，而空白說不出 token 沒設定。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 422,
        json: async () => ({ detail: { message: '還沒設定「Discord」的 Bot Token' } }),
      }) as unknown as Response),
    );
    await expect(fetchDropdownOptions('discord', 'cache-k')).rejects.toThrow(
      '還沒設定「Discord」的 Bot Token',
    );
  });

  it('連不上後端時翻成中文，不把 `Failed to fetch` 丟給使用者', async () => {
    const boom = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn(async () => { throw boom; }));
    await expect(fetchDropdownOptions('http', 'cache-l')).rejects.toThrow('連不上後端');
    // 原因不能弄丟——console 上要查得到到底是什麼掛了。
    await expect(fetchDropdownOptions('http', 'cache-l')).rejects.toMatchObject({ cause: boom });
  });
});

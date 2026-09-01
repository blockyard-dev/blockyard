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

  it('回應不是 2xx 就丟出帶著端點與狀態碼的錯誤', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, statusText: 'boom' }) as unknown as Response),
    );
    await expect(fetchDropdownOptions('http', 'cache-f')).rejects.toThrow(/500/);
  });
});

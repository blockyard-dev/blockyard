/**
 * 動態下拉的 60 秒快取（§8.1、附錄 A）。
 *
 * `POST /api/extensions/{extId}/dropdown/{source}` 每次都真的呼叫積木包
 * 的 `@dropdown` 函式——`openai.models` 那類的可能真的打外部 API。60 秒內
 * 重用結果，避免同一顆積木在畫布上被畫出好幾次（工具箱、flyout、畫布）
 * 就各自發一次請求；手動重新整理（`FieldDynamicDropdown.refresh()`）用
 * `force` 繞過。
 */

export interface DropdownOption {
  label: string;
  value: string;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { options: [string, string][]; at: number }>();

function cacheKey(extId: string, source: string): string {
  return `${extId}/${source}`;
}

/**
 * 同步讀快取，讀不到（沒抓過、或已經過期）就回 `null`。
 *
 * 給欄位在**建構的那一刻**（`configure_`）就把選項種進去用——續航工具箱一路
 * 掃過去，多數積木在使用者真的把它拖出來之前，flyout 早就先幫它抓過一次
 * 了（同一個 extId/source，60 秒的窗口內）。有快取就直接種好整份清單，不必
 * 再等一次非同步的抓取跟重畫，選單第一次打開就是對的。
 */
export function peekDropdownOptions(extId: string, source: string): [string, string][] | null {
  const cached = cache.get(cacheKey(extId, source));
  if (!cached || Date.now() - cached.at >= CACHE_TTL_MS) return null;
  return cached.options;
}

export async function fetchDropdownOptions(
  extId: string,
  source: string,
  opts?: { force?: boolean },
): Promise<[string, string][]> {
  const key = cacheKey(extId, source);
  const cached = cache.get(key);
  if (!opts?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.options;
  }

  const res = await fetch(
    `/api/extensions/${encodeURIComponent(extId)}/dropdown/${encodeURIComponent(source)}`,
    { method: 'POST' },
  );
  if (!res.ok) {
    throw new Error(
      `POST /api/extensions/${extId}/dropdown/${source} → ${res.status} ${res.statusText}`,
    );
  }
  const raw = (await res.json()) as DropdownOption[];
  const options: [string, string][] = raw.map((o) => [o.label, o.value]);
  cache.set(key, { options, at: Date.now() });
  return options;
}

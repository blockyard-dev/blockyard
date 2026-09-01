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

/** 同一顆積木上其他已填參數的值（manifest 的 `depends`）。 */
export type DropdownArgs = Record<string, string>;

/**
 * **args 是 key 的一部分。** `discord.channels` 在 A 伺服器與 B 伺服器底下是
 * 兩份不同的清單，共用一個 key 的話，選了 A、再選 B，B 的頻道下拉會在 60 秒
 * 內拿到 A 的頻道——而那份清單看起來完全正常，只是屬於另一個伺服器。
 *
 * key 排序過再序列化：`{a,b}` 與 `{b,a}` 是同一次查詢，不該各佔一格快取。
 */
function cacheKey(extId: string, source: string, args?: DropdownArgs): string {
  const entries = Object.entries(args ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const suffix = entries.length > 0 ? `?${JSON.stringify(entries)}` : '';
  return `${extId}/${source}${suffix}`;
}

/**
 * 同步讀快取，讀不到（沒抓過、或已經過期）就回 `null`。
 *
 * 給欄位在**建構的那一刻**（`configure_`）就把選項種進去用——續航工具箱一路
 * 掃過去，多數積木在使用者真的把它拖出來之前，flyout 早就先幫它抓過一次
 * 了（同一個 extId/source，60 秒的窗口內）。有快取就直接種好整份清單，不必
 * 再等一次非同步的抓取跟重畫，選單第一次打開就是對的。
 */
export function peekDropdownOptions(
  extId: string,
  source: string,
  args?: DropdownArgs,
): [string, string][] | null {
  const cached = cache.get(cacheKey(extId, source, args));
  if (!cached || Date.now() - cached.at >= CACHE_TTL_MS) return null;
  return cached.options;
}

export async function fetchDropdownOptions(
  extId: string,
  source: string,
  opts?: { force?: boolean; args?: DropdownArgs },
): Promise<[string, string][]> {
  const key = cacheKey(extId, source, opts?.args);
  const cached = cache.get(key);
  if (!opts?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.options;
  }

  // 沒有 args 就不帶 body：不吃別格的下拉佔絕大多數（`http.method`、
  // `openai.models`），讓它們為了一個空物件多帶一個 content-type 只是噪音。
  // 後端兩種都收（`api/extensions.py::_dropdown_args`）。
  const args = opts?.args;
  const body =
    args && Object.keys(args).length > 0
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }) }
      : {};
  const res = await fetch(
    `/api/extensions/${encodeURIComponent(extId)}/dropdown/${encodeURIComponent(source)}`,
    { method: 'POST', ...body },
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

/**
 * dev server 的 proxy 要蓋住**後端所有對外的路徑**，不只 `/api`。
 *
 * 這個檔案存在的理由也是一個真的 bug：§9.3 的 webhook 掛在 `/hooks/…`，刻意
 * 不在 `/api` 底下（它是給 GitHub 打的位址，不是編輯器的 API）——而 dev 的
 * proxy 只有 `/api` 與 `/ws`。
 *
 * **症狀很難查**：webhook 面板給的網址是用「這個分頁的來源」組出來的（打包後
 * 前後端同一個 process，那是對的），所以 dev 下複製到的是
 * `http://localhost:5173/hooks/…`——而 5173 上沒有那條路徑，打過去是 404。
 * 後端明明好好的，看起來卻像 webhook 壞了。
 *
 * 讀設定檔的原文而不是 import 它：`defineConfig` 會把 env 讀進去，而這一題問
 * 的是「有沒有寫」，不是「跑起來長怎樣」。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), '../vite.config.ts');

/** 後端在 `/api` 之外還開了哪些路徑。新增一條就要在這裡加一行。 */
const OUTSIDE_API = ['/ws', '/hooks'];

describe('dev proxy', () => {
  const source = readFileSync(CONFIG, 'utf8');

  it.each(OUTSIDE_API)('代理得到 %s', (path) => {
    expect(source).toContain(`'${path}'`);
  });
});

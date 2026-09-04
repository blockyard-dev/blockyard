/**
 * 把 Blockly 的 media（垃圾桶、下拉箭頭、游標）複製進 `public/`。
 *
 * 這些是一整個資料夾的圖檔，import 不進來。複製出去而不是連 CDN：`blockyard
 * serve` 是單機工具，離線必須能用（§15 的打包策略）。
 *
 * 放 `public/` 讓 Vite 在 dev 與 build 兩邊用同一條路徑供應（`/media/...`），
 * 這樣 `theme.ts` 的 `media: 'media/'` 開發時與打包後指的是同一個地方。
 */
import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(dirname(createRequire(import.meta.url).resolve('blockly')), 'media');
const target = resolve(here, '../public/media');

await mkdir(dirname(target), { recursive: true });
await cp(source, target, { recursive: true });
console.log(`已複製 Blockly media → ${target}`);

/**
 * 從 `packages/shared-schema/manifest.schema.json` 產生 TS 型別（§14、§8.1）。
 *
 * 這支腳本是 `backend/tools/export_schema.py` 的前端那一半：後端從 pydantic
 * 匯出 JSON Schema，這裡再把 JSON Schema 變成 TS。手寫一份 TS interface 的話，
 * D21 之後 manifest 就有兩個真實來源，而漂移的形式會是「前端畫不出某個新
 * 欄位，但沒有任何東西報錯」。
 *
 * 產物**進版控**（與 shared-schema 一樣），因為它是可讀的介面文件。用
 * `--check` 擋倒退，與 export_schema.py 的 CI 慣例相同。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { compile } from 'json-schema-to-typescript';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = resolve(here, '../../shared-schema/manifest.schema.json');
const OUT = resolve(here, '../src/types/manifest.ts');

const BANNER = `/**
 * 自動產生，不要手改。
 *
 * 來源：packages/shared-schema/manifest.schema.json
 * 重新產生：cd packages/editor && npm run gen:types
 */
`;

const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));

/**
 * pydantic 把 `Any` 型別的欄位（`ArgSpec.default`）匯出成 `{}`——在 JSON
 * Schema 裡那是「任何值」，但 json-schema-to-typescript 會把它當成沒有屬性的
 * 物件，產出 `{ [k: string]: unknown }`。於是 `default: 10` 會是型別錯誤。
 *
 * 不改後端的匯出（`{}` 是正確的 JSON Schema），改在這裡用 j-s-t-t 官方支援的
 * `tsType` 擴充關鍵字把它標成 `unknown`。
 */
function markAnySchemas(node) {
  if (Array.isArray(node)) return node.forEach(markAnySchemas);
  if (node === null || typeof node !== 'object') return;
  const ANNOTATIONS = new Set(['title', 'description', 'default', '$comment']);
  const keys = Object.keys(node);
  if (keys.length > 0 && keys.every((k) => ANNOTATIONS.has(k))) {
    node.tsType = 'unknown';
    return;
  }
  Object.values(node).forEach(markAnySchemas);
}
markAnySchemas(schema.$defs);

const generated = await compile(schema, 'Manifest', {
  bannerComment: '',
  additionalProperties: false,
  style: { singleQuote: true },
});

const content = BANNER + generated + `
/** 這份檔案的入口型別。schema 的 \`title\` 決定了上面那個名字。 */
export type Manifest = BlockyExtensionManifest;
`;

if (process.argv.includes('--check')) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== content) {
    console.error('src/types/manifest.ts 不是最新的，請跑 npm run gen:types');
    process.exit(1);
  }
  console.log('manifest 型別是最新的');
} else {
  writeFileSync(OUT, content, 'utf8');
  console.log(`已寫入 ${OUT}`);
}

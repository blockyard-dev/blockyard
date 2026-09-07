/**
 * 動態下拉的影子要活得過一次存檔 + 重新載入（D22、§8.4）。
 *
 * **這個檔案是為了一個真實的 bug 存在的**：`http.method` 選好 `POST`、存檔、
 * 重新整理，那一格會從下拉變成一個通用文字輸入框。值是對的（`POST` 還在），
 * 錯的是**那一格的樣子**——所以上一輪在瀏覽器裡驗的那句「選 POST → 存檔 →
 * 重新整理 → 值還在」剛好驗不到它。
 *
 * 成因：`shadowKindOf('blockyard.shadow.dropdown#…')` 回 `null`，而
 * `deserialize.ts::buildShadowState` 拿它跟 `kindOfValue('POST')`（`'text'`）
 * 比對，對不上就退回 `DEFAULT_SHADOWS.text`。存檔那一半一直是好的：
 * `readShadowValue` 認不出種類時會掉進文字分支，字串照樣寫出去。
 *
 * 所以下面的題目一律斷言**影子的 Blockly type**，不是它的值。讀的是
 * `_bundled/http/manifest.yaml` 這份真的檔案（同 `roundtrip.test.ts` 的理由：
 * 複製出來的一份會在漂移的那天繼續綠著）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as Blockly from 'blockly/core';
import { parse } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerManifests } from '../blockly/setup';
import {
  SHADOW_DROPDOWN,
  SHADOW_TEXT,
  isSwitchableShadow,
  shadowKindOf,
} from '../blockly/define';
import { buildContext, type ConversionContext } from './context';
import { loadProject } from './deserialize';
import { serializeWorkspace } from './serialize';
import type { Manifest } from '../types/manifest';
import type { BlockyardProjectIR as ProjectIR } from '../types/project';

const HTTP_MANIFEST = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../backend/blockyard/_bundled/http/manifest.yaml',
);

/** 一顆 `http.request`，`method` 是使用者從下拉選好的 `POST`。 */
const PROJECT: ProjectIR = {
  version: 1,
  blocks: {
    b1: {
      opcode: 'http.request',
      inputs: {
        method: { kind: 'literal', value: 'POST' },
        url: { kind: 'literal', value: 'https://example.com' },
        headers: { kind: 'literal', value: '{}' },
        body: { kind: 'literal', value: '{}' },
      },
    },
  },
  scripts: [{ id: 's1', top: 'b1', x: 0, y: 0 }],
} as unknown as ProjectIR;

let ctx: ConversionContext;

beforeAll(() => {
  const manifest = parse(readFileSync(HTTP_MANIFEST, 'utf8')) as Manifest;
  ctx = buildContext(registerManifests([manifest]).blocks);
});

function methodShadow(): Blockly.Block {
  const workspace = new Blockly.Workspace();
  loadProject(PROJECT, workspace, ctx);
  const block = workspace.getAllBlocks(false).find((b) => b.type === 'http.request');
  const shadow = block?.getInput('method')?.connection?.targetBlock();
  if (!shadow) throw new Error('method 那一格沒有影子');
  return shadow;
}

describe('shadowKindOf 認得下拉影子', () => {
  const type = `${SHADOW_DROPDOWN}#http.request.method`;

  it('下拉存出去是文字——widget 不是型別', () => {
    // 這一條紅過。回 `null` 的時候，重新整理之後那一格會變成文字輸入框。
    expect(shadowKindOf(type)).toBe('text');
  });

  it('但它的型別不給使用者改掉', () => {
    // 選項是封閉的一組（D22）。換成自由的數字框等於做出一顆再也選不回合法值
    // 的積木——`shadowKindOf` 與 `isSwitchableShadow` 問的是兩個不同的問題。
    expect(isSwitchableShadow(type)).toBe(false);
    expect(isSwitchableShadow(SHADOW_TEXT)).toBe(true);
  });
});

describe('載入一份存好的專案', () => {
  it('method 那一格仍然是下拉，不是通用文字影子', () => {
    expect(methodShadow().type).toBe(`${SHADOW_DROPDOWN}#http.request.method`);
  });

  it('而且值是存進去的那一個', () => {
    expect(methodShadow().getFieldValue('VALUE')).toBe('POST');
  });

  it('存 → 讀 → 再存，值不漂移', () => {
    const workspace = new Blockly.Workspace();
    loadProject(PROJECT, workspace, ctx);
    const again = serializeWorkspace(workspace, ctx);
    const block = Object.values(again.blocks ?? {}).find((b) => b.opcode === 'http.request');
    expect(block?.inputs?.method).toEqual({ kind: 'literal', value: 'POST' });
  });
});

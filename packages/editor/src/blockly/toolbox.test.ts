/**
 * 工具箱的組法（§8.1、§8.5、D25）。
 *
 * 讀**後端真正在用的那 9 份 yaml**（與 `define.test.ts` 同一個理由）：這一步
 * 新增的 `buttons` 是宣告，複製一份 fixture 的話，哪天 `procedure.yaml` 少了
 * 那顆「創建積木」，測試會繼續綠著而畫布上生不出任何函式。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { buildProjectToolbox, registerManifests, type Registration } from './setup';
import { isParamType, registerProcedures } from './procedures';
import { buttonCallbackKey, findVariableReader } from './toolbox';
import type { Manifest } from '../types/manifest';
import type { Procedure } from '../types/project';

const BUILTINS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../backend/blocky/interpreter/builtins',
);

let registration: Registration;

beforeAll(() => {
  const manifests = readdirSync(BUILTINS)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => parseYaml(readFileSync(join(BUILTINS, f), 'utf8')) as Manifest);
  registration = registerManifests(manifests);
});

interface Category {
  name: string;
  contents: Record<string, unknown>[];
}

function categories(toolbox: Record<string, unknown>): Category[] {
  return toolbox.contents as unknown as Category[];
}

function category(toolbox: Record<string, unknown>, name: string): Category {
  const found = categories(toolbox).find((c) => c.name === name);
  if (!found) throw new Error(`工具箱沒有「${name}」分類`);
  return found;
}

const JUMP: Procedure = {
  name: '跳 %(a1) 次 到 %(a2)',
  params: [
    { id: 'a1', name: '次數', type: 'number' },
    { id: 'a2', name: '方向', type: 'string' },
  ],
  returns: null,
};

describe('工具箱按鈕（D25）', () => {
  it('「創建積木」在函式分類的最上面', () => {
    const toolbox = buildProjectToolbox(registration, []);
    const first = category(toolbox, '函式').contents[0];
    expect(first).toEqual({
      kind: 'button',
      text: '建立一個積木',
      'web-class': 'blocky-flyout-button',
      callbackKey: buttonCallbackKey('procedure', 'create'),
    });
  });

  it('callbackKey 帶命名空間——兩個包都可以有一顆 id 是 docs 的按鈕', () => {
    expect(buttonCallbackKey('discord', 'docs')).not.toBe(buttonCallbackKey('http', 'docs'));
  });

  it('沒宣告按鈕的分類就是一串積木', () => {
    const toolbox = buildProjectToolbox(registration, []);
    expect(category(toolbox, '資料').contents.every((c) => c.kind === 'block')).toBe(true);
  });
});

describe('函式分類是動態的（§4.6、§8.5）', () => {
  it('每個函式一顆呼叫積木；定義帽子不上架', () => {
    const procedures = { p_jump: JUMP };
    const blocks = registerProcedures(procedures);
    const contents = category(buildProjectToolbox(registration, blocks), '函式').contents;
    const types = contents.map((c) => c.type);

    expect(types).toContain('procedure.call#p_jump');
    // 建立函式的入口是那顆按鈕（D25）：拖一顆定義出來會產生一個沒有名字的函式。
    expect(types).not.toContain('procedure.definition#p_jump');
  });

  it('參數**不上架**——它們掛在定義帽子上，拖一下就有一份（§4.6）', () => {
    // 第六輪回饋：分類裡不必再列一份。上架等於同一顆積木有兩個入口，而分類
    // 裡那一份還少了「它屬於哪個函式」——畫面上就是一排沒有上下文的名字。
    const procedures = { p_jump: JUMP };
    const blocks = registerProcedures(procedures);
    const contents = category(buildProjectToolbox(registration, blocks), '函式').contents;

    expect(contents.map((c) => c.type).filter((t) => typeof t === 'string' && isParamType(t))).toEqual([]);
    // 也不是舊的 `取得 (參數名)`：那顆在資料分類，不在這裡。
    expect(contents.some((c) => c.type === 'data.get')).toBe(false);
  });

  it('沒有函式時分類裡只有按鈕與 `回傳`', () => {
    const contents = category(buildProjectToolbox(registration, []), '函式').contents;
    expect(contents.map((c) => c.type)).toEqual([undefined, 'procedure.return']);
  });
});

describe('變數讀取器來自宣告，不是寫死的 opcode', () => {
  it('讀的是 manifest 的 reads', () => {
    expect(findVariableReader(registration.blocks)).toEqual({ type: 'data.get', arg: 'name' });
  });

  it('取長度的那顆不算——它的形狀一模一樣，差別只在回傳什麼', () => {
    // 這一條是「用推導代替宣告」那一版的死因：`data.list_length` 也是一顆
    // reporter 加一個非 binds 的 variable 參數，於是挑中誰只取決於 yaml 的順序。
    const withoutGet = registration.blocks.filter((b) => b.type !== 'data.get');
    expect(withoutGet.some((b) => b.type === 'data.list_length')).toBe(true);
    expect(findVariableReader(withoutGet)).toBeNull();
  });
});

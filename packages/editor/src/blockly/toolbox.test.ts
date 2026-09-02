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
import {
  BLOCK_GAP,
  buildToolbox,
  buttonCallbackKey,
  findVariableReader,
  groupByManifest,
} from './toolbox';
import { defineManifest } from './define';
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

  it('沒宣告按鈕的分類裡就沒有按鈕條目', () => {
    const toolbox = buildProjectToolbox(registration, []);
    expect(category(toolbox, '資料').contents.some((c) => c.kind === 'button')).toBe(false);
  });
});

describe('按鈕的位置（§7.2 的 palette）', () => {
  /** 畫出來的順序，只留種類與名字——版面數字由「分段與間隔」那一組驗。 */
  function layout(palette: Record<string, unknown>[]) {
    const groups = groupByManifest(defineManifest({
      manifestVersion: 1,
      id: 'demo_order',
      name: '順序示範',
      version: '0.1.0',
      palette,
    } as unknown as Manifest));
    return (buildToolbox(groups) as { contents: Category[] }).contents
      .find((c) => c.name === '順序示範')!.contents
      .filter((entry) => entry.kind !== 'sep')
      .map((entry) => (entry.kind === 'button' ? `[${String(entry.text)}]` : String(entry.type)));
  }

  const block = (opcode: string) => ({ opcode, type: 'command', text: opcode });
  const button = (id: string) => ({
    button: id,
    label: id,
    action: 'open_url',
    url: 'https://example.com',
  });

  it('寫在哪兩顆積木中間，畫出來就在那裡', () => {
    // 使用者要的排版：積木、按鈕、按鈕、積木。palette 怎麼寫，工具箱就怎麼長。
    expect(layout([block('a'), button('測試'), button('說明'), block('b')])).toEqual([
      'demo_order.a', '[測試]', '[說明]', 'demo_order.b',
    ]);
  });

  it('放在最上面就是最上面（Scratch 放「製作積木」的位置）', () => {
    expect(layout([button('說明'), block('a'), block('b')])).toEqual([
      '[說明]', 'demo_order.a', 'demo_order.b',
    ]);
  });

  it('最後一顆積木底下也放得了', () => {
    expect(layout([block('a'), block('b'), button('說明')])).toEqual([
      'demo_order.a', 'demo_order.b', '[說明]',
    ]);
  });

  it('deprecated 的積木不上架，但它前後的東西照樣接得起來', () => {
    // 「註冊但不上架」（§13.1）：舊專案載得進來，工具箱裡沒有它。
    expect(layout([
      block('a'),
      { opcode: 'gone', type: 'command', text: 'gone', deprecated: true },
      button('說明'),
    ])).toEqual(['demo_order.a', '[說明]']);
  });

  it('按鈕的 callbackKey 用的是 palette 條目上的 button id', () => {
    const groups = groupByManifest(defineManifest({
      manifestVersion: 1,
      id: 'demo_key',
      name: '按鈕 key',
      version: '0.1.0',
      palette: [{ ...button('docs'), button: 'docs' }, block('a')],
    } as unknown as Manifest));
    const contents = (buildToolbox(groups) as { contents: Category[] }).contents
      .find((c) => c.name === '按鈕 key')!.contents;

    expect(contents[0]).toMatchObject({ callbackKey: buttonCallbackKey('demo_key', 'docs') });
  });

  it('分類帶著自己宣告的 secret——`open_config` 按鈕要靠它才知道開哪一把', () => {
    // 按鈕上只有 id、label、action（`ButtonSpec`），說不出是哪一把金鑰。那是
    // 刻意的：一顆按鈕能指定金鑰，等於一個包能送使用者去設定別人的那一把。
    // 所以 `App.tsx` 讀的是分類上這一份，而它從 manifest 的 config 來。
    const [group] = groupByManifest(defineManifest({
      manifestVersion: 1,
      id: 'demo_secret',
      name: '金鑰',
      version: '0.1.0',
      config: [
        { key: 'base_url', type: 'string', label: '端點' },
        { key: 'bot_token', type: 'secret', label: 'Bot Token', envVar: 'X_TOKEN' },
      ],
      palette: [block('a')],
    } as unknown as Manifest));

    expect(group!.secrets.map((c) => c.key)).toEqual(['bot_token']);
  });
});

describe('`open_config` 的按鈕設定完就收起來', () => {
  /** 一個宣告了金鑰、也放了那顆按鈕的包。 */
  function groups() {
    return groupByManifest(defineManifest({
      manifestVersion: 1,
      id: 'demo_done',
      name: '設定完就消失',
      version: '0.1.0',
      config: [{ key: 'bot_token', type: 'secret', label: 'Bot Token' }],
      palette: [
        { opcode: 'a', type: 'command', text: 'a' },
        { button: 'bot_token', label: '設定 Bot Token', action: 'open_config' },
        { button: 'docs', label: '說明', action: 'open_url', url: 'https://example.com' },
      ],
    } as unknown as Manifest));
  }

  function labels(configured?: Set<string>): string[] {
    return (buildToolbox(groups(), configured) as { contents: Category[] }).contents
      .find((c) => c.name === '設定完就消失')!.contents
      .filter((entry) => entry.kind === 'button')
      .map((entry) => String(entry.text));
  }

  it('還沒設定的時候在', () => {
    expect(labels()).toEqual(['設定 Bot Token', '說明']);
  });

  it('設定好了就不上架——它送人去做的那件事已經做完了', () => {
    expect(labels(new Set(['demo_done.bot_token']))).toEqual(['說明']);
  });

  it('別人的金鑰不算數', () => {
    // 名單是整個編輯器共用的一份（每個包的每一把都在裡面），所以比對的必須是
    // `extId.key` 而不是只有 key——只比 key 的話，另一個包也叫 `bot_token`
    // 的那一把會讓這顆按鈕憑空消失。
    expect(labels(new Set(['other.bot_token']))).toEqual(['設定 Bot Token', '說明']);
  });

  it('只有 `open_config` 會消失：別的動作沒有「做完了」這個狀態', () => {
    expect(labels(new Set(['demo_done.bot_token']))).toContain('說明');
  });
});

describe('分段與間隔（§8.1）', () => {
  it('每顆積木都帶同一個間隔', () => {
    const toolbox = buildProjectToolbox(registration, []);
    const blocks = category(toolbox, '資料').contents.filter((c) => c.kind === 'block');
    expect(blocks.length).toBeGreaterThan(0);
    expect(new Set(blocks.map((c) => c.gap))).toEqual(new Set([BLOCK_GAP]));
  });

  it('`section: true` 在那顆積木前面插一個更大的間隔', () => {
    const toolbox = buildProjectToolbox(registration, []);
    const contents = category(toolbox, '運算').contents;
    // operator.yaml 的「比較」那一段從 `eq` 開始
    const at = contents.findIndex((c) => c.type === 'operator.eq');
    expect(contents[at - 1]).toMatchObject({ kind: 'sep' });
    // **近的是一段，遠的是換一段**——這個關係才是規格，數字是口味
    expect(contents[at - 1]!.gap as number).toBeGreaterThan(BLOCK_GAP);
  });

  it('分類的第一顆不插大間隔——分類標題本身已經是斷點', () => {
    const groups = groupByManifest(defineManifest({
      manifestVersion: 1,
      id: 'demo_first',
      name: '開頭示範',
      version: '0.1.0',
      palette: [{ section: true }, { opcode: 'a', type: 'command', text: 'a' }],
    } as Manifest));
    const contents = (buildToolbox(groups) as { contents: Category[] }).contents
      .find((c) => c.name === '開頭示範')!.contents;

    expect(contents).toEqual([{ kind: 'block', type: 'demo_first.a', gap: BLOCK_GAP }]);
  });

  it('`section` 給字串時多一行標題，而標題與它底下那一段更近', () => {
    // **不讀內建的 yaml**：這一條驗的是展開的機制，不是「運算分類今天有沒有
    // 用標題」。內建現在六段都是 `section: true`（純間隔），改一次標題就會讓
    // 一個與標題無關的測試變紅。
    const groups = groupByManifest(defineManifest({
      manifestVersion: 1,
      id: 'demo_section',
      name: '分段示範',
      version: '0.1.0',
      palette: [
        { opcode: 'a', type: 'command', text: 'a' },
        { section: '第二段' },
        { opcode: 'b', type: 'command', text: 'b' },
      ],
    } as Manifest));
    const contents = (buildToolbox(groups) as { contents: Category[] }).contents
      .find((c) => c.name === '分段示範')!.contents;

    const [first, before, label, after, second] = contents;
    expect(first).toEqual({ kind: 'block', type: 'demo_section.a', gap: BLOCK_GAP });
    expect(before).toMatchObject({ kind: 'sep' });
    expect(label).toEqual({ kind: 'label', text: '第二段', 'web-class': 'blocky-section-label' });
    expect(after).toMatchObject({ kind: 'sep' });
    expect(second).toEqual({ kind: 'block', type: 'demo_section.b', gap: BLOCK_GAP });
    // 換一段比同一段遠；標題與它說明的那一段又比同一段更近
    expect(before!.gap as number).toBeGreaterThan(BLOCK_GAP);
    expect(after!.gap as number).toBeLessThan(BLOCK_GAP);
  });

  it('段落標題帶得走 class——theme.ts 靠它把段落標題排除在分類邊界之外', () => {
    // 它同時是 index.css 的樣式掛勾，兩個檔案共用這個字串（記在 PROGRESS §2.5）
    const groups = groupByManifest(defineManifest({
      manifestVersion: 1,
      id: 'demo_label',
      name: '標題示範',
      version: '0.1.0',
      palette: [{ section: '運算' }, { opcode: 'a', type: 'command', text: 'a' }],
    } as Manifest));
    const contents = (buildToolbox(groups) as { contents: Category[] }).contents
      .find((c) => c.name === '標題示範')!.contents;

    expect(contents[0]).toEqual({
      kind: 'label',
      // **刻意取一個與分類同名的標題**：擋在 `theme.ts` 那條覆寫，不是靠「標題
      // 不准跟分類同名」的規則，所以這裡產得出來是對的
      text: '運算',
      'web-class': 'blocky-section-label',
    });
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

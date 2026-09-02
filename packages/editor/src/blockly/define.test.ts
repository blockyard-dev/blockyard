/**
 * manifest → Blockly 定義的轉換測試。
 *
 * 兩層：前半是手寫的邊界題（形狀、`⋯` 分段、修飾欄位往哪裡走），後半直接吃
 * **後端真正在用的那 9 份 `builtins/*.yaml`**——87 顆積木一顆不漏地跑過同一條
 * 轉換，而它們正是第 3 步驗收標準裡「工具箱畫得出全部 9 個內建命名空間」的
 * 那些積木。
 *
 * 讀 YAML 而不是複製一份 fixture：複製出來的那份不會跟著 handler 一起改，於是
 * 測試會在真的漂移的那一天繼續綠著。這與 §8.1 的兩個後端一致性測試是同一個
 * 理由。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildDefinitions, SHADOW_NUMBER, SHADOW_TEXT } from './define';
import { FIELD_TEXT_TYPE } from './fields/FieldText';
import { FIELD_DYNAMIC_DROPDOWN_TYPE } from './fields/FieldDynamicDropdown';
import type { BlockSpec, Manifest } from '../types/manifest';

const BUILTINS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../backend/blocky/interpreter/builtins',
);

function loadBuiltins(): Manifest[] {
  return readdirSync(BUILTINS)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => parse(readFileSync(join(BUILTINS, f), 'utf8')) as Manifest);
}

function manifestOf(blocks: BlockSpec[]): Manifest {
  return { id: 'test', name: '測試', version: '1.0.0', color: '#123456', palette: blocks };
}

/** 一顆積木的所有 `messageN` / `argsN`，依序攤平。 */
function rows(definition: Record<string, unknown>): { message: string; args: any[] }[] {
  const out: { message: string; args: any[] }[] = [];
  for (let i = 0; definition[`message${i}`] !== undefined; i++) {
    out.push({
      message: definition[`message${i}`] as string,
      args: (definition[`args${i}`] ?? []) as any[],
    });
  }
  return out;
}

function argNames(definition: Record<string, unknown>): string[] {
  return rows(definition).flatMap((row) => row.args.map((a) => a.name as string));
}

describe('形狀（§4.2）', () => {
  const { definitions } = buildDefinitions(
    manifestOf([
      { opcode: 'cmd', type: 'command', text: '做事' },
      { opcode: 'rep', type: 'reporter', text: '取值', returns: 'object' },
      { opcode: 'bool', type: 'boolean', text: '是不是' },
      { opcode: 'hat', type: 'hat', text: '當某事發生' },
      { opcode: 'cap', type: 'command', text: '回傳', terminal: true },
    ]),
  );
  const byType = Object.fromEntries(definitions.map((d) => [d.type as string, d]));

  it('command 上下都能接', () => {
    expect(byType['test.cmd']).toMatchObject({ previousStatement: null, nextStatement: null });
    expect(byType['test.cmd']).not.toHaveProperty('output');
  });

  it('reporter 的 output 不帶 check——型別用警告不用形狀（§8.5）', () => {
    // `returns: object` 是給 Host 驗證用的合約，不是 Blockly 的連接限制。
    // 寫成 check 的話，變數（型別未知）就插不進宣告了型別的孔。
    expect(byType['test.rep']).toHaveProperty('output', null);
  });

  it('boolean 的 output 是 Boolean，好讓孔畫成六角形', () => {
    expect(byType['test.bool']).toHaveProperty('output', 'Boolean');
  });

  it('terminal 是 cap block：接得上、下面接不了（§4.6）', () => {
    // 沒有這一條，形狀就在說謊——使用者接得上一顆下一步，按存檔才被後端的
    // 「是終止積木，下面不能接積木」打回來。
    expect(byType['test.cap']).toHaveProperty('previousStatement', null);
    expect(byType['test.cap']).not.toHaveProperty('nextStatement');
    expect(byType['test.cap']).not.toHaveProperty('output');
  });

  it('hat 只有下接點且戴帽子', () => {
    // 帽子走 extension 而不是 `style: { hat: 'cap' }`——那個寫法只有第一顆
    // 積木拿得到帽子（jsonInit 會把共用定義物件上的 style 清成 null，理由見
    // `define.ts` 的 `registerHatExtension`）。
    expect(byType['test.hat']).toMatchObject({
      nextStatement: null,
      extensions: ['blocky_start_hat'],
    });
    expect(byType['test.hat']).not.toHaveProperty('style');
    expect(byType['test.hat']).not.toHaveProperty('previousStatement');
  });
});

describe('text 的分段與參數', () => {
  it('被 %() 參照過的參數只出現一次', () => {
    // 這條守的是一個真的發生過的 bug：「沒被參照到的參數補在後面」如果在
    // 展開 `%()` **之前**就算，`%(condition)` 會被當成漏網之魚再畫一次。
    const { definitions } = buildDefinitions(
      manifestOf([
        {
          opcode: 'if',
          type: 'command',
          text: '如果 %(condition) 那麼',
          args: { condition: { type: 'boolean' }, then: { type: 'stack' } },
        },
      ]),
    );
    expect(argNames(definitions[0]!)).toEqual(['condition', 'then']);
  });

  it('沒被 %() 參照到的參數仍然畫得出來', () => {
    // `debug.log` 的 `level` 就是這種：漏寫 `%()` 不該讓那個參數消失，
    // 因為它照樣會被送進直譯器。
    const { definitions } = buildDefinitions(
      manifestOf([
        {
          opcode: 'log',
          type: 'command',
          text: '記錄 %(text)',
          args: {
            text: { type: 'string' },
            level: { type: 'dropdown', field: true, options: [{ value: 'info' }] },
          },
        },
      ]),
    );
    expect(argNames(definitions[0]!)).toEqual(['text', 'level']);
  });

  it('⋯ 把文字切開，堆疊插在切口上', () => {
    const { definitions } = buildDefinitions(
      manifestOf([
        {
          opcode: 'if_else',
          type: 'command',
          text: '如果 %(condition) 那麼 ⋯ 否則',
          args: {
            condition: { type: 'boolean' },
            then: { type: 'stack' },
            else: { type: 'stack' },
          },
        },
      ]),
    );
    expect(rows(definitions[0]!).map((r) => r.message)).toEqual(['如果 %1 那麼', '%1', '否則', '%1']);
    expect(argNames(definitions[0]!)).toEqual(['condition', 'then', 'else']);
  });

  it('沒有 ⋯ 的 C 型積木，堆疊接在文字下面', () => {
    const { definitions } = buildDefinitions(
      manifestOf([
        {
          opcode: 'repeat',
          type: 'command',
          text: '重複 %(times) 次',
          args: { times: { type: 'number', default: 10 }, body: { type: 'stack' } },
        },
      ]),
    );
    expect(rows(definitions[0]!).map((r) => r.message)).toEqual(['重複 %1 次', '%1']);
  });
});

describe('參數 → 欄位還是輸入孔（§4.2、D22）', () => {
  const { definitions, blocks } = buildDefinitions(
    manifestOf([
      {
        opcode: 'mix',
        type: 'command',
        text: '%(name) %(value) %(flag) %(pick)',
        args: {
          name: { type: 'variable', default: '' },
          value: { type: 'string', default: 'hi' },
          flag: { type: 'boolean', field: true, default: true },
          pick: { type: 'dropdown', field: true, default: 'b', options: [{ value: 'a' }, { value: 'b' }] },
        },
      },
    ]),
  );
  const args = rows(definitions[0]!)[0]!.args;

  it('type: variable 是欄位，即使 manifest 沒寫 field: true', () => {
    // 直譯器讀它用的是 `t.field(b, "name")`，所以值必須落在 IR 的 fields。
    expect(args[0]).toMatchObject({ type: FIELD_TEXT_TYPE, name: 'name', mode: 'variable' });
  });

  it('沒有 field 旗標的參數是輸入孔', () => {
    expect(args[1]).toMatchObject({ type: 'input_value', name: 'value' });
  });

  it('field: true 的 boolean 是勾選盒、dropdown 是下拉', () => {
    expect(args[2]).toMatchObject({ type: 'field_checkbox', checked: true });
    expect(args[3]).toMatchObject({ type: 'field_dropdown' });
  });

  it('下拉的預設值靠工具箱補——積木定義的 JSON 收不了它', () => {
    expect(blocks[0]!.fields).toEqual({ pick: 'b' });
  });
});

describe('運算式欄位（§4.7b）', () => {
  const { definitions, blocks } = buildDefinitions(
    manifestOf([
      {
        opcode: 'expr',
        type: 'reporter',
        returns: 'number',
        text: '運算 %(expr)',
        args: { expr: { type: 'expression', default: '(1 + 2) * 3' } },
      },
    ]),
  );
  const args = rows(definitions[0]!)[0]!.args;

  it('是欄位而不是輸入孔——運算式是那顆積木自己的內容，不能被別的積木蓋掉', () => {
    expect(args[0]).toMatchObject({
      type: FIELD_TEXT_TYPE,
      name: 'expr',
      mode: 'expression',
      text: '(1 + 2) * 3',
    });
  });

  it('沒有影子積木：欄位不是孔，沒有東西可以插進去', () => {
    expect(blocks[0]!.shadows).toEqual({});
  });
});

describe('影子積木', () => {
  it('boolean 孔沒有影子：空的六角形才分得出「還沒填」', () => {
    const { blocks } = buildDefinitions(
      manifestOf([
        {
          opcode: 'x',
          type: 'command',
          text: '%(cond) %(text)',
          args: { cond: { type: 'boolean' }, text: { type: 'string', default: 'hi' } },
        },
      ]),
    );
    expect(Object.keys(blocks[0]!.shadows)).toEqual(['text']);
    expect(blocks[0]!.shadows.text).toEqual({ type: SHADOW_TEXT, fields: { VALUE: 'hi' } });
  });

  it('沒有修飾欄位的參數共用同一顆影子', () => {
    const { definitions, blocks } = buildDefinitions(
      manifestOf([
        {
          opcode: 'x',
          type: 'command',
          text: '%(a) %(b)',
          args: { a: { type: 'string' }, b: { type: 'number' } },
        },
      ]),
    );
    expect(blocks[0]!.shadows.a?.type).toBe(SHADOW_TEXT);
    expect(blocks[0]!.shadows.b?.type).toBe(SHADOW_NUMBER);
    expect(definitions).toHaveLength(1); // 沒有多生的影子定義
  });

  it('宣告了修飾欄位的參數拿到專屬影子，設定跟著送過去', () => {
    // 使用者打字的地方是影子上的欄位，不是外面那顆積木——`multiline` /
    // `min` / `max` 送不到影子上就等於宣告了但沒有效果。
    const { definitions, blocks } = buildDefinitions(
      manifestOf([
        {
          opcode: 'x',
          type: 'command',
          text: '%(msg) %(n)',
          args: {
            msg: { type: 'string', multiline: true, rows: 4 },
            n: { type: 'number', default: 1, min: 0, max: 100 },
          },
        },
      ]),
    );
    const extra = Object.fromEntries(definitions.slice(1).map((d) => [d.type as string, d]));
    const msgShadow = extra[blocks[0]!.shadows.msg!.type]!;
    expect((msgShadow.args0 as any[])[0]).toMatchObject({ multiline: true, rows: 4 });

    const numShadow = extra[blocks[0]!.shadows.n!.type]!;
    expect((numShadow.args0 as any[])[0]).toMatchObject({ min: 0, max: 100, value: 1 });
  });

  it('code 參數不插值（§4.7：${HOME} 是 shell 的東西）', () => {
    const { definitions, blocks } = buildDefinitions(
      manifestOf([
        { opcode: 'x', type: 'command', text: '%(src)', args: { src: { type: 'code' } } },
      ]),
    );
    const shadow = definitions.find((d) => d.type === blocks[0]!.shadows.src!.type)!;
    expect((shadow.args0 as any[])[0]).toMatchObject({ interpolate: false });
  });

  it('dropdown 參數（非 field，D22）拿到動態下拉的影子，帶著 extId／source', () => {
    // `http.method` 的真實形狀：source 指向積木包的 @dropdown 函式，不是
    // manifest 裡寫死的 options（那是 field: true 的內建下拉才有的路）。
    const { definitions, blocks } = buildDefinitions(
      manifestOf([
        {
          opcode: 'x',
          type: 'reporter',
          returns: 'string',
          text: '%(method)',
          args: { method: { type: 'dropdown', source: 'methods', default: 'GET' } },
        },
      ]),
    );
    const shadowType = blocks[0]!.shadows.method!.type;
    expect(shadowType).not.toBe(SHADOW_TEXT);
    const shadow = definitions.find((d) => d.type === shadowType)!;
    expect((shadow.args0 as any[])[0]).toMatchObject({
      type: FIELD_DYNAMIC_DROPDOWN_TYPE,
      extId: 'test',
      source: 'methods',
      value: 'GET',
    });
    // IR 表示跟文字影子完全一樣：一顆字面值存在 fields.VALUE，換掉的只有影子的型別。
    expect(blocks[0]!.shadows.method).toEqual({ type: shadowType, fields: { VALUE: 'GET' } });
  });

  it('depends 的下拉一起帶上那幾格的 label，不是只帶參數名', () => {
    // 「還沒選伺服器」是這種下拉最常見的空狀態，而欄位要說得出那句話
    // （`FieldDynamicDropdown::emptyText`）。只有參數名的話它會變成「先選擇
    // server」——宣告裡的名字，不是使用者在積木上看到的字。
    const { definitions, blocks } = buildDefinitions(
      manifestOf([
        {
          opcode: 'send',
          type: 'command',
          text: '發到 %(server) 的 %(channel)',
          args: {
            server: { type: 'dropdown', source: 'servers', default: '', label: '伺服器' },
            channel: {
              type: 'dropdown',
              source: 'channels',
              depends: ['server'],
              default: '',
              label: '頻道',
            },
          },
        },
      ] as unknown as BlockSpec[]),
    );
    const shadow = definitions.find((d) => d.type === blocks[0]!.shadows.channel!.type)!;
    expect((shadow.args0 as any[])[0]).toMatchObject({
      depends: ['server'],
      dependsLabels: { server: '伺服器' },
      placeholder: '選擇頻道',
    });
  });
});

describe('dynamic 積木', () => {
  it('不註冊：參數來自 project.procedures，形狀也不固定（D22）', () => {
    const { blocks } = buildDefinitions(
      manifestOf([
        { opcode: 'call', type: 'reporter', text: '呼叫函式', dynamic: true },
        { opcode: 'return', type: 'command', text: '回傳 %(value)', args: { value: { type: 'string' } } },
      ]),
    );
    expect(blocks.map((b) => b.type)).toEqual(['test.return']);
  });
});

describe('後端真正在用的 builtins/*.yaml', () => {
  const manifests = loadBuiltins();

  it('9 個命名空間都讀得到', () => {
    expect(manifests.map((m) => m.id).sort()).toEqual([
      'control', 'data', 'debug', 'event', 'object', 'operator', 'procedure', 'time', 'type',
    ]);
  });

  const all = manifests.flatMap((m) => {
    const { definitions, blocks } = buildDefinitions(m);
    return blocks.map((b) => ({
      block: b,
      definition: definitions.find((d) => d.type === b.type)!,
    }));
  });

  it('每顆積木都轉得出定義', () => {
    expect(all.length).toBeGreaterThan(80);
    for (const { definition } of all) expect(definition).toBeDefined();
  });

  it.each(['message0'])('每顆積木都有 %s', (key) => {
    for (const { definition, block } of all) {
      expect(definition[key], `${block.type} 少了 ${key}`).toBeDefined();
    }
  });

  it('宣告過的參數都畫得出來，而且只畫一次', () => {
    for (const { definition, block } of all) {
      const declared = Object.keys(block.spec.args ?? {});
      const drawn = argNames(definition);
      expect(new Set(drawn).size, `${block.type} 有參數被畫了兩次：${drawn}`).toBe(drawn.length);
      expect(drawn.sort(), `${block.type} 的參數對不上`).toEqual(declared.sort());
    }
  });

  it('每個 %N 都對得到一個參數', () => {
    for (const { definition, block } of all) {
      for (const row of rows(definition)) {
        const refs = (row.message.match(/%\d+/g) ?? []).map((r) => Number(r.slice(1)));
        for (const n of refs) {
          expect(row.args[n - 1], `${block.type} 的 ${row.message} 指向不存在的 %${n}`).toBeDefined();
        }
        expect(row.args.length, `${block.type} 的 ${row.message} 有沒被指到的參數`).toBe(
          new Set(refs).size,
        );
      }
    }
  });

  it('每個非 boolean 的輸入孔都有影子（不然使用者沒地方打字）', () => {
    for (const { definition, block } of all) {
      const inputs = rows(definition)
        .flatMap((r) => r.args)
        .filter((a) => a.type === 'input_value');
      for (const input of inputs) {
        const isBool = block.spec.args?.[input.name]?.type === 'boolean';
        expect(
          Boolean(block.shadows[input.name]),
          `${block.type}.${input.name} 沒有影子`,
        ).toBe(!isBool);
      }
    }
  });
});

/**
 * 執行前靜態檢查的測試（§4.5、§4.6、§8.5）。
 *
 * 每一題都走**真的工作區**：手寫一份 IR → `loadProject` → `checkWorkspace`。
 * 直接組 Blockly 積木會漏掉這個檢查真正的來源——影子上的 `${}`、`binds` 宣告
 * 從哪裡讀、函式積木的型別字串長什麼樣，全部是載入那一半決定的。
 *
 * manifest 一樣讀**後端真正在用的那 9 份 yaml**（與 `define.test.ts`、
 * `literals.test.ts` 同一個理由）：`binds` 是這一步新增的宣告，複製一份
 * fixture 的話，哪天 `data.set` 少宣告了 binds，測試會繼續綠著而編輯器會把
 * 每一個正確的變數都標成「還沒有被設定過」。
 */
import * as Blockly from 'blockly/core';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerManifests } from '../blockly/setup';
import type { RegisteredBlock } from '../blockly/define';
import { registerProcedures, callType, definitionType } from '../blockly/procedures';
import { buildContext, type ConversionContext } from './context';
import { loadProject } from './deserialize';
import { CheckRunner, checkWorkspace, warningId, type Warning } from './checks';
import type { Manifest } from '../types/manifest';
import type { Block as IRBlock, BlockyProjectIR as ProjectIR, Procedure } from '../types/project';

const BUILTINS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../backend/blocky/interpreter/builtins',
);

let builtinBlocks: RegisteredBlock[];

beforeAll(() => {
  const manifests = readdirSync(BUILTINS)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => parseYaml(readFileSync(join(BUILTINS, f), 'utf8')) as Manifest);
  builtinBlocks = registerManifests(manifests).blocks;
});

// -------------------------------------------------------------------- //
// 題目的組法
// -------------------------------------------------------------------- //

type PartialBlock = Partial<IRBlock> & { opcode: string };

/** 一顆積木的 IR，把 `parent` / `next` / 空欄位那些樣板補齊。 */
function block(spec: PartialBlock): IRBlock {
  return {
    parent: null,
    next: null,
    inputs: {},
    fields: {},
    mutation: null,
    ui: null,
    ...spec,
  };
}

interface Scene {
  workspace: Blockly.Workspace;
  ctx: ConversionContext;
  procedures: Record<string, Procedure>;
  check(): Warning[];
  runner: CheckRunner;
}

/**
 * `blocks` 的 key 就是 blockId；`tops` 列出哪幾顆是腳本的最上面一顆。
 * 函式定義積木不必列進 `tops`——`loadProject` 從 `procedures` 那一側載入它們。
 */
function scene(
  blocks: Record<string, PartialBlock>,
  tops: string[],
  procedures: Record<string, Procedure> = {},
): Scene {
  const ctx = buildContext([...builtinBlocks, ...registerProcedures(procedures)]);
  const project: ProjectIR = {
    formatVersion: 1,
    meta: { id: 'p', name: 'p' },
    extensions: [],
    variables: {},
    procedures,
    scripts: tops.map((top, i) => ({ id: `sc_${i}`, top, x: 0, y: 0 })),
    blocks: Object.fromEntries(Object.entries(blocks).map(([id, b]) => [id, block(b)])),
  };
  const workspace = new Blockly.Workspace();
  loadProject(project, workspace, ctx);
  const runner = new CheckRunner(workspace);
  return {
    workspace,
    ctx,
    procedures,
    runner,
    check: () => checkWorkspace(workspace, { ctx, procedures }),
  };
}

/** 「這顆積木身上有沒有這一種警告」——測試只關心這個，不比對整句話。 */
function kindsOn(warnings: Warning[], blockId: string): string[] {
  return warnings.filter((w) => w.blockId === blockId).map((w) => w.kind);
}

function messageOn(warnings: Warning[], blockId: string): string {
  return warnings.find((w) => w.blockId === blockId)?.message ?? '';
}

// -------------------------------------------------------------------- //
// §4.5 變數
// -------------------------------------------------------------------- //

describe('沒有被設定過的變數（§4.5）', () => {
  it('只出現在「取得」的名字要被標，而且帶建議', () => {
    const s = scene(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'set' },
        set: { opcode: 'data.set', parent: 'h', next: 'log', fields: { name: 'count' } },
        log: { opcode: 'debug.log', parent: 'set', inputs: { text: { kind: 'block', id: 'get' } } },
        get: { opcode: 'data.get', parent: 'log', fields: { name: 'conut' } },
      },
      ['h'],
    );
    const warnings = s.check();
    expect(kindsOn(warnings, 'get')).toEqual(['variable']);
    expect(messageOn(warnings, 'get')).toContain('你是不是要「count」？');
  });

  it('設定過的名字不標', () => {
    const s = scene(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'set' },
        set: { opcode: 'data.set', parent: 'h', next: 'get', fields: { name: 'count' } },
        get: { opcode: 'data.change', parent: 'set', fields: { name: 'count' } },
      },
      ['h'],
    );
    expect(s.check()).toEqual([]);
  });

  it('「改變」不算設定——它 §4.5 明定要求變數已存在', () => {
    const s = scene(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'chg' },
        chg: { opcode: 'data.change', parent: 'h', fields: { name: 'count' } },
      },
      ['h'],
    );
    expect(kindsOn(s.check(), 'chg')).toEqual(['variable']);
  });

  it('迴圈變數與錯誤變數算設定過（manifest 的 binds）', () => {
    const s = scene(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'each' },
        each: {
          opcode: 'control.for_each',
          parent: 'h',
          next: 'try',
          fields: { name: 'item' },
          inputs: { body: { kind: 'stack', id: 'g1' } },
        },
        g1: { opcode: 'data.change', parent: 'each', fields: { name: 'item' } },
        try: {
          opcode: 'control.try_catch',
          parent: 'each',
          fields: { error_name: 'err' },
          inputs: { catch: { kind: 'stack', id: 'g2' } },
        },
        g2: { opcode: 'data.change', parent: 'try', fields: { name: 'err' } },
      },
      ['h'],
    );
    expect(s.check()).toEqual([]);
  });

  it('hat 的 yields 算設定過（§5.4 第 2 層）', () => {
    const s = scene(
      {
        h: {
          opcode: 'event.when_webhook',
          next: 'get',
          inputs: { path: { kind: 'literal', value: '/hook' } },
        },
        get: { opcode: 'data.change', parent: 'h', fields: { name: 'body' } },
      },
      ['h'],
    );
    expect(s.check()).toEqual([]);
  });

  it('函式參數算設定過（§5.4 第 1 層）', () => {
    const s = scene(
      {
        d: { opcode: 'procedure.definition', next: 'get', fields: { proc: 'p_sum' } },
        get: { opcode: 'data.change', parent: 'd', fields: { name: '清單' } },
      },
      [],
      { p_sum: { name: '加總', params: [{ id: 'a1', name: '清單' }], returns: null, definitionBlock: 'd', body: 'get' } },
    );
    expect(s.check()).toEqual([]);
  });
});

describe('`${}` 引用（§4.7 + §4.5）', () => {
  it('文字欄位裡打錯的 root 也要標，警告掛在父積木上', () => {
    const s = scene(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'set' },
        set: { opcode: 'data.set', parent: 'h', next: 'log', fields: { name: 'resp' } },
        log: {
          opcode: 'debug.log',
          parent: 'set',
          inputs: { text: { kind: 'template', value: '第 ${rsep.items[1]} 筆', refs: [] } },
        },
      },
      ['h'],
    );
    const warnings = s.check();
    // 影子沒有自己的圖示位置，所以標在 `log` 上而不是那顆影子上。
    expect(kindsOn(warnings, 'log')).toEqual(['variable']);
    expect(messageOn(warnings, 'log')).toContain('你是不是要「resp」？');
  });

  it('引用設定過的名字不標，路徑的第二段不算變數', () => {
    const s = scene(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'set' },
        set: { opcode: 'data.set', parent: 'h', next: 'log', fields: { name: 'resp' } },
        log: {
          opcode: 'debug.log',
          parent: 'set',
          inputs: { text: { kind: 'template', value: '${resp.items[1].title}', refs: [] } },
        },
      },
      ['h'],
    );
    expect(s.check()).toEqual([]);
  });
});

// -------------------------------------------------------------------- //
// §8.5 型別
// -------------------------------------------------------------------- //

describe('型別不符的插孔（§8.5）', () => {
  it('文字積木插進物件孔 → 警告，而且提「解析 JSON」', () => {
    const s = scene(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'log' },
        log: { opcode: 'debug.log', parent: 'h', inputs: { text: { kind: 'block', id: 'get' } } },
        get: { opcode: 'object.get', parent: 'log', inputs: { object: { kind: 'block', id: 'j' } } },
        j: { opcode: 'operator.join', parent: 'get' },
      },
      ['h'],
    );
    const warnings = s.check();
    expect(kindsOn(warnings, 'get')).toEqual(['type']);
    expect(messageOn(warnings, 'get')).toContain('解析 JSON');
  });

  it('returns: any 一律放行——`解析 JSON` 回什麼由伺服器決定', () => {
    const s = scene(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'log' },
        log: { opcode: 'debug.log', parent: 'h', inputs: { text: { kind: 'block', id: 'get' } } },
        get: { opcode: 'object.get', parent: 'log', inputs: { object: { kind: 'block', id: 'p' } } },
        p: { opcode: 'object.parse_json', parent: 'get' },
      },
      ['h'],
    );
    expect(s.check()).toEqual([]);
  });

  it('清單積木插進數字孔 → 警告（§4.3：容器轉不成數字）', () => {
    const s = scene(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'del' },
        del: {
          opcode: 'data.list_delete',
          parent: 'h',
          fields: { name: 'xs' },
          inputs: { index: { kind: 'block', id: 'k' } },
        },
        k: { opcode: 'object.keys', parent: 'del' },
      },
      ['h'],
    );
    expect(kindsOn(s.check(), 'del')).toContain('type');
  });

  it('`type: string` 的孔永遠不警告——轉字串是全函數（§4.3）', () => {
    const s = scene(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'if' },
        if: { opcode: 'control.if', parent: 'h', inputs: { condition: { kind: 'block', id: 'eq' } } },
        // `( ) ≈ ( )` 的兩個孔宣告的都是 string：寬鬆比對不需要自己一條例外。
        eq: {
          opcode: 'operator.eq',
          parent: 'if',
          fields: { op: 'approx' },
          inputs: { a: { kind: 'block', id: 'k' }, b: { kind: 'literal', value: '5' } },
        },
        k: { opcode: 'object.keys', parent: 'eq' },
      },
      ['h'],
    );
    expect(s.check()).toEqual([]);
  });

  it('影子不算「插了一顆積木」', () => {
    const s = scene(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'log' },
        log: { opcode: 'debug.log', parent: 'h', inputs: { text: { kind: 'block', id: 'get' } } },
        get: {
          opcode: 'object.get',
          parent: 'log',
          inputs: { object: { kind: 'literal', value: 'not an object' } },
        },
      },
      ['h'],
    );
    expect(s.check()).toEqual([]);
  });
});

// -------------------------------------------------------------------- //
// §4.6 回傳
// -------------------------------------------------------------------- //

describe('「回傳」的位置與缺漏（§4.6）', () => {
  it('掛在一般腳本上的「回傳」要標', () => {
    const s = scene(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'r' },
        r: { opcode: 'procedure.return', parent: 'h', inputs: { value: { kind: 'literal', value: 1 } } },
      },
      ['h'],
    );
    expect(kindsOn(s.check(), 'r')).toEqual(['return']);
  });

  it('放在函式定義裡（即使巢狀在迴圈中）不標', () => {
    const s = scene(
      {
        d: { opcode: 'procedure.definition', next: 'rep', fields: { proc: 'p_sum' } },
        rep: {
          opcode: 'control.repeat',
          parent: 'd',
          inputs: { times: { kind: 'literal', value: 3 }, body: { kind: 'stack', id: 'r' } },
        },
        r: { opcode: 'procedure.return', parent: 'rep', inputs: { value: { kind: 'literal', value: 1 } } },
      },
      [],
      { p_sum: { name: '加總', params: [], returns: 'number', definitionBlock: 'd', body: 'rep' } },
    );
    expect(s.check()).toEqual([]);
  });

  it('宣告了回傳型別卻一顆「回傳」都沒有 → 標在定義積木上', () => {
    const s = scene(
      {
        d: { opcode: 'procedure.definition', next: 'log', fields: { proc: 'p_sum' } },
        log: { opcode: 'debug.log', parent: 'd', inputs: { text: { kind: 'literal', value: 'hi' } } },
      },
      [],
      { p_sum: { name: '加總', params: [], returns: 'number', definitionBlock: 'd', body: 'log' } },
    );
    expect(kindsOn(s.check(), 'd')).toEqual(['return']);
  });

  it('沒宣告回傳型別的函式不必有「回傳」', () => {
    const s = scene(
      {
        d: { opcode: 'procedure.definition', next: 'log', fields: { proc: 'p_sum' } },
        log: { opcode: 'debug.log', parent: 'd', inputs: { text: { kind: 'literal', value: 'hi' } } },
      },
      [],
      { p_sum: { name: '加總', params: [], returns: null, definitionBlock: 'd', body: 'log' } },
    );
    expect(s.check()).toEqual([]);
  });
});

// -------------------------------------------------------------------- //
// 套用與清除
// -------------------------------------------------------------------- //

/**
 * 警告圖示只有 `BlockSvg` 畫得出來（`Block.setWarningText` 是空實作），而這裡
 * 是無畫面的工作區。所以測的不是圖示本身，是**下了哪些 setWarningText 指令**
 * ——`inert.ts` 死掉的地方正是那個帳：它算不出「現在還有誰該被清」。
 */
function spy(block: Blockly.Block): { id: string; text: string | null }[] {
  const calls: { id: string; text: string | null }[] = [];
  block.setWarningText = (text: string | null, id?: string) => {
    calls.push({ id: id ?? '', text });
  };
  return calls;
}

describe('CheckRunner 的清除（inert.ts 的那個 bug）', () => {
  function undefinedVariableScene(): Scene {
    return scene(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'get' },
        get: { opcode: 'data.change', parent: 'h', fields: { name: 'count' } },
      },
      ['h'],
    );
  }

  it('警告標得上去', () => {
    const s = undefinedVariableScene();
    const calls = spy(s.workspace.getBlockById('get')!);
    s.runner.run({ ctx: s.ctx, procedures: s.procedures });
    expect(calls).toEqual([
      { id: 'blocky-check:variable', text: expect.stringContaining('還沒有被設定過') },
    ]);
  });

  it('改對之後圖示會被清掉——即使那顆積木已經不是頂層積木', () => {
    const s = undefinedVariableScene();
    s.runner.run({ ctx: s.ctx, procedures: s.procedures });
    const calls = spy(s.workspace.getBlockById('get')!);
    // 補一顆「設定 count 為」，`get` 從此有了定義。它不是頂層積木——那正是
    // `markInertStacks` 清不掉圖示的原因，而這裡的帳是按 blockId 記的。
    const set = s.workspace.newBlock('data.set');
    set.getField('name')!.setValue('count');
    s.runner.run({ ctx: s.ctx, procedures: s.procedures });
    expect(calls).toEqual([{ id: 'blocky-check:variable', text: null }]);
  });

  it('沒有變化時不重複下指令', () => {
    const s = undefinedVariableScene();
    s.runner.run({ ctx: s.ctx, procedures: s.procedures });
    const calls = spy(s.workspace.getBlockById('get')!);
    s.runner.run({ ctx: s.ctx, procedures: s.procedures });
    // 同一筆會被重設一次（訊息可能變了），但**不會**多出一筆 null。
    expect(calls.filter((c) => c.text === null)).toEqual([]);
  });

  it('clear() 只拆自己那幾個 id', () => {
    const s = undefinedVariableScene();
    s.runner.run({ ctx: s.ctx, procedures: s.procedures });
    const calls = spy(s.workspace.getBlockById('get')!);
    s.runner.clear();
    expect(calls).toEqual([{ id: 'blocky-check:variable', text: null }]);
  });

  it('warningId 帶前綴，不會與存檔／欄位警告的 id 撞到', () => {
    expect(warningId('variable')).toBe('blocky-check:variable');
  });
});

describe('註冊過的函式積木型別', () => {
  it('定義與呼叫的 type 帶著 proc id', () => {
    expect(definitionType('p_sum')).toBe('procedure.definition#p_sum');
    expect(callType('p_sum')).toBe('procedure.call#p_sum');
  });
});

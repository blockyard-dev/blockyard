/**
 * 認不得的 opcode → 佔位符（§13.3）。
 *
 * 這一組守的第一件事是**編輯器不會消失**。在它存在之前，一份用了沒裝的積木包
 * 的專案會讓 `Blockly.serialization.blocks.append` 丟例外，例外穿過 React 樹，
 * 畫面變成一片白而且沒有任何訊息。那是實測撞到的，不是推論。
 *
 * 第二件、也是更難守的一件：**存回去不能掉東西**。§13.3 說「保留該積木」，而
 * 保留到一半（積木在、mutation 沒了、`extensions` 宣告沒了）比整個打不開更糟
 * ——後者至少看得出來。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import * as Blockly from 'blockly/core';
import { parse } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerManifests } from '../blockly/setup';
import { isPlaceholderType } from '../blockly/placeholder';
import { buildContext, type ConversionContext } from './context';
import { loadProject } from './deserialize';
import { serializeWorkspace } from './serialize';
import type { Manifest } from '../types/manifest';
import type { Block as IRBlock, BlockyProjectIR as ProjectIR } from '../types/project';

const BUILTINS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../backend/blocky/interpreter/builtins',
);

let ctx: ConversionContext;

beforeAll(() => {
  const manifests = readdirSync(BUILTINS)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => parse(readFileSync(join(BUILTINS, f), 'utf8')) as Manifest);
  ctx = buildContext(registerManifests(manifests).blocks);
});

type Partial_ = Partial<IRBlock> & { opcode: string };

function block(spec: Partial_): IRBlock {
  return { parent: null, next: null, inputs: {}, fields: {}, mutation: null, ui: null, ...spec };
}

function project(
  blocks: Record<string, Partial_>,
  tops: string[],
  extensions: ProjectIR['extensions'] = [],
): ProjectIR {
  return {
    formatVersion: 1,
    meta: { id: 'p', name: 'p' },
    extensions,
    variables: {},
    procedures: {},
    scripts: tops.map((top, i) => ({ id: `sc_${i}`, top, x: 0, y: 0 })),
    blocks: Object.fromEntries(Object.entries(blocks).map(([id, b]) => [id, block(b)])),
  };
}

function roundTrip(ir: ProjectIR): Required<Pick<ProjectIR, 'blocks' | 'extensions'>> & ProjectIR {
  const workspace = new Blockly.Workspace();
  loadProject(ir, workspace, ctx);
  const out = serializeWorkspace(workspace, ctx, { meta: ir.meta });
  return { ...out, blocks: out.blocks ?? {}, extensions: out.extensions ?? [] };
}

// -------------------------------------------------------------------- //

describe('認不得的 opcode（§13.3）', () => {
  it('不會把整個編輯器炸掉——這是它存在的理由', () => {
    const ir = project(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'ghost' },
        ghost: { opcode: 'ghost.vanish', parent: 'h' },
      },
      ['h'],
    );
    const workspace = new Blockly.Workspace();
    // 在這之前這一行是 `TypeError: Invalid block definition for type: ghost.vanish`
    expect(() => loadProject(ir, workspace, ctx)).not.toThrow();
    expect(workspace.getBlockById('ghost')?.type).toBe('ghost.vanish');
  });

  it('這顆積木被認出是佔位符（警告文字本身要瀏覽器才看得到）', () => {
    // `setWarningText` 只在 `BlockSvg` 上有實作，headless 的 `Workspace` 是空
    // 操作、也讀不回來（同 PROGRESS §3.5 那一類「只有瀏覽器守得住」的東西）。
    // 這裡守得住的是它的前提：這個 type 被認出來是佔位符。
    const ir = project(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'ghost' },
        ghost: { opcode: 'ghost.vanish', parent: 'h' },
      },
      ['h'],
    );
    loadProject(ir, new Blockly.Workspace(), ctx);
    expect(isPlaceholderType('ghost.vanish')).toBe(true);
    expect(isPlaceholderType('debug.log')).toBe(false);
  });

  it('存回去一模一樣：opcode、欄位、孔、mutation、next 都在', () => {
    // **保留到一半比整個打不開更糟**——後者至少看得出來。
    const ir = project(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'ghost' },
        ghost: {
          opcode: 'ghost.vanish',
          parent: 'h',
          next: 'after',
          fields: { mode: '安靜' },
          inputs: { target: { kind: 'literal', value: '世界' } },
          mutation: { spooky: true, level: 3 },
        },
        after: { opcode: 'debug.log', parent: 'ghost' },
      },
      ['h'],
    );
    const out = roundTrip(ir).blocks.ghost!;
    expect(out.opcode).toBe('ghost.vanish');
    expect(out.fields).toEqual({ mode: '安靜' });
    expect(out.inputs).toEqual({ target: { kind: 'literal', value: '世界' } });
    // mutation 原封不動：那是某個我們不認得的包的東西，看得懂它的只有那個包。
    expect(out.mutation).toEqual({ spooky: true, level: 3 });
    expect(out.next).toBe('after');
  });

  it('插在孔裡的那顆認得出自己是 reporter，而且子積木不會掉', () => {
    // 形狀猜錯的代價很實際：接不回原來的位置，於是「保留」變成「掉在旁邊」。
    const ir = project(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'log' },
        log: { opcode: 'debug.log', parent: 'h', inputs: { text: { kind: 'block', id: 'ghost' } } },
        ghost: {
          opcode: 'ghost.read',
          parent: 'log',
          inputs: { from: { kind: 'block', id: 'inner' } },
        },
        inner: { opcode: 'data.new_list', parent: 'ghost' },
      },
      ['h'],
    );
    const out = roundTrip(ir);
    expect(out.blocks.log!.inputs).toEqual({ text: { kind: 'block', id: 'ghost' } });
    expect(out.blocks.ghost!.inputs).toEqual({ from: { kind: 'block', id: 'inner' } });
    expect(out.blocks.inner!.opcode).toBe('data.new_list');
  });

  it('C 型的嘴巴留著，裡面那疊積木也留著', () => {
    const ir = project(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'ghost' },
        ghost: {
          opcode: 'ghost.wrap',
          parent: 'h',
          inputs: { body: { kind: 'stack', id: 'inside' } },
        },
        inside: { opcode: 'debug.log', parent: 'ghost' },
      },
      ['h'],
    );
    const out = roundTrip(ir);
    expect(out.blocks.ghost!.inputs).toEqual({ body: { kind: 'stack', id: 'inside' } });
    expect(out.blocks.inside!.opcode).toBe('debug.log');
  });

  it('`extensions` 宣告不會在存檔時安靜消失', () => {
    // 那份宣告的來源是「畫布上用到哪些包」，而佔位符的包照定義就查不到。丟掉它
    // 的話，這份專案從此忘了自己需要哪個包——「一鍵安裝」沒有東西可以裝，而在
    // 裝了那個包的機器上打開也不會載入它（`open_registry(only=declared)`）。
    const ir = project(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'ghost' },
        ghost: { opcode: 'ghost.vanish', parent: 'h' },
      },
      ['h'],
      [{ id: 'ghost', version: '2.1.0' }],
    );
    expect(roundTrip(ir).extensions).toEqual([{ id: 'ghost', version: '2.1.0' }]);
  });

  it('同一個 opcode 在專案裡填了不同的孔 → 兩份都留得住', () => {
    // Blockly 的 type 是全域的，所以孔要取聯集。少宣告一個，`append` 會拋
    // 「missing a(n) X connection」——又是一份打不開的專案。
    const ir = project(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'a' },
        a: {
          opcode: 'ghost.vanish',
          parent: 'h',
          next: 'b',
          inputs: { one: { kind: 'literal', value: '1' } },
        },
        b: {
          opcode: 'ghost.vanish',
          parent: 'a',
          inputs: { two: { kind: 'literal', value: '2' } },
        },
      },
      ['h'],
    );
    const out = roundTrip(ir);
    expect(out.blocks.a!.inputs).toEqual({ one: { kind: 'literal', value: '1' } });
    expect(out.blocks.b!.inputs).toEqual({ two: { kind: 'literal', value: '2' } });
  });

  it('認得的積木不受影響——佔位符只在真的查不到時才出現', () => {
    const ir = project(
      {
        h: { opcode: 'event.when_flag_clicked', next: 'log' },
        log: { opcode: 'debug.log', parent: 'h', inputs: { text: { kind: 'literal', value: 'hi' } } },
      },
      ['h'],
    );
    loadProject(ir, new Blockly.Workspace(), ctx);
    expect(isPlaceholderType('debug.log')).toBe(false);
    expect(isPlaceholderType('event.when_flag_clicked')).toBe(false);
  });
});

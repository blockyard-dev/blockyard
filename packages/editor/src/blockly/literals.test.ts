/**
 * 字面值的型別切換（§16 Q16）。
 *
 * 兩件事要守：
 *
 * 1. **切換保留看得懂的值**（`coerceLiteral`）。規則刻意對齊後端 §4.3 的轉換
 *    表，否則「切過去再切回來」會變成另一個值，而使用者只是想換個型別。
 * 2. **切完之後存得出對的 JSON 型別**。這一條走完整的來回（工作區 →
 *    `serializeWorkspace` → `loadProject` → 再讀影子），因為 Q16 的整個重點就是
 *    「打 `99` 拿到的是 99 不是 `"99"`」——只驗畫面上那顆影子換掉了，等於沒驗。
 */
import * as Blockly from 'blockly/core';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerManifests } from './setup';
import { SHADOW_BOOLEAN, SHADOW_NULL, SHADOW_NUMBER, SHADOW_TEXT, shadowKindOf } from './define';
import { coerceLiteral, literalValueOf, switchLiteralKind } from './literals';
import { buildContext, type ConversionContext } from '../ir/context';
import { loadProject } from '../ir/deserialize';
import { serializeWorkspace } from '../ir/serialize';
import type { Manifest } from '../types/manifest';
import type { BlockyProjectIR as ProjectIR, LiteralInput } from '../types/project';

const BUILTINS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../backend/blocky/interpreter/builtins',
);

let ctx: ConversionContext;

beforeAll(() => {
  const manifests = readdirSync(BUILTINS)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => parseYaml(readFileSync(join(BUILTINS, f), 'utf8')) as Manifest);
  ctx = buildContext(registerManifests(manifests).blocks);
});

/** `設定 [count] 為 (value)`，value 是一顆字面值影子。 */
function setBlock(workspace: Blockly.Workspace, value: unknown): Blockly.BlockSvg {
  const project: ProjectIR = {
    formatVersion: 1,
    meta: { id: 'p', name: 'p' },
    extensions: [],
    variables: {},
    procedures: {},
    scripts: [{ id: 's1', top: 'b1', x: 0, y: 0 }],
    blocks: {
      b1: {
        opcode: 'data.set',
        parent: null,
        next: null,
        inputs: { value: { kind: 'literal', value } },
        fields: { name: 'count' },
        mutation: null,
        ui: null,
      },
    },
  };
  loadProject(project, workspace, ctx);
  return workspace.getBlockById('b1') as Blockly.BlockSvg;
}

function shadowOf(block: Blockly.Block): Blockly.BlockSvg {
  return block.getInput('value')!.connection!.targetBlock() as Blockly.BlockSvg;
}

function savedValue(workspace: Blockly.Workspace): unknown {
  const ir = serializeWorkspace(workspace, ctx, { meta: { id: 'p', name: 'p' } });
  return (ir.blocks?.b1?.inputs?.value as LiteralInput).value;
}

describe('影子的型別跟著值走（載入）', () => {
  const cases: [unknown, string][] = [
    ['hi', SHADOW_TEXT],
    [99, SHADOW_NUMBER],
    [true, SHADOW_BOOLEAN],
    [false, SHADOW_BOOLEAN],
    [null, SHADOW_NULL],
  ];

  for (const [value, type] of cases) {
    it(`${JSON.stringify(value)} → ${type}`, () => {
      const workspace = new Blockly.Workspace();
      expect(shadowOf(setBlock(workspace, value)).type).toBe(type);
    });
  }

  it('宣告是文字孔也一樣——manifest 的 type: string 說的是「用文字框編輯」', () => {
    // `data.set` 的 value 宣告成 string。信任值本身才讓「載入再存回去」不失真。
    const workspace = new Blockly.Workspace();
    setBlock(workspace, 99);
    expect(shadowOf(workspace.getBlockById('b1')!).type).toBe(SHADOW_NUMBER);
    expect(savedValue(workspace)).toBe(99);
  });
});

describe('切換保留看得懂的值', () => {
  it('文字 → 數字', () => {
    expect(coerceLiteral('12', 'number')).toBe(12);
    expect(coerceLiteral('12.5', 'number')).toBe(12.5);
  });

  it('轉不動的數字退回 0，不報錯——使用者只是點了一下選單', () => {
    expect(coerceLiteral('四', 'number')).toBe(0);
  });

  it('數字 / 布林 / 空值 → 文字，與 §4.3 的 to_string 一致', () => {
    expect(coerceLiteral(5, 'text')).toBe('5');
    expect(coerceLiteral(true, 'text')).toBe('true');
    expect(coerceLiteral(false, 'text')).toBe('false');
    expect(coerceLiteral(null, 'text')).toBe('');
  });

  it('→ 是非用 falsy 的方向判斷', () => {
    expect(coerceLiteral('', 'boolean')).toBe(false);
    expect(coerceLiteral('false', 'boolean')).toBe(false);
    expect(coerceLiteral('0', 'boolean')).toBe(false);
    expect(coerceLiteral('你好', 'boolean')).toBe(true);
    expect(coerceLiteral(0, 'boolean')).toBe(false);
    expect(coerceLiteral(3, 'boolean')).toBe(true);
  });

  it('→ 空值就是空值', () => {
    expect(coerceLiteral('任何東西', 'null')).toBeNull();
  });

  it('布林 → 數字是 1 / 0', () => {
    expect(coerceLiteral(true, 'number')).toBe(1);
    expect(coerceLiteral(false, 'number')).toBe(0);
  });
});

describe('切完存得出對的 JSON 型別', () => {
  it('文字 "99" 切成數字，存出去是 99 不是 "99"（Q16 的整個重點）', () => {
    const workspace = new Blockly.Workspace();
    const block = setBlock(workspace, '99');
    expect(savedValue(workspace)).toBe('99');

    switchLiteralKind(shadowOf(block), 'number');
    expect(shadowOf(block).type).toBe(SHADOW_NUMBER);
    expect(savedValue(workspace)).toBe(99);
  });

  it('切成是非存出去是 JSON 布林', () => {
    const workspace = new Blockly.Workspace();
    const block = setBlock(workspace, '你好');
    switchLiteralKind(shadowOf(block), 'boolean');
    expect(savedValue(workspace)).toBe(true);
  });

  it('切成空值存出去是 null', () => {
    const workspace = new Blockly.Workspace();
    const block = setBlock(workspace, 'hi');
    switchLiteralKind(shadowOf(block), 'null');
    expect(shadowOf(block).type).toBe(SHADOW_NULL);
    expect(savedValue(workspace)).toBeNull();
  });

  it('來回一趟不失真', () => {
    const source = new Blockly.Workspace();
    const block = setBlock(source, '7');
    switchLiteralKind(shadowOf(block), 'number');
    const ir = serializeWorkspace(source, ctx, { meta: { id: 'p', name: 'p' } });

    const target = new Blockly.Workspace();
    loadProject(ir, target, ctx);
    const loaded = shadowOf(target.getBlockById('b1')!);
    expect(shadowKindOf(loaded.type)).toBe('number');
    expect(literalValueOf(loaded)).toBe(7);
  });

  it('**目前退不回去**：Blockly 的 setShadowState 是 recordUndo: false', () => {
    // 這條測的是已知限制，不是想要的行為。Blockly 把「孔上的影子」當成父積木
    // 狀態的一部分，`createShadowBlock` 明寫 `recordUndo: false`，所以換型別
    // 不進 undo 堆疊。留著這個斷言是為了讓它**變好的那天會紅**——屆時把這條
    // 改成「一次 undo 退得回去」，而不是有人默默以為它一直都能 undo。
    const workspace = new Blockly.Workspace();
    const block = setBlock(workspace, '99');
    switchLiteralKind(shadowOf(block), 'number');
    expect(savedValue(workspace)).toBe(99);

    workspace.undo(false);
    expect(savedValue(workspace)).toBe(99);
  });
});

/**
 * 孔裡插著 reporter 時，底下那顆影子仍然要在（§8.5）。
 *
 * 這是實測回饋的第九輪第一顆：`設定 seconds 為 (取得 seconds)` 存檔重載之後，
 * 把 `取得` 拉出來，那一格變成灰色的空孔，打不進任何字——而同一顆積木剛從工具箱
 * 拉出來時是好的。差別就在 IR 的 `kind: block` 說不出「被蓋住的影子是哪一顆」。
 */
describe('插著 reporter 的孔底下仍然有影子', () => {
  /** `設定 count 為 (取得 other)` —— value 孔插著一顆 reporter。 */
  function withReporter(workspace: Blockly.Workspace): Blockly.BlockSvg {
    const project: ProjectIR = {
      formatVersion: 1,
      meta: { id: 'p', name: 'p' },
      extensions: [],
      variables: {},
      procedures: {},
      scripts: [{ id: 's1', top: 'b1', x: 0, y: 0 }],
      blocks: {
        b1: {
          opcode: 'data.set',
          parent: null,
          next: null,
          inputs: { value: { kind: 'block', id: 'b2' } },
          fields: { name: 'count' },
          mutation: null,
          ui: null,
        },
        b2: {
          opcode: 'data.get',
          parent: 'b1',
          next: null,
          inputs: {},
          fields: { name: 'other' },
          mutation: null,
          ui: null,
        },
      },
    };
    loadProject(project, workspace, ctx);
    return workspace.getBlockById('b1') as Blockly.BlockSvg;
  }

  it('拔掉 reporter 之後那一格還編輯得了', () => {
    const workspace = new Blockly.Workspace();
    const block = withReporter(workspace);
    expect(shadowOf(block).type).toBe('data.get');

    workspace.getBlockById('b2')!.outputConnection!.disconnect();

    const revealed = shadowOf(block);
    expect(revealed.isShadow()).toBe(true);
    expect(shadowKindOf(revealed.type)).toBe('text');
  });

  it('影子在底下不改變存出去的 IR', () => {
    const workspace = new Blockly.Workspace();
    withReporter(workspace);
    const ir = serializeWorkspace(workspace, ctx, { meta: { id: 'p', name: 'p' } });
    expect(ir.blocks?.b1?.inputs?.value).toEqual({ kind: 'block', id: 'b2' });
  });

  it('boolean 孔沒有影子——六角孔本來就是空的', () => {
    const workspace = new Blockly.Workspace();
    const project: ProjectIR = {
      formatVersion: 1,
      meta: { id: 'p', name: 'p' },
      extensions: [],
      variables: {},
      procedures: {},
      scripts: [{ id: 's1', top: 'b1', x: 0, y: 0 }],
      blocks: {
        b1: {
          opcode: 'control.if',
          parent: null,
          next: null,
          inputs: { condition: { kind: 'block', id: 'b2' } },
          fields: {},
          mutation: null,
          ui: null,
        },
        b2: {
          opcode: 'operator.not',
          parent: 'b1',
          next: null,
          inputs: {},
          fields: {},
          mutation: null,
          ui: null,
        },
      },
    };
    loadProject(project, workspace, ctx);
    const block = workspace.getBlockById('b1')!;
    workspace.getBlockById('b2')!.outputConnection!.disconnect();
    expect(block.getInput('condition')!.connection!.targetBlock()).toBeNull();
  });
});

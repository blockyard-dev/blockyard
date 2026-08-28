/**
 * `FieldText` 的**非渲染**行為（§8.5）。
 *
 * 畫面（pill、紅線、尺寸）要有真的 SVG 才量得出來，那條線在瀏覽器裡驗；這裡
 * 守的是三件不需要畫面也會壞、而且壞了很難發現的事：
 *
 * 1. autocomplete 什麼時候該跳出來（`completionContext`）。
 * 2. 「重新命名此變數的所有引用」有沒有掃到每一格（`renameVariable`）。
 * 3. 多行的第 3 層有沒有真的存進 `blocks[].ui.multiline` 又讀得回來。
 *
 * 第 3 條是這一步唯一動到 IR 的地方，所以它走的是**完整的來回**：真的工作區
 * → `serializeWorkspace` → `loadProject` → 再讀一次欄位。只測其中一半的話，
 * 存得進去卻讀不回來（或反過來）會安靜地通過。
 */
import * as Blockly from 'blockly/core';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerManifests } from '../setup';
import { buildContext, type ConversionContext } from '../../ir/context';
import { loadProject } from '../../ir/deserialize';
import { serializeWorkspace } from '../../ir/serialize';
import { SHADOW_FIELD } from '../define';
import {
  FieldText,
  caretScrollTop,
  collectVariableNames,
  completionContext,
  matchNames,
  renameVariable,
} from './FieldText';
import type { Manifest } from '../../types/manifest';
import type { BlockyProjectIR as ProjectIR } from '../../types/project';

const BUILTINS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../backend/blocky/interpreter/builtins',
);

let ctx: ConversionContext;

beforeAll(() => {
  const manifests = readdirSync(BUILTINS)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => parseYaml(readFileSync(join(BUILTINS, f), 'utf8')) as Manifest);
  ctx = buildContext(registerManifests(manifests).blocks);
});

/** `設定 [name] 為 (value)` 一顆。變數名稱是欄位、值是影子上的欄位。 */
function setBlock(workspace: Blockly.Workspace, id: string, name: string, value: string) {
  return Blockly.serialization.blocks.append(
    {
      type: 'data.set',
      id,
      fields: { name },
      inputs: { value: { shadow: { type: 'blocky.shadow.text', fields: { VALUE: value } } } },
    },
    workspace,
  );
}

/** `記錄 (text) [level]` 一顆。`text` 在 manifest 裡宣告成 `multiline: true, rows: 2`。 */
function logBlock(workspace: Blockly.Workspace, text: string): Blockly.Block {
  loadProject(
    {
      formatVersion: 1,
      meta: { id: 'p', name: 'p' },
      extensions: [],
      variables: {},
      procedures: {},
      scripts: [{ id: 's1', top: 'lg', x: 0, y: 0 }],
      blocks: {
        lg: {
          opcode: 'debug.log',
          parent: null,
          next: null,
          inputs: { text: { kind: 'literal', value: text } },
          fields: {},
          mutation: null,
          ui: null,
        },
      },
    },
    workspace,
    ctx,
  );
  return workspace.getBlockById('lg')!;
}

function fieldOf(block: Blockly.Block, name: string): FieldText {
  const own = block.getField(name);
  if (own instanceof FieldText) return own;
  const shadow = block.getInput(name)?.connection?.targetBlock();
  const field = shadow?.getField(SHADOW_FIELD);
  if (!(field instanceof FieldText)) throw new Error(`找不到 FieldText：${name}`);
  return field;
}

describe('autocomplete 什麼時候跳出來', () => {
  it('變數名稱欄位一聚焦就整格可換', () => {
    expect(completionContext('cou', 3, 'variable', false)).toEqual({
      start: 0,
      end: 3,
      prefix: 'cou',
      close: false,
    });
  });

  it('一般文字要打了 ${ 才算', () => {
    expect(completionContext('嗨 ', 3, 'text', true)).toBeNull();
    expect(completionContext('嗨 ${na', 6, 'text', true)).toEqual({
      start: 4,
      end: 6,
      prefix: 'na',
      close: true,
    });
  });

  it('後面已經有 } 就不再補一個', () => {
    expect(completionContext('${na}', 4, 'text', true)?.close).toBe(false);
  });

  it('插值關掉的欄位（code）不跳', () => {
    expect(completionContext('echo ${HOME', 11, 'text', false)).toBeNull();
  });

  it('運算式即使 interpolate 沒開也跳——它的 ${} 是文法的一部分', () => {
    expect(completionContext('${a', 3, 'expression', false)?.prefix).toBe('a');
  });

  it('$${ 是逸出，不是插值的開頭', () => {
    expect(completionContext('$${a', 4, 'text', true)).toBeNull();
  });

  it('已經關起來的插值不再跳', () => {
    expect(completionContext('${a} ', 5, 'text', true)).toBeNull();
  });

  it('走到路徑第二段就不跳了——那要知道值長什麼樣子', () => {
    expect(completionContext('${a.b', 5, 'text', true)).toBeNull();
    expect(completionContext('${a[1', 5, 'text', true)).toBeNull();
  });
});

describe('候選的排序', () => {
  const names = ['count', 'discount', '總數'];

  it('沒打字就全列', () => {
    expect(matchNames(names, '')).toEqual(names);
  });

  it('前綴優先於包含', () => {
    expect(matchNames(names, 'coun')).toEqual(['count', 'discount']);
  });

  it('不分大小寫', () => {
    expect(matchNames(names, 'COU')).toEqual(['count', 'discount']);
  });

  it('已經打完的那個不再提示', () => {
    expect(matchNames(names, 'count')).toEqual(['discount']);
  });

  it('中文照樣比對', () => {
    expect(matchNames(names, '總')).toEqual(['總數']);
  });
});

describe('掃描工作區的變數名稱', () => {
  it('只收變數名稱欄位，不收 ${} 裡打過的 root', () => {
    // §4.5 的靜態檢查就是這麼定義的：一個名字要先被 data.set 過才算數。
    // 把引用也收進來，等於讓 autocomplete 幫忙傳播錯字。
    const workspace = new Blockly.Workspace();
    setBlock(workspace, 'b1', 'count', '${typoo}');
    setBlock(workspace, 'b2', '總數', '');
    // 排序用 `localeCompare(…, 'zh-Hant')`，中文排在拉丁字母前面
    expect(collectVariableNames(workspace)).toEqual(['總數', 'count']);
  });

  it('空名稱不算', () => {
    const workspace = new Blockly.Workspace();
    setBlock(workspace, 'b1', '', '');
    expect(collectVariableNames(workspace)).toEqual([]);
  });
});

describe('重新命名此變數的所有引用（§4.5）', () => {
  it('名稱欄位與 ${} 引用一起換，路徑其餘部分不動', () => {
    const workspace = new Blockly.Workspace();
    const a = setBlock(workspace, 'b1', 'count', '');
    const b = setBlock(workspace, 'b2', 'other', '目前 ${count.items[1]} 個');

    expect(renameVariable(workspace, 'count', '總數')).toBe(2);
    expect(fieldOf(a, 'name').getValue()).toBe('總數');
    expect(fieldOf(b, 'value').getValue()).toBe('目前 ${總數.items[1]} 個');
    expect(fieldOf(b, 'name').getValue()).toBe('other');
  });

  it('沒有引用到的欄位一個都不碰', () => {
    const workspace = new Blockly.Workspace();
    setBlock(workspace, 'b1', 'count', 'plain ${counter}');
    expect(renameVariable(workspace, 'nothing', 'x')).toBe(0);
  });
});

describe('多行第 3 層 → blocks[].ui.multiline（§4.2、§8.5）', () => {
  function project(workspace: Blockly.Workspace): ProjectIR {
    return serializeWorkspace(workspace, ctx, { meta: { id: 'p', name: 'p' } });
  }

  it('沒有強制就沒有 ui——不留空殼', () => {
    const workspace = new Blockly.Workspace();
    setBlock(workspace, 'b1', 'count', 'hi');
    expect(project(workspace).blocks?.b1?.ui).toBeNull();
  });

  it('影子上的欄位記的是孔名', () => {
    const workspace = new Blockly.Workspace();
    const block = setBlock(workspace, 'b1', 'count', 'hi');
    fieldOf(block, 'value').setForcedMultiline(true);
    expect(project(workspace).blocks?.b1?.ui).toEqual({ multiline: ['value'] });
  });

  it('存進去讀得回來', () => {
    const source = new Blockly.Workspace();
    const block = setBlock(source, 'b1', 'count', 'hi');
    fieldOf(block, 'value').setForcedMultiline(true);

    const target = new Blockly.Workspace();
    loadProject(project(source), target, ctx);

    const loaded = target.getBlockById('b1')!;
    expect(fieldOf(loaded, 'value').getForcedMultiline()).toBe(true);
    expect(fieldOf(loaded, 'value').isMultiline()).toBe(true);
  });

  it('認不得的 ui key 跳過就好，不該讓專案打不開（§4.2 前向相容）', () => {
    const source = new Blockly.Workspace();
    setBlock(source, 'b1', 'count', 'hi');
    const ir = project(source);
    ir.blocks!.b1!.ui = { multiline: ['沒有這個孔'], 未來的key: 1 };

    const target = new Blockly.Workspace();
    expect(() => loadProject(ir, target, ctx)).not.toThrow();
  });
});

describe('畫幾行由值決定——形狀跟著它走', () => {
  // 回饋：`記錄 (你好)` 變成矩形。根因是曾經有一條「多行欄位至少畫兩行」，
  // 於是 manifest 宣告 `multiline: true` 的欄位即使只有一行字也被畫成兩行高，
  // 而**形狀是跟著行數走的**（單行膠囊、多行圓角矩形，見 `syncOutputShape`）。
  // 這一組把「行數只由值決定」釘住——形狀本身要有 renderer 才量得到，headless
  // 的工作區量不到，所以測的是它的唯一輸入。

  it('宣告成多行、但值只有一行 → 還是一行', () => {
    const workspace = new Blockly.Workspace();
    const block = logBlock(workspace, '你好');
    const field = fieldOf(block, 'text');
    expect(field.isDeclaredMultiline()).toBe(true);
    expect(field.isMultiline()).toBe(true);
    expect(field.renderedRows()).toBe(1);
  });

  it('值真的有換行才變多行', () => {
    const workspace = new Blockly.Workspace();
    expect(fieldOf(logBlock(workspace, '你好\n世界'), 'text').renderedRows()).toBe(2);
  });

  it('右鍵開了多行、值只有一行 → 仍然是一行', () => {
    const workspace = new Blockly.Workspace();
    const field = fieldOf(setBlock(workspace, 'b1', 'count', 'hi'), 'value');
    field.setForcedMultiline(true);
    expect(field.renderedRows()).toBe(1);
  });

  it('單行欄位裡的換行不會撐高——溢出的部分收成一行', () => {
    const workspace = new Blockly.Workspace();
    const field = fieldOf(setBlock(workspace, 'b1', 'count', 'a'), 'value');
    field.setForcedMultiline(false);
    field.setValue('a\nb\nc');
    expect(field.renderedRows()).toBe(1);
  });

  it('rows 是捲動上限，不是高度', () => {
    // `debug.log` 宣告 rows: 2；五行的值只畫得出兩行，其餘捲動。
    const workspace = new Blockly.Workspace();
    expect(fieldOf(logBlock(workspace, 'a\nb\nc\nd\ne'), 'text').renderedRows()).toBe(2);
  });
});

describe('三層多行的優先序', () => {
  it('強制 > 自動', () => {
    const workspace = new Blockly.Workspace();
    const block = setBlock(workspace, 'b1', 'count', 'a\nb');
    const field = fieldOf(block, 'value');
    // 第 2 層：值裡有換行就是多行
    expect(field.isMultiline()).toBe(true);
    // 第 3 層壓得過它（只是這個方向存不進 ui.multiline，見 serialize.ts）
    field.setForcedMultiline(false);
    expect(field.isMultiline()).toBe(false);
  });

  it('長字串自動變多行', () => {
    const workspace = new Blockly.Workspace();
    const block = setBlock(workspace, 'b1', 'count', 'x'.repeat(61));
    expect(fieldOf(block, 'value').isMultiline()).toBe(true);
  });
});

describe('超過 rows 之後要捲到游標那一行', () => {
  // plugin 的 Shift+Enter 是自己接的：直接改 input.value 再設 selectionStart，
  // 而程式設定選取範圍不會讓瀏覽器把游標捲進視野。症狀是打到第五行之後畫面
  // 停在前四行，使用者看不到自己在打什麼。這裡測的是補上的那段算術。
  const base = { lineHeight: 20, padTop: 3, clientHeight: 80 }; // 看得見四行

  const at = (value: string, caret: number, scrollTop: number) =>
    caretScrollTop({ ...base, value, caret, scrollTop });

  it('游標已經看得見就完全不動——不然每打一個字畫面都會跳', () => {
    expect(at('a\nb\nc', 3, 0)).toBe(0);
  });

  it('打到第五行就往下捲到剛好露出它', () => {
    const value = 'L1\nL2\nL3\nL4\nL5';
    // 第 5 行（index 4）的底部 = 3 + 5×20 = 103，減掉看得見的 80
    expect(at(value, value.length, 0)).toBe(23);
  });

  it('往回捲之後把游標移到上面，會捲回去', () => {
    expect(at('L1\nL2\nL3\nL4\nL5', 0, 23)).toBe(3);
  });

  it('是最小移動，不是置中', () => {
    const value = 'L1\nL2\nL3\nL4\nL5\nL6';
    // 從 23 捲到第 6 行：只多捲一行的高度
    expect(at(value, value.length, 23)).toBe(43);
  });

  it('沒有換行時永遠不捲', () => {
    expect(at('一整行很長的字'.repeat(20), 10, 0)).toBe(0);
  });
});

/**
 * 可重複參數群組的編輯器行為（§16 Q19）。
 *
 * manifest 讀**後端真正在用的那幾份 yaml**（同 `define.test.ts`）：`repeat` 是
 * 這一步新增的宣告，複製一份 fixture 的話，哪天 `control.if_else` 的宣告改了，
 * 測試會繼續綠著而編輯器會畫錯。
 */
import * as Blockly from 'blockly/core';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerManifests } from './setup';
import { REPEAT_KEY, argSpecOf, repeatArgName } from './repeat';
import type { BlockSpec, Manifest } from '../types/manifest';

const BUILTINS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../backend/blockyard/interpreter/builtins',
);

let ifElseSpec: BlockSpec;

beforeAll(() => {
  const manifests = readdirSync(BUILTINS)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => parse(readFileSync(join(BUILTINS, f), 'utf8')) as Manifest);
  registerManifests(manifests);
  const control = manifests.find((m) => m.id === 'control')!;
  ifElseSpec = (control.palette ?? []).find(
    (e): e is BlockSpec => 'opcode' in e && e.opcode === 'if_else',
  )!;
});

/** 按一下積木上的 `+` / `−`。`FieldImage` 的點擊走 `showEditor_`。 */
function press(block: Blockly.Block, field: 'REPEAT_PLUS' | 'REPEAT_MINUS'): void {
  (block.getField(field) as unknown as { showEditor_(): void }).showEditor_();
}

function inputs(block: Blockly.Block): string[] {
  return block.inputList.map((i) => i.name).filter((n) => n !== '');
}

function extraState(block: Blockly.Block): unknown {
  return (block as unknown as { saveExtraState?(): unknown }).saveExtraState?.();
}

describe('可重複參數群組（§16 Q19）', () => {
  it('剛拖出來的積木沒有任何額外的份', () => {
    const b = new Blockly.Workspace().newBlock('control.if_else');
    expect(inputs(b)).toEqual(['condition', 'then', 'else', 'REPEAT_CONTROLS']);
  });

  it('沒按過 + 的積木存出來完全沒有 mutation', () => {
    // **這一條守的是向下相容。** 少了它，這次改版會讓每一顆既有的
    // `如果⋯否則` 在存檔時長出一個 mutation，而 round-trip 等價（§4.1）當場破掉。
    const b = new Blockly.Workspace().newBlock('control.if_else');
    expect(extraState(b)).toBeNull();
  });

  it('+ 長出一份，且落在「否則」之前', () => {
    // 位置由宣告的 `repeat.before` 說——append 一律接在最後，而
    // `否則如果` 出現在 `否則` 後面是讀不通的。
    const b = new Blockly.Workspace().newBlock('control.if_else');
    press(b, 'REPEAT_PLUS');

    expect(inputs(b)).toEqual([
      'condition',
      'then',
      'condition_1',
      'REPEAT_TAIL_0',
      'body_1',
      'else',
      'REPEAT_CONTROLS',
    ]);
    expect(extraState(b)).toEqual({ [REPEAT_KEY]: 1 });
  });

  it('新的那一份落在「否則」那兩個字之前，不是之間', () => {
    // `否則` 是一個**沒有名字的 dummy 列**，`else` 是它後面那個堆疊。插在
    // `else` 之前就會落在兩者中間，而 `inputsInline` 讓它們擠成同一行——
    // 畫面上是「否則 否則如果 ◇ 那麼」，讀起來不知道在說什麼。
    const b = new Blockly.Workspace().newBlock('control.if_else');
    press(b, 'REPEAT_PLUS');

    const rows = b.inputList.map((i) => i.name || i.fieldRow.map((f) => f.getText()).join(''));
    expect(rows.indexOf('condition_1')).toBeLessThan(rows.indexOf('否則'));
  });

  it('+ 兩次是兩份，編號從 1 開始', () => {
    const b = new Blockly.Workspace().newBlock('control.if_else');
    press(b, 'REPEAT_PLUS');
    press(b, 'REPEAT_PLUS');

    expect(inputs(b)).toContain('condition_2');
    expect(inputs(b)).toContain('body_2');
    expect(extraState(b)).toEqual({ [REPEAT_KEY]: 2 });
  });

  it('− 收回一份', () => {
    const b = new Blockly.Workspace().newBlock('control.if_else');
    press(b, 'REPEAT_PLUS');
    press(b, 'REPEAT_MINUS');

    expect(inputs(b)).toEqual(['condition', 'then', 'else', 'REPEAT_CONTROLS']);
    expect(extraState(b)).toBeNull();
  });

  it('− 到底就停住，不會變成負的', () => {
    const b = new Blockly.Workspace().newBlock('control.if_else');
    press(b, 'REPEAT_MINUS');
    press(b, 'REPEAT_MINUS');

    expect(extraState(b)).toBeNull();
  });

  it('− 不會刪掉插在那一份裡的積木', () => {
    // §8.5：靜默刪除是這個專案一路在避免的事——使用者按了一下 `−`，半個流程
    // 消失，而 undo 之外沒有任何線索。斷開成孤兒，不是丟掉。
    const ws = new Blockly.Workspace();
    const b = ws.newBlock('control.if_else');
    press(b, 'REPEAT_PLUS');

    const inner = ws.newBlock('debug.log');
    b.getInput('body_1')!.connection!.connect(inner.previousConnection!);
    expect(inner.getParent()).toBe(b);

    press(b, 'REPEAT_MINUS');

    expect(inner.isDisposed()).toBe(false);
    expect(inner.getParent()).toBeNull();
  });

  it('+ 是一步 undo，不是三步', async () => {
    // 一次 `+` 在畫面上是一個動作。拆成「加一個孔、再加一個孔、再重畫」的話，
    // 使用者要按三次 undo 才回得去。
    //
    // 等一個 tick：Blockly 的事件排進 queue、下一個 tick 才送，而 undo 堆疊
    // 在那時候才長出來。同步斷言的話它永遠是空的。
    const ws = new Blockly.Workspace();
    const b = ws.newBlock('control.if_else');
    press(b, 'REPEAT_PLUS');
    await new Promise((r) => setTimeout(r, 0));
    expect(extraState(b)).toEqual({ [REPEAT_KEY]: 1 });

    ws.undo(false);
    expect(extraState(ws.getBlockById(b.id)!)).toBeNull();
  });

  it('loadExtraState 把份數夾在宣告的上下限裡', () => {
    // 一份手寫的 IR 說有一千份時，畫面不該試著畫出來。
    const b = new Blockly.Workspace().newBlock('control.if_else');
    (b as unknown as { loadExtraState(s: unknown): void }).loadExtraState({ [REPEAT_KEY]: 999 });

    expect(extraState(b)).toEqual({ [REPEAT_KEY]: ifElseSpec.repeat!.max ?? 20 });
  });
});

describe('展開後的參數宣告查得到（§16 Q19）', () => {
  it('body_1 查得到，而且知道它是 stack', () => {
    // 序列化時靠它分辨 `kind: stack` 與 `kind: block`。查不到的話，一份存好的
    // 專案讀回來會接錯位置——而那要到執行時才看得出來。
    expect(argSpecOf(ifElseSpec, 'body_1')?.type).toBe('stack');
    expect(argSpecOf(ifElseSpec, 'condition_1')?.type).toBe('boolean');
  });

  it('基底的參數照樣查得到', () => {
    expect(argSpecOf(ifElseSpec, 'then')?.type).toBe('stack');
  });

  it('編號從 0 或不是數字的一律查不到', () => {
    expect(argSpecOf(ifElseSpec, 'body_0')).toBeUndefined();
    expect(argSpecOf(ifElseSpec, 'body_x')).toBeUndefined();
    expect(argSpecOf(ifElseSpec, 'nope_1')).toBeUndefined();
  });

  it('`scope` 跟著那一份走，不是指回基底那一疊（D29 × Q19）', () => {
    // 原樣回傳的話，第 2 份 catch 綁的名字會宣稱自己在**第 1 份** catch 裡
    // 有效——祖先鏈於是標錯一顆積木，而畫面上那兩顆長得一模一樣。
    const spec: BlockSpec = {
      opcode: 'multi_catch',
      type: 'command',
      text: '嘗試 %(try)',
      args: { try: { type: 'stack' } },
      repeat: {
        label: '出錯時把錯誤存進 %(error_name)',
        args: {
          error_name: { type: 'variable', binds: true, scope: 'catch' },
          catch: { type: 'stack' },
        },
      },
    } as BlockSpec;
    expect(argSpecOf(spec, 'error_name_1')?.scope).toBe('catch_1');
    expect(argSpecOf(spec, 'error_name_2')?.scope).toBe('catch_2');
  });

  it('展開的命名規則與後端同一條', () => {
    expect(repeatArgName('condition', 0)).toBe('condition_1');
  });
});

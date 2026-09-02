/**
 * 「畫布上還有誰在用這個積木包」（D31 的刪除規則）。
 *
 * 這條規則擋的是「刪掉之後畫布上留著一批改得動、卻再也生不出第二顆的積木」，
 * 所以它的每一種漏抓都是使用者事後才會發現的：少算一顆就是放行。
 */
import * as Blockly from 'blockly/core';
import { describe, expect, it } from 'vitest';
import { defineManifest } from './define';
import { groupByManifest } from './toolbox';
import { blocksUsing } from './usage';
import type { Manifest } from '../types/manifest';

function pack(id: string, opcodes: string[]) {
  const [group] = groupByManifest(
    defineManifest({
      manifestVersion: 1,
      id,
      name: id,
      version: '0.1.0',
      palette: opcodes.map((opcode) => ({ opcode, type: 'command', text: opcode })),
    } as unknown as Manifest),
  );
  return group!;
}

const A = pack('use_a', ['one', 'two']);
const B = pack('use_b', ['one']);

describe('還有誰在用', () => {
  it('空的工作區沒有人在用', () => {
    expect(blocksUsing(new Blockly.Workspace(), A)).toEqual([]);
  });

  it('算的是這個命名空間的**每一種**積木，不是只有第一種', () => {
    const ws = new Blockly.Workspace();
    ws.newBlock('use_a.one');
    ws.newBlock('use_a.two');
    ws.newBlock('use_a.two');
    expect(blocksUsing(ws, A)).toHaveLength(3);
  });

  it('別的包不算——兩個包可以有同名的 opcode，差別在命名空間', () => {
    const ws = new Blockly.Workspace();
    ws.newBlock('use_b.one');
    expect(blocksUsing(ws, A)).toEqual([]);
    expect(blocksUsing(ws, B)).toHaveLength(1);
  });

  it('刪掉那顆積木之後就放行了', () => {
    const ws = new Blockly.Workspace();
    const block = ws.newBlock('use_a.one');
    expect(blocksUsing(ws, A)).toHaveLength(1);
    block.dispose(false);
    expect(blocksUsing(ws, A)).toEqual([]);
  });
});

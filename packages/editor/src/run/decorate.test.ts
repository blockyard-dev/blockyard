/**
 * 「只有落單的 reporter 才冒值氣泡」（§8.3，第九輪回饋）。
 *
 * 這條規則的全部風險在**它會不會連別的一起關掉**：command 與 hat 沒有輸出孔，
 * 錯誤氣泡不受它管——所以測的不是「插在孔裡的不冒」那一條，而是那三條沒被
 * 波及。用真的工作區（headless）而不是假物件：`outputConnection.isConnected()`
 * 正是這條規則的全部，假掉它等於什麼都沒驗。
 */
import * as Blockly from 'blockly/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { speaks } from './decorate';
import type { BlockState } from './store';

const REPORTER = 'test_speaks_reporter';
const COMMAND = 'test_speaks_command';

beforeAll(() => {
  Blockly.common.defineBlocksWithJsonArray([
    {
      type: REPORTER,
      message0: '%1',
      args0: [{ type: 'input_value', name: 'A' }],
      output: null,
    },
    { type: COMMAND, message0: '做事', previousStatement: null, nextStatement: null },
  ]);
});

function done(value: unknown): BlockState {
  return { phase: 'done', value, seq: 1 };
}

describe('值氣泡：只有落單的才冒（§8.3）', () => {
  it('落單的 reporter 冒，插在孔裡的不冒', () => {
    const workspace = new Blockly.Workspace();
    const outer = workspace.newBlock(REPORTER, 'outer');
    const inner = workspace.newBlock(REPORTER, 'inner');
    outer.getInput('A')?.connection?.connect(inner.outputConnection!);

    // `1 + (2 * 3)` 只有 `+` 說話：裡面的孔有沒有東西不看，所以巢狀自動只剩
    // 最外面那顆。
    expect(speaks(done(6), workspace, 'outer')).toBe(true);
    expect(speaks(done(6), workspace, 'inner')).toBe(false);
  });

  it('command 沒有輸出孔，不受這條影響', () => {
    const workspace = new Blockly.Workspace();
    workspace.newBlock(COMMAND, 'cmd');
    // command 的 `block.exit` 本來就沒有 value，所以它安靜的理由仍然是舊的
    // 那一條；有 count 的 hot 才是這裡真的要問的。
    expect(speaks({ phase: 'hot', count: 4210, seq: 2 }, workspace, 'cmd')).toBe(true);
  });

  it('錯誤氣泡不受這條管——插在深處的積木出錯必須看得見', () => {
    const workspace = new Blockly.Workspace();
    const outer = workspace.newBlock(REPORTER, 'outer');
    const inner = workspace.newBlock(REPORTER, 'inner');
    outer.getInput('A')?.connection?.connect(inner.outputConnection!);

    const error = { type: 'BlockyError', code: 'boom', message: '炸了' };
    expect(speaks({ phase: 'error', error, seq: 3 }, workspace, 'inner')).toBe(true);
  });

  it('積木被刪掉（執行中拖走一顆）當成落單', () => {
    const workspace = new Blockly.Workspace();
    expect(speaks(done(1), workspace, '不存在')).toBe(true);
  });
});

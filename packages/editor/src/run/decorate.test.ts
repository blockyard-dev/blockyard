/**
 * 「只有落單的 reporter 才冒值氣泡」（§8.3，第九輪回饋）。
 *
 * 外加 `locate`：§5.1 的「點一下就跑」現在也認工具箱裡那一顆，而它不在主畫布上。
 *
 * 這條規則的全部風險在**它會不會連別的一起關掉**：command 與 hat 沒有輸出孔，
 * 錯誤氣泡不受它管——所以測的不是「插在孔裡的不冒」那一條，而是那三條沒被
 * 波及。用真的工作區（headless）而不是假物件：`outputConnection.isConnected()`
 * 正是這條規則的全部，假掉它等於什麼都沒驗。
 */
import * as Blockly from 'blockly/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { locate, speaks } from './decorate';
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

    const error = { type: 'BlockyardError', code: 'boom', message: '炸了' };
    expect(speaks({ phase: 'error', error, seq: 3 }, workspace, 'inner')).toBe(true);
  });

  it('積木被刪掉（執行中拖走一顆）當成落單', () => {
    const workspace = new Blockly.Workspace();
    expect(speaks(done(1), workspace, '不存在')).toBe(true);
  });
});

/**
 * 工具箱裡的積木也跑得動（§5.1），而它不在主畫布上——`locate` 是那條退路。
 *
 * flyout 的工作區是**真的一個工作區**（Blockly 就是這樣做的），所以這裡用兩個
 * headless 工作區。假掉的只有 `getFlyout` 一個方法：起一個有 flyout 的
 * `WorkspaceSvg` 要 DOM，而它證得的東西不比「主畫布找不到就問那一份」更多。
 */
describe('積木在哪裡：主畫布找不到就問工具箱（§5.1）', () => {
  function withFlyout(main: Blockly.Workspace, flyout: Blockly.Workspace): Blockly.Workspace {
    (main as unknown as { getFlyout: () => unknown }).getFlyout = () => ({
      getWorkspace: () => flyout,
    });
    return main;
  }

  it('工具箱那一份找得到，而且主畫布優先', () => {
    const main = new Blockly.Workspace();
    const flyout = new Blockly.Workspace();
    const onCanvas = main.newBlock(REPORTER, 'same');
    flyout.newBlock(REPORTER, 'same');
    const inFlyout = flyout.newBlock(REPORTER, 'only_in_flyout');
    withFlyout(main, flyout);

    expect(locate(main, 'only_in_flyout')).toBe(inFlyout);
    expect(locate(main, 'same')).toBe(onCanvas);
    expect(locate(main, '不存在')).toBeNull();
  });

  it('沒有 flyout 的工作區（測試、預覽）不會炸', () => {
    const workspace = new Blockly.Workspace();
    expect(locate(workspace, '不存在')).toBeNull();
    expect(locate(null, '不存在')).toBeNull();
  });

  it('工具箱裡那顆落單的 reporter 照樣冒值氣泡', () => {
    const main = new Blockly.Workspace();
    const flyout = new Blockly.Workspace();
    flyout.newBlock(REPORTER, 'in_flyout');
    withFlyout(main, flyout);

    expect(speaks(done('hi'), main, 'in_flyout')).toBe(true);
  });
});

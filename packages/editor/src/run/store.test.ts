/**
 * `useRunStore` 的事件 → 狀態化簡（§8.3）。
 *
 * 測的是「一批事件進來之後畫面該是什麼樣子」，不是 WebSocket 怎麼連——後者
 * 在後端的 `test_runs.py` 已經有整條路的題目了。這裡守的是前端獨有的三條：
 * 哪些積木該發光、哪些該冒氣泡、以及「跑完之後別繼續發光」。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { RunEvent, RunFrame } from '../api/runs';
import { useRunStore } from './store';

function frame(...events: RunEvent[]): RunFrame {
  return { runId: 'r_1', events };
}

function apply(...events: RunEvent[]): void {
  useRunStore.getState().apply(frame(...events));
}

beforeEach(() => {
  useRunStore.getState().begin();
});

describe('積木狀態', () => {
  it('block.enter 讓積木發光，block.exit 讓它停下來', () => {
    apply({ op: 'block.enter', threadId: 't_1', blockId: 'b1' });
    expect(useRunStore.getState().blocks.get('b1')?.phase).toBe('running');

    apply({ op: 'block.exit', threadId: 't_1', blockId: 'b1' });
    expect(useRunStore.getState().blocks.get('b1')?.phase).toBe('done');
  });

  it('command 的 exit 沒有值，所以不冒氣泡；reporter 的有', () => {
    apply(
      { op: 'block.exit', threadId: 't_1', blockId: 'cmd' },
      { op: 'block.exit', threadId: 't_1', blockId: 'rep', value: 42 },
    );
    const { blocks } = useRunStore.getState();
    expect(blocks.get('cmd')?.value).toBeUndefined();
    expect(blocks.get('rep')?.value).toBe(42);
  });

  it('同一個值連續回兩次，seq 仍然要往前走', () => {
    // 氣泡靠 seq 判斷「這是新的一次」。不遞增的話迴圈裡第二圈的氣泡會沿用
    // 第一圈的倒數計時，看起來像提早消失。
    apply({ op: 'block.exit', threadId: 't_1', blockId: 'b1', value: 7 });
    const first = useRunStore.getState().blocks.get('b1')?.seq;
    apply({ op: 'block.exit', threadId: 't_1', blockId: 'b1', value: 7 });
    expect(useRunStore.getState().blocks.get('b1')?.seq).toBe((first ?? 0) + 1);
  });

  it('block.hot 帶著累計次數，之後的 enter 不會把它清掉', () => {
    apply({ op: 'block.hot', blockId: 'b1', count: 4210, lastValue: 3 });
    expect(useRunStore.getState().blocks.get('b1')).toMatchObject({
      phase: 'hot',
      count: 4210,
      value: 3,
    });

    apply({ op: 'block.enter', threadId: 't_1', blockId: 'b1' });
    expect(useRunStore.getState().blocks.get('b1')?.count).toBe(4210);
  });

  it('block.error 標紅、進 log、並讓 topbar 說得出是什麼錯', () => {
    apply({
      op: 'block.error',
      threadId: 't_1',
      blockId: 'b1',
      error: { type: 'UndefinedVariableError', code: 'undefined_variable', message: '未知變數 x' },
    });

    const state = useRunStore.getState();
    expect(state.blocks.get('b1')?.phase).toBe('error');
    expect(state.logs.at(-1)).toMatchObject({ level: 'error', text: '未知變數 x' });
    expect(state.message).toBe('未知變數 x');
  });

  it('run.end 在同一批事件裡到達時也要收尾', () => {
    // 正常跑完走的是這條（`finish()` 只有連線意外斷掉才會被呼叫）。
    apply(
      { op: 'block.enter', threadId: 't_1', blockId: 'b1' },
      { op: 'run.end', runId: 'r_1', status: 'cancelled' },
    );
    expect(useRunStore.getState().blocks.get('b1')?.phase).toBe('done');
  });

  it('run.end 之後沒有積木還在發光', () => {
    apply(
      { op: 'block.enter', threadId: 't_1', blockId: 'b1' },
      { op: 'block.hot', blockId: 'b2', count: 99 },
      {
        op: 'block.error',
        threadId: 't_1',
        blockId: 'b3',
        error: { type: 'E', code: 'e', message: 'boom' },
      },
    );
    useRunStore.getState().finish('cancelled');

    const { blocks } = useRunStore.getState();
    expect(blocks.get('b1')?.phase).toBe('done');
    expect(blocks.get('b2')?.phase).toBe('done');
    // 錯誤留著：它是使用者要看的結果，不是「正在跑」的訊號
    expect(blocks.get('b3')?.phase).toBe('error');
    expect(blocks.get('b2')?.count).toBe(99);
  });
});

describe('變數與輸出', () => {
  it('var.set 直接反映現值', () => {
    apply(
      { op: 'var.set', name: 'count', value: 1 },
      { op: 'var.set', name: 'count', value: 10 },
      { op: 'var.set', name: 'items', value: [1, 2] },
    );
    const { variables } = useRunStore.getState();
    expect(variables.get('count')).toBe(10);
    expect(variables.get('items')).toEqual([1, 2]);
  });

  it('log buffer 是環形的（§8.2 上限 5000）', () => {
    for (let i = 0; i < 5200; i++) {
      apply({ op: 'log', level: 'info', text: `#${i}` });
    }
    const { logs } = useRunStore.getState();
    expect(logs).toHaveLength(5000);
    expect(logs.at(-1)?.text).toBe('#5199');
    expect(logs[0]?.text).toBe('#200');
  });

  it('丟棄的事件數要累加起來，前端才說得出畫面不完整（§6.2）', () => {
    useRunStore.getState().apply({ runId: 'r_1', events: [], dropped: 30 });
    useRunStore.getState().apply({ runId: 'r_1', events: [], dropped: 12 });
    expect(useRunStore.getState().dropped).toBe(42);
  });

  it('begin() 把上一次的一切清乾淨', () => {
    apply(
      { op: 'var.set', name: 'count', value: 1 },
      { op: 'log', level: 'info', text: 'hi' },
      { op: 'block.enter', threadId: 't_1', blockId: 'b1' },
    );
    useRunStore.getState().begin();

    const state = useRunStore.getState();
    expect(state.variables.size).toBe(0);
    expect(state.logs).toHaveLength(0);
    expect(state.blocks.size).toBe(0);
    expect(state.status).toBe('starting');
  });
});

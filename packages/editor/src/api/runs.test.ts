/**
 * 輪詢到的 Run，哪一個該把 WebSocket 接過去（§6.1、§9）。
 *
 * 這個檔案存在的理由是一個實測抓到的 bug：一顆 `* * * * *` 的 cron 正常跑完、
 * Discord 也真的收到訊息了，而編輯器上跳出**「執行失敗：事件連線中斷」**。
 *
 * 成因是兩件各自都對的事撞在一起：cron 的 Run 只有幾毫秒，而輪詢是 1.5 秒一
 * 次——所以問到它時它一定已經結束了；對結束的 Run 開 WebSocket，後端回 4404
 * （broker 早關了），而前端把「非正常關閉」翻成一句執行失敗。
 *
 * **兩邊都沒寫錯，中間那句話沒有人負責**（PROGRESS 第 5 條）。
 */
import { describe, expect, it } from 'vitest';
import { runToAttach, type RunSummary } from './runs';

function run(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'r_1',
    projectId: 'p',
    trigger: 'event.when_cron',
    status: 'running',
    startedAt: '2026-09-02T00:00:00.000Z',
    ...over,
  };
}

const HATS = ['event.when_cron'];

describe('哪一個 Run 該接（§9）', () => {
  it('還在跑的就接', () => {
    const r = run();
    expect(runToAttach([r], HATS, null)).toEqual({ attach: r, seen: 'r_1' });
  });

  it('已經跑完的**不接**，但要記下來', () => {
    // 記下來是為了不要每 1.5 秒重新判斷同一個 Run 一次。
    const r = run({ status: 'ok', endedAt: '2026-09-02T00:00:00.002Z' });
    expect(runToAttach([r], HATS, null)).toEqual({ attach: null, seen: 'r_1' });
  });

  it('同一個 Run 不會接第二次', () => {
    expect(runToAttach([run()], HATS, 'r_1')).toEqual({ attach: null, seen: 'r_1' });
  });

  it('不是這次接上的 hat 觸發的就不理', () => {
    // 手動執行有自己的 runId，前端本來就知道——這條路只為了「後端自己起的」
    // 那些存在。
    const r = run({ trigger: 'manual' });
    expect(runToAttach([r], HATS, null)).toEqual({ attach: null, seen: null });
  });

  it('一個都沒有時不動 lastSeen', () => {
    expect(runToAttach([], HATS, 'r_9')).toEqual({ attach: null, seen: 'r_9' });
  });

  it('只看最新的那一筆', () => {
    // `listRuns` 新的在前。舊的那些即使還掛著也不接——編輯器同時只顯示一個
    // Run（一個 socket、一份高亮）。
    const newest = run({ runId: 'r_2' });
    const older = run({ runId: 'r_1' });
    expect(runToAttach([newest, older], HATS, null).attach?.runId).toBe('r_2');
  });

  it('最新的跑完了就不接，即使前一筆還在跑', () => {
    const newest = run({ runId: 'r_2', status: 'ok', endedAt: 'x' });
    const older = run({ runId: 'r_1' });
    expect(runToAttach([newest, older], HATS, null)).toEqual({ attach: null, seen: 'r_2' });
  });
});

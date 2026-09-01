/**
 * 工具列那顆「監聽」按鈕該顯示什麼（§9.2）。
 *
 * 這個檔案存在的理由是一個真的 bug：**P2 把 active 搬進 SQLite 之後，畫面沒有
 * 跟著改成去問後端。** 開場的狀態是 `useState({ on: false })`，所以重新整理之後
 * 那顆按鈕會說「監聽」——而排程其實正在跑。一顆說謊的按鈕比沒有按鈕糟：使用者
 * 會以為沒開，然後去別的地方找為什麼沒觸發。
 *
 * P2 之前那樣寫是誠實的（監聽跟這個分頁同生共死），所以這不是「當初寫錯」，是
 * **一條規則變了而它的下游沒跟上**——這種東西只有把三個呼叫端收成一個純函數
 * 才守得住。
 */
import { describe, expect, it } from 'vitest';
import { NOT_LISTENING, listeningStateOf, type TriggerSummary } from './triggers';

function summary(over: Partial<TriggerSummary> = {}): TriggerSummary {
  return { projectId: 'p', active: true, hats: ['event.when_cron'], errors: [], ...over };
}

describe('監聽狀態（§9.2）', () => {
  it('後端說 active，按鈕就要顯示「正在監聽」', () => {
    expect(listeningStateOf(summary()).on).toBe(true);
  });

  it('後端說沒在跑，就是沒在跑', () => {
    expect(listeningStateOf(summary({ active: false })).on).toBe(false);
  });

  it('active 但畫布上沒有 hat 要說一句話', () => {
    // 空陣列不是失敗，是「這份畫布目前沒有東西要聽」。不說的話，按下去什麼
    // 都沒發生會被當成壞掉。
    expect(listeningStateOf(summary({ hats: [] })).message).toBe('畫布上沒有事件積木');
  });

  it('有 hat 就不要多話', () => {
    expect(listeningStateOf(summary()).message).toBeUndefined();
  });

  it('沒在跑的時候不說「沒有事件積木」', () => {
    // 那句話講的是「開著但沒東西聽」。關著的時候講它只會讓人以為開過了。
    expect(listeningStateOf(summary({ active: false, hats: [] })).message).toBeUndefined();
  });

  it('webhooks 沒給就是空的，不是 undefined', () => {
    // 面板拿它去 `.map()`。給 undefined 的話那裡要多一個 `?? []`，而少寫一次
    // 就是一個白畫面。
    expect(listeningStateOf(summary()).webhooks).toEqual([]);
  });

  it('NOT_LISTENING 是關著的樣子', () => {
    expect(NOT_LISTENING).toEqual({ on: false, hats: [], webhooks: [] });
  });
});

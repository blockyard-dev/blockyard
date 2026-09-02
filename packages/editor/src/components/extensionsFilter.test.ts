/**
 * 擴充功能面板的搜尋（D31）。
 */
import { describe, expect, it } from 'vitest';
import { matchesQuery } from './extensionsFilter';

const HTTP = { id: 'http', name: 'HTTP', description: '發 HTTP 請求、讀回應' };
const DEMO = { id: 'demo', name: '示範', description: null };

describe('搜尋比對三個欄位', () => {
  it('空字串是全部——搜尋框沒打東西時不該過濾掉任何一張卡', () => {
    expect(matchesQuery(HTTP, '')).toBe(true);
    expect(matchesQuery(HTTP, '   ')).toBe(true);
  });

  it('名字', () => {
    expect(matchesQuery(DEMO, '示範')).toBe(true);
  });

  it('id——畫面上不顯示它，但使用者手上多半就是那個字', () => {
    expect(matchesQuery(HTTP, 'htt')).toBe(true);
  });

  it('說明——「請求」找得到 HTTP 才是搜尋該做的事', () => {
    expect(matchesQuery(HTTP, '請求')).toBe(true);
  });

  it('不分大小寫', () => {
    expect(matchesQuery(HTTP, 'http')).toBe(true);
    expect(matchesQuery(HTTP, 'HTTP')).toBe(true);
  });

  it('沒有說明的包不會因此爆掉，也不會因此變成什麼都命中', () => {
    expect(matchesQuery(DEMO, '請求')).toBe(false);
  });

  it('對不上就是對不上——不做模糊比對', () => {
    // 「為什麼這個也算命中」在一個畫面裝得下的清單裡不值得換來任何東西。
    expect(matchesQuery(HTTP, 'htp')).toBe(false);
  });
});

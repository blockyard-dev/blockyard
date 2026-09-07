/**
 * 審閱畫面的規則（§12.1、P3 第 2 步）。
 */
import { describe, expect, it } from 'vitest';
import type { ExtensionDiff, ImportReview } from '../api/client';
import {
  changeWords,
  formatSize,
  summarize,
  updateVerdict,
} from './importRules';

function review(over: Partial<ImportReview> = {}): ImportReview {
  return {
    token: 't',
    id: 'greet',
    name: '打招呼',
    version: '0.1.0',
    author: null,
    description: null,
    origin: { origin: 'zip', label: 'greet.zip', url: null, ref: null, commit: null },
    editor: null,
    requirements: [],
    blocks: [],
    panels: [],
    config: [],
    urls: [],
    installed: null,
    ...over,
  };
}

describe('最上面那一句', () => {
  it('只講看得見的東西', () => {
    expect(
      summarize(
        review({
          blocks: [{ opcode: 'greet.hello', text: 'x' }],
          panels: [{ id: 'chart', name: '圖表' }],
          config: [{ key: 'token', label: null, type: 'secret', envVar: null }],
          requirements: ['httpx'],
        }),
      ),
    ).toBe('1 顆積木、1 格面板和1 項設定');
  });

  it('沒有面板與設定時不畫那兩段', () => {
    expect(summarize(review({ blocks: [{ opcode: 'a.b', text: 'x' }] }))).toBe('1 顆積木');
  });
});

describe('檔案大小', () => {
  it('讀得出量級就好，不是精確值', () => {
    expect(formatSize(12)).toBe('12 B');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(200_000)).toBe('195 KB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

/* ------------------------------------------------------------------ *
 * 更新那段差集（`docs/extension-design.md` §4）
 *
 * §4 那張表有兩欄，而它們住在兩邊：「這一版少了什麼」是後端算的，「而畫布上
 * 有幾顆」只有前端數得出來。這幾題守的是把兩欄合起來的那條規則。
 * ------------------------------------------------------------------ */

function diffOf(over: Partial<ExtensionDiff> = {}): ExtensionDiff {
  return {
    version: { from: '0.1.0', to: '0.2.0' },
    gone: [],
    changed: [],
    added: [],
    requirementsChanged: false,
    ...over,
  };
}

const GONE = { opcode: 'greet.hello', text: '說哈囉', why: 'missing' as const };

function changedOf(over: Partial<ExtensionDiff['changed'][number]> = {}) {
  return {
    opcode: 'greet.hello',
    text: '說哈囉',
    argsAdded: [],
    argsRemoved: [],
    argsRetyped: [],
    textChanged: false,
    nowDeprecated: false,
    ...over,
  };
}

describe('更新的差集怎麼分列', () => {
  it('少了一顆積木、而畫布上有 → 擋', () => {
    const v = updateVerdict(diffOf({ gone: [GONE] }), { 'greet.hello': 3 });
    expect(v.blocking).toEqual([GONE]);
    expect(v.quietGone).toEqual([]);
  });

  it('少了一顆積木、但沒人用到 → 只說一聲', () => {
    // **同一種變動，兩種下場。** 分列的依據是「誰會受影響」，不是「變動的
    // 種類」——所以這一題與上一題只差一個數字。
    const v = updateVerdict(diffOf({ gone: [GONE] }), { 'greet.hello': 0 });
    expect(v.blocking).toEqual([]);
    expect(v.quietGone).toEqual([GONE]);
  });

  it('參數變了、而畫布上有 → 警告，不擋', () => {
    const changed = changedOf({ argsAdded: [{ name: 'tone', required: true }] });
    const v = updateVerdict(diffOf({ changed: [changed] }), { 'greet.hello': 1 });
    expect(v.warning).toEqual([changed]);
    expect(v.blocking).toEqual([]);
  });

  it('數不到的 opcode 當作沒人用（往放行那一邊倒）', () => {
    // 擋是一件要有理由的事。「數不出來」不是理由——而使用者可能正是為了修那個
    // 包才要更新。
    expect(updateVerdict(diffOf({ gone: [GONE] }), {}).blocking).toEqual([]);
  });

  it('宣告完全沒變也仍然是一次更新', () => {
    const v = updateVerdict(diffOf(), {});
    expect(v.nothingDeclared).toBe(true);
  });

  it('依賴變動也應列在摘要', () => {
    const v = updateVerdict(diffOf({ requirementsChanged: true }), {});
    expect(v.nothingDeclared).toBe(false);
  });
});

describe('一顆積木變了什麼，寫成一句話', () => {
  it('必填與選填分開講', () => {
    // 多一格**必填**的會讓那幾顆積木多出填不了東西的空孔，而那份專案從此存不
    // 起來（§16 Q21）。多一格選填的只是多一個孔。
    const words = changeWords(
      changedOf({
        argsAdded: [
          { name: 'tone', required: true },
          { name: 'lang', required: false },
        ],
      }),
    );
    expect(words).toContain('多了必填的 tone');
    expect(words).toContain('多了 lang');
  });

  it('少了一格參數要說那幾格會被丟掉', () => {
    expect(changeWords(changedOf({ argsRemoved: ['who'] }))).toContain('那幾格會被丟掉');
  });

  it('換型別說得出從什麼變成什麼', () => {
    const words = changeWords(
      changedOf({ argsRetyped: [{ name: 'n', from: 'string', to: 'number' }] }),
    );
    expect(words).toBe('n 從 string 變成 number');
  });

  it('只有字變了才單獨提它', () => {
    expect(changeWords(changedOf({ textChanged: true }))).toBe('積木上的字換了');
    // 有別的變動時就不再重複——那是最不重要的一項，而它已經隱含在別的句子裡。
    expect(changeWords(changedOf({ textChanged: true, argsRemoved: ['who'] }))).not.toContain(
      '積木上的字換了',
    );
  });
});

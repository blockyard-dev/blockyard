/**
 * 審閱畫面的規則（§12.1、P3 第 2 步）。
 */
import { describe, expect, it } from 'vitest';
import type { ImportFinding, ImportReview } from '../api/client';
import {
  formatSize,
  looseFindings,
  mismatchedFindings,
  permissionLabel,
  permissionRows,
  summarize,
} from './importRules';

function finding(over: Partial<ImportFinding> = {}): ImportFinding {
  return { path: 'main.py', line: 1, message: 'x', permission: null, declared: true, ...over };
}

function review(over: Partial<ImportReview> = {}): ImportReview {
  return {
    token: 't',
    id: 'greet',
    name: '打招呼',
    version: '0.1.0',
    author: null,
    description: null,
    permissions: [],
    requirements: [],
    blocks: [],
    panels: [],
    config: [],
    urls: [],
    files: [],
    sources: [],
    omitted: [],
    findings: [],
    installed: null,
    ...over,
  };
}

describe('權限那張表：宣告與程式碼併成一列', () => {
  it('宣告了、也掃到了 —— 一列，兩邊都對得起來', () => {
    const rows = permissionRows(
      review({
        permissions: ['net'],
        findings: [finding({ permission: 'net', declared: true })],
      }),
    );
    expect(rows).toEqual([{ permission: 'net', label: '連上網路', declared: true, seen: 1 }]);
  });

  it('宣告了、但一行都沒掃到 —— 仍然是一列', () => {
    // 掃描一定漏報（`getattr(__builtins__, ...)`），所以 `seen: 0` 不代表
    // 「作者多宣告了」。這一列要在，因為它是使用者拿到的摘要。
    const rows = permissionRows(review({ permissions: ['env'] }));
    expect(rows).toEqual([{ permission: 'env', label: '讀環境變數', declared: true, seen: 0 }]);
  });

  it('掃到了、但沒宣告 —— 這是 §12.1 的「與宣告不符」，而且要排最前面', () => {
    const rows = permissionRows(
      review({
        permissions: ['env'],
        findings: [finding({ permission: 'net', declared: false })],
      }),
    );
    // 混在一份按字母排的清單裡就等於不存在——這一頁上唯一需要停下來想一秒的
    // 就是這一列。
    expect(rows.map((r) => r.permission)).toEqual(['net', 'env']);
    expect(rows[0]).toMatchObject({ declared: false, seen: 1 });
  });

  it('同一項掃到很多行就數起來', () => {
    const rows = permissionRows(
      review({
        findings: [
          finding({ permission: 'net', declared: false }),
          finding({ permission: 'net', declared: false, line: 9 }),
        ],
      }),
    );
    expect(rows[0]?.seen).toBe(2);
  });

  it('認不得的權限原樣顯示，不是空白', () => {
    expect(permissionLabel('usb')).toBe('usb');
  });
});

describe('不對應任何權限的那幾條', () => {
  const r = review({
    findings: [
      finding({ message: "eval()：會把字串當程式碼跑" }),
      finding({ permission: 'net', declared: false, message: 'import httpx' }),
    ],
  });

  it('`eval` 只是說一聲，不進權限表的「不符」', () => {
    // 沒有一種宣告能讓 `eval` 變成相符，所以它永遠標紅只會讓那個標記失去意思。
    expect(looseFindings(r).map((f) => f.message)).toEqual(['eval()：會把字串當程式碼跑']);
  });

  it('「不符」數的是有權限、卻沒宣告的那幾條', () => {
    expect(mismatchedFindings(r)).toHaveLength(1);
  });
});

describe('最上面那一句', () => {
  it('只講看得見的東西', () => {
    expect(
      summarize(
        review({
          blocks: [{ opcode: 'greet.hello', text: 'x' }],
          panels: [{ id: 'chart', title: '圖表' }],
          config: [{ key: 'token', label: null, type: 'secret', envVar: null }],
          requirements: ['httpx'],
        }),
      ),
    ).toBe('1 顆積木、1 格面板、1 項設定');
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

/**
 * `ir/highlight.ts` 的行為（§4.7、§4.7b、§8.5）。
 *
 * 三組：
 *
 * 1. **與後端同一句話**——測資是 `backend/tests/fixtures/field_messages.yaml`，
 *    後端的 `test_editor_mirror.py` 讀的是**同一個檔案**。前端在欄位裡畫的
 *    紅線與後端存檔時回的 422 必須是同一句，不然使用者會以為那是兩個問題。
 *    這與 `roundtrip.test.ts` 直接讀後端的 `builtins/*.yaml` 是同一個理由：
 *    複製一份出來的測資，會在漂移的那天繼續綠著。
 *
 * 2. **run 的切法**——渲染與重新命名都吃它，所以 pill 畫到哪、換字換到哪，
 *    是同一份答案。
 *
 * 3. **與存檔契約一致**——`ir/template.ts` 那兩個函式是刻意獨立的最小實作
 *    （存檔的正確性不該依賴顯示層的錯誤復原），這裡釘住兩者對合法輸入的
 *    結論相同。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  analyze,
  analyzeExpression,
  analyzeTemplate,
  referencedRoots,
  renameRoot,
  type AnalyzeOptions,
} from './highlight';
import { hasInterpolation, isWholeTemplate } from './template';

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../backend/tests/fixtures/field_messages.yaml',
);

interface Case {
  value: string;
  error?: string;
  roots?: string[];
  whole?: boolean;
}

const cases = parseYaml(readFileSync(FIXTURE, 'utf8')) as Record<string, Case[]>;

const TEXT: AnalyzeOptions = { mode: 'text', interpolate: true };
const EXPR: AnalyzeOptions = { mode: 'expression', interpolate: true };
const NAME: AnalyzeOptions = { mode: 'variable', interpolate: false };

describe('與後端同一句話', () => {
  describe('${} 插值', () => {
    for (const c of cases.template ?? []) {
      it(`${JSON.stringify(c.value)}`, () => {
        const result = analyzeTemplate(c.value);
        expect(result.error).toBe(c.error ?? null);
        if (c.error) return;
        expect(result.whole).toBe(c.whole ?? false);
        if (c.roots) expect(referencedRoots(c.value, TEXT).sort()).toEqual([...c.roots].sort());
      });
    }
  });

  describe('運算式', () => {
    for (const c of cases.expression ?? []) {
      it(`${JSON.stringify(c.value)}`, () => {
        const result = analyzeExpression(c.value);
        expect(result.error).toBe(c.error ?? null);
        if (c.error) return;
        if (c.roots) expect(referencedRoots(c.value, EXPR).sort()).toEqual([...c.roots].sort());
      });
    }
  });

  describe('變數名稱', () => {
    for (const c of cases.variable ?? []) {
      it(`${JSON.stringify(c.value)}`, () => {
        expect(analyze(c.value, NAME).error).toBe(c.error ?? null);
      });
    }
  });
});

describe('run 的切法', () => {
  const kinds = (value: string, opts: AnalyzeOptions) =>
    analyze(value, opts).runs.map((r) => `${r.kind}:${value.slice(r.start, r.end)}`);

  it('純文字是一段', () => {
    expect(kinds('abc', TEXT)).toEqual(['text:abc']);
  });

  it('插值前後的文字各自成段', () => {
    expect(kinds('嗨 ${name}，你好', TEXT)).toEqual(['text:嗨 ', 'ref:${name}', 'text:，你好']);
  });

  it('連續兩個插值中間沒有空的文字段', () => {
    expect(kinds('${a}${b}', TEXT)).toEqual(['ref:${a}', 'ref:${b}']);
  });

  it('$${ 逸出整段都是文字', () => {
    expect(kinds('$${a}', TEXT)).toEqual(['text:$${a}']);
  });

  it('錯誤只吃掉那一段插值，前面的文字照畫', () => {
    expect(kinds('a ${b} c ${d+e}', TEXT)).toEqual([
      'text:a ',
      'ref:${b}',
      'text: c ',
      'error:${d+e}',
    ]);
  });

  it('沒有關的 ${ 一路標到字串尾', () => {
    expect(kinds('x ${y', TEXT)).toEqual(['text:x ', 'error:${y']);
  });

  it('運算式裡的路徑是 pill，其餘是文字', () => {
    expect(kinds('${a} * 2', EXPR)).toEqual(['ref:${a}', 'text: * 2']);
  });

  it('運算式的語法錯誤標在出事的那個 token 上', () => {
    // 「多了東西」指的是 `)`，不是整格——紅線要指得到位置
    expect(kinds('1 + 2)', EXPR)).toEqual(['text:1 + 2', 'error:)']);
  });

  it('interpolate 關掉的欄位（code）整格都是文字', () => {
    const opts: AnalyzeOptions = { mode: 'text', interpolate: false };
    expect(kinds('echo ${HOME}', opts)).toEqual(['text:echo ${HOME}']);
    expect(analyze('echo ${HOME}', opts).error).toBeNull();
  });

  it('變數名稱整格是一顆 pill', () => {
    expect(kinds('計數', NAME)).toEqual(['ref:計數']);
  });

  it('ref 帶得出 root 在原字串上的位置', () => {
    const [run] = analyzeTemplate('${ resp.items[1] }').runs;
    expect(run?.root).toBe('resp');
    expect('${ resp.items[1] }'.slice(run!.rootStart, run!.rootEnd)).toBe('resp');
  });
});

describe('重新命名（§4.5）', () => {
  it('只換 root，路徑其餘部分不動', () => {
    expect(renameRoot('${舊.items[1].title}', '舊', '新', TEXT)).toBe('${新.items[1].title}');
  });

  it('一格裡的多個引用一起換', () => {
    expect(renameRoot('${a} 與 ${a.b}', 'a', 'c', TEXT)).toBe('${c} 與 ${c.b}');
  });

  it('名字只是前綴的不換', () => {
    expect(renameRoot('${ab}', 'a', 'c', TEXT)).toBe('${ab}');
  });

  it('空白保留原樣', () => {
    expect(renameRoot('${ a . b }', 'a', 'z', TEXT)).toBe('${ z . b }');
  });

  it('運算式與插值走同一條路', () => {
    expect(renameRoot('${a}*2+${a}', 'a', 'b', EXPR)).toBe('${b}*2+${b}');
  });

  it('變數名稱欄位整格換', () => {
    expect(renameRoot('a', 'a', 'b', NAME)).toBe('b');
    expect(renameRoot('aa', 'a', 'b', NAME)).toBe('aa');
  });

  it('壞掉的插值不會被換（它根本不是引用）', () => {
    expect(renameRoot('${a+b}', 'a', 'c', TEXT)).toBe('${a+b}');
  });
});

describe('與存檔契約（ir/template.ts）一致', () => {
  // 存檔那兩個函式是刻意分開的最小實作。這裡不要求它們共用程式碼，只要求
  // 對**合法**輸入結論相同——不合法的那些後端會以 422 擋下，存出去的形狀
  // 不影響任何人。
  const legal = (cases.template ?? []).filter((c) => !c.error).map((c) => c.value);

  for (const value of legal) {
    it(`${JSON.stringify(value)}`, () => {
      const result = analyzeTemplate(value);
      expect(isWholeTemplate(value)).toBe(result.whole);
      expect(hasInterpolation(value)).toBe(result.runs.some((r) => r.kind === 'ref'));
    });
  }
});

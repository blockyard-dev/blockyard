/**
 * `${}` 插值與運算式的**顯示層**分析（§4.7、§4.7b、§8.5）。
 *
 * `FieldText` 要在使用者打字的當下就畫出 pill、把不合法的地方畫紅線、把原因
 * 寫進 warning icon。那需要一份**不會丟例外**的解析結果：後端的
 * `template.py` / `expression.py` 遇到第一個錯誤就 raise，而畫面上「錯誤之前
 * 那幾段」仍然要畫得出來。
 *
 * 三條界線，寫在最前面免得這個檔案慢慢長成第二套語意：
 *
 * 1. **這裡不是規格，後端才是。** 存檔仍然由 `PUT /api/projects` 的 422 擋
 *    （`ir/schema.py::load`），紅線只是提早說。兩邊不一致時以後端為準，這裡
 *    是 bug。
 * 2. **錯誤訊息一字不差地抄後端。** 使用者不該在欄位裡看到一句話、按存檔
 *    看到另一句話。`backend/tests/unit/test_editor_mirror.py` 直接讀這個檔案
 *    比對那些字串，抄漏了會有人叫。
 * 3. **存檔路徑不吃這裡。** `ir/template.ts` 的 `hasInterpolation` /
 *    `isWholeTemplate` 是存檔契約（決定 IR 的 kind 與 whole），刻意留成獨立
 *    的最小實作——存檔的正確性不該依賴顯示層的錯誤復原。兩者由
 *    `highlight.test.ts` 的交叉測試釘住。
 *
 * 回傳的是 **run 序列**：把原字串切成「純文字 / 一段 `${路徑}` / 一段錯誤」，
 * 每一段都帶原字串上的區間。渲染照著畫，重新命名照著換字元——兩件事共用同
 * 一份切法，所以「畫成 pill 的那一段」與「重新命名會動到的那一段」不可能
 * 對不齊。
 */

/** 一段 run 的身分。`ref` 畫成 pill，`error` 畫紅線，`text` 就是文字。 */
export type RunKind = 'text' | 'ref' | 'error';

export interface Run {
  kind: RunKind;
  /** 在原字串上的區間，含頭不含尾。 */
  start: number;
  end: number;
  /** `kind === 'error'`：原因，與後端同一句話。 */
  message?: string;
  /** `kind === 'ref'`：根變數名，以及它在原字串上的區間（重新命名靠它）。 */
  root?: string;
  rootStart?: number;
  rootEnd?: number;
}

export interface Analysis {
  runs: Run[];
  /** 第一個錯誤的訊息，沒有錯誤時是 `null`。warning icon 吃它。 */
  error: string | null;
  /** §4.7 的整格取值：恰好一段插值、沒有其他文字。 */
  whole: boolean;
}

/** `FieldText` 的三種模式，見 `fields/FieldText.ts` 的 `FieldTextOptions`。 */
export type AnalyzeMode = 'text' | 'variable' | 'expression';

export interface AnalyzeOptions {
  mode: AnalyzeMode;
  /** 這一格的 `${}` 要不要當插值（manifest 的 `interpolate`，`code` 預設關）。 */
  interpolate: boolean;
}

/**
 * 出現在 `${}` 的**名稱**片段裡即判定為運算式的字元（D9 的防線）。
 *
 * 與 `blockyard/ir/template.py::_EXPRESSION_CHARS` 逐字元相同。`[...]` 的內容
 * 不走這條檢查——那裡由索引規則自己擋，所以 `items[-1]` 的負號不會被誤判
 * 成減法。
 */
const EXPRESSION_CHARS = '+-*/%=<>!&|?:(),~^"\'`';

/** 變數名稱唯一禁掉的字元（`template.py::NAME_FORBIDDEN`）。 */
export const NAME_FORBIDDEN = '.[]{}$';

/** 運算式的數字常值。刻意不收 `1e3`，與 `expression.py::_NUMBER_RE` 相同。 */
const NUMBER_RE = /\d+(?:\.\d+)?/y;

const INDEX_RE = /^-?\d+$/;

const ADD_OPS = '+-';
const MUL_OPS = '*/%';

/** 錯誤訊息裡列給使用者看的東西，與 `expression.py::_ALLOWED` 同步。 */
const ALLOWED = '數字、${變數}、+ - * / % 與括號';

// --------------------------------------------------------------------------
// 入口
// --------------------------------------------------------------------------

export function analyze(value: string, opts: AnalyzeOptions): Analysis {
  if (opts.mode === 'expression') return analyzeExpression(value);
  if (opts.mode === 'variable') return analyzeVariableName(value);
  if (!opts.interpolate) return plain(value);
  return analyzeTemplate(value);
}

/** 整格都是普通文字（`interpolate: false` 的 `code` 欄位）。 */
function plain(value: string): Analysis {
  return { runs: value ? [{ kind: 'text', start: 0, end: value.length }] : [], error: null, whole: false };
}

// --------------------------------------------------------------------------
// 插值（§4.7）——`template.py::parse` 的不丟例外版本
// --------------------------------------------------------------------------

export function analyzeTemplate(value: string): Analysis {
  const runs: Run[] = [];
  let error: string | null = null;
  let i = 0;
  let textStart = 0;

  const flush = (end: number) => {
    if (end > textStart) runs.push({ kind: 'text', start: textStart, end });
  };

  while (i < value.length) {
    if (value[i] !== '$') {
      i++;
      continue;
    }
    // `$${` 是逸出，輸出字面的 `${`——它整段都是文字。
    if (value.startsWith('$${', i)) {
      i += 3;
      continue;
    }
    if (!value.startsWith('${', i)) {
      i += 1;
      continue;
    }

    const close = value.indexOf('}', i + 2);
    if (close === -1) {
      flush(i);
      const message = '「${」沒有對應的「}」';
      runs.push({ kind: 'error', start: i, end: value.length, message });
      error ??= message;
      textStart = value.length;
      i = value.length;
      break;
    }

    flush(i);
    runs.push(pathRun(value, i, close + 1));
    error ??= runs[runs.length - 1]!.message ?? null;
    i = close + 1;
    textStart = i;
  }

  flush(value.length);

  // `whole` 的定義與後端相同：整串只有一段，而且那一段是插值。這裡順帶要求
  // 它沒有錯誤——一段畫著紅線的插值不該被當成「整格取值」畫上底色。
  const whole = runs.length === 1 && runs[0]!.kind === 'ref';
  return { runs, error, whole };
}

/**
 * `${…}`（含大括號）的一段 → 一個 run。
 *
 * 逐條對應 `template.py::parse_path`：先 trim、再 tokenize、再跑 D9 的名稱
 * 檢查、最後取 root。任何一步不過就退化成 `error` run，而不是丟例外。
 */
function pathRun(value: string, start: number, end: number): Run {
  const innerStart = start + 2;
  const inner = value.slice(innerStart, end - 1);
  const lead = inner.length - inner.trimStart().length;
  const raw = inner.trim();
  const at = (offset: number) => innerStart + lead + offset;

  if (raw === '') return { kind: 'error', start, end, message: '「${}」是空的' };

  const tokens = tokenizePath(raw);
  if ('message' in tokens) return { kind: 'error', start, end, message: tokens.message };

  // --- D9 的防線：只檢查「名稱」片段 ---
  for (const tok of tokens.parts) {
    if (typeof tok.value !== 'string') continue;
    const bad = [...new Set([...tok.value].filter((c) => EXPRESSION_CHARS.includes(c)))].sort();
    if (bad.length > 0) {
      return {
        kind: 'error',
        start,
        end,
        message: `「\${}」內不支援運算（出現了 ${bad.join(' ')}），請改用「運算」積木`,
      };
    }
  }

  const root = tokens.parts[0];
  if (root === undefined || typeof root.value !== 'string') {
    return { kind: 'error', start, end, message: '「${}」必須以變數名稱開頭' };
  }
  if (root.value === '') {
    return { kind: 'error', start, end, message: '「${}」內的變數名稱是空的' };
  }

  return {
    kind: 'ref',
    start,
    end,
    root: root.value,
    rootStart: at(root.start),
    rootEnd: at(root.end),
  };
}

interface PathPart {
  /** `string` 是 object key（來自 `.`），`number` 是 list 索引（來自 `[]`）。 */
  value: string | number;
  /** 在 trim 過的 `raw` 上的區間，只有名稱片段用得到。 */
  start: number;
  end: number;
}

/**
 * `resp.items[1].title` → `['resp', 'items', 1, 'title']`。
 *
 * 與 `template.py::_tokenize_path` 相同，多回一份區間——重新命名要知道 root
 * 的那幾個字元在哪裡。
 */
function tokenizePath(raw: string): { parts: PathPart[] } | { message: string } {
  const parts: PathPart[] = [];
  let buf = '';
  let bufStart = 0;
  let i = 0;

  const flushName = () => {
    const lead = buf.length - buf.trimStart().length;
    const name = buf.trim();
    parts.push({ value: name, start: bufStart + lead, end: bufStart + lead + name.length });
    buf = '';
  };

  while (i < raw.length) {
    const c = raw[i]!;
    if (c === '.') {
      flushName();
      i += 1;
      bufStart = i;
    } else if (c === '[') {
      flushName();
      const close = raw.indexOf(']', i);
      if (close === -1) return { message: '「[」沒有對應的「]」' };
      const token = raw.slice(i + 1, close).trim();
      const index = parseIndex(token);
      if (index === null) {
        return { message: `「[]」內只能是整數或 last，收到 "${token}"` };
      }
      parts.push({ value: index, start: i, end: close + 1 });
      i = close + 1;
      // `[1].title` 的 `.` 由上面的分支處理；`[1][2]` 也可以
      if (i < raw.length && raw[i] === '.') i += 1;
      bufStart = i;
    } else if (c === ']') {
      return { message: '多餘的「]」' };
    } else {
      if (buf === '') bufStart = i;
      buf += c;
      i += 1;
    }
  }

  if (buf !== '' || parts.length === 0) flushName();

  // 去掉因 `a.` 或 `a[1]` 結尾產生的空片段
  const kept = parts.filter((p) => p.value !== '');
  return { parts: kept.length > 0 ? kept : [{ value: '', start: 0, end: 0 }] };
}

/** `[...]` 內只接受整數與 `last`；`last` desugar 成 -1。 */
function parseIndex(token: string): number | null {
  if (token === 'last') return -1;
  return INDEX_RE.test(token) ? Number(token) : null;
}

// --------------------------------------------------------------------------
// 變數名稱（§4.5、§8.5）
// --------------------------------------------------------------------------

/**
 * 變數名稱欄位。整格就是一個名字，所以它畫成一顆 pill——與 `${}` 裡的那顆
 * 長一樣，這正是「這兩個地方講的是同一個東西」最省字的說法。
 *
 * 空名稱給錯誤：§8.5 說「空的變數名稱欄位很難發現」，而 autocomplete 只在
 * 使用者點進去之後才幫得上忙。
 */
function analyzeVariableName(value: string): Analysis {
  // 檢查的順序與 `template.py::validate_name` 相同：先空白、再空字串、
  // 最後禁用字元。順序換了，`" "` 會拿到另一句話。
  if (value !== value.trim()) {
    const message = `變數名稱前後不能有空白："${value}"`;
    return { runs: [{ kind: 'error', start: 0, end: value.length, message }], error: message, whole: false };
  }
  if (value === '') {
    return { runs: [], error: '變數名稱不能是空的', whole: false };
  }
  const bad = [...new Set([...value].filter((c) => NAME_FORBIDDEN.includes(c)))].sort();
  if (bad.length > 0) {
    // 走得到這裡代表 `FieldText.doClassValidation_` 的過濾被繞過了（程式設值、
    // 或載入一份手寫的 IR）。畫紅線而不是默默吃掉：欄位裡看得見的字元與存出去
    // 的值不一樣才是真正查不出來的那種 bug。
    const message = `變數名稱不能包含 ${bad.join(' ')}："${value}"`;
    return {
      runs: [{ kind: 'error', start: 0, end: value.length, message }],
      error: message,
      whole: false,
    };
  }
  return {
    runs: [{ kind: 'ref', start: 0, end: value.length, root: value, rootStart: 0, rootEnd: value.length }],
    error: null,
    whole: false,
  };
}

// --------------------------------------------------------------------------
// 運算式（§4.7b）——`expression.py` 的不丟例外版本
// --------------------------------------------------------------------------

interface ExprToken {
  kind: 'num' | 'ref' | 'op' | '(' | ')';
  /** 錯誤訊息裡印出來的東西（`運算式在「+」之後多了東西`）。 */
  text: string;
  start: number;
  end: number;
  run?: Run;
}

export function analyzeExpression(value: string): Analysis {
  const lexed = tokenizeExpression(value);
  const runs = buildExpressionRuns(value, lexed.tokens, lexed.error);

  if (lexed.error) {
    return { runs: merge(runs), error: lexed.error.message, whole: false };
  }

  const parsed = parseExpression(lexed.tokens, value);
  if (!parsed) return { runs: merge(runs), error: null, whole: false };

  // 語法錯誤標在出事的那個 token 上（走到字串尾就標最後一段），這樣紅線指得
  // 到「少了東西」的位置而不是整格。
  markError(runs, parsed.start, parsed.end, parsed.message);
  return { runs: merge(runs), error: parsed.message, whole: false };
}

interface LexError {
  message: string;
  start: number;
  end: number;
}

function tokenizeExpression(s: string): { tokens: ExprToken[]; error: LexError | null } {
  const tokens: ExprToken[] = [];
  let i = 0;

  while (i < s.length) {
    const c = s[i]!;

    if (/\s/.test(c)) {
      i += 1;
      continue;
    }

    if (c === '$') {
      // `${` 之外的 `$` 沒有意義。字串欄位裡它是字面值，這裡不是字串。
      if (!s.startsWith('${', i)) {
        return { tokens, error: { message: '運算式裡的變數要寫成 ${名稱}', start: i, end: i + 1 } };
      }
      const close = s.indexOf('}', i + 2);
      if (close === -1) {
        return { tokens, error: { message: '「${」沒有對應的「}」', start: i, end: s.length } };
      }
      // 路徑的解析與 §4.7 共用，連 `${a+b}` 的錯誤訊息都是同一句
      const run = pathRun(s, i, close + 1);
      if (run.kind === 'error') {
        return { tokens, error: { message: run.message!, start: i, end: close + 1 } };
      }
      tokens.push({ kind: 'ref', text: s.slice(i, close + 1), start: i, end: close + 1, run });
      i = close + 1;
      continue;
    }

    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(s);
    if (m) {
      tokens.push({ kind: 'num', text: m[0], start: i, end: i + m[0].length });
      i += m[0].length;
      continue;
    }

    if (ADD_OPS.includes(c) || MUL_OPS.includes(c)) {
      tokens.push({ kind: 'op', text: c, start: i, end: i + 1 });
      i += 1;
      continue;
    }

    if (c === '(' || c === ')') {
      tokens.push({ kind: c, text: c, start: i, end: i + 1 });
      i += 1;
      continue;
    }

    // 文法裡沒有的東西——比較、函式呼叫、字串常值全部在此止步。字母另給一句：
    // `max(a, b)` 與 `a * 2` 是使用者最常試的兩種寫法。
    const message = /[A-Za-z_]/.test(c)
      ? '運算式裡不能呼叫函式；變數要寫成 ${名稱}'
      : `運算式裡不能用「${c}」，只能有${ALLOWED}`;
    return { tokens, error: { message, start: i, end: i + 1 } };
  }

  return { tokens, error: null };
}

/**
 * token 序列 → run 序列。token 之間的空白補成 `text`，`ref` 保留自己那顆
 * pill，tokenizer 的錯誤標在出事的那幾個字元上。
 */
function buildExpressionRuns(value: string, tokens: ExprToken[], error: LexError | null): Run[] {
  const runs: Run[] = [];
  let cursor = 0;

  const gap = (upto: number) => {
    if (upto > cursor) runs.push({ kind: 'text', start: cursor, end: upto });
    cursor = Math.max(cursor, upto);
  };

  for (const t of tokens) {
    gap(t.start);
    runs.push(t.run ?? { kind: 'text', start: t.start, end: t.end });
    cursor = t.end;
  }

  if (error) {
    gap(error.start);
    runs.push({ kind: 'error', start: error.start, end: error.end, message: error.message });
    cursor = error.end;
  }
  gap(value.length);
  // **這裡不併**：`markError` 要能只把出事的那一個 token 標紅（`1 + 2)` 的
  // 紅線該在 `)` 上，不是整格）。併是最後一步，見 `analyzeExpression`。
  return runs;
}

/**
 * 相鄰、同類、同訊息的 run 併成一段。
 *
 * 運算式是一個 token 一個 run，不併的話 `* 2` 會被切成四顆 `<text>`——字距
 * 會在每個切點斷掉，而那是「等寬字讓括號對得起來」想要的相反效果。`ref` 永遠
 * 不併：一顆 pill 就是一顆。
 */
function merge(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (
      last &&
      last.kind === run.kind &&
      last.kind !== 'ref' &&
      last.message === run.message &&
      last.end === run.start
    ) {
      out[out.length - 1] = { ...last, end: run.end };
      continue;
    }
    out.push(run);
  }
  return out;
}

/** 把 `[start, end)` 這一段的 run 改標成錯誤。 */
function markError(runs: Run[], start: number, end: number, message: string): void {
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    if (run.end <= start || run.start >= end) continue;
    runs[i] = { ...run, kind: 'error', message };
  }
}

interface ParseError {
  message: string;
  start: number;
  end: number;
}

/**
 * 遞迴下降，優先序由 expr → term → unary → primary 表達（`expression.py` 的
 * `_Parser`）。回 `null` 代表沒有語法錯誤——這裡不需要 AST，只需要知道哪裡壞了。
 */
function parseExpression(tokens: ExprToken[], source: string): ParseError | null {
  let i = 0;
  const peek = () => tokens[i];
  const tail = (): { start: number; end: number } => {
    const last = tokens[tokens.length - 1];
    return last ? { start: last.start, end: last.end } : { start: 0, end: source.length };
  };
  const fail = (message: string, at?: ExprToken): ParseError => ({ message, ...(at ?? tail()) });

  if (tokens.length === 0) {
    return { message: '運算式是空的', start: 0, end: source.length };
  }

  let failure: ParseError | null = null;
  const bail = (e: ParseError) => {
    failure ??= e;
    return e;
  };

  const primary = (): void => {
    const t = peek();
    if (t === undefined) {
      bail(fail('運算式在這裡就結束了，少了一個數字或變數'));
      return;
    }
    i += 1;
    if (t.kind === 'num' || t.kind === 'ref') return;
    if (t.kind === '(') {
      expr();
      if (failure) return;
      const next = peek();
      if (next === undefined || next.kind !== ')') {
        bail(fail('「(」沒有對應的「)」', t));
        return;
      }
      i += 1;
      return;
    }
    if (t.kind === ')') {
      bail(fail('多餘的「)」', t));
      return;
    }
    bail(fail(`這裡應該是數字或變數，卻是「${t.text}」`, t));
  };

  const unary = (): void => {
    const t = peek();
    if (t !== undefined && t.kind === 'op' && ADD_OPS.includes(t.text)) {
      i += 1;
      unary();
      return;
    }
    primary();
  };

  const term = (): void => {
    unary();
    while (!failure) {
      const t = peek();
      if (t === undefined || t.kind !== 'op' || !MUL_OPS.includes(t.text)) break;
      i += 1;
      unary();
    }
  };

  const expr = (): void => {
    term();
    while (!failure) {
      const t = peek();
      if (t === undefined || t.kind !== 'op' || !ADD_OPS.includes(t.text)) break;
      i += 1;
      term();
    }
  };

  expr();
  if (failure) return failure;

  const rest = peek();
  if (rest !== undefined) return fail(`運算式在「${rest.text}」之後多了東西`, rest);
  return null;
}

// --------------------------------------------------------------------------
// 重新命名（§4.5、§8.5 的右鍵選單）
// --------------------------------------------------------------------------

/**
 * 把這一格裡所有 root 是 `from` 的引用換成 `to`，回傳新字串。
 *
 * 只動 root，不動路徑其餘部分——`${舊名.items[1]}` 換成 `${新名.items[1]}`。
 * 換不到就原樣回傳，呼叫端靠「值有沒有變」決定要不要寫回去（少一次 Blockly
 * 事件）。
 */
export function renameRoot(
  value: string,
  from: string,
  to: string,
  opts: AnalyzeOptions,
): string {
  const { runs } = analyze(value, opts);
  let out = '';
  let cursor = 0;
  for (const run of runs) {
    if (run.kind !== 'ref' || run.root !== from || run.rootStart === undefined) continue;
    out += value.slice(cursor, run.rootStart) + to;
    cursor = run.rootEnd!;
  }
  return out + value.slice(cursor);
}

/** 這一格引用到的變數名（去重、保持出現順序）。 */
export function referencedRoots(value: string, opts: AnalyzeOptions): string[] {
  const seen = new Set<string>();
  for (const run of analyze(value, opts).runs) {
    if (run.kind === 'ref' && run.root) seen.add(run.root);
  }
  return [...seen];
}

/**
 * 「創建積木」對話框正在編輯的那份簽章（§4.6、§8.5、D26）。
 *
 * IR 把簽章存成一份**模板**（`name: "跳 %(a1) 次 到 %(a2)"`）加一份參數列，
 * 而對話框要編輯的是「一句話裡的一段一段」。兩種形狀對同一件事：
 *
 * ```
 * name:   "跳 %(a1) 次 到 %(a2)"        segments: [跳][a1][次 到][a2]
 * params: [a1 次數][a2 方向]
 * ```
 *
 * 這個檔案就是那個轉換，**而且不認識 Blockly**——版面編輯（加一格、刪一格、
 * 換型別）全部是純函數，所以「刪掉中間那個參數之後簽章長什麼樣」這種問題，
 * 測試裡問得到，不必先開一個工作區。
 *
 * 分段是編輯期的形狀，**不是 IR 的形狀**：存出去的仍然是 `name` + `params`
 * （D26：不加 IR 欄位）。
 */
import type { ProcParam, Procedure, Returns } from '../types/project';
import { validateName } from '../blockly/fields/FieldText';
import { PLACEHOLDER, hasSignatureTemplate } from '../blockly/signature';

/** 參數的型別。只影響孔的形狀與靜態檢查的嚴格度，不影響執行（§8.5）。 */
export type ParamType = 'any' | 'number' | 'string' | 'boolean' | 'list' | 'object';

export type Segment =
  | { kind: 'label'; text: string }
  | { kind: 'param'; id: string; name: string; type: ParamType };

export interface Draft {
  segments: Segment[];
  /** `null` = 沒有回傳值，呼叫積木是 command 形狀（§4.6）。 */
  returns: Returns;
}

/**
 * 新函式的起點：一段名字加一個參數，與 Scratch 的 modal 打開時一樣。
 *
 * 預設文字是**真的值**而不是 placeholder：空欄位在積木上只畫得出一個很窄的
 * 白格子，看不出「這裡要打字」；一段選得起來的文字自己就說了。
 */
export function blankDraft(): Draft {
  return {
    segments: [
      { kind: 'label', text: '積木名稱' },
      { kind: 'param', id: 'a1', name: 'input', type: 'any' },
    ],
    returns: null,
  };
}

/**
 * IR → 分段。
 *
 * **沒有佔位符的簽章是相容模式**（D26），不是壞資料：AI 生成的 IR（D5）多半
 * 長那樣。那時候版面由 `params` 的順序決定，於是還原成「名字 + 依序排開的
 * 參數」——使用者一旦在對話框裡按下確定，它就升級成一份模板，而那是一次
 * 明確的編輯，不是偷偷改寫。
 */
export function fromProcedure(proc: Procedure): Draft {
  const params = proc.params ?? [];
  const returns = proc.returns ?? null;
  const byId = new Map(params.map((p) => [p.id, p]));

  if (!hasSignatureTemplate(proc.name)) {
    return {
      segments: [
        { kind: 'label', text: proc.name },
        ...params.map(toSegment),
      ],
      returns,
    };
  }

  const segments: Segment[] = [];
  let at = 0;
  for (const match of proc.name.matchAll(PLACEHOLDER)) {
    const text = proc.name.slice(at, match.index).trim();
    if (text) segments.push({ kind: 'label', text });
    const param = byId.get(match[1] ?? '');
    // 引用不存在的參數在後端是存檔期錯誤（§4.6），這裡不可能拿到——真的拿到
    // 就把那段當字面文字留著，比默默吞掉一段簽章好查。
    segments.push(param ? toSegment(param) : { kind: 'label', text: match[0] });
    at = (match.index ?? 0) + match[0].length;
  }
  const tail = proc.name.slice(at).trim();
  if (tail) segments.push({ kind: 'label', text: tail });

  // 模板沒引用到的參數在後端也是存檔期錯誤，同樣採取「留著」而不是丟掉：
  // 使用者的參數不會因為打開一次對話框就消失。
  const used = new Set(segments.filter(isParam).map((s) => s.id));
  segments.push(...params.filter((p) => !used.has(p.id)).map(toSegment));

  return { segments, returns };
}

function toSegment(param: ProcParam): Segment {
  return {
    kind: 'param',
    id: param.id,
    name: param.name,
    type: (param.type ?? 'any') as ParamType,
  };
}

/** 分段 → IR。段與段之間補一個空格，不然 `跳%(a1)次` 會黏成一團。 */
export function toProcedure(draft: Draft): Pick<Procedure, 'name' | 'params' | 'returns'> {
  const name = draft.segments
    .map((s) => (s.kind === 'label' ? s.text.trim() : `%(${s.id})`))
    .filter((s) => s !== '')
    .join(' ');

  return {
    name,
    params: draft.segments.filter(isParam).map((s) => ({ id: s.id, name: s.name, type: s.type })),
    returns: draft.returns,
  };
}

export function isParam(segment: Segment): segment is Extract<Segment, { kind: 'param' }> {
  return segment.kind === 'param';
}

/** 沒被用過的參數 id。`%(a1)` 的 `a1` 要走得過 `\w+`，所以不能拿名稱當 id。 */
export function nextParamId(draft: Draft): string {
  const taken = new Set(draft.segments.filter(isParam).map((s) => s.id));
  for (let i = 1; ; i++) {
    const id = `a${i}`;
    if (!taken.has(id)) return id;
  }
}

export function addParam(draft: Draft, type: ParamType): Draft {
  const id = nextParamId(draft);
  const used = draft.segments.filter(isParam).length;
  return {
    ...draft,
    segments: [...draft.segments, { kind: 'param', id, name: defaultParamName(used), type }],
  };
}

/** Scratch 的預設名字就是 `input`；第二顆之後補號碼，不然兩格會同名。 */
function defaultParamName(used: number): string {
  return used === 0 ? 'input' : `input${used + 1}`;
}

export function addLabel(draft: Draft): Draft {
  return { ...draft, segments: [...draft.segments, { kind: 'label', text: '說明文字' }] };
}

export function removeSegment(draft: Draft, index: number): Draft {
  return { ...draft, segments: draft.segments.filter((_, i) => i !== index) };
}

export function setSegmentType(draft: Draft, index: number, type: ParamType): Draft {
  return {
    ...draft,
    segments: draft.segments.map((s, i) => (i === index && isParam(s) ? { ...s, type } : s)),
  };
}

/**
 * 把使用者在預覽積木上打的字寫回分段。
 *
 * 對話框裡**打字的那一份真相在積木上**，不在這裡：每個按鍵都回寫 draft 會讓
 * 積木重建，而重建就是把正在編輯的欄位關掉。所以只有結構要變（加一格、刪
 * 一格、換型別、按確定）之前才回讀一次。
 */
export function applyTexts(draft: Draft, texts: Record<number, string>): Draft {
  return {
    ...draft,
    segments: draft.segments.map((segment, i) => {
      const text = texts[i];
      if (text === undefined) return segment;
      return segment.kind === 'label'
        ? { ...segment, text }
        : { ...segment, name: validateName(text) };
    }),
  };
}

/**
 * 這份簽章能不能存。回傳一句給使用者看的話，或 `null`。
 *
 * 這裡擋的是**畫面上做得出來、但存出去就壞掉**的組合。後端的
 * `_validate_signature` 擋的是另外兩條（引用不存在的參數、漏掉參數），
 * 而對話框的結構讓那兩條不可能發生——分段本身就是版面。
 */
export function draftIssue(draft: Draft): string | null {
  const labels = draft.segments.filter((s) => s.kind === 'label');
  if (!labels.some((s) => s.text.trim() !== '')) {
    return '積木要有名字：至少留一段說明文字';
  }
  if (labels.some((s) => s.text.includes('%('))) {
    // `%(` 是佔位符的開頭（與 manifest 的 `text` 同一套語法），出現在標籤裡會
    // 讓存出去的簽章引用一個不存在的參數。單獨的 `%` 沒問題。
    return '說明文字不能含有「%(」——那是參數的位置記號';
  }

  const params = draft.segments.filter(isParam);
  const names = new Set<string>();
  for (const param of params) {
    const name = param.name.trim();
    if (name === '') return '每個輸入方塊都要有名字';
    if (names.has(name)) return `參數名稱重複：${name}`;
    names.add(name);
  }
  return null;
}

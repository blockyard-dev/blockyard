/**
 * 函式的簽章模板（§4.6、D26）。
 *
 * `procedures[].name` 不是一個名字而是一份模板，語法**與 manifest 的 `text`
 * 完全相同**（`%(參數id)`）——所以呼叫積木的 `text` 幾乎就是簽章本身，
 * `define.ts::buildBlock` 那一套 `%()` 展開一行都不必改。
 *
 * 一個 `%(` 都沒有的簽章是**相容模式**，不是舊資料：AI 生成的 IR（D5）多半
 * 長那樣，而那時候版面由 `params` 的順序決定（`呼叫 X 參數名: (孔)`）。
 *
 * 規格在後端（`ir/schema.py` 的 `_validate_signature`）：引用不存在的參數、
 * 或排了版卻漏掉參數，都是存檔期錯誤。這裡只負責畫。
 */
import type { Procedure, ProcParam } from '../types/project';

/** 與後端 `ir/schema.py::PLACEHOLDER` 同一套語法。 */
export const PLACEHOLDER = /%\((\w+)\)/g;

export function hasSignatureTemplate(name: string): boolean {
  return name.includes('%(');
}

/** 簽章引用到的參數 id，依出現順序。 */
export function placeholdersOf(name: string): string[] {
  return [...name.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '');
}

/**
 * 給人看的一句話：`跳 %(a1) 次 到 %(a2)` → `跳 (次數) 次 到 (方向)`。
 *
 * tooltip、警告訊息、對話框標題用它。**IR 的參數 id 在畫面上一個字都不該
 * 出現**——那是第 6 步留下的 bug（tooltip 漏出 `procedure.definition#p_sum`）
 * 的同一類錯誤。
 */
export function displayName(proc: Procedure): string {
  const names = new Map((proc.params ?? []).map((p) => [p.id, p.name]));
  if (!hasSignatureTemplate(proc.name)) {
    const params = (proc.params ?? []).map((p) => `(${p.name})`).join(' ');
    return params ? `${proc.name} ${params}` : proc.name;
  }
  return proc.name.replace(PLACEHOLDER, (whole, id: string) => `(${names.get(id) ?? whole})`);
}

/**
 * 呼叫積木的 `text`。
 *
 * 有模板就直接用它——那正是 D26 的重點：畫出來是 `跳 (10) 次 到 [左]`，
 * 不是 `呼叫 跳 次數: (10) 方向: [左]`。
 *
 * 沒有模板才走相容排版。相容版帶「呼叫」兩個字與參數名，因為那時候句子本身
 * 說不出誰是誰：`加總 (清單)` 讀得懂是因為模板把名字排在對的位置，而
 * `加總 (孔) (孔)` 讀不懂。
 */
export function callText(proc: Procedure): string {
  const params = paramsOf(proc);
  // 沒有參數的函式，簽章**就是**整顆積木的文字（Scratch 也是這樣畫的）。
  // 相容排版只在「有參數、但簽章沒說它們排在哪裡」時才需要——那時候句子本身
  // 說不出誰是誰（`加總 (孔) (孔)` 讀不懂），所以才補上動詞與參數名。
  if (hasSignatureTemplate(proc.name) || params.length === 0) return proc.name;
  return [`呼叫 ${proc.name}`, ...params.map((p) => `${p.name}: %(${p.id})`)].join(' ');
}

/**
 * 定義帽子的 `text`。
 *
 * 與呼叫積木**同一份模板**，只在前面加一個動詞——兩顆讀起來要是同一句話，
 * 不然使用者得在腦子裡對照「定義的那顆」與「呼叫的那顆」是不是同一個東西。
 *
 * 帽子上的參數是**輸入孔**，與呼叫積木一樣（`%(參數id)`）——但那些孔裡放的
 * 不是值，是一顆拖得出去的 `取得 (參數名)`（§4.6、`blockly/params.ts`）。
 * 它們是**畫面，不是內容**：`procedures[].params` 已經是那份資料的唯一來源，
 * 所以 `ir/serialize.ts` 不把帽子的孔寫進 IR（與 §4.5 的 `variables` 索引留空
 * 是同一個判斷——存兩份就會漂移）。
 */
export function definitionText(proc: Procedure): string {
  const params = paramsOf(proc);
  if (hasSignatureTemplate(proc.name) || params.length === 0) return `定義 ${proc.name}`;
  // 相容排版與 `callText` 一致，理由也一樣：簽章沒說參數排在哪裡時，句子本身
  // 說不出誰是誰。
  return [`定義 ${proc.name}`, ...params.map((p) => `${p.name}: %(${p.id})`)].join(' ');
}

/** 參數列，`params` 沒給時是空陣列。 */
export function paramsOf(proc: Procedure): ProcParam[] {
  return proc.params ?? [];
}

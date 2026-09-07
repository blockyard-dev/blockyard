/** 安裝摘要與更新對畫布的影響。 */
import type { ExtensionDiff, ImportReview } from '../api/client';
import { list, number, t } from '../i18n';

/** `1234` → `1.2 KB`。檔案清單上那一欄。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${number(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${number(kb, kb < 10
    ? { minimumFractionDigits: 1, maximumFractionDigits: 1 }
    : { maximumFractionDigits: 0 })} KB`;
  const mb = kb / 1024;
  return `${number(mb, mb < 10
    ? { minimumFractionDigits: 1, maximumFractionDigits: 1 }
    : { maximumFractionDigits: 0 })} MB`;
}

/**
 * 這個包裝進來會多出什麼——審閱畫面最上面那一句。
 *
 * **只講看得見的東西**（積木、面板、要填的金鑰），不講 `requirements`：使用者
 * 對「多了 3 個相依套件」無話可說，而那份清單本來就攤在下面。
 */
export function summarize(review: ImportReview): string {
  const parts: string[] = [t('import.summaryBlocks', { count: number(review.blocks.length) })];
  if (review.editor) parts.push(t('import.summaryEditor'));
  if (review.panels.length > 0) parts.push(t('import.summaryPanels', { count: number(review.panels.length) }));
  if (review.config.length > 0) parts.push(t('import.summaryConfig', { count: number(review.config.length) }));
  return list(parts);
}

/**
 * 一段差集 ＋ 畫布上的用量 → **§4 那張表的三列**。
 *
 * | 差集 | 怎麼辦 |
 * |---|---|
 * | 少了一顆積木，**而畫布上有** | 擋 |
 * | 參數變了，**而畫布上有** | 警告後放行 |
 * | 沒人用到的變動 | 只說一聲 |
 *
 * **分列的依據是「誰會受影響」，不是「變動的種類」。** 同樣是「少了一顆積木」，
 * 畫布上有的那幾顆會擋住更新，沒人用到的只是一行字——所以這個函式一定要同時
 * 吃兩邊：`diff` 是後端算的（兩份 manifest 的差），`usage` 是 `App` 數的（那份
 * 工作區還沒存檔，後端手上那一份可能是十分鐘前的）。
 */
export interface UpdateVerdict {
  /** 擋：這一版少了畫布上正在用的積木。 */
  blocking: ExtensionDiff['gone'];
  /** 警告後放行：畫布上正在用的積木變了（多半是多出空孔，§16 Q21）。 */
  warning: ExtensionDiff['changed'];
  /** 只說一聲：少了、但沒人用到的那幾顆。 */
  quietGone: ExtensionDiff['gone'];
  /** 宣告完全沒變。**這仍然是一次真的更新**——程式碼可能全改了，而 manifest
   * 看不出來（§8：分不出來的就不假裝分得出來）。 */
  nothingDeclared: boolean;
}

export function updateVerdict(
  diff: ExtensionDiff,
  usage: Record<string, number>,
): UpdateVerdict {
  const used = (opcode: string) => (usage[opcode] ?? 0) > 0;
  return {
    blocking: diff.gone.filter((g) => used(g.opcode)),
    warning: diff.changed.filter((c) => used(c.opcode)),
    quietGone: diff.gone.filter((g) => !used(g.opcode)),
    nothingDeclared:
      diff.gone.length === 0 &&
      diff.changed.length === 0 &&
      diff.added.length === 0 &&
      !diff.requirementsChanged,
  };
}

/**
 * 一顆積木這一版變了什麼，寫成一句話。
 *
 * **必填與選填分開講**：多一格必填的參數會讓那幾顆積木多出填不了東西的空孔，
 * 而那份專案從此存不起來（§16 Q21、後端的 `normalize_args`）。多一格選填的
 * 只是多一個孔。兩者都要說，但它們不是同一件事。
 */
export function changeWords(change: ExtensionDiff['changed'][number]): string {
  const parts: string[] = [];
  const required = change.argsAdded.filter((a) => a.required).map((a) => a.name);
  const optional = change.argsAdded.filter((a) => !a.required).map((a) => a.name);
  if (required.length > 0) parts.push(t('import.changeRequired', { names: list(required) }));
  if (optional.length > 0) parts.push(t('import.changeOptional', { names: list(optional) }));
  if (change.argsRemoved.length > 0) {
    parts.push(t('import.changeRemoved', { names: list(change.argsRemoved) }));
  }
  if (change.argsRetyped.length > 0) {
    parts.push(list(change.argsRetyped.map((a) => t('import.changeRetyped', a))));
  }
  if (change.nowDeprecated) parts.push(t('import.changeDeprecated'));
  // 只有字變了才單獨說它：上面那幾句已經隱含「這顆積木不一樣了」，而多一句
  // 「積木上的字換了」只是把最不重要的變動排在最後面重複一次。
  if (parts.length === 0 && change.textChanged) parts.push(t('import.changeText'));
  return list(parts);
}

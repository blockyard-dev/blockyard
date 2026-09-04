/**
 * 審閱畫面的規則那一半（§12.1）。純函式，所以它測得到。
 *
 * 這裡真正在做的一件事是**把兩份話併成一張表**：manifest 的 `permissions`
 * （作者宣告的）與靜態掃描看到的（程式碼真的做的）。分成兩區畫的話，使用者
 * 要自己在兩份清單之間對照才看得出「宣告說不上網、程式碼裡有 httpx」——而那
 * 正是 §12.1 表格裡「與宣告不符時警告」唯一想讓他看見的事。
 */
import type { ImportFinding, ImportReview } from '../api/client';

/**
 * 權限的中文說法。**認不得的字串原樣顯示**——後端加一個新權限時，這一頁會畫出
 * 一列 `usb`，而那比一列空白誠實得多（同一條線：D21 之後前端不認識任何一個
 * 積木包的 id）。
 */
const LABELS: Record<string, string> = {
  net: '連上網路',
  'fs.read': '讀這台機器上的檔案',
  'fs.write': '寫或刪這台機器上的檔案',
  subprocess: '執行別的程式',
  env: '讀環境變數',
};

export function permissionLabel(permission: string): string {
  return LABELS[permission] ?? permission;
}

export interface PermissionRow {
  permission: string;
  label: string;
  /** manifest 宣告了這一項。 */
  declared: boolean;
  /** 靜態掃描在程式碼裡看到幾行。**0 不代表沒有**（掃描一定漏報）。 */
  seen: number;
}

/**
 * 一項權限一列，**沒宣告卻掃到的排最前面**。
 *
 * 排序不是美觀問題：這一頁上唯一需要使用者停下來想一秒的就是那幾列，而它們
 * 混在一份按字母排的清單裡就等於不存在。
 */
export function permissionRows(review: ImportReview): PermissionRow[] {
  const declared = new Set(review.permissions);
  const seen = new Map<string, number>();
  for (const f of review.findings) {
    if (f.permission) seen.set(f.permission, (seen.get(f.permission) ?? 0) + 1);
  }
  const rows = [...new Set([...declared, ...seen.keys()])].map((permission) => ({
    permission,
    label: permissionLabel(permission),
    declared: declared.has(permission),
    seen: seen.get(permission) ?? 0,
  }));
  rows.sort((a, b) => {
    const mismatch = Number(a.declared) - Number(b.declared);
    return mismatch !== 0 ? mismatch : a.permission.localeCompare(b.permission);
  });
  return rows;
}

/**
 * 不對應任何一項權限的那幾條（`eval`、`pickle`、語法錯誤）。
 *
 * 它們永遠只是「說一聲」：沒有一種宣告能讓 `eval` 變成相符，所以把它們放進上面
 * 那張表只會多出一列永遠標著紅字、而使用者做不了任何事的東西。
 */
export function looseFindings(review: ImportReview): ImportFinding[] {
  return review.findings.filter((f) => f.permission === null);
}

/** 掃到、但 manifest 沒宣告的那幾條。審閱畫面上那一句警告數的就是它。 */
export function mismatchedFindings(review: ImportReview): ImportFinding[] {
  return review.findings.filter((f) => f.permission !== null && !f.declared);
}

/** `1234` → `1.2 KB`。檔案清單上那一欄。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * 這個包裝進來會多出什麼——審閱畫面最上面那一句。
 *
 * **只講看得見的東西**（積木、面板、要填的金鑰），不講 `requirements`：使用者
 * 對「多了 3 個相依套件」無話可說，而那份清單本來就攤在下面。
 */
export function summarize(review: ImportReview): string {
  const parts: string[] = [`${review.blocks.length} 顆積木`];
  if (review.panels.length > 0) parts.push(`${review.panels.length} 格面板`);
  if (review.config.length > 0) parts.push(`${review.config.length} 項設定`);
  return parts.join('、');
}

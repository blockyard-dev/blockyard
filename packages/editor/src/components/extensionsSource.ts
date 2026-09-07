/**
 * 一張收據 → 卡片上那一行（`docs/extension-design.md` §2）。
 *
 * 純函式，因為這是這條路上唯一的規則——其餘都是一次 fetch 與一個 `<span>`。
 *
 * **「沒有收據」是一個答案，不是缺資料。** 那代表使用者自己把資料夾放進去了，
 * 而我們對那種包唯一該做的事是不碰它——所以那句話要說得出口，不能畫成空白。
 * 第 4 步的「解除安裝⋯」看的是同一件事（`canUninstall`），而它們必須是同一個
 * 判斷：畫面上說「你自己放的」、選單卻給得出解除安裝，是最糟的那一種不一致。
 */
import type { ExtensionReceipt } from '../api/client';
import { date, t } from '../i18n';

/** 收據上那個日期，畫成使用者當地的年月日。認不得就不畫日期。 */
function installedOn(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return date(at);
}

/**
 * 這張卡下面那一行。
 *
 * 官方包**不寫日期**：它的安裝時間是「這台機器第一次打開編輯器的那天」，
 * 而那個日期對使用者不說明任何事——他沒有裝過它。
 */
export function sourceLine(receipt: ExtensionReceipt | undefined): string {
  if (!receipt) return t('extensions.sourceManual');
  if (receipt.origin === 'official') return t('extensions.sourceOfficial');
  const on = installedOn(receipt.installedAt);
  return on
    ? t('extensions.sourceInstalledOn', { source: receipt.label, date: on })
    : t('extensions.sourceInstalled', { source: receipt.label });
}

/**
 * 我們可不可以移除這個資料夾（§2 的核心規則）。
 *
 * **沒有收據就是不行。** 那不是錯誤狀態——那是一個人正在那個資料夾裡寫他自己
 * 的包，而替他刪掉一個他正在編輯的目錄，是這整份設計裡唯一一件真的會弄丟東西
 * 的事。收據是一張「這個資料夾是我搬進來的」的憑據，而只有開收據的人有資格把
 * 它搬走。
 *
 * 現在只有 `sourceLine` 的措辭用得到它；**第 4 步的「解除安裝⋯」用的是同一個
 * 判斷**，這個函式先存在是為了讓那時候不會多長出第二個答案。
 */
export function canUninstall(receipt: ExtensionReceipt | undefined): boolean {
  return receipt !== undefined;
}

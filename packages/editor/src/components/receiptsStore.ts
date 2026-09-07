/**
 * 收據那份表：**這幾個資料夾是誰搬進來的**（`docs/extension-design.md` §2）。
 *
 * 一份 store 而不是各自 fetch，理由不是省一趟請求，是**兩個地方必須給出同一個
 * 答案**：工具箱分類欄上那顆色圓點的右鍵選單，與擴充功能面板上那張卡的右鍵
 * 選單，指的是同一個包。畫面上一邊說「你自己放進資料夾的」、另一邊的選單卻
 * 給得出「解除安裝⋯」，是最糟的那一種不一致——而那正是這兩條規則共用
 * `canUninstall()` 的理由（`extensionsSource.ts`）。
 *
 * **不在這裡的 id 就是沒有收據**（後端的 `/receipts` 只吐有收據的那幾個），
 * 而沒有收據的意思是「使用者自己放的，我們不碰」。所以「還沒載入」與「沒有
 * 收據」在畫面上長得一樣——那是刻意的，因為兩者能做的動作完全相同（都不能
 * 解除安裝），而往安全那一邊倒的成本只是一次重新整理。
 */
import { create } from 'zustand';
import { fetchExtensionReceipts, type ExtensionReceipt } from '../api/client';

interface ReceiptsState {
  receipts: ReadonlyMap<string, ExtensionReceipt>;
  /** 重問一次。裝好、更新完、解除安裝之後都要——那三件事都會改動這份表。 */
  reload(signal?: AbortSignal): Promise<void>;
}

export const useReceipts = create<ReceiptsState>((set) => ({
  receipts: new Map(),
  reload: async (signal) => {
    try {
      const rows = await fetchExtensionReceipts(signal);
      set({ receipts: new Map(rows.map((r) => [r.extId, r])) });
    } catch {
      // 讀不到收據不該讓任何一頁壞掉：它只決定選單上多不多一條「解除安裝⋯」，
      // 而少了那一條的畫面仍然是完整、可用、而且安全的那一邊。
    }
  },
}));

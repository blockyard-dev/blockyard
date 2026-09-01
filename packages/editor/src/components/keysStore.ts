/**
 * 「金鑰」面板的開關（D28）。
 *
 * 面板本來由 `KeysEntry` 自己用 `useState` 開關，夠用——直到執行紀錄裡的
 * 「還沒設定金鑰」需要**從另一棵子樹**把它打開，而且要帶著「打開哪一把」。
 * 那條路徑穿過 topbar 與 run panel 兩個互不相干的元件，用 props 傳等於把
 * 這件事沿路寫進每一層。
 *
 * `target` 是「開啟時直接進到新增畫面，並且鎖定這一把」；`null` 代表就只是
 * 打開面板。它在面板讀走之後**不清掉**——清掉的時機是關閉面板，不然 React
 * 在同一輪 render 裡會先看到 target 再看到 null，畫面閃一下。
 */
import { create } from 'zustand';

export interface KeysTarget {
  extId: string;
  extName: string;
  key: string;
  label: string | null;
  envVar: string | null;
}

interface KeysUiState {
  open: boolean;
  target: KeysTarget | null;
  openKeys(target?: KeysTarget): void;
  closeKeys(): void;
}

export const useKeysUi = create<KeysUiState>((set) => ({
  open: false,
  target: null,
  openKeys: (target) => set({ open: true, target: target ?? null }),
  closeKeys: () => set({ open: false, target: null }),
}));

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
import { keyId } from '../api/client';

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
  /**
   * 已經設定好的那幾把（`keyId`）。
   *
   * 在這裡而不是各自 fetch：讀它的人是**工具箱**（`open_config` 的按鈕設定完
   * 就收起來），而寫它的人是金鑰面板。兩者在元件樹上互不相干，中間隔著整個
   * App——跟 `target` 當初搬進來的理由一模一樣。
   */
  configured: ReadonlySet<string>;
  openKeys(target?: KeysTarget): void;
  closeKeys(): void;
  setConfigured(ids: Iterable<string>): void;
}

export const useKeysUi = create<KeysUiState>((set) => ({
  open: false,
  target: null,
  configured: new Set<string>(),
  openKeys: (target) => set({ open: true, target: target ?? null }),
  closeKeys: () => set({ open: false, target: null }),
  // **內容一樣就不換那個 Set**。面板每次開啟、每次存檔、每次刪除都會重讀一
  // 次清單，而讀到的多半跟上一次一樣；每次都換一份新的 Set，訂閱它的 App 就
  // 會每次都重建一份工具箱——一份長得完全一樣的工具箱，而重建會讓 flyout 捲
  // 回頂端。
  setConfigured: (ids) =>
    set((state) => {
      const next = new Set(ids);
      return sameSet(state.configured, next) ? state : { configured: next };
    }),
}));

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** `KeyEntry[]` → 這份 store 要的那個名單。 */
export function configuredIds(keys: { extId: string; key: string; configured: boolean }[]): string[] {
  return keys.filter((k) => k.configured).map(keyId);
}

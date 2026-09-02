/**
 * 擴充功能面板的開關，與「哪幾個積木包在工具箱上」那份名單（D31）。
 *
 * **註冊不等於上架。** 後端 `discover()` 到的每一個包都會被註冊（不然舊專案
 * 裡那些積木會退化成 §13.3 的佔位符），但工具箱上只有加進來的那幾個。理由與
 * Scratch 把「音樂」「畫筆」收進擴充頁一樣：分類欄是 60px 寬的一直排，每多一個
 * 沒人用的包，使用者每天要掃過的東西就多一格——而那一格永遠不會自己消失。
 *
 * 名單存 localStorage（§16 Q15 的暫定答案），**不進 `project.json`**：它是
 * 「我這台機器上想看到什麼」，不是專案的內容。專案那一半由 `initEnabled` 補
 * ——IR 的 `extensions` 是從畫布上的積木算出來的（§13.3），所以「這個專案用到
 * 哪些包」是一件問得出來的事，而答案必須先進名單，否則打開一份別人的專案會
 * 看到一堆積木、而工具箱裡沒有任何一個地方生得出它們。
 *
 * 反過來，**移除只是收起來**：畫布上已經有的積木照樣跑（註冊還在），而下次載入
 * 這個專案時 `initEnabled` 會把它加回來。所以這顆按鈕不需要「你確定嗎」——它
 * 弄不壞任何東西。
 */
import { create } from 'zustand';
import { readPref, writePref } from '../prefs';

const PREF_KEY = 'extensions.enabled';

/**
 * 這一刻該有的名單 = **偏好裡的 ∪ 這個專案用到的**。
 *
 * 交集或只取其一都不對：只取偏好，別人傳來的專案打不開（積木在畫布上，工具箱
 * 裡卻沒有那個分類）；只取專案，使用者昨天加進來、今天還沒拉出積木的那個包會
 * 自己消失——而「我明明加過了」是最難查的那種問題。
 *
 * 純函式，因為它是這個檔案裡唯一一條規則；其餘都是 set 與 localStorage。
 */
export function mergeEnabled(stored: Iterable<string>, used: Iterable<string>): Set<string> {
  return new Set([...stored, ...used]);
}

/** 存進偏好的那份名單。壞掉的值（手改過的 localStorage）當作沒有。 */
function readEnabled(): string[] {
  const raw = readPref<unknown>(PREF_KEY, []);
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
}

interface ExtensionsUiState {
  /** 擴充功能面板開著。 */
  open: boolean;
  /** 工具箱上的積木包（內建不在這裡面，它們不受名單管）。 */
  enabled: ReadonlySet<string>;
  openGallery(): void;
  closeGallery(): void;
  /** 載入專案時呼叫一次：偏好 ∪ 這個專案用到的，並把結果寫回偏好。 */
  initEnabled(used: Iterable<string>): void;
  add(id: string): void;
  remove(id: string): void;
}

export const useExtensionsUi = create<ExtensionsUiState>((set) => ({
  open: false,
  enabled: new Set(readEnabled()),
  openGallery: () => set({ open: true }),
  closeGallery: () => set({ open: false }),
  initEnabled: (used) =>
    set((state) => {
      const next = mergeEnabled(state.enabled, used);
      // **內容一樣就不換那個 Set**（同 `keysStore.setConfigured`）：訂閱它的
      // `App` 會為每一個新的 Set 物件重建一次工具箱，而重建會讓 flyout 捲回
      // 頂端——即使那份工具箱長得一模一樣。
      if (sameSet(state.enabled, next)) return state;
      writePref(PREF_KEY, [...next]);
      return { enabled: next };
    }),
  add: (id) =>
    set((state) => {
      if (state.enabled.has(id)) return state;
      const next = new Set(state.enabled).add(id);
      writePref(PREF_KEY, [...next]);
      return { enabled: next };
    }),
  remove: (id) =>
    set((state) => {
      if (!state.enabled.has(id)) return state;
      const next = new Set(state.enabled);
      next.delete(id);
      writePref(PREF_KEY, [...next]);
      return { enabled: next };
    }),
}));

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

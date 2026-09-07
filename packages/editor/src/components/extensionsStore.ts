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
import { LEGACY_PROJECT_ID, currentProjectId } from '../project/current';

/**
 * **每個專案一份名單**（`docs/project-storage-design.md` §4）。
 *
 * 原本是整台機器一份，而 `initEnabled` 做的是聯集（偏好 ∪ 這個專案用到的）。
 * 單專案時那是對的；多專案時它變成一個只進不出的桶子：
 *
 *     打開 A（用 discord）→ 名單 = {discord}
 *     打開 B（用 openai） → 名單 = {discord, openai}
 *     回到 A             → 名單還是 {discord, openai}
 *
 * 於是分類欄上永遠留著你在**別的專案**裡用過的包，而 D31 擋的正是這件事
 * （60px 寬的一直排，每一格都不會自己消失）。聯集規則不動——它在一個專案內
 * 仍然是對的，變的只是這個 key 多了一個維度。
 *
 * 這不違反 §16 Q15（偏好不進 `project.json`）：名單仍然住在瀏覽器裡，所以
 * 「同一份專案在不同人手上長得一樣」那條線沒有動。
 */
export function enabledPrefKey(projectId: string = currentProjectId()): string {
  return `extensions.enabled.${projectId}`;
}

/**
 * 複製一份專案時，名單也跟著（`ProjectsPage` 的「複製」）。
 *
 * 少了這一行，副本的工具箱只剩「這份 IR 用到的包」（`initEnabled` 的聯集裡少了
 * 一半）——症狀是使用者昨天加進來、還沒拉出積木的那個包在副本裡不見了，而那
 * 正是 D31 那份名單存在的理由。
 *
 * 名單住在瀏覽器裡，所以這件事只能在前端做（後端的 `copy_project` 看不到它）。
 */
export function copyEnabledPref(fromId: string, toId: string): void {
  const list = readPref<unknown>(enabledPrefKey(fromId), null);
  if (Array.isArray(list)) writePref(enabledPrefKey(toId), list);
}

/** 多專案之前那個「整台機器一份」的 key。見 `readEnabled`。 */
const LEGACY_PREF_KEY = 'extensions.enabled';

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

/**
 * 存進偏好的那份名單。壞掉的值（手改過的 localStorage）當作沒有。
 *
 * **舊 key 只給那個舊專案接**：多專案之前這台機器上只有 `prj_local`，所以那份
 * 名單就是它的。讓每一個新專案都繼承它，等於把「工具箱上多了我沒加過的東西」
 * 這個症狀從跨專案搬到新專案身上——而那正是這次要修的事。
 */
function readEnabled(): string[] {
  const own = readPref<unknown>(enabledPrefKey(), null);
  const raw =
    own === null && currentProjectId() === LEGACY_PROJECT_ID
      ? readPref<unknown>(LEGACY_PREF_KEY, [])
      : (own ?? []);
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
}

interface ExtensionsUiState {
  /** 擴充功能面板開著。 */
  open: boolean;
  /**
   * 面板打開的目的是**換掉這個 id 的包**（`docs/extension-design.md` §4）。
   *
   * 右鍵選單上的「更新／替換⋯」在工具箱那一側，而換一版的流程（挑檔案或貼
   * 網址 → 審閱 → 差集）整條住在面板裡——**因為那與第一次安裝是同一條管線**。
   * 這一格就是那兩邊之間唯一要傳的東西：一個 id。
   *
   * 放在 store 而不是 `openGallery(id)` 的一個參數，是因為面板是被 `open`
   * 這個旗標畫出來的，而不是被誰呼叫出來的——多一條 props 就要多一個「是誰
   * 打開它的」的答案。
   */
  updating: string | null;
  /** 工具箱上的積木包（內建不在這裡面，它們不受名單管）。 */
  enabled: ReadonlySet<string>;
  openGallery(): void;
  closeGallery(): void;
  /** 打開面板，並且說「現在要換的是這一個」。 */
  startUpdate(id: string): void;
  /** 面板收下了那個意圖（或使用者取消了）。 */
  clearUpdate(): void;
  /** 載入專案時呼叫一次：偏好 ∪ 這個專案用到的，並把結果寫回偏好。 */
  initEnabled(used: Iterable<string>): void;
  add(id: string): void;
  remove(id: string): void;
}

export const useExtensionsUi = create<ExtensionsUiState>((set) => ({
  open: false,
  updating: null,
  enabled: new Set(readEnabled()),
  openGallery: () => set({ open: true, updating: null }),
  // 關掉面板一定要把意圖清掉：留著的話，下一次使用者自己打開面板時會莫名其妙
  // 從一個更新流程開始。
  closeGallery: () => set({ open: false, updating: null }),
  startUpdate: (id) => set({ open: true, updating: id }),
  clearUpdate: () => set({ updating: null }),
  initEnabled: (used) =>
    set((state) => {
      const next = mergeEnabled(state.enabled, used);
      // **內容一樣就不換那個 Set**（同 `keysStore.setConfigured`）：訂閱它的
      // `App` 會為每一個新的 Set 物件重建一次工具箱，而重建會讓 flyout 捲回
      // 頂端——即使那份工具箱長得一模一樣。
      if (sameSet(state.enabled, next)) return state;
      writePref(enabledPrefKey(), [...next]);
      return { enabled: next };
    }),
  add: (id) =>
    set((state) => {
      if (state.enabled.has(id)) return state;
      const next = new Set(state.enabled).add(id);
      writePref(enabledPrefKey(), [...next]);
      return { enabled: next };
    }),
  remove: (id) =>
    set((state) => {
      if (!state.enabled.has(id)) return state;
      const next = new Set(state.enabled);
      next.delete(id);
      writePref(enabledPrefKey(), [...next]);
      return { enabled: next };
    }),
}));

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

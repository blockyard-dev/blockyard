/**
 * **這個分頁打開的是哪一個專案**（`docs/project-storage-design.md` §3）。
 *
 * 答案來自**網址**（`/p/prj_ab12cd34`，見 `routes.ts`），localStorage 只留一份
 * 「上次那一份」——它唯一的用途是 `/` 要導去哪裡。
 *
 * 這個順序很重要：**網址是身分，偏好只是記憶**。反過來（偏好是主、網址是裝飾）
 * 的話，兩個分頁各開一份專案時，後開的那個會把先開的那個的身分改掉——而先開的
 * 那個分頁下一次存檔就存到別人身上去了。
 *
 * 一個模組層的變數，不是 React state 或 zustand。理由是它的讀者不只有元件：
 * 動態下拉的欄位（`blockly/fields/dropdownCache.ts`）與金鑰的 API 呼叫
 * （`api/client.ts`）都要它，而那兩個都住在 React 的樹外面——把它做成 state
 * 就得沿路把 id 傳進 Blockly 的欄位建構子裡。
 *
 * **一次載入之內它不會變**：換一份專案是一次真的導覽（`routes.go`），所以整個
 * 模組會重新載入一遍。
 */
import { readPref, writePref } from '../prefs';
import { routeOf } from './routes';

const PREF_KEY = 'project.current';

/**
 * P0b 那個寫死的 id（`App.tsx` 原本的 `PROJECT_ID = 'prj_local'`）。
 *
 * **它是預設值，不是一個特別的專案**：舊的使用者手上那一份就叫這個名字，而
 * 它的執行歷史、webhook 網址與金鑰全都掛在這個字串上（§3）。換掉它等於把那些
 * 東西弄丟，所以它會一直是「什麼線索都沒有時的答案」。
 */
export const LEGACY_PROJECT_ID = 'prj_local';

const route = routeOf();
const current = route.name === 'editor' ? route.id : remembered();

// 網址說了算，而「上次那一份」跟著它走。寫在模組載入時而不是某個 effect 裡：
// 這件事沒有時機問題（網址在第一行程式碼跑之前就定了），而放進 effect 會讓
// 「重新整理一次就記住了」變成一件要靠 React 生命週期解釋的事。
if (route.name === 'editor') writePref(PREF_KEY, current);

function remembered(): string {
  const raw = readPref<unknown>(PREF_KEY, '');
  return typeof raw === 'string' && raw ? raw : LEGACY_PROJECT_ID;
}

/**
 * 上次打開的那一份，**沒有就 `null`**。
 *
 * 只有 `/` 那次轉址讀它，而它要分得出「沒有上次」——那時候該去的是列表，不是
 * 一個猜出來的 id。
 */
export function lastOpenedProjectId(): string | null {
  const raw = readPref<unknown>(PREF_KEY, '');
  return typeof raw === 'string' && raw ? raw : null;
}

/**
 * 忘掉「上次那一份」。
 *
 * 發現它已經不在了的時候叫（`App` 讀到 404 的那一刻）。不忘的話，下一次打開
 * `/` 還是會被導去同一個死網址、再被踢回列表一次——一個每次啟動都要繞一圈的
 * 迴圈，而畫面上只會說「那份專案不在了」，不會說「而且它還記著」。
 */
export function forgetLastOpened(): void {
  writePref(PREF_KEY, '');
}

/** 現在這一刻打開的專案 id。**同步的**——呼叫它的地方一半在 React 外面。 */
export function currentProjectId(): string {
  return current;
}

/** 每一條要說出「這是哪個專案的」的請求都接這一段。 */
export function projectQuery(): string {
  return `project=${encodeURIComponent(current)}`;
}

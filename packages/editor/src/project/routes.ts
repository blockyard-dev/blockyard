/**
 * 這個編輯器只有兩個地方，而網址說得出你在哪一個
 * （`docs/project-storage-design.md` §3）。
 *
 *     /                 → 導到上次那一份（沒有上次就進列表）
 *     /projects         → 主選單：列表、新建、匯入。**這一頁是家，所以它沒有返回**
 *     /p/prj_ab12cd34   → 編輯器
 *     /docs/discord/    → Discord 積木包教學
 *
 * **為什麼專案 id 該住在網址裡**：它本來就是這份專案的身分（§3），而在這之前
 * 那個身分住在 localStorage——一個看不見、按不到、分享不了的地方。搬到網址上
 * 之後，上一頁、書籤、兩個分頁各開一份全部免費，而它們現在一件都做不到。
 *
 * **網址裡是 opaque id 不是名字**，這是 §3 的延伸：改名不會弄壞一個書籤。
 * 路徑用 `/p/` 不用 `/專案/`——中文路徑一複製就變成一串百分號。
 *
 * **`/` 落在上次那一份，不是主選單。** 每天回來繼續弄同一個專案的人，落在選單上
 * 就是每次多一次點擊，而那是這個工具九成的使用情境（VS Code 開上次的資料夾、
 * Notion 開上次那一頁，走的都是這條）。落在列表是給真的在很多檔案之間跳的人用的，
 * 而那還不是這裡的樣子。
 *
 * **導覽是整頁載入**（`go()` 用 `location.assign`），不是 history API 的 push。
 * 那不是偷懶：編輯器的狀態散在 Blockly 的工作區、WebSocket、監聽與快取裡，換一份
 * 專案本來就得整個重來（見 `projectsStore` 的檔頭）。差別只在於它現在是一次真的
 * 導覽——所以上一頁會動。
 *
 * 沒有 router 套件：兩條路徑、一個 `switch`，而一個 router 會把「這個 app 有哪些
 * 地方」的答案搬進一份設定裡。
 */

/** 主選單。 */
export const LIST_PATH = '/projects';

/**
 * 回主選單，**而且說得出是被踢回來的**：那份專案不在了。
 *
 * 這條路會發生，而且不罕見：`/` 導去的是「上次那一份」（一個記在 localStorage
 * 裡的 id），而那一份可能在別的分頁被刪掉了、或是從別台機器同步過來的一個書籤。
 *
 * **編輯器不准自己生一份出來。** 那是它原本做的事（P0b 的 id 是寫死的，第一次
 * 啟動本來就沒有專案，所以「讀不到就開一張白紙」是對的），而在多專案之後那個
 * 行為變成：打開一個死掉的網址 → 看到一張空白畫布 → 一存檔就把那份被刪掉的
 * 專案**復活**，或者無中生有一個從來不存在的專案。開一份專案現在是一個明確的
 * 動作（主選單上那顆「新專案」），所以網址只能打開已經存在的東西。
 */
export function missingProjectPath(id: string): string {
  return `${LIST_PATH}?gone=${encodeURIComponent(id)}`;
}

/** 剛剛被踢回來時，那個不在了的專案 id。平常是 `null`。 */
export function missingProjectId(): string | null {
  if (typeof location === 'undefined') return null;
  return new URLSearchParams(location.search).get('gone');
}

/** 一份專案的網址。 */
export function projectPath(id: string): string {
  return `/p/${encodeURIComponent(id)}`;
}

export type Route =
  /** `/` —— 還不知道要去哪，由 `main.tsx` 導走。 */
  | { name: 'home' }
  | { name: 'list' }
  | { name: 'editor'; id: string }
  | { name: 'docs'; page: 'discord' };

/**
 * 現在這條路徑（沒有 `location` 就當首頁）。
 *
 * 測試跑在 node 環境裡，那裡沒有 `location`——而 `routeOf()` 是在模組載入時就
 * 被叫的（`current.ts`），所以少了這個判斷，任何一個間接 import 到它的測試檔
 * 都會在載入那一刻爆掉。
 */
function here(): string {
  return typeof location === 'undefined' ? '/' : location.pathname;
}

/**
 * 現在這個網址是哪一個地方。
 *
 * **認不得的路徑當作首頁**（而不是畫一頁 404）：這個 app 只有兩個地方，一個打錯
 * 的網址唯一合理的意思是「我想開這個工具」。一頁 404 在這裡只會是一個需要使用者
 * 自己想辦法離開的死巷。
 */
export function routeOf(pathname: string = here()): Route {
  // **查詢字串先切掉。** `location.pathname` 本來就不含它，所以瀏覽器裡永遠碰
  // 不到——但呼叫端手上常常是一整條路徑（`missingProjectPath()` 就回一條帶
  // `?gone=` 的），而那時候 `projects?gone=x` 會被當成一整段、變成首頁。
  // 一個「在瀏覽器裡是對的、你自己餵它就錯」的函式遲早會咬人。
  const parts = (pathname.split(/[?#]/)[0] ?? '')
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);
  if (parts.length === 2 && parts[0] === 'p' && parts[1]) {
    return { name: 'editor', id: parts[1] };
  }
  if (parts.length === 1 && parts[0] === 'projects') return { name: 'list' };
  if (parts.length === 2 && parts[0] === 'docs' && parts[1] === 'discord') {
    return { name: 'docs', page: 'discord' };
  }
  return { name: 'home' };
}

/** 走過去。整頁載入（見檔頭）。 */
export function go(path: string): void {
  location.assign(withExtensionMode(path));
}

/**
 * 走過去，**而且不要在上一頁堆一格**。
 *
 * 只有 `/` 那次轉址用它：`/` 是一個沒有內容的地方，留在歷史裡的結果是使用者按
 * 上一頁會回到它、然後又被轉走——一個按了等於沒按的按鈕。
 */
export function replace(path: string): void {
  location.replace(withExtensionMode(path));
}

function withExtensionMode(path: string): string {
  if (typeof location === 'undefined' || new URLSearchParams(location.search).get('extensions') !== 'off') return path;
  const url = new URL(path, location.href);
  url.searchParams.set('extensions', 'off');
  return url.pathname + url.search + url.hash;
}

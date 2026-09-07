/**
 * 這個 app 只有兩個地方，而**網址說得出你在哪一個**（`project/routes.ts`）。
 *
 *     /                 → 導到上次那一份（沒有上次就進列表）
 *     /projects         → 主選單
 *     /p/prj_ab12cd34   → 編輯器
 *     /docs/discord/    → Discord 積木包教學
 *
 * 這裡不是一個 router：它只讀一次網址、挑一個元件。**沒有「換一頁」這件事**
 * ——換一份專案是一次整頁載入（見 `projectsStore` 的檔頭：編輯器的狀態散在
 * Blockly 的工作區、WebSocket、監聽與快取裡，換一份本來就得整個重來）。
 * 所以這一層跑一次就定案了，而上一頁是瀏覽器自己在管。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { lastOpenedProjectId } from './project/current';
import { LIST_PATH, projectPath, replace, routeOf } from './project/routes';
import { initializeLocale } from './i18n';
import './index.css';

initializeLocale();

const host = document.getElementById('root');
if (!host) throw new Error('index.html 少了 #root');

const route = routeOf();

if (route.name === 'home') {
  // `/` 沒有內容，它只是一個轉址。**用 replace 不用 assign**：留在歷史裡的話，
  // 使用者按上一頁會回到它、然後又被轉走——一個按了等於沒按的按鈕。
  const last = lastOpenedProjectId();
  replace(last ? projectPath(last) : LIST_PATH);
} else {
  // Each top-level destination is its own bundle. In particular, opening a short docs
  // article must not download Blockly and the entire editor first.
  const Page = route.name === 'list'
    ? (await import('./components/ProjectsPage')).ProjectsPage
    : route.name === 'docs'
      ? (await import('./docs/DocsPage')).DocsPage
      : (await import('./App')).App;
  // StrictMode 在開發時會把 effect 跑兩次；WorkspaceView 的 cleanup 會 dispose，
  // 所以那是安全的——反過來說，如果哪天畫面出現兩個工作區，就是 cleanup 漏了。
  createRoot(host).render(<StrictMode><Page /></StrictMode>);
}

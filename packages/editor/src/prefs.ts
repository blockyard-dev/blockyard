/**
 * 使用者偏好（§8.3、§16 Q15）。
 *
 * 這裡放的東西有一個共同性質：**它不屬於專案**。§4.2 對 `ui` 的規則是「刪掉
 * 不影響執行結果」，而變數面板開不開連積木都不屬於——把它存進 `project.json`
 * 會讓同一份專案在不同人手上長得不一樣。
 *
 * 目前用 `localStorage`：單機、單使用者，這是最短的路。§16 Q15 還沒決定最終
 * 要放哪（後端的使用者設定 vs 瀏覽器），所以出入口只有這兩個函式——換掉時
 * 要改的地方就這麼多。
 *
 * 讀寫都吞例外：無痕視窗、擋 cookie 的瀏覽器裡 `localStorage` 會直接丟。
 * 偏好讀不到就用預設值，不該讓整個編輯器打不開。
 */

const PREFIX = 'blockyard.pref.';

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // 存不了就算了：偏好遺失是小事，丟例外會讓呼叫它的 render 整個掛掉
  }
}

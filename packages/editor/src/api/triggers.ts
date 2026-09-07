/**
 * `/api/triggers`：把專案標記為 active，讓它的 hat 常駐（§9、P2 第 2 步）。
 *
 * **跟「執行」是兩件事，所以是兩條路。** 執行是「現在跑一次」，active 是「一直
 * 聽著，外面發生事情就跑」——後者沒有結束時間，也不屬於任何一個 runId。共用
 * `/api/runs` 的話，「停止」到底是停哪一個就講不清楚了。
 *
 * 取代了 P1 的 `/api/listeners`：那條管的是「這個 process 有沒有在聽」，重啟就
 * 沒了；這條管的是「這個專案是不是該跑」，寫在 SQLite 上，與瀏覽器和後端的
 * 生死無關（§9.2）。
 */
import { toApiError } from './client';
import { t } from '../i18n';

export interface TriggerSummary {
  projectId: string;
  /** §9.2 的 active。後端重啟之後仍然是這個值。 */
  active: boolean;
  /** 沒在跑的專案沒有這一欄。 */
  activatedAt?: string;
  /** 接上的 hat opcode。空陣列 = 這份畫布上沒有 hat，不是失敗。 */
  hats: string[];
  /** 沒有 Run 可以歸屬的錯誤（連線斷了、token 不對）。 */
  errors: string[];
  /**
   * 這個專案掛著的 webhook 網址（§9.3）。**只有 active 的時候才有東西**——
   * 網址是掛上去之後才存在的，沒在跑的專案沒有位址可以給。
   */
  webhooks?: WebhookUrl[];
}

export interface WebhookUrl {
  /** 積木上寫的那一段，正規化過（`/github/` → `github`）。 */
  path: string;
  /** `/hooks/{32位隨機}/{path}`。前面接上這台後端的來源就是完整網址。 */
  url: string;
  /** 是哪一顆積木。簽章密鑰以它為 key（§16 Q22 決議 (a)）。 */
  blockId: string;
  /** `none` / `hmac_sha256` / `hmac_sha1`。 */
  verify: string;
  /**
   * 密鑰設了沒有。**只有 `verify !== 'none'` 時才有這一欄**——密鑰本身永遠不
   * 出來（D28），這裡只說有沒有。
   *
   * `false` 代表那顆積木現在**擋掉每一則請求**，不是退回不驗：宣告要驗卻驗不
   * 了，正確答案不是放行（見 `runs/triggers.py` 的 `_signature_ok`）。
   */
  secretSet?: boolean;
}

/**
 * 後端說的狀態 → 工具列那顆按鈕要顯示的東西。
 *
 * 抽出來是因為它有**三個呼叫端**：開場問一次（§9.2：active 是後端的持久狀態，
 * 畫面必須去讀，不能自己記）、按下監聽之後、以及設完 webhook 密鑰之後。三份
 * 各寫一次的話，「沒有 hat 時要說一句話」這種規則遲早只有其中兩份記得。
 */
export interface ListeningState {
  on: boolean;
  hats: string[];
  webhooks: WebhookUrl[];
  message?: string;
}

export function listeningStateOf(summary: TriggerSummary): ListeningState {
  return {
    on: summary.active,
    hats: summary.hats,
    webhooks: summary.webhooks ?? [],
    // 空陣列代表**這份畫布上沒有 hat**，不是失敗；那句話要說出來，否則
    // 按下去什麼都沒發生會被當成壞掉。
    message: summary.active && summary.hats.length === 0 ? t('editor.noEventBlocks') : undefined,
  };
}

/** 沒在跑的樣子。三個呼叫端的 catch 分支共用。 */
export const NOT_LISTENING: ListeningState = { on: false, hats: [], webhooks: [] };

/**
 * 正在監聽的那幾顆 hat 裡，**由這個積木包提供的**是哪些
 * （`docs/extension-design.md` §4）。
 *
 * 更新一個積木包會換掉磁碟上的 `main.py`，但**正在監聽的那一組子行程早就把它
 * import 進去了**（`runs/triggers.py`：那組東西重建的條件是「積木包的集合變
 * 了」，而更新前後那個集合一樣）。所以更新前要先暫停監聽——但**只有在真的相關
 * 的時候**。
 *
 * 判準是 hat，而且它是精準的：後端只為**提供 hat 的那幾個包**開子行程
 * （`want_exts`），而 hat 一觸發起的 Run 走的是一個全新的 registry。所以
 * 「監聽 `discord` 的訊息時更新 `http`」對監聽那一側毫無影響，不該問。
 *
 * 純函式，因為這是這條路上唯一的規則——其餘都是一個對話框與兩個 API 呼叫。
 */
export function listeningHatsOf(state: ListeningState, extId: string): string[] {
  if (!state.on) return [];
  // opcode 是 `<id>.<opcode>`，與後端 `opcode.split(".", 1)[0]` 同一條規則。
  return state.hats.filter((opcode) => opcode.slice(0, opcode.indexOf('.')) === extId);
}

/** 標記 active 並接上。已經 active 就重新同步一次，不是 409。 */
export async function activateProject(projectId: string): Promise<TriggerSummary> {
  const res = await fetch('/api/triggers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  });
  if (!res.ok) throw await toApiError(res, `POST /api/triggers → ${res.status}`);
  return (await res.json()) as TriggerSummary;
}

/** 停掉。沒在跑也是 204——要的結果是「現在沒在跑」，而那已經成立。 */
export async function deactivateProject(projectId: string): Promise<void> {
  const res = await fetch(`/api/triggers/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
  if (!res.ok) throw await toApiError(res, `DELETE /api/triggers/${projectId}`);
}

/** 一個專案的狀態。**沒在跑不是 404**——那個問題對任何存在的專案都有答案。 */
export async function fetchTriggerState(projectId: string): Promise<TriggerSummary> {
  const res = await fetch(`/api/triggers/${encodeURIComponent(projectId)}`);
  if (!res.ok) throw await toApiError(res, `GET /api/triggers/${projectId} → ${res.status}`);
  return (await res.json()) as TriggerSummary;
}

/**
 * 設定一顆 webhook 積木的簽章密鑰（§9.3、§16 Q22 決議 (a)）。
 *
 * **明文只往這個方向走**，讀不回來——同 D28 的金鑰面板。而且它不進 IR，所以
 * 分享出去的專案在對方機器上會驗不過：那是對的，但要在畫面上說出來。
 */
export async function setWebhookSecret(
  projectId: string,
  blockId: string,
  secret: string,
): Promise<void> {
  const res = await fetch(`/api/triggers/${encodeURIComponent(projectId)}/secret`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    // **blockId 在 body，不在路徑上。** Blockly 的 id 大約五分之一含 `/`，而
    // 伺服器會在路由之前就把 `%2F` 解回 `/`——那一格於是比對不上，回 404。
    // 症狀是「按了設定密鑰，回到清單卻還是說沒設」，而且只有五分之一的積木
    // 會發生，看起來像隨機的鬼。
    body: JSON.stringify({ blockId, secret }),
  });
  if (!res.ok) throw await toApiError(res, `PUT webhook secret → ${res.status}`);
}

/**
 * 把密鑰明文拿回來，**只給剪貼簿用**（D28）。
 *
 * 呼叫端不可以把它放進 state 或 DOM：「不顯示明文」擋的是畫面上一直躺著一串
 * 密鑰，而複製按鈕不違反它——值只進剪貼簿。
 */
export async function revealWebhookSecret(projectId: string, blockId: string): Promise<string> {
  const q = new URLSearchParams({ blockId });
  const res = await fetch(`/api/triggers/${encodeURIComponent(projectId)}/secret/reveal?${q}`);
  if (!res.ok) throw await toApiError(res, `GET webhook secret → ${res.status}`);
  return ((await res.json()) as { value: string }).value;
}

/** 拿掉密鑰。**拿掉之後那顆積木會擋掉每一則請求**，不是回歸「不驗」。 */
export async function clearWebhookSecret(projectId: string, blockId: string): Promise<void> {
  const q = new URLSearchParams({ blockId });
  const res = await fetch(`/api/triggers/${encodeURIComponent(projectId)}/secret?${q}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw await toApiError(res, `DELETE webhook secret → ${res.status}`);
}

/**
 * 所有 active 專案。**主選單那一頁靠這條畫「哪幾份在聽」**。
 *
 * 一次問完，不是每張卡各問一次自己：那會讓一頁二十份專案打二十個請求，而它們
 * 的答案本來就躺在同一張表裡（`storage/triggers.py`）。
 */
export async function listActiveProjects(signal?: AbortSignal): Promise<TriggerSummary[]> {
  const res = await fetch('/api/triggers', { signal });
  if (!res.ok) throw await toApiError(res, `GET /api/triggers → ${res.status}`);
  return (await res.json()) as TriggerSummary[];
}

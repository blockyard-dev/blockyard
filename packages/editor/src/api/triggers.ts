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

export async function listActiveProjects(): Promise<TriggerSummary[]> {
  const res = await fetch('/api/triggers');
  if (!res.ok) throw await toApiError(res, `GET /api/triggers → ${res.status}`);
  return (await res.json()) as TriggerSummary[];
}

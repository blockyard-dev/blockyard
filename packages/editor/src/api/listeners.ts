/**
 * `/api/listeners`：把畫布上的 hat 接上／斷開（§9、P1 第 4 步第 3 段）。
 *
 * **跟「執行」是兩件事，所以是兩條路。** 執行是「現在跑一次」，監聽是「一直
 * 聽著，外面發生事情就跑」——後者沒有結束時間，也不屬於任何一個 runId。共用
 * `/api/runs` 的話，「停止」到底是停哪一個就講不清楚了。
 *
 * 後端不是 §9 的 Trigger Manager，是它的前身：監聽活在後端的記憶體裡，重啟就
 * 沒了（`backend/blocky/runs/listeners.py` 開頭那張表列了差在哪）。
 */
import { toApiError } from './client';

export interface ListenerSummary {
  projectId: string;
  startedAt: string;
  /** 接上的 hat opcode。空陣列 = 這份畫布上沒有 hat，不是失敗。 */
  hats: string[];
  /** 監聽期間沒有 Run 可以歸屬的錯誤（連線斷了、token 不對）。 */
  errors: string[];
}

export async function startListening(projectId: string): Promise<ListenerSummary> {
  const res = await fetch('/api/listeners', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  });
  if (!res.ok) throw await toApiError(res, `POST /api/listeners → ${res.status}`);
  return (await res.json()) as ListenerSummary;
}

/** 斷開。沒在聽也是 204——要的結果是「現在沒在聽」，而那已經成立。 */
export async function stopListening(projectId: string): Promise<void> {
  const res = await fetch(`/api/listeners/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
  if (!res.ok) throw await toApiError(res, `DELETE /api/listeners/${projectId}`);
}

export async function listListeners(): Promise<ListenerSummary[]> {
  const res = await fetch('/api/listeners');
  if (!res.ok) throw await toApiError(res, `GET /api/listeners → ${res.status}`);
  return (await res.json()) as ListenerSummary[];
}

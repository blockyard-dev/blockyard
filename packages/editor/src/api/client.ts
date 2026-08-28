/**
 * 後端 API 客戶端（附錄 A）。
 *
 * 路徑一律相對：開發時 Vite 代理到 127.0.0.1:8787（`vite.config.ts`），打包後
 * 前端由同一個 process 提供（`api/app.py` 的 StaticFiles），兩邊都對。
 */
import type { Manifest } from '../types/manifest';
import type { BlockyProjectIR as ProjectIR } from '../types/project';

export async function fetchExtensions(signal?: AbortSignal): Promise<Manifest[]> {
  const res = await fetch('/api/extensions', { signal });
  if (!res.ok) {
    throw new Error(`GET /api/extensions → ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as Manifest[];
}

/**
 * `/api/projects/{id}` 的驗證錯誤形狀（`backend/blocky/api/errors.py`）。
 * `blockId` 有值時前端才知道要把哪一顆積木標紅（§8.4 第 4 步的驗收項）。
 */
export interface ApiErrorDetail {
  message: string;
  blockId?: string;
  path?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly detail?: ApiErrorDetail,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 把後端的錯誤 body 翻成 `ApiError`。`/api/runs` 走同一條（`api/runs.ts`）——
 * 422 的形狀由 `api/errors.py` 統一決定，前端也只該有一個地方認得它。 */
export async function toApiError(res: Response, fallback: string): Promise<ApiError> {
  try {
    const body = (await res.json()) as { detail?: ApiErrorDetail | string };
    const detail = typeof body.detail === 'string' ? { message: body.detail } : body.detail;
    return new ApiError(detail?.message ?? fallback, res.status, detail);
  } catch {
    return new ApiError(fallback, res.status);
  }
}

/** GET 一份專案。回傳 `null` 表示這個 id 還沒有專案（404）——呼叫端自己決定要不要視為「新專案」。 */
export async function fetchProject(id: string, signal?: AbortSignal): Promise<ProjectIR | null> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw await toApiError(res, `GET /api/projects/${id} → ${res.status} ${res.statusText}`);
  return (await res.json()) as ProjectIR;
}

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 存檔。**驗證通過才寫**是後端的規則（`api/projects.py`），這裡只是把
 * 422 的結構化錯誤（含 `blockId`）原樣往上丟，讓呼叫端能標紅那顆積木。
 *
 * 回傳的是 summary，不是整份專案——PUT 回應本來就只有這些（後端存的是
 * PUT 進去的原文，不會另外吐一份「驗證過的版本」回來，見
 * `storage/projects.py`）。呼叫端手上已經有剛剛送出去的那份，不必再要一次。
 */
export async function saveProject(
  id: string,
  project: ProjectIR,
  signal?: AbortSignal,
): Promise<ProjectSummary> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project),
    signal,
  });
  if (!res.ok) throw await toApiError(res, `PUT /api/projects/${id} → ${res.status} ${res.statusText}`);
  return (await res.json()) as ProjectSummary;
}

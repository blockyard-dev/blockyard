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

/** D28：右上角「金鑰」面板的一列——只有已設定／未設定，沒有明文。 */
export interface KeyEntry {
  extId: string;
  extName: string;
  key: string;
  label: string | null;
  envVar: string | null;
  configured: boolean;
  /** 末四碼，用來分辨「現在裝著的是哪一把」。太短的金鑰後端整個不給（D28）。 */
  suffix: string | null;
}

/**
 * 一把金鑰在前端的身分：`extId.key`。
 *
 * 這個字串在三個地方要對得起來（面板鎖定哪一把、工具箱那顆按鈕該不該出現、
 * store 裡那份「已經設定好的」名單），而三個地方各自寫一次 `${a}.${b}` 的
 * 話，哪天格式要變就只會改到其中兩個——症狀是按鈕不消失，而沒有人會認為那
 * 跟字串格式有關。
 */
export function keyId(entry: { extId: string; key: string }): string {
  return `${entry.extId}.${entry.key}`;
}

export async function fetchKeys(signal?: AbortSignal): Promise<KeyEntry[]> {
  const res = await fetch('/api/keys', { signal });
  if (!res.ok) throw await toApiError(res, `GET /api/keys → ${res.status} ${res.statusText}`);
  return (await res.json()) as KeyEntry[];
}

/** 寫一把。已經有值就覆寫——「換一把」跟「第一次填」是同一個動作。 */
export async function putKey(
  extId: string,
  key: string,
  value: string,
  signal?: AbortSignal,
): Promise<KeyEntry> {
  const path = `/api/keys/${encodeURIComponent(extId)}/${encodeURIComponent(key)}`;
  const res = await fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
    signal,
  });
  if (!res.ok) throw await toApiError(res, `PUT ${path} → ${res.status} ${res.statusText}`);
  return (await res.json()) as KeyEntry;
}

/**
 * 讀回**一把**的完整明文，給複製按鈕用。
 *
 * 刻意不是 `KeyEntry` 上的一個欄位：列表每開一次面板就打一次，把明文掛在
 * 上面等於讓它跟著每一次輪詢多走一趟。呼叫端拿到之後應該**直接送進剪貼簿**，
 * 不要存進 state、不要畫進 DOM。
 */
export async function revealKey(
  extId: string,
  key: string,
  signal?: AbortSignal,
): Promise<string> {
  const path = `/api/keys/${encodeURIComponent(extId)}/${encodeURIComponent(key)}/reveal`;
  const res = await fetch(path, { signal });
  if (!res.ok) throw await toApiError(res, `GET ${path} → ${res.status} ${res.statusText}`);
  return ((await res.json()) as { value: string }).value;
}

/** 拿掉一把。本來就沒有也是成功——這個端點描述的是結束狀態。 */
export async function deleteKey(extId: string, key: string, signal?: AbortSignal): Promise<void> {
  const path = `/api/keys/${encodeURIComponent(extId)}/${encodeURIComponent(key)}`;
  const res = await fetch(path, { method: 'DELETE', signal });
  if (!res.ok) throw await toApiError(res, `DELETE ${path} → ${res.status} ${res.statusText}`);
}

export interface ImportEnvResult {
  written: { extId: string; key: string; envVar: string }[];
  unmatched: string[];
}

/** 匯入 `.env` 原文。對不上宣告的行**列出來但不寫入**（D28）——回應只帶
 * 變數名稱，前端不該也拿不到它們的值。 */
export async function importEnvKeys(text: string, signal?: AbortSignal): Promise<ImportEnvResult> {
  const res = await fetch('/api/keys/import-env', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) {
    throw await toApiError(res, `POST /api/keys/import-env → ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as ImportEnvResult;
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

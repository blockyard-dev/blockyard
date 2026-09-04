/**
 * 後端 API 客戶端（附錄 A）。
 *
 * 路徑一律相對：開發時 Vite 代理到 127.0.0.1:8787（`vite.config.ts`），打包後
 * 前端由同一個 process 提供（`api/app.py` 的 StaticFiles），兩邊都對。
 */
import type { Manifest } from '../types/manifest';
import type { BlockyardProjectIR as ProjectIR } from '../types/project';

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
 * `/api/projects/{id}` 的驗證錯誤形狀（`backend/blockyard/api/errors.py`）。
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

// --------------------------------------------------------------------------
// 從電腦匯入 `.zip` 積木包（§15 P3 第 2 步、§12.1）
// --------------------------------------------------------------------------

/** 靜態掃描命中的一行（§12.1）。`declared: false` = manifest 沒宣告這一項權限。 */
export interface ImportFinding {
  path: string;
  line: number;
  message: string;
  permission: string | null;
  declared: boolean;
}

/** 審閱畫面的一整份資料。後端的 `extensions/review.py` 決定它攤開什麼。 */
export interface ImportReview {
  /** 這份暫存的編號。按下安裝或取消時帶回去——**上傳只有一次**。 */
  token: string;
  id: string;
  name: string;
  version: string;
  author: string | null;
  description: string | null;
  permissions: string[];
  requirements: string[];
  blocks: { opcode: string; text: string }[];
  panels: { id: string; title: string }[];
  config: { key: string; label: string | null; type: string; envVar: string | null }[];
  /** `open_url` 按鈕會開到哪裡去（§7.2 說這要進審閱畫面）。 */
  urls: string[];
  files: { path: string; size: number }[];
  sources: { path: string; text: string; truncated: boolean }[];
  /** 文字檔，但沒攤開（超出預算或讀不成文字）。**列出來，不是藏起來。** */
  omitted: string[];
  findings: ImportFinding[];
  /** 這台機器上已經有同 id 的包（§16 Q24 還沒答，所以裝不進去）。 */
  installed: { version: string } | null;
}

/**
 * 上傳一個 `.zip`，拿回審閱資料。**這一步還沒有裝任何東西。**
 *
 * body 就是那個檔案本身（不是 `FormData`）：這條路上只有一個檔案、沒有別的
 * 欄位，而 multipart 會讓後端多一個相依、前端多一層包裝，換來的是一個沒有人
 * 用得到的「還可以再帶幾個欄位」。
 */
export async function inspectExtensionZip(
  file: Blob,
  signal?: AbortSignal,
): Promise<ImportReview> {
  const res = await fetch('/api/extensions/import', { method: 'POST', body: file, signal });
  if (res.status === 404 || res.status === 405) throw new ApiError(STALE_BACKEND, res.status);
  if (!res.ok) throw await toApiError(res, `POST /api/extensions/import → ${res.status}`);
  return (await res.json()) as ImportReview;
}

/**
 * 「後端還沒重啟」在這條路上長什麼樣子（design.md §14.1）。
 *
 * 路由是在 `create_app()` 建 app 時註冊的，所以改了後端而沒重啟時這個端點根本
 * 不存在。而**症狀會指錯主詞**：`packages/editor/dist` 存在時，後端的 `/` 底下
 * 掛著 `StaticFiles`，它只收 GET/HEAD——一個打不中任何 API 路由的 POST 就掉進
 * 那個 catch-all，回的是 `{"detail": "Method Not Allowed"}`。畫在畫面上就是一句
 * 「Method Not Allowed」，聽起來像「這個端點不收 POST」，而真正的意思是「這個
 * 端點不存在」。
 *
 * **只有這條路認它。** `installExtension` 的 404 有另一個合法的意思（那份暫存
 * 過期或被取消了，而後端說得出那句話），把兩者混成同一句就是拿一個猜測蓋掉一句
 * 準確的話。這裡沒有那個問題：`POST /api/extensions/import` 只會回
 * 200 / 400 / 422，所以 404 與 405 都只剩一種解釋。
 *
 * 收件人是**寫這個工具的人**（同面板那句「3 秒還沒 ready」）：使用者裝一個包時
 * 碰不到這條路，會碰到的是每次改完後端的自己。
 */
const STALE_BACKEND =
  '後端沒有「匯入」這個端點——多半是改了後端還沒重啟（新的路由要重新啟動才會註冊）。';

/** 按下安裝。回傳裝好的那個包叫什麼——註冊仍然走 `GET /api/extensions`。 */
export async function installExtension(
  token: string,
  signal?: AbortSignal,
): Promise<{ id: string; name: string; version: string }> {
  const path = `/api/extensions/import/${encodeURIComponent(token)}`;
  const res = await fetch(path, { method: 'POST', signal });
  if (!res.ok) throw await toApiError(res, `POST ${path} → ${res.status}`);
  return (await res.json()) as { id: string; name: string; version: string };
}

/** 按下取消（或關掉審閱畫面）。**失敗不要說**——使用者已經走掉了，而留下來的
 * 那個暫存目錄下一次有人匯入時會被收掉（後端的 `purge_stale`）。 */
export function cancelExtensionImport(token: string): void {
  void fetch(`/api/extensions/import/${encodeURIComponent(token)}`, { method: 'DELETE' }).catch(
    () => {},
  );
}

/** 讀不進來的積木包（`GET /api/extensions/problems`）。正常情況下是空陣列。 */
export interface ExtensionProblem {
  dir: string;
  message: string;
}

export async function fetchExtensionProblems(signal?: AbortSignal): Promise<ExtensionProblem[]> {
  const res = await fetch('/api/extensions/problems', { signal });
  if (!res.ok) return [];
  return (await res.json()) as ExtensionProblem[];
}

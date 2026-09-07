/**
 * 後端 API 客戶端（附錄 A）。
 *
 * 路徑一律相對：開發時 Vite 代理到 127.0.0.1:8787（`vite.config.ts`），打包後
 * 前端由同一個 process 提供（`api/app.py` 的 StaticFiles），兩邊都對。
 */
import { projectQuery } from '../project/current';
import type { Manifest } from '../types/manifest';
import type { BlockyardProjectIR as ProjectIR } from '../types/project';
import { currentLocale, t } from '../i18n';

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

/**
 * 這個專案的金鑰（§16 Q23）。
 *
 * **每一條路都帶 `?project=`**：一把金鑰屬於一個專案裡的一個積木包，所以
 * 「哪一把」這個問題在沒有專案的情況下答不完整——兩個專案各接一個 Discord bot
 * 時，少了那一格就是後填的蓋掉先填的。主詞從 `project/current.ts` 讀，不從
 * 呼叫端傳：金鑰面板、工具箱那顆按鈕、`open_config` 三個地方各自傳一次的話，
 * 哪天有一處忘了帶，症狀是「我明明填過了」。
 */
export async function fetchKeys(signal?: AbortSignal): Promise<KeyEntry[]> {
  const res = await fetch(`/api/keys?${projectQuery()}`, { signal });
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
  const path = `/api/keys/${encodeURIComponent(extId)}/${encodeURIComponent(key)}?${projectQuery()}`;
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
  const path = `/api/keys/${encodeURIComponent(extId)}/${encodeURIComponent(key)}/reveal?${projectQuery()}`;
  const res = await fetch(path, { signal });
  if (!res.ok) throw await toApiError(res, `GET ${path} → ${res.status} ${res.statusText}`);
  return ((await res.json()) as { value: string }).value;
}

/** 拿掉一把。本來就沒有也是成功——這個端點描述的是結束狀態。 */
export async function deleteKey(extId: string, key: string, signal?: AbortSignal): Promise<void> {
  const path = `/api/keys/${encodeURIComponent(extId)}/${encodeURIComponent(key)}?${projectQuery()}`;
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
  const res = await fetch(`/api/keys/import-env?${projectQuery()}`, {
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
  code?: string;
  params?: Record<string, unknown>;
  message?: string;
  hintCode?: string;
  hintParams?: Record<string, unknown>;
  hint?: string;
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
    return new ApiError(detail ? translatedError(detail) : fallback, res.status, detail);
  } catch {
    return new ApiError(fallback, res.status);
  }
}

export function translatedError(detail: ApiErrorDetail): string {
  const { message, hint } = translatedErrorParts(detail);
  return hint ? `${message}（${hint}）` : message;
}

export function translatedErrorParts(detail: ApiErrorDetail): { message: string; hint?: string } {
  const fallback = detail.message ?? t('common.noMessage');
  let message = fallback;
  // The backend fallback is the full Traditional Chinese sentence. Keep that richer
  // wording in the baseline locale; English uses stable codes and never exposes it.
  if (currentLocale() === 'en') switch (detail.code) {
    case 'project.not_found':
      message = t('error.project.notFound', { projectId: String(detail.params?.projectId ?? '') });
      break;
    case 'run.not_found':
      message = t('error.run.notFound', { runId: String(detail.params?.runId ?? '') });
      break;
    case 'request.validation': message = t('error.requestValidation'); break;
    case 'validation.invalid': message = t('error.validation'); break;
    case 'http.bad_request': message = t('error.http.badRequest'); break;
    case 'http.unauthorized': message = t('error.http.unauthorized'); break;
    case 'http.forbidden': message = t('error.http.forbidden'); break;
    case 'http.not_found': message = t('error.http.notFound'); break;
    case 'http.conflict': message = t('error.http.conflict'); break;
    case 'http.too_large': message = t('error.http.tooLarge'); break;
    case 'http.unsupported_media': message = t('error.http.unsupportedMedia'); break;
    case 'http.unprocessable': message = t('error.http.unprocessable'); break;
    case 'error': message = t('error.runtime.generic'); break;
    case 'type': message = t('error.runtime.type'); break;
    case 'index': message = t('error.runtime.index'); break;
    case 'key': message = detail.params?.key
      ? t('error.runtime.keyNamed', { key: String(detail.params.key) })
      : t('error.runtime.key'); break;
    case 'undefined_variable': message = detail.params?.name
      ? t('error.runtime.undefinedVariableNamed', { name: String(detail.params.name) })
      : t('error.runtime.undefinedVariable'); break;
    case 'param_out_of_scope': message = detail.params?.name
      ? t('error.runtime.paramNamed', { name: String(detail.params.name) })
      : t('error.runtime.paramScope'); break;
    case 'template': message = t('error.runtime.template'); break;
    case 'recursion_limit': message = detail.params?.limit
      ? t('error.runtime.recursionLimit', { limit: String(detail.params.limit) })
      : t('error.runtime.recursion'); break;
    case 'unknown_block': message = t('error.runtime.unknownBlock'); break;
    case 'extension': message = t('error.runtime.extension'); break;
    case 'missing_secret': message = detail.params?.extName && detail.params?.label
      ? t('error.runtime.missingSecretNamed', {
          extension: String(detail.params.extName), label: String(detail.params.label),
        })
      : t('error.runtime.missingSecret'); break;
    case 'invalid_secret': message = t('error.runtime.invalidSecret'); break;
    // User-thrown and unknown/legacy errors are data, so preserve their original message.
  }
  const hint = detail.hintCode === 'project.save_before_run'
    ? t('error.project.saveBeforeRun')
    : detail.hintCode === 'project.save_before_listen'
      ? t('error.project.saveBeforeListen')
      : currentLocale() === 'en' && detail.hintCode
        ? undefined
        : detail.hint;
  return hint ? { message, hint } : { message };
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
  preview: string | null;
}

/** 保存卡片封面。專案本體已成功時，這份衍生圖片才會送出。 */
export async function saveProjectPreview(id: string, preview: Blob): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/preview`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/webp' },
    body: preview,
  });
  if (!res.ok) {
    throw await toApiError(res, `PUT /api/projects/${id}/preview → ${res.status} ${res.statusText}`);
  }
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

/** 安裝摘要。後端的 `extensions/review.py` 只讀宣告與來源。 */
export interface ImportReview {
  /** 這份暫存的編號。按下安裝或取消時帶回去——**上傳只有一次**。 */
  token: string;
  id: string;
  name: string;
  version: string;
  author: string | null;
  description: string | null;
  origin: { origin: string; label: string; url: string | null; ref: string | null; commit: string | null };
  editor: { entry: string; apiVersion: number } | null;
  requirements: string[];
  blocks: { opcode: string; text: string }[];
  panels: { id: string; name: string }[];
  config: { key: string; label: string | null; type: string; envVar: string | null }[];
  /** `open_url` 按鈕會開到哪裡去（§7.2 說這要進審閱畫面）。 */
  urls: string[];
  /**
   * 這台機器上已經有同 id 的包——**所以按下去是一次更新**，而更新多一段差集
   * （`docs/extension-design.md` §4）。
   */
  installed: { version: string; diff: ExtensionDiff; editor?: { entry: string; apiVersion: number } | null } | null;
}

/**
 * 這一版跟手上那一版差在哪（後端的 `extensions/diff.py`）。
 *
 * **「而畫布上有」那半句不在這份資料裡。** 後端說得出「這一版少了
 * `http.head`」，數得出「而你正在用它 3 次」的是前端——那份工作區還沒存檔。
 * 兩邊各答一半，合起來才是 §4 那張表。
 */
export interface ExtensionDiff {
  version: { from: string; to: string };
  /** 這一版沒有的積木。`why` 是 `missing`（不見了）或 `shape`（形狀變了）。 */
  gone: { opcode: string; text: string; why: 'missing' | 'shape' }[];
  changed: {
    opcode: string;
    text: string;
    argsAdded: { name: string; required: boolean }[];
    argsRemoved: string[];
    argsRetyped: { name: string; from: string; to: string }[];
    textChanged: boolean;
    nowDeprecated: boolean;
  }[];
  added: { opcode: string; text: string }[];
  requirementsChanged: boolean;
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
  const res = await fetch('/api/extensions/import', {
    method: 'POST',
    body: file,
    // 檔名走 header，因為 body 就是那個 `.zip` 的 bytes（後端的 `api/imports.py`）。
    // 它只有一個用途：收據上那一行「從 greet.zip 裝的」（§2）。**送不出去也不會
    // 壞**——後端洗不出檔名時會退回一句「從這台電腦上傳」。
    //
    // `encodeURIComponent`：header 的值只能是 latin-1，而檔名可以是「打招呼.zip」。
    headers: filenameHeader(file),
    signal,
  });
  if (res.status === 404 || res.status === 405) throw new ApiError(staleBackend(), res.status);
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
const staleBackend = () => t('error.staleBackend');

/**
 * 貼一個 GitHub 網址，拿回**同一份**審閱資料（§6）。
 *
 * `.zip` 與 GitHub 只差第一步——怎麼把 bytes 弄到後端的暫存目錄。之後那一段
 * 一個字都不一樣，不然「從 GitHub 裝的包比較少檢查」遲早是真的（§3）。
 */
export async function inspectExtensionGithub(
  url: string,
  signal?: AbortSignal,
): Promise<ImportReview> {
  const res = await fetch('/api/extensions/import/github', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  });
  if (res.status === 404 || res.status === 405) throw new ApiError(staleBackend(), res.status);
  if (!res.ok) throw await toApiError(res, `POST /api/extensions/import/github → ${res.status}`);
  return (await res.json()) as ImportReview;
}

/**
 * 按下安裝（或更新）。回傳裝好的那個包叫什麼——註冊仍然走 `GET /api/extensions`。
 *
 * `replaced` 有值時這是一次更新：換掉的是哪一版、舊的那一份去了垃圾桶的哪裡。
 * 那個路徑是「更新完發現更糟」唯一的線索，所以它要一路走到畫面上。
 */
export async function installExtension(
  token: string,
  signal?: AbortSignal,
): Promise<InstallResult> {
  const path = `/api/extensions/import/${encodeURIComponent(token)}`;
  const res = await fetch(path, { method: 'POST', signal });
  if (!res.ok) throw await toApiError(res, `POST ${path} → ${res.status}`);
  return (await res.json()) as InstallResult;
}

export interface InstallResult {
  id: string;
  name: string;
  version: string;
  replaced: { version: string; trash: string } | null;
}

/** 按下取消（或關掉審閱畫面）。**失敗不要說**——使用者已經走掉了，而留下來的
 * 那個暫存目錄下一次有人匯入時會被收掉（後端的 `purge_stale`）。 */
export function cancelExtensionImport(token: string): void {
  void fetch(`/api/extensions/import/${encodeURIComponent(token)}`, { method: 'DELETE' }).catch(
    () => {},
  );
}

/**
 * 解除安裝：**把這個包從磁碟上搬進垃圾桶**（§5）。
 *
 * **與「從工具箱移除」是兩個動詞**（§1 的三層帳）：那一個只動瀏覽器裡的一份
 * 名單、隨時可以再加回來，所以它根本不會走到後端。這一個動的是磁碟。
 *
 * 回傳舊的那一份去了哪裡——那是拔錯了唯一的退路。
 */
export async function uninstallExtension(
  extId: string,
  signal?: AbortSignal,
): Promise<{ id: string; version: string; trash: string }> {
  const path = `/api/extensions/${encodeURIComponent(extId)}`;
  const res = await fetch(path, { method: 'DELETE', signal });
  if (!res.ok) throw await toApiError(res, `DELETE ${path} → ${res.status}`);
  return (await res.json()) as { id: string; version: string; trash: string };
}

/** 下載一份可直接走「從電腦(.zip)」重新安裝的積木包；環境與安裝收據不在裡面。 */
export function downloadExtension(extId: string): void {
  const a = document.createElement('a');
  a.href = `/api/extensions/${encodeURIComponent(extId)}/export`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * 隨 Blockyard 出貨、而且**被使用者拔掉過**的那幾個包。正常情況下是空陣列。
 *
 * 它們的出貨來源在 site-packages 底下，使用者沒有第二條路把它們裝回來——而
 * P3 的驗收句是「全程不碰檔案總管」。
 */
export async function fetchUninstalledOfficial(
  signal?: AbortSignal,
): Promise<{ id: string; name: string; version: string }[]> {
  const res = await fetch('/api/extensions/uninstalled', { signal });
  if (!res.ok) return [];
  return (await res.json()) as { id: string; name: string; version: string }[];
}

/** 把一個拔掉過的官方包鋪回去。**不走審閱畫面**——那是這個 app 自己出貨的
 * 那一份，使用者第一次啟動時本來就被鋪過一次。 */
export async function reinstallOfficial(extId: string, signal?: AbortSignal): Promise<void> {
  const path = `/api/extensions/${encodeURIComponent(extId)}/reinstall`;
  const res = await fetch(path, { method: 'POST', signal });
  if (!res.ok) throw await toApiError(res, `POST ${path} → ${res.status}`);
}

/** 讀不進來的積木包（`GET /api/extensions/problems`）。正常情況下是空陣列。 */
/** 檔名塞得進一個 HTTP header 的樣子。認不得就不送這個 header。 */
function filenameHeader(file: Blob): Record<string, string> {
  const name = file instanceof File ? file.name : '';
  return name ? { 'X-Blockyard-Filename': encodeURIComponent(name) } : {};
}

export interface ExtensionProblem {
  dir: string;
  message: string;
}

export async function fetchExtensionProblems(signal?: AbortSignal): Promise<ExtensionProblem[]> {
  const res = await fetch('/api/extensions/problems', { signal });
  if (!res.ok) return [];
  return (await res.json()) as ExtensionProblem[];
}

/**
 * 一張收據：**這個資料夾是誰搬進來的**（`docs/extension-design.md` §2）。
 *
 * 後端的 `extensions/receipt.py` 寫、`GET /api/extensions/receipts` 讀。
 */
export interface ExtensionReceipt {
  extId: string;
  origin: 'official' | 'zip' | 'github' | 'registry';
  /** 給人看的一行：`greet.zip`、`隨 Blockyard 出貨`。 */
  label: string;
  url: string | null;
  ref: string | null;
  commit: string | null;
  version: string;
  digest: string;
  /** ISO 8601、UTC，結尾是 `Z`。 */
  installedAt: string;
}

/**
 * **沒有收據的包不在這份清單裡**，而那就是答案：沒有收據 = 使用者自己放的 =
 * 我們不碰。所以問的是「這個 id 在不在名單上」，不是去讀某個欄位。
 */
export async function fetchExtensionReceipts(signal?: AbortSignal): Promise<ExtensionReceipt[]> {
  const res = await fetch('/api/extensions/receipts', { signal });
  if (!res.ok) return [];
  return (await res.json()) as ExtensionReceipt[];
}

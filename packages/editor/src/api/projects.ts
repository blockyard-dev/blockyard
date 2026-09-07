/**
 * 專案的列表、新建、改名、刪除，以及帶出門／收下來那兩條
 * （`docs/project-storage-design.md`）。
 *
 * **與 `client.ts` 的 `fetchProject`／`saveProject` 分開**：那兩條講的是「這一份
 * 專案的內容」，是編輯器每次存檔都會走的路；這裡講的是「有哪些專案、它們怎麼
 * 進出這台機器」。兩件事的讀者不一樣（前者是畫布，後者是那一頁面板），而合在
 * 一個檔案裡會讓「存檔」跟「匯出」看起來像同一階的東西。
 */
import { toApiError, type ProjectSummary } from './client';
import type { ImportReview } from './client';
import { t } from '../i18n';

export type { ProjectSummary };

export async function listProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
  const res = await fetch('/api/projects', { signal });
  if (!res.ok) throw await toApiError(res, `GET /api/projects → ${res.status}`);
  return (await res.json()) as ProjectSummary[];
}

/**
 * 開一個新專案。**id 由後端給**（§3：opaque、產生一次就不變）。
 *
 * 前端送的只有名字。讓前端挑 id 的話，那個字串遲早會是名字的 slug，而那會讓
 * 「改名」看起來應該跟著改 id——那正是這條規則要擋的事（keyring 裡那幾把金鑰
 * 掛在 id 上）。
 */
export async function createProject(name: string, signal?: AbortSignal): Promise<ProjectSummary> {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
    signal,
  });
  if (!res.ok) throw await toApiError(res, `POST /api/projects → ${res.status}`);
  return (await res.json()) as ProjectSummary;
}

/** 改名。**只改名字**——id、積木、金鑰、執行歷史一個都不動。 */
export async function renameProject(
  id: string,
  name: string,
  signal?: AbortSignal,
): Promise<ProjectSummary> {
  const path = `/api/projects/${encodeURIComponent(id)}`;
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
    signal,
  });
  if (!res.ok) throw await toApiError(res, `PATCH ${path} → ${res.status}`);
  return (await res.json()) as ProjectSummary;
}

/**
 * 複製一份。**新的 id、同一份畫布**（後端的 `copy_project`）。
 *
 * 名字由後端取（「X 的副本」，撞名往下數）：撞不撞名要問「這台機器上還有誰」，
 * 而列表這一頁手上那份是上一次 reload 的快照。
 */
export async function copyProject(id: string, signal?: AbortSignal): Promise<ProjectSummary> {
  const path = `/api/projects/${encodeURIComponent(id)}/copy`;
  const res = await fetch(path, { method: 'POST', signal });
  if (!res.ok) throw await toApiError(res, `POST ${path} → ${res.status}`);
  return (await res.json()) as ProjectSummary;
}

/** 刪掉一個專案。執行歷史、webhook 網址與這個專案的金鑰一起走（後端做的）。 */
export async function deleteProject(id: string, signal?: AbortSignal): Promise<void> {
  const path = `/api/projects/${encodeURIComponent(id)}`;
  const res = await fetch(path, { method: 'DELETE', signal });
  if (!res.ok) throw await toApiError(res, `DELETE ${path} → ${res.status}`);
}

// --------------------------------------------------------------------------
// 匯出（§5、§6、§9）
// --------------------------------------------------------------------------

/** 那個勾選框旁邊的一列：**這次會走出去哪一把**。只有末四碼（D28）。 */
export interface ProjectSecret {
  extId: string;
  extName: string;
  key: string;
  label: string | null;
  envVar: string | null;
  configured: boolean;
  suffix: string | null;
  /** `.env` 是靠變數名對回去的。沒有 `envVar` 的那一把寫出去也餵不回來。 */
  exportable: boolean;
}

/**
 * **這次會走出去什麼**：帶哪幾個積木包的原始碼、以及哪幾把金鑰（§5、§6）。
 *
 * 從後端算而不是讓前端數：使用者在面板上匯出的可能是**另一份**專案（不是現在
 * 打開的那個），而那份 IR 前端手上根本沒有。
 *
 * 讀不到就當空的：那個面板仍然畫得出來，只是少了那兩句摘要——而匯出本身
 * 不靠它們。
 */
export interface ExportPlan {
  packs: { id: string; name: string; version: string }[];
  secrets: ProjectSecret[];
}

export async function fetchExportPlan(id: string, signal?: AbortSignal): Promise<ExportPlan> {
  const path = `/api/projects/${encodeURIComponent(id)}/export-plan`;
  const res = await fetch(path, { signal });
  if (!res.ok) return { packs: [], secrets: [] };
  return (await res.json()) as ExportPlan;
}

/**
 * 走瀏覽器下載那一條。**它永遠成立**：不需要 tkinter、不需要後端與瀏覽器同一
 * 台機器，落在使用者的下載資料夾裡（§9 第 4 條）。
 *
 * 用一個看不見的 `<a download>` 而不是 `fetch` + `URL.createObjectURL`：後者要
 * 把整份 bundle 讀進記憶體再造一個 blob，而換到的東西是零——檔名由後端的
 * `Content-Disposition` 決定，兩條路都一樣。
 */
export function downloadExport(id: string, kind: 'bundle' | 'env'): void {
  const path =
    kind === 'env'
      ? `/api/projects/${encodeURIComponent(id)}/export/env`
      : `/api/projects/${encodeURIComponent(id)}/export`;
  const a = document.createElement('a');
  a.href = path;
  // `download` 不帶值：檔名由後端那個 header 說了算（它才知道專案叫什麼）。
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 「瀏覽…」開出來的那一個位置。`token` 是 `null` 代表使用者按了取消。 */
export interface SaveTarget {
  available: boolean;
  token: string | null;
  /** 畫在那一格**唯讀**欄位裡的字。它是回執，不是輸入框。 */
  display: string | null;
}

/**
 * 開一個原生的「另存新檔」（§9）。
 *
 * **路徑從頭到尾不經過這個瀏覽器的手**：對話框回一個路徑 → 後端記在一個一次性
 * token 底下 → 匯出時只送 token。少了這條，`POST {"path": …}` 就是一個從網頁
 * 打得到的任意寫入端點。
 */
export async function openSaveDialog(
  suggestedName: string,
  signal?: AbortSignal,
): Promise<SaveTarget> {
  const res = await fetch('/api/files/save-dialog', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ suggestedName, extension: '.blockyard', title: t('export.title') }),
    signal,
  });
  if (!res.ok) throw await toApiError(res, `POST /api/files/save-dialog → ${res.status}`);
  return (await res.json()) as SaveTarget;
}

/** 那顆「瀏覽…」該不該畫。問一次就好——一次啟動之內答案不會變。 */
export async function fetchDialogAvailable(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch('/api/files/dialog-available', { signal });
    if (!res.ok) return false;
    return ((await res.json()) as { available: boolean }).available;
  } catch {
    return false;
  }
}

/** 寫到「瀏覽…」選好的那個位置。`secrets` 為真時**另外**寫一個 `.env`（§6）。 */
export async function exportToPath(
  id: string,
  token: string,
  secrets: boolean,
  signal?: AbortSignal,
): Promise<{ path: string; envPath: string | null }> {
  const path = `/api/projects/${encodeURIComponent(id)}/export`;
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, secrets }),
    signal,
  });
  if (!res.ok) throw await toApiError(res, `POST ${path} → ${res.status}`);
  return (await res.json()) as { path: string; envPath: string | null };
}

// --------------------------------------------------------------------------
// 匯入（§7）
// --------------------------------------------------------------------------

/**
 * bundle 裡的一個積木包，以及**這台機器對它的答案**。
 *
 * * `same`——已經裝了而且 digest 一樣。**完全不出現在畫面上**：沒有任何新的
 *   程式碼要進來。
 * * `different`——裝過了、但不是同一份。**預設跳過，並且說出來**：覆蓋是更新，
 *   不能靠匯入偷渡。
 * * `new`——沒裝過。進審閱，一個包一頁，而 `review` 就是 `.zip` 那條路上的
 *   同一份資料。
 */
export interface BundlePack {
  id: string;
  name: string;
  version: string;
  digest: string;
  status: 'same' | 'different' | 'new';
  installedVersion: string | null;
  review?: ImportReview;
}

export interface BundleReview {
  token: string;
  name: string;
  exportedAt: string | null;
  packs: BundlePack[];
  /** 這台機器上已經有的同名專案（§10）。id 是 opaque 的，所以一定並存。 */
  sameName: ProjectSummary[];
}

/** 上傳一份 `.blockyard`，拿回審閱資料。**這一步還沒裝任何東西、也還沒開專案。** */
export async function inspectBundle(file: File, signal?: AbortSignal): Promise<BundleReview> {
  const res = await fetch('/api/projects/import', {
    method: 'POST',
    body: file,
    // 檔名走 header（body 就是那份 bytes）。它只有一個用途：收據上那一行
    // 「從 我的專案.blockyard 裝的」。header 的值只能是 latin-1，而檔名可以是
    // 中文，所以送的是 `encodeURIComponent` 過的。
    headers: file.name ? { 'X-Blockyard-Filename': encodeURIComponent(file.name) } : {},
    signal,
  });
  if (!res.ok) throw await toApiError(res, `POST /api/projects/import → ${res.status}`);
  return (await res.json()) as BundleReview;
}

/** 裝這份 bundle 裡的一個包。走的是與 `.zip` 完全相同的那條安裝管線。 */
export async function installBundledPack(
  token: string,
  extId: string,
  signal?: AbortSignal,
): Promise<{ id: string; name: string; version: string }> {
  const path = `/api/projects/import/${encodeURIComponent(token)}/extensions/${encodeURIComponent(extId)}`;
  const res = await fetch(path, { method: 'POST', signal });
  if (!res.ok) throw await toApiError(res, `POST ${path} → ${res.status}`);
  return (await res.json()) as { id: string; name: string; version: string };
}

/** 開出那個專案。**沒裝的包不擋這一步**——那些積木是佔位符，不是錯誤。 */
export async function finishBundleImport(
  token: string,
  signal?: AbortSignal,
): Promise<ProjectSummary & { reusedId: boolean }> {
  const path = `/api/projects/import/${encodeURIComponent(token)}`;
  const res = await fetch(path, { method: 'POST', signal });
  if (!res.ok) throw await toApiError(res, `POST ${path} → ${res.status}`);
  return (await res.json()) as ProjectSummary & { reusedId: boolean };
}

/** 按下取消。**失敗不要說**——使用者已經走掉了（同 `cancelExtensionImport`）。 */
export function cancelBundleImport(token: string): void {
  void fetch(`/api/projects/import/${encodeURIComponent(token)}`, { method: 'DELETE' }).catch(
    () => {},
  );
}

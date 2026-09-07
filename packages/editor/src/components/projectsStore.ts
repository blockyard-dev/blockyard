/**
 * 主選單那份列表（`docs/project-storage-design.md` §4）。
 *
 * **這裡只剩下資料。** 「現在開著哪一份」與「怎麼換一份」都搬到網址上了
 * （`project/routes.ts`）：前者是 `/p/<id>`，後者是一次真的導覽。
 *
 * **換一份專案是整頁載入，不是換一個 state。** 那不是偷懶，是這個編輯器的狀態
 * 真的散在很多地方：Blockly 的工作區與註冊表、執行中的 WebSocket、監聽狀態、
 * 值氣泡的裝飾器、下拉的 60 秒快取。要在原地換掉一個專案，就得為上面每一樣
 * 東西回答一次「它該被清成什麼樣子」——而漏掉任何一個的症狀，都是「這個畫面
 * 上有一半是上一個專案的東西」，那是最難查的一種。整頁載入讓那份清單只有一項，
 * 而搬到網址上之後它順便是一次上一頁按得回來的導覽。
 */
import { create } from 'zustand';
import { listProjects, type ProjectSummary } from '../api/projects';
import { listActiveProjects } from '../api/triggers';
import { date, t } from '../i18n';

interface ProjectsUiState {
  projects: ProjectSummary[];
  /**
   * 現在正在監聽的那幾份（§9.2 的 active）。
   *
   * **放在這裡而不是各張卡自己去問**：那是一張表的內容，一次問完就有；一頁
   * 二十張卡各問一次，只會得到二十個同樣的答案跟二十個請求。
   *
   * 它跟著 `reload` 走，所以複製、刪除、改名之後都會重新對過一次——那幾個動作
   * 本來就會動到「哪幾份還在」。
   */
  listening: Set<string>;
  loading: boolean;
  /** 讀列表失敗那一句。**不擋面板**——使用者至少還按得到「新專案」。 */
  error: string | null;
  /** 列表上的耳朵切換成功後，就地更新那張卡，不必為一個布林值重讀整頁。 */
  setListening(projectId: string, on: boolean): void;
  reload(signal?: AbortSignal): Promise<void>;
}

export const useProjectsUi = create<ProjectsUiState>((set) => ({
  projects: [],
  listening: new Set(),
  // **開場就是讀取中**：第一次 render 時列表還沒回來，而 `false` 會讓那一格先
  // 畫一次「還沒有任何專案」——一句在那一刻是錯的話。
  loading: true,
  error: null,
  setListening: (projectId, on) =>
    set((state) => {
      const listening = new Set(state.listening);
      if (on) listening.add(projectId);
      else listening.delete(projectId);
      return { listening };
    }),
  reload: async (signal) => {
    set({ loading: true });
    try {
      const [projects, active] = await Promise.all([
        listProjects(signal),
        // **監聽狀態讀不到不會拖垮列表。** 這一頁的主體是「這台機器上有哪些
        // 專案」，而角標是旁註；讓旁註的失敗吃掉整頁，等於把主次顛倒過來。
        // 讀不到就當作沒有人在聽——那是這一頁本來的樣子。
        listActiveProjects(signal).catch(() => []),
      ]);
      set({
        projects,
        // 後端只會把 active 的列進來，這裡再濾一次是因為 `active` 是回應上明講
        // 的一欄——照著它讀，比依賴「有出現就等於開著」穩。
        listening: new Set(active.filter((s) => s.active).map((s) => s.projectId)),
        error: null,
      });
    } catch (e) {
      if (signal?.aborted) return;
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },
}));

/** 給列表用的一行日期。**不畫秒**——它回答的是「哪一份是我最近在弄的」。 */
export function whenText(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const now = new Date();
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  const time = date(at, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return t('projects.today', { time });
  return date(at, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * `useRunStore`（§8.2）：runId、thread 狀態、blockId → 執行狀態的 map、log buffer。
 *
 * §8.3 那張表的左欄（事件）在這裡變成狀態，右欄（UI 表現）留給 `decorate.ts`
 * 與各個元件。切開的理由是**一個事件會影響好幾個地方**：`block.error` 同時要
 * 標紅積木、進 log、讓 topbar 顯示失敗——如果讓 WebSocket 的 handler 直接去
 * 碰 Blockly 與 DOM，這三件事就再也拆不開了。
 *
 * `blocks` 是一個 Map 而不是 React state 樹：一個窗口可能一次改幾百顆積木的
 * 狀態，逐顆 setState 會讓 React 在 50ms 內重繪幾百次。整批換掉一個 Map，
 * 訂閱它的元件只重繪一次。
 */
import { create } from 'zustand';
import type {
  BlockError,
  BlockErrorAction,
  ProjectFrame,
  RunEndStatus,
  RunFrame,
  RunSummary,
} from '../api/runs';

/** §8.3 的積木狀態。同一顆積木同時只會是其中一種。 */
export type BlockPhase = 'running' | 'hot' | 'done' | 'error';

export interface BlockState {
  phase: BlockPhase;
  /** reporter 的回傳值（`block.exit` 帶 `value` 的才有）。 */
  value?: unknown;
  truncated?: boolean;
  /** `block.hot` 的累計次數（§6.2）。 */
  count?: number;
  error?: BlockError;
  /** 用來讓氣泡淡出：值換過幾次。同一個值連續出現時也要重新開始計時。 */
  seq: number;
}

export interface LogLine {
  id: number;
  level: string;
  text: string;
  blockId?: string | null;
  /** 這一列**可以按**（`RunPanel` 畫成按鈕）。只有 `block.error` 會帶。 */
  action?: BlockErrorAction;
}

/** §8.2：log buffer 上限 5000 筆，環形。 */
const LOG_LIMIT = 5000;

/**
 * 一格宣告面板留幾則訊息。
 *
 * 這份記錄的用途是**重播**：(a) 路線把面板的狀態放在瀏覽器，而 iframe 換分頁或
 * 搬進彈出視窗一定會重載（規格）。重播讓那件事不痛，同時解掉「面板還沒開就先
 * 送」——一個 outbox，`ready` 之後沖出去。
 *
 * 有上限，因為它是一個 `重複 10000 次` 就會長到一萬則的東西。丟最舊的，於是
 * 重播出來的是「最近這幾則」——而那正是 §6.2 那條規則的形狀：丟掉可以，靜靜地
 * 丟掉不行（丟了就標 `truncated`，畫面上會說）。
 *
 * 這個數字比「一次執行畫幾個點」要大一個級距，因為**它跨 Run 累積**（見
 * `emptyRun` 的說明）：一次 60 點的圖跑十次就是 600 則。
 */
const OUTBOX_LIMIT = 2000;

export type RunStatus = 'idle' | 'starting' | 'running' | RunEndStatus;

interface RunState {
  runId: string | null;
  /**
   * 前端**自己接著** `/ws/run` 的那個 Run（`App.tsx` 的 `attachSocket`）。
   *
   * 一個 Run 的事件只能從一個地方進來，而這一格就是「哪一個 Run 已經有主了」
   * ——`applyProject` 靠它把重複的那一份擋掉。見 `own()`。
   */
  ownedRunId: string | null;
  status: RunStatus;
  /** 連不上、啟動失敗之類的整體訊息。積木層級的錯誤不放這裡。 */
  message: string | null;
  blocks: Map<string, BlockState>;
  variables: Map<string, unknown>;
  /**
   * 積木包**宣告**的面板收到的訊息，`extId/panelId` → 這次 Run 的全部訊息。
   *
   * key 是 `extId/panelId`，也就是 manifest 宣告的那一格。**分頁是宣告出來
   * 的**，所以這份 Map 的鍵不會憑空長出新的一個。
   */
  extPanels: Map<string, { messages: unknown[]; truncated: boolean }>;
  logs: LogLine[];
  /** 後端因為前端跟不上而丟掉的事件數（§6.2）。>0 代表畫面不完整。 */
  dropped: number;
  threads: Map<string, string>;

  begin(): void;
  attach(run: RunSummary): void;
  own(runId: string | null): void;
  fail(message: string): void;
  apply(frame: RunFrame): void;
  applyProject(frame: ProjectFrame): void;
  /** 這次 Run 送給某一格面板的訊息記錄有沒有被截掉（`OUTBOX_LIMIT`）。 */
  panelTruncated(key: string): boolean;
  finish(status: RunEndStatus, message?: string): void;
}

/**
 * 按下執行時要清掉的那些。
 *
 * **`extPanels` 不在裡面。** 面板跨 Run 累積，清空由使用者拉一顆 `清空圖表`
 * 明確要求——理由是 §5.1 的「點一下就跑」：每次執行都清的話，點一顆
 * `加一個點` 就只會看到一個點，那顆積木等於不能單獨點，而單獨點正是那條規則
 * 存在的意義。
 *
 * 它也才是 (a) 那條路一致的樣子：**面板的狀態在瀏覽器**，Python 只是資料來源。
 * 在這裡清掉等於把「面板是 Run 的產物」偷偷帶回來——而那時候 iframe 裡的畫面
 * 並不會跟著清，於是**切一下分頁（重掛、重播）畫面就會少掉前幾次的東西**：
 * 同一份資料，看你有沒有切過分頁而不一樣。
 */
function emptyRun() {
  return {
    blocks: new Map<string, BlockState>(),
    variables: new Map<string, unknown>(),
    logs: [] as LogLine[],
    dropped: 0,
    threads: new Map<string, string>(),
    message: null,
  };
}

let logSeq = 0;

export const useRunStore = create<RunState>((set, get) => ({
  runId: null,
  ownedRunId: null,
  status: 'idle',
  // 跨 Run 活著，所以不在 `emptyRun()` 裡（見那份說明）。清空的入口有兩個：
  // 使用者拉的 `清空圖表` 積木，以及整頁重新整理。
  extPanels: new Map<string, { messages: unknown[]; truncated: boolean }>(),
  ...emptyRun(),

  /** 按下執行的那一刻：上一次的高亮、值氣泡、log 全部清掉。 */
  begin: () => set({ runId: null, status: 'starting', ...emptyRun() }),

  /**
   * `POST /api/runs` 回來了：這個 Run 是我們的。
   *
   * **但它可能已經結束了。** 監聽開著時「點一下就跑」不開 run 通道（D33），
   * 事件走專案通道——而一次 1 毫秒的 Run 比一趟 HTTP 往返快得多，所以
   * `run.start` 與 `run.end` 常常在 POST 回來**之前**就到齊了。無條件寫
   * `running` 就是把一個終局推回「執行中」，而那個 Run 不會再有任何事件來把它
   * 關掉——症狀是按鈕永遠停在「停止」，而後端那一列寫著 ok。
   *
   * 判斷用「這一格的狀態是什麼」而不是「剛剛發生了什麼」（PROGRESS 第 12 條）：
   * 同一個 runId 已經是終局就什麼都不動。
   */
  attach: (run) =>
    set((s) =>
      s.runId === run.runId && s.status !== 'starting' && s.status !== 'running'
        ? {}
        : { runId: run.runId, status: 'running' },
    ),

  /**
   * 「這個 Run 的事件由 run 通道送」，`null` = 沒有人接著。
   *
   * `App.tsx` 開／關那條 socket 時各叫一次。放在 store 而不是一個 ref，是因為
   * 用它的是 `applyProject`——判斷「這一份要不要套用」的地方就在這裡。
   */
  own: (runId) => set({ ownedRunId: runId }),

  fail: (message) => set({ status: 'error', message }),

  panelTruncated: (key) => get().extPanels.get(key)?.truncated ?? false,

  /**
   * 專案通道送來的一批（§9）。`runId` 換人就先清空再套用。
   *
   * **編輯器同時只顯示一個 Run**（一份高亮、一份 log），而這條通道上會有好幾個
   * ——每一則 Discord 訊息一個。所以「換 Run」在這裡是一個明確的動作，而不是讓
   * 兩次執行的高亮疊在同一張畫布上：那樣的畫面說不出哪一顆是這一次亮的。
   *
   * 判斷只看 `runId`，不看 `run.start` 在不在這一批裡：慢客戶端的第一批有可能
   * 是被丟過的（§6.2），而那時候 `run.start` 已經不在裡面了。
   */
  applyProject: (frame) => {
    // **已經有主的那個 Run 不從這條通道進來。** 後端每一個 Run 都往專案通道
    // 送（`runs/manager.py` 的 `hub.publish`），所以前端自己接著 `/ws/run` 的
    // 那一個會收到兩份同樣的 frame——而 log 是累加的，畫面上就是每一行印兩次。
    //
    // 正常情況下 `App.tsx` 在監聽開著時根本不開 run 通道，這道判斷守的是接縫：
    // Run 先開始、使用者才按下監聽（綠旗就是這個順序）。
    if (frame.runId === get().ownedRunId) return;
    if (frame.runId !== get().runId) {
      set({ runId: frame.runId, status: 'running', ...emptyRun() });
    }
    get().apply(frame);
  },

  finish: (status, message) =>
    set((s) => ({
      status,
      message: message ?? s.message,
      // 停在半路的積木不該繼續發光。錯誤與 hot 的計數留著——那是使用者要看的
      // 結果，不是「正在跑」的訊號。
      blocks: settle(s.blocks),
    })),

  apply: (frame) =>
    set((state) => {
      const blocks = new Map(state.blocks);
      const variables = new Map(state.variables);
      let extPanels = state.extPanels;
      const threads = new Map(state.threads);
      let logs = state.logs;
      let status = state.status;
      let message = state.message;

      for (const event of frame.events) {
        switch (event.op) {
          case 'run.start':
            status = 'running';
            break;
          case 'run.end':
            status = event.status;
            break;
          case 'thread.start':
            threads.set(event.threadId, 'running');
            break;
          case 'thread.end':
            threads.set(event.threadId, event.status);
            break;
          case 'block.enter':
            blocks.set(event.blockId, bump(blocks.get(event.blockId), { phase: 'running' }));
            break;
          case 'block.exit':
            blocks.set(
              event.blockId,
              bump(blocks.get(event.blockId), {
                phase: 'done',
                // command 的 exit 沒有 value；那種積木不冒氣泡（§8.3 只說
                // reporter 冒值），所以 `value` 保持 undefined。
                value: 'value' in event ? event.value : undefined,
                truncated: event.truncated,
              }),
            );
            break;
          case 'block.hot':
            blocks.set(
              event.blockId,
              bump(blocks.get(event.blockId), {
                phase: 'hot',
                count: event.count,
                value: 'lastValue' in event ? event.lastValue : undefined,
                truncated: event.truncated,
              }),
            );
            break;
          case 'block.error':
            message = event.error.message;
            if (event.blockId) {
              blocks.set(
                event.blockId,
                bump(blocks.get(event.blockId), { phase: 'error', error: event.error }),
              );
            }
            logs = append(logs, {
              level: 'error',
              text: event.error.message,
              blockId: event.blockId,
              action: event.error.action,
            });
            break;
          case 'var.set':
            variables.set(event.name, event.value);
            break;
          case 'log':
            logs = append(logs, { level: event.level, text: event.text, blockId: event.blockId });
            break;
          case 'ext.panel': {
            const key = `${event.extId}/${event.panelId}`;
            const prev = extPanels.get(key);
            const messages = [...(prev?.messages ?? []), event.payload];
            const over = messages.length > OUTBOX_LIMIT;
            extPanels = new Map(extPanels);
            extPanels.set(key, {
              messages: over ? messages.slice(messages.length - OUTBOX_LIMIT) : messages,
              truncated: (prev?.truncated ?? false) || over,
            });
            break;
          }
        }
      }

      return {
        blocks:
          // `run.end` 就在這一批裡的話，收尾也要在這裡做。以前只有「連線意外
          // 斷掉」才走 finish()，於是正常跑完的專案會留著最後那兩顆積木一直
          // 發光——看起來像卡住了。
          status === 'running' || status === 'starting' ? blocks : settle(blocks),
        variables,
        extPanels,
        threads,
        logs,
        status,
        message,
        dropped: state.dropped + (frame.dropped ?? 0),
      };
    }),
}));

function bump(prev: BlockState | undefined, next: Omit<BlockState, 'seq'>): BlockState {
  // `count` 只有 block.hot 帶，`error` 只有 block.error 帶——但兩者都要在後續的
  // enter/exit 之間活下來，否則「持續執行中 ×4210」會在下一個窗口閃掉。
  return {
    count: prev?.count,
    error: prev?.error,
    ...next,
    seq: (prev?.seq ?? 0) + 1,
  };
}

function append(logs: LogLine[], line: Omit<LogLine, 'id'>): LogLine[] {
  const next = [...logs, { ...line, id: logSeq++ }];
  return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next;
}

function settle(blocks: Map<string, BlockState>): Map<string, BlockState> {
  const out = new Map<string, BlockState>();
  for (const [id, state] of blocks) {
    out.set(
      id,
      state.phase === 'running' || state.phase === 'hot' ? { ...state, phase: 'done' } : state,
    );
  }
  return out;
}

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
import type { BlockError, RunFrame, RunSummary } from '../api/runs';

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
}

/** §8.2：log buffer 上限 5000 筆，環形。 */
const LOG_LIMIT = 5000;

export type RunStatus = 'idle' | 'starting' | 'running' | RunSummary['status'];

interface RunState {
  runId: string | null;
  status: RunStatus;
  /** 連不上、啟動失敗之類的整體訊息。積木層級的錯誤不放這裡。 */
  message: string | null;
  blocks: Map<string, BlockState>;
  variables: Map<string, unknown>;
  logs: LogLine[];
  /** 後端因為前端跟不上而丟掉的事件數（§6.2）。>0 代表畫面不完整。 */
  dropped: number;
  threads: Map<string, string>;

  begin(): void;
  attach(run: RunSummary): void;
  fail(message: string): void;
  apply(frame: RunFrame): void;
  finish(status: RunSummary['status'], message?: string): void;
}

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

export const useRunStore = create<RunState>((set) => ({
  runId: null,
  status: 'idle',
  ...emptyRun(),

  /** 按下執行的那一刻：上一次的高亮、值氣泡、log 全部清掉。 */
  begin: () => set({ runId: null, status: 'starting', ...emptyRun() }),

  attach: (run) => set({ runId: run.runId, status: 'running' }),

  fail: (message) => set({ status: 'error', message }),

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
            logs = append(logs, { level: 'error', text: event.error.message, blockId: event.blockId });
            break;
          case 'var.set':
            variables.set(event.name, event.value);
            break;
          case 'log':
            logs = append(logs, { level: event.level, text: event.text, blockId: event.blockId });
            break;
        }
      }

      return {
        blocks:
          // `run.end` 就在這一批裡的話，收尾也要在這裡做。以前只有「連線意外
          // 斷掉」才走 finish()，於是正常跑完的專案會留著最後那兩顆積木一直
          // 發光——看起來像卡住了。
          status === 'running' || status === 'starting' ? blocks : settle(blocks),
        variables,
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

/**
 * `/api/runs` 與 `/ws/run/{runId}`（附錄 A、§6.1）。
 *
 * 事件型別直接照抄 §6.1 的那段 jsonc。**不從後端產生**——它不是 JSON Schema，
 * 沒有唯一真實來源可以生（manifest 與 IR 有，所以那兩份是產生的）。手抄的代價
 * 是要記得跟著改；換來的是 `switch (event.op)` 有窮盡性檢查，少一個 case
 * TypeScript 就會叫。
 */
import { toApiError } from './client';

/**
 * 一次執行**跑完時**的結局。`run.end` 事件帶的就是這個。
 *
 * 與 `RunSummary['status']` 分開是刻意的：`interrupted` 只會出現在執行歷史裡
 * （後端被砍掉時還在跑的那些，啟動時補標），**永遠不會**沿著 WebSocket 送出來
 * ——沒有人在那一刻還活著可以送它。合成一個型別的話，`run.end` 的 handler 就得
 * 處理一個它永遠收不到的狀態。
 */
export type RunEndStatus = 'running' | 'ok' | 'error' | 'cancelled';

/** 執行歷史裡才有的狀態（§6.3 的落地）。 */
export type StoredRunStatus = RunEndStatus | 'interrupted';

export interface RunSummary {
  runId: string;
  projectId: string;
  /** 綠旗是 `event.when_flag_clicked`；「點一下就跑」是 `manual`。 */
  trigger: string;
  status: StoredRunStatus;
  startedAt: string;
  endedAt?: string;
  /** §5.1「點一下就跑」點的那顆積木。 */
  blockId?: string;
  /** §6.3：這個 Run 的 `log` 超過上限，最舊的那些被丟掉了。 */
  logsTruncated?: boolean;
}

/** §5.6 的錯誤形狀（`backend/blockyard/errors.py` 的 `BlockyardError.to_dict`）。 */
/**
 * 錯誤附帶的**可點擊補救動作**（後端 `BlockyardError.action`）。
 *
 * `hint` 是給人讀的一句話，這個是給 UI 讀的一個結構——「還沒設定金鑰」那句話
 * 的正確結局是一顆把你送到設定畫面、而且欄位已經填好的按鈕。
 *
 * 刻意是**封閉的聯集**：payload 由 host 從 manifest 產生，但它一路經過積木包
 * 的 process，所以前端這一側只認得出白名單裡的 `kind`，認不得的就當作沒有。
 */
export type BlockErrorAction = {
  kind: 'configure_secret';
  extId: string;
  extName: string;
  key: string;
  label: string | null;
  envVar: string | null;
};

export interface BlockError {
  type: string;
  code: string;
  params?: Record<string, unknown>;
  message: string;
  blockId?: string;
  hint?: string;
  hintCode?: string;
  hintParams?: Record<string, unknown>;
  action?: BlockErrorAction;
}

export type RunEvent =
  | { op: 'run.start'; runId: string; ts?: number }
  | { op: 'run.end'; runId: string; status: RunEndStatus; ts?: number }
  | { op: 'thread.start'; threadId: string; scriptId: string }
  | { op: 'thread.end'; threadId: string; status: string }
  | { op: 'block.enter'; threadId: string; blockId: string }
  | { op: 'block.exit'; threadId: string; blockId: string; value?: unknown; truncated?: boolean }
  | { op: 'block.error'; threadId: string; blockId: string | null; error: BlockError }
  | { op: 'block.hot'; blockId: string; count: number; lastValue?: unknown; truncated?: boolean }
  | { op: 'var.set'; threadId?: string; name: string; value: unknown }
  | { op: 'log'; threadId?: string; level: string; text: string; blockId?: string | null }
  /**
   * 送給積木包**宣告**的那一格面板（§16 Q17 的 B 路線）。
   *
   * `payload` 是那個包自己的協定，我們**一個字都不解讀**——編輯器只負責把它
   * 原樣轉給那個 iframe，順序不動。這是 A 路線（封頂的 widget 字彙表）與 B
   * 路線唯一的分界：A 的 payload 我們畫得出來，B 的我們不知道它是什麼。
   */
  | {
      op: 'ext.panel';
      threadId?: string;
      extId: string;
      panelId: string;
      payload: unknown;
      blockId?: string | null;
    };

/**
 * 一個 WS frame。§6.2 一個 frame 裝一個 50ms 窗口的事件陣列——**不是**一個事件
 * 一個 frame，那正是它要避免的事。
 */
export interface RunFrame {
  runId: string;
  events: RunEvent[];
  /** 後端因為這個客戶端跟不上而丟掉的事件數（§6.2）。有值就代表畫面不完整。 */
  dropped?: number;
}

/**
 * 開一次 Run。
 *
 * `blockId` 給了就是 §5.1 的「點一下就跑」：從那顆積木所在的堆疊頂端起跑，
 * 起點是 reporter 時只求值那一顆。**同一個端點**——同一份事件、同一個停止
 * API、同一套 §6.2 流量控制。
 *
 * `scratch` 是**工具箱裡**點的那一顆（`ir/serialize.ts::serializeBlock`）：
 * 它不在存檔裡，所以它自己那一小段 IR 得跟著請求走。後端併進去只活在那個
 * Run 裡，硬碟上的專案不動（`runs/scratch.py`）。
 */
export async function startRun(
  projectId: string,
  opts: { blockId?: string; scratch?: unknown; signal?: AbortSignal } = {},
): Promise<RunSummary> {
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId,
      ...(opts.blockId ? { blockId: opts.blockId } : {}),
      ...(opts.scratch ? { scratch: opts.scratch } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok) throw await toApiError(res, `POST /api/runs → ${res.status}`);
  return (await res.json()) as RunSummary;
}

/**
 * 目前所有的 Run，新的在前。
 *
 * 監聽（`api/listeners.ts`）要用：hat 觸發的 Run 是**後端自己起的**，前端沒有
 * 那個 runId，不問就不知道它存在——症狀會是「Discord 有訊息進來、後端真的跑了、
 * 而編輯器一片安靜」。
 */
export async function listRuns(options: {
  projectId?: string;
  limit?: number;
} = {}): Promise<RunSummary[]> {
  const q = new URLSearchParams();
  if (options.projectId) q.set('projectId', options.projectId);
  if (options.limit) q.set('limit', String(options.limit));
  const res = await fetch(`/api/runs${q.toString() ? `?${q}` : ''}`);
  if (!res.ok) throw await toApiError(res, `GET /api/runs → ${res.status}`);
  return (await res.json()) as RunSummary[];
}

/** 一筆執行歷史的事件（§6.3）。`seq` 只保證遞增，**不保證連續**。 */
export interface StoredEvent {
  seq: number;
  op: string;
  [k: string]: unknown;
}

export interface RunEventsPage {
  runId: string;
  events: StoredEvent[];
  /** 下一頁從哪裡開始。`null` = 沒有更多了（由後端算，前端猜不得）。 */
  nextAfter: number | null;
}

/**
 * 一次執行留下來的事件（§6.3 的落地，跨後端重啟存活）。
 *
 * **回來的是落地過的那些，不是 WebSocket 上那一串。** `block.enter/exit` 查不
 * 到是規格不是缺陷——它們是除錯用的即時訊號，一個掛著跑三天的迴圈會寫進幾億
 * 列。所以歷史看得到的是骨架、`log` 與 `block.error`。
 */
export async function fetchRunEvents(
  runId: string,
  options: { after?: number; limit?: number } = {},
): Promise<RunEventsPage> {
  const q = new URLSearchParams();
  if (options.after) q.set('after', String(options.after));
  if (options.limit) q.set('limit', String(options.limit));
  const res = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/events${q.toString() ? `?${q}` : ''}`,
  );
  if (!res.ok) throw await toApiError(res, `GET /api/runs/${runId}/events → ${res.status}`);
  return (await res.json()) as RunEventsPage;
}

/** §5.5 的外部停止。202 是「收到了」，不是「已經停了」——見後端那段註解。 */
export async function stopRun(runId: string): Promise<void> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw await toApiError(res, `DELETE /api/runs/${runId}`);
}

export interface RunSocketHandlers {
  onFrame(frame: RunFrame): void;
  /** 連線收掉了。`clean` 為 false 代表不是因為 Run 結束——那要讓使用者知道。 */
  onClose(clean: boolean): void;
}

/**
 * 事件通道。
 *
 * WebSocket 的 URL 不能用相對路徑，所以這裡自己拼——dev server 會把 `/ws`
 * 一起代理過去（`vite.config.ts`），打包後前端與後端本來就同源。
 */
/**
 * 專案通道送來的一批（`/ws/project/{id}`）。與 `RunFrame` 同一個形狀——差別只在
 * **它的 `runId` 會變**：一個專案同時可以有好幾個 Run，而且下一個隨時會來。
 */
export type ProjectFrame = RunFrame;

export interface ProjectSocketHandlers {
  onFrame(frame: ProjectFrame): void;
  /** 斷了。呼叫端決定要不要重連——這條通道沒有「結束」這回事。 */
  onClose(clean: boolean): void;
}

/**
 * 一個**專案**的事件通道（§6.1、§9）。
 *
 * 與 `RunSocket` 的差別是**接的時機**：那一條要先有 runId，所以只接得到自己
 * 起的 Run；這一條在 Run 開始**之前**就接著，所以 hat 觸發的 Run 也看得到——
 * 而那種 Run 只有零點幾毫秒，先問再接是永遠追不上的。
 *
 * **單向。** 停止一個 Run 仍然走 `RunSocket` 或 `DELETE /api/runs/{id}`：這條
 * 通道上同時有好幾個 Run 的事件，一句沒有指名的 `stop` 說不出要停哪一個。
 */
export class ProjectSocket {
  private ws: WebSocket;
  private closedByUs = false;

  constructor(projectId: string, handlers: ProjectSocketHandlers) {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(
      `${scheme}://${location.host}/ws/project/${encodeURIComponent(projectId)}`,
    );
    this.ws.onmessage = (ev) => handlers.onFrame(JSON.parse(ev.data as string) as ProjectFrame);
    this.ws.onclose = () => handlers.onClose(this.closedByUs);
  }

  close(): void {
    this.closedByUs = true;
    this.ws.close();
  }
}

export class RunSocket {
  private ws: WebSocket;
  private closedByUs = false;

  constructor(runId: string, handlers: RunSocketHandlers) {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${scheme}://${location.host}/ws/run/${encodeURIComponent(runId)}`);
    this.ws.onmessage = (ev) => handlers.onFrame(JSON.parse(ev.data as string) as RunFrame);
    this.ws.onclose = () => handlers.onClose(this.closedByUs);
    // onerror 不另外處理：WebSocket 的 error 事件永遠緊接著 close，
    // 分開處理只會讓同一件事被通報兩次。
  }

  /** §6.1 前端 → 後端的兩種訊息之一。與 `DELETE /api/runs/{id}` 等價。 */
  stop(): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op: 'stop' }));
  }

  close(): void {
    this.closedByUs = true;
    this.ws.close();
  }
}

/**
 * `/api/runs` 與 `/ws/run/{runId}`（附錄 A、§6.1）。
 *
 * 事件型別直接照抄 §6.1 的那段 jsonc。**不從後端產生**——它不是 JSON Schema，
 * 沒有唯一真實來源可以生（manifest 與 IR 有，所以那兩份是產生的）。手抄的代價
 * 是要記得跟著改；換來的是 `switch (event.op)` 有窮盡性檢查，少一個 case
 * TypeScript 就會叫。
 */
import { toApiError } from './client';

export interface RunSummary {
  runId: string;
  projectId: string;
  /** 綠旗是 `event.when_flag_clicked`；「點一下就跑」是 `manual`。 */
  trigger: string;
  status: 'running' | 'ok' | 'error' | 'cancelled';
  startedAt: string;
  endedAt?: string;
  /** §5.1「點一下就跑」點的那顆積木。 */
  blockId?: string;
}

/** §5.6 的錯誤形狀（`backend/blocky/errors.py` 的 `BlockyError.to_dict`）。 */
/**
 * 錯誤附帶的**可點擊補救動作**（後端 `BlockyError.action`）。
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
  message: string;
  blockId?: string;
  hint?: string;
  action?: BlockErrorAction;
}

export type RunEvent =
  | { op: 'run.start'; runId: string; ts?: number }
  | { op: 'run.end'; runId: string; status: RunSummary['status']; ts?: number }
  | { op: 'thread.start'; threadId: string; scriptId: string }
  | { op: 'thread.end'; threadId: string; status: string }
  | { op: 'block.enter'; threadId: string; blockId: string }
  | { op: 'block.exit'; threadId: string; blockId: string; value?: unknown; truncated?: boolean }
  | { op: 'block.error'; threadId: string; blockId: string | null; error: BlockError }
  | { op: 'block.hot'; blockId: string; count: number; lastValue?: unknown; truncated?: boolean }
  | { op: 'var.set'; threadId?: string; name: string; value: unknown }
  | { op: 'log'; threadId?: string; level: string; text: string; blockId?: string | null };

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
 */
export async function startRun(
  projectId: string,
  opts: { blockId?: string; signal?: AbortSignal } = {},
): Promise<RunSummary> {
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.blockId ? { projectId, blockId: opts.blockId } : { projectId }),
    signal: opts.signal,
  });
  if (!res.ok) throw await toApiError(res, `POST /api/runs → ${res.status}`);
  return (await res.json()) as RunSummary;
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

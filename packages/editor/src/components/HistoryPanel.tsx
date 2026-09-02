/**
 * 執行歷史與日誌檢視（§6.3、P2）。
 *
 * **這個面板是 §1.3 那句話在畫面上的樣子**：「關掉瀏覽器仍會準時執行」——而
 * 執行完之後，使用者回來要看得到它跑過。`RunPanel` 看的是**現在這一次**（走
 * WebSocket，一關掉就沒了）；這裡看的是**跑過的每一次**（走 SQLite，跨後端
 * 重啟存活）。兩個面板不合併，因為它們的資料來源與生命週期完全不同。
 *
 * ## 為什麼看不到 `block.enter`
 *
 * §6.3 只落地骨架、`log` 與 `block.error`。`block.enter/exit` 是**除錯用的即時
 * 訊號，不是稽核紀錄**——一個掛著跑三天的 `forever` 迴圈會寫進幾億列。所以這
 * 裡的空狀態要說「這次執行沒有輸出」，不能說「沒有事件」：後者會讓使用者以為
 * 東西掉了。
 *
 * ## 為什麼不即時更新
 *
 * 開著的時候不輪詢。歷史是「回頭看」的東西，而一個會自己跳動的清單在使用者
 * 正在讀某一列時是干擾。要看新的就重開，或按重新整理。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, History, RotateCw, X } from 'lucide-react';
import {
  fetchRunEvents,
  listRuns,
  type RunSummary,
  type StoredEvent,
} from '../api/runs';
import { focusableIn, modalKeyAction, nextFocusIndex } from './modalKeys';

/** 一次抓幾筆執行。200 是後端每個專案的保留上限（§6.3），所以這是「全部」。 */
const RUN_LIMIT = 200;

/** 一次抓幾筆事件。夠一次執行的骨架加上幾百行 log。 */
const EVENT_PAGE = 500;

const STATUS_TEXT: Record<string, string> = {
  running: '執行中',
  ok: '完成',
  error: '出錯',
  cancelled: '已停止',
  // §6.3：後端被砍掉時還在跑的那些。**不是 `cancelled`**——那是有人做過的
  // 決定，這個是沒有人知道它跑到哪裡。
  interrupted: '中斷',
};

export function HistoryPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [selected, setSelected] = useState<RunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRuns(await listRuns({ projectId, limit: RUN_LIMIT }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      // **失敗也要離開「讀取中」。** 不設的話畫面會同時顯示一句錯誤和一句
      // 「讀取中⋯」，而後者永遠不會結束——使用者會以為它還在試。
      setRuns([]);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const action = modalKeyAction({
      key: e.key,
      shiftKey: e.shiftKey,
      editing: false,
      inWorkspace: false,
      target: (e.target as HTMLElement).tagName.toLowerCase(),
    });
    if (action === 'cancel') {
      e.preventDefault();
      // 進到某一次的細節之後，Esc 先退回清單——那是使用者心裡的「上一步」。
      selected ? setSelected(null) : onClose();
    } else if (action === 'focus-next' || action === 'focus-prev') {
      if (!dialogRef.current) return;
      const items = focusableIn(dialogRef.current);
      if (items.length === 0) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[nextFocusIndex(items.length, at, action === 'focus-prev')]?.focus();
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="執行紀錄"
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <header className="modal-head">
          <h2>
            <History size={16} strokeWidth={2.5} />
            {selected ? `執行紀錄 · ${selected.runId}` : '執行紀錄'}
          </h2>
          {!selected && (
            <button
              type="button"
              className="button"
              onClick={() => void load()}
              aria-label="重新整理"
            >
              <RotateCw size={13} strokeWidth={2.5} /> 重新整理
            </button>
          )}
          <button type="button" className="modal-close" onClick={onClose} aria-label="關閉">
            <X size={16} />
          </button>
        </header>

        {error && (
          <p className="modal-hint hook-error">
            <AlertTriangle size={14} /> {error}
          </p>
        )}

        {selected ? (
          <RunDetail run={selected} onBack={() => setSelected(null)} />
        ) : runs === null ? (
          <p className="modal-hint">讀取中⋯</p>
        ) : runs.length === 0 ? (
          <p className="modal-hint">
            {error
              ? '讀不到執行紀錄。'
              : '這個專案還沒有跑過。按「執行」，或讓它的事件積木被觸發一次。'}
          </p>
        ) : (
          <ul className="history-list">
            {runs.map((run) => (
              <li key={run.runId}>
                <button type="button" className="history-row" onClick={() => setSelected(run)}>
                  <span className={`history-status history-status-${run.status}`}>
                    {STATUS_TEXT[run.status] ?? run.status}
                  </span>
                  <span className="history-main">
                    <span className="history-trigger">{triggerLabel(run)}</span>
                    <span className="history-time">
                      {formatTime(run.startedAt)}
                      {run.endedAt && ` · ${duration(run)}`}
                    </span>
                  </span>
                  {run.logsTruncated && (
                    // §6.3：丟掉可以，靜靜地丟掉不行。
                    <span className="history-truncated" title="log 超過上限，最舊的被丟掉了">
                      log 不完整
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RunDetail({ run, onBack }: { run: RunSummary; onBack: () => void }) {
  const [events, setEvents] = useState<StoredEvent[] | null>(null);
  const [more, setMore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadFrom = useCallback(
    async (after?: number) => {
      setError(null);
      try {
        const page = await fetchRunEvents(run.runId, { after, limit: EVENT_PAGE });
        setEvents((prev) => (after ? [...(prev ?? []), ...page.events] : page.events));
        setMore(page.nextAfter);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        // 同上：失敗就離開「讀取中」。這裡還多一條——**已經載到的那幾頁要留
        // 著**：第 3 頁失敗不該把前兩頁的內容從畫面上抹掉。
        setEvents((prev) => prev ?? []);
        setMore(null);
      }
    },
    [run.runId],
  );

  useEffect(() => {
    void loadFrom();
  }, [loadFrom]);

  return (
    <>
      <div className="history-detail-head">
        <button type="button" className="button" onClick={onBack}>
          ← 回清單
        </button>
        <span className="history-time">
          {triggerLabel(run)} · {formatTime(run.startedAt)}
        </span>
      </div>

      {error && (
        <p className="modal-hint hook-error">
          <AlertTriangle size={14} /> {error}
        </p>
      )}

      {events === null ? (
        <p className="modal-hint">讀取中⋯</p>
      ) : events.length === 0 ? (
        <p className="modal-hint">{error ? '讀不到這次的事件。' : '這次執行沒有輸出。'}</p>
      ) : (
        <ol className="history-events">
          {events.map((e) => (
            <EventRow key={e.seq} event={e} />
          ))}
        </ol>
      )}

      {more !== null && (
        <button type="button" className="button" onClick={() => void loadFrom(more)}>
          載入更多
        </button>
      )}

      <p className="modal-hint">
        歷史只留骨架、輸出與錯誤（§6.3）。逐顆積木的進出是除錯用的即時訊號，
        <strong>不落地</strong>——那要在執行時看右側面板。
      </p>
    </>
  );
}

function EventRow({ event }: { event: StoredEvent }) {
  if (event.op === 'log') {
    const level = String(event.level ?? 'info');
    return (
      <li className={`history-event history-log-${level}`}>
        <span className="history-event-op">輸出</span>
        <span className="history-event-body">{String(event.text ?? '')}</span>
      </li>
    );
  }
  if (event.op === 'block.error') {
    const err = (event.error ?? {}) as { message?: string; hint?: string };
    return (
      <li className="history-event history-event-error">
        <span className="history-event-op">錯誤</span>
        <span className="history-event-body">
          {err.message ?? '（沒有訊息）'}
          {err.hint && <span className="history-event-hint">{err.hint}</span>}
        </span>
      </li>
    );
  }
  // 骨架事件（run/thread 的起訖）。它們是歷史的支架，但不是使用者要讀的內容，
  // 所以壓低成一條細線而不是跟輸出平起平坐。
  return (
    <li className="history-event history-event-frame">
      <span className="history-event-op">{event.op}</span>
      {typeof event.status === 'string' && (
        <span className="history-event-body">{STATUS_TEXT[event.status] ?? event.status}</span>
      )}
    </li>
  );
}

/** 綠旗是 `event.when_flag_clicked`、點一下就跑是 `manual`，其餘是 hat 的 opcode。 */
function triggerLabel(run: RunSummary): string {
  if (run.trigger === 'manual') return run.blockId ? '點了一顆積木' : '手動';
  if (run.trigger === 'event.when_flag_clicked') return '執行';
  if (run.trigger === 'event.when_cron') return '排程';
  if (run.trigger === 'event.when_webhook') return 'Webhook';
  return run.trigger;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function duration(run: RunSummary): string {
  if (!run.endedAt) return '';
  const ms = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`;
}

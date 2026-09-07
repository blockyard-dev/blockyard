/** 受信任的 HTML 面板。iframe 保留文件與樣式生命週期，不提供安全隔離。 */
import { useEffect, useRef, useState } from 'react';
import { currentLocale } from '../i18n';
import { t } from '../i18n';

/** 協定版本。**從第一天就在**——沒有它，改協定的那天只能靠猜對面是哪一版。 */
export const PROTOCOL_V = 1;

/**
 * 等 `ready` 等多久就說話。
 *
 * 沒有這一段的話，「面板的 JS 沒跑起來」與「面板還沒收到訊息」在畫面上一模一樣
 * ——而第一次踩到的實況正是那樣：HTML 與 CSS 都到了（`<link>` 是 no-cors），
 * 只有 `<script type="module">` 被 CORS 擋掉，而畫面上什麼都沒說。
 *
 * 三秒是「本機檔案早就載完了」的量級，不是網路的量級。
 */
const READY_TIMEOUT_MS = 3000;

export interface ExtPanelProps {
  extId: string;
  panelId: string;
  entry: string;
  /** 這次 Run 送給這格面板的全部訊息，依序。`ready` 之後一次沖出去。 */
  outbox: readonly unknown[];
  /**
   * 這次 Run 的訊息記錄被截掉過（`OUTBOX_LIMIT`）。
   *
   * §6.2 那條規則的形狀：**丟掉可以，靜靜地丟掉不行**。重播出來的畫面因此不
   * 完整，而面板自己說不出這件事——它只看得到收到的那幾則。
   */
  truncated?: boolean;
  /** 面板送回來的東西（`call` 等等）。這是**不可信輸入**——使用者開得了 devtools。 */
  onMessage?: (payload: unknown) => void;
}

export function ExtPanel({ extId, panelId, entry, outbox, truncated, onMessage }: ExtPanelProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [stalled, setStalled] = useState(false);
  const readyRef = useRef(false);
  // 已經送到第幾則。`ready` 之前是 0，之後只送新增的那幾則——不然每次 render
  // 都會把整份記錄再送一次。
  const sentRef = useRef(0);
  // outbox 放 ref：新的一則訊息不該讓 iframe 重新掛載（那會清掉它的畫面）。
  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const flush = () => {
    const frame = frameRef.current;
    if (!readyRef.current || !frame?.contentWindow) return;
    for (let i = sentRef.current; i < outboxRef.current.length; i++) {
      frame.contentWindow.postMessage(
        { v: PROTOCOL_V, type: 'message', payload: outboxRef.current[i] },
        // 同源面板仍依來源視窗分流，保留 v1 訊息格式。
        '*',
      );
    }
    sentRef.current = outboxRef.current.length;
  };

  useEffect(() => {
    const onWindowMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { v?: number; type?: string; payload?: unknown };
      if (data?.v !== PROTOCOL_V) return;
      if (data.type === 'ready') {
        readyRef.current = true;
        setStalled(false);
        // 面板重載（換分頁、彈出視窗）之後會再送一次 `ready`，那時候整份記錄
        // 都要重播——所以歸零，不是接著上次。
        sentRef.current = 0;
        flush();
        return;
      }
      if (data.type === 'call') onMessageRef.current?.(data.payload);
    };

    window.addEventListener('message', onWindowMessage);
    const timer = window.setTimeout(() => {
      if (!readyRef.current) setStalled(true);
    }, READY_TIMEOUT_MS);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onWindowMessage);
      readyRef.current = false;
      sentRef.current = 0;
    };
    // 這條 effect 一輩子只跑一次：換 entry 就是換一個面板，由外層的 key 決定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 有新訊息就沖。`ready` 還沒到就什麼都不做——它到的時候會自己補。
  useEffect(flush);

  return (
    <>
      {truncated && (
        <p className="panel-note">
          {t('panel.messagesTruncated')}
        </p>
      )}
      {stalled && (
        // 這句話的收件人是**寫那個包的人**，所以它要說得出下一步去哪裡看。
        <p className="panel-note panel-note-warn">
          {t('panel.stalled')}
        </p>
      )}
      <iframe
        ref={frameRef}
      className="panel-frame"
      title={t('panel.frameTitle', { id: extId })}
      src={`/api/extensions/${extId}/asset/${entry}?lang=${encodeURIComponent(currentLocale())}`}
        data-panel-id={panelId}
      />
    </>
  );
}

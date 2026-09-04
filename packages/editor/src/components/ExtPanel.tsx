/**
 * 積木包自己的面板：一個 `sandbox` 的 iframe（§8.3、§16 Q17 的 B 路線）。
 *
 * **`sandbox="allow-scripts"`，而且刻意不給 `allow-same-origin`。** 那個組合拿到
 * 的是 opaque origin：裡面的程式碼碰不到 `parent.document`、`localStorage` 會
 * throw、`fetch` 打我們的 API 會帶 `Origin: null`（我們不放行）。唯一的通道是
 * `postMessage`。給了 `allow-same-origin` 就全部作廢——那是「看起來有隔離、其實
 * 沒有」，而 §7.6 已經為同一個形狀付過一次錢。
 *
 * 而**子資源照常載入**（相對路徑的 `<link>` / `<script>` / vendored three.js）：
 * sandbox 管的是安全決策時的 origin，不是文件能不能載東西。
 *
 * ## 認人不能靠 origin
 *
 * opaque origin 序列化出來是字串 `"null"`，而**每一個** sandbox iframe 都是
 * `"null"`。所以送出去只能用 `targetOrigin: '*'`，收進來只能比對
 * `event.source === iframe.contentWindow`。比對 `event.origin` 的那個檢查等於
 * 沒寫，而它看起來完全正常。
 *
 * ## 重掛就重來
 *
 * 把 iframe 搬到另一個 document（換分頁、彈出視窗）一定會重載——那是規格，不是
 * 我們能繞過的。而 (a) 路線把面板的狀態放在瀏覽器，所以重掛 = 狀態沒了。補法是
 * **這次 Run 的訊息記錄由編輯器留著，`ready` 之後重播**：一個 outbox 同時解掉
 * 「面板還沒開就先送」與「重掛」兩件事。代價是包的訊息協定要**從空的開始重播
 * 得出同一張畫面**，那是寫包的人的合約。
 */
import { useEffect, useRef, useState } from 'react';

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
        // opaque origin 沒有可以指名的目標，見上面那段。
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
          訊息太多，只重播了最近 2000 則——這格畫面可能不完整。
        </p>
      )}
      {stalled && (
        // 這句話的收件人是**寫那個包的人**，所以它要說得出下一步去哪裡看。
        <p className="panel-note panel-note-warn">
          這格面板沒有回報 <code>ready</code>。它的 JS 可能沒跑起來——
          開 devtools 選那個 frame 看 console。
        </p>
      )}
      <iframe
        ref={frameRef}
      className="panel-frame"
      title={`${extId} 的面板`}
      // 只有 allow-scripts。多一個 allow-same-origin 就等於沒有 sandbox。
      sandbox="allow-scripts"
      // `embed` 是**這一頁的 origin**，後端拿它組 CSP 的 default-src。後端算不
      // 出來：dev 下瀏覽器載的是 5173（Vite 代理），而後端看到的是被代理之後的
      // 自己——用錯的話這一格會一片空白。
      src={`/api/extensions/${extId}/asset/${entry}?embed=${encodeURIComponent(window.location.origin)}`}
      // CSP 不在這裡：它是那份 HTML 的 response header（`api/extensions.py`）。
      // iframe 的 `csp` 屬性支援度不齊，而它失敗的樣子是**靜靜地沒有生效**。
        data-panel-id={panelId}
      />
    </>
  );
}

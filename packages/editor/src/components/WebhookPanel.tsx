/**
 * webhook 的網址與簽章密鑰（§9.3、§16 Q22 決議 (a)）。
 *
 * **只在監聽開著時才有東西。** 網址是掛上去之後才存在的——沒在跑的專案沒有位址
 * 可以給，而給一個「等你按下監聽才會生效」的網址等於讓使用者去別的系統貼一串
 * 現在會 404 的東西。
 *
 * 三件事要在這個面板上說清楚：
 *
 *   1. **完整網址**（含這台後端的來源）。使用者要把它貼進 GitHub 的設定頁，
 *      而 `/hooks/…` 這種相對路徑貼過去是沒有用的。
 *   2. **密鑰不跟著專案走**（D28）。分享出去的專案在對方機器上會驗不過，那是
 *      對的，但它要寫在畫面上——不能讓對方從一連串 401 裡猜。
 *   3. **宣告要驗但沒設密鑰 = 全部擋掉**，不是退回不驗。那顆積木現在什麼都收
 *      不到，而畫面必須說出來，否則使用者只會看到「webhook 壞了」。
 *
 * 版面照 `KeysPanel` 的殼子，明文的處理也照它：值的輸入框是 `type="password"`，
 * 送出後立刻清掉，而且**讀不回來**。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, KeyRound, Link2, Trash2, X } from 'lucide-react';
import {
  clearWebhookSecret,
  revealWebhookSecret,
  setWebhookSecret,
  type WebhookUrl,
} from '../api/triggers';
import { focusableIn, modalKeyAction, nextFocusIndex } from './modalKeys';

/** 幾秒後把「已複製」收回去。夠久到看得見，短到不會擋住下一次操作。 */
const COPIED_MS = 1600;

export function WebhookPanel({
  projectId,
  webhooks,
  onClose,
  onChanged,
}: {
  projectId: string;
  webhooks: WebhookUrl[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<WebhookUrl | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (copied === null) return;
    const t = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const action = modalKeyAction({
        key: e.key,
        shiftKey: e.shiftKey,
        editing: false,
        inWorkspace: false,
        target: (e.target as HTMLElement).tagName.toLowerCase(),
      });
      if (action === 'cancel') {
        e.preventDefault();
        editing ? setEditing(null) : onClose();
      } else if (action === 'focus-next' || action === 'focus-prev') {
        if (!dialogRef.current) return;
        const items = focusableIn(dialogRef.current);
        if (items.length === 0) return;
        e.preventDefault();
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[nextFocusIndex(items.length, at, action === 'focus-prev')]?.focus();
      }
    },
    [editing, onClose],
  );

  /** 貼進別的系統要的是完整網址，不是 `/hooks/…`。 */
  const absolute = (url: string) => new URL(url, window.location.origin).toString();

  const copy = async (hook: WebhookUrl) => {
    try {
      await navigator.clipboard.writeText(absolute(hook.url));
      setCopied(hook.url);
    } catch {
      setError('複製失敗——請手動選取網址');
    }
  };

  /**
   * 密鑰 → 剪貼簿（D28）。
   *
   * 明文**不經過 React state**：拿到就寫進剪貼簿，函式一結束那個字串就沒有引用
   * 了。存進 state 的話它會活到下一次 render，而且會出現在 devtools 的元件樹
   * 裡——那正是「畫面上一直躺著一串密鑰」的另一種樣子。
   */
  const copySecret = async (hook: WebhookUrl) => {
    try {
      await navigator.clipboard.writeText(await revealWebhookSecret(projectId, hook.blockId));
      setCopied(hook.blockId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '複製密鑰失敗');
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Webhook 網址"
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <header className="modal-head">
          <h2>
            <Link2 size={16} strokeWidth={2.5} /> Webhook 網址
          </h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="關閉">
            <X size={16} />
          </button>
        </header>

        {error && (
          <p className="modal-hint hook-error">
            <AlertTriangle size={14} /> {error}
          </p>
        )}

        {editing ? (
          <SecretForm
            projectId={projectId}
            hook={editing}
            onDone={() => {
              setEditing(null);
              onChanged();
            }}
            onCancel={() => setEditing(null)}
            onError={setError}
          />
        ) : (
          <>
            <ul className="hook-list">
              {webhooks.map((hook) => (
                <li key={hook.url} className="hook-row">
                  <div className="hook-main">
                    <code className="hook-url">{absolute(hook.url)}</code>
                    <HookVerify hook={hook} />
                  </div>
                  <div className="hook-actions">
                    <button type="button" className="button" onClick={() => void copy(hook)}>
                      {copied === hook.url ? (
                        <>
                          <Check size={13} strokeWidth={2.5} /> 已複製
                        </>
                      ) : (
                        <>
                          <Copy size={13} strokeWidth={2.5} /> 複製網址
                        </>
                      )}
                    </button>
                    {hook.verify !== 'none' && (
                      <button type="button" className="button" onClick={() => setEditing(hook)}>
                        <KeyRound size={13} strokeWidth={2.5} />
                        {hook.secretSet ? '更換密鑰' : '設定密鑰'}
                      </button>
                    )}
                    {hook.verify !== 'none' && hook.secretSet && (
                      // D28：「不顯示明文」擋的是畫面上一直躺著一串密鑰，而複製
                      // 按鈕不違反它——值只進剪貼簿，不進 state、不進 DOM。所以
                      // 這裡不預先抓，按下去才去要那一把。
                      <button
                        type="button"
                        className="button"
                        title="複製密鑰到剪貼簿"
                        onClick={() => void copySecret(hook)}
                      >
                        {copied === hook.blockId ? (
                          <>
                            <Check size={13} strokeWidth={2.5} /> 已複製
                          </>
                        ) : (
                          <>
                            <Copy size={13} strokeWidth={2.5} /> 密鑰
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <p className="modal-hint">
              密鑰存在這台機器的鑰匙圈裡，<strong>不會跟著專案走</strong>
              ——把專案分享出去，對方要自己設一次，否則那邊會一直退回 401。
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** 這一顆現在收不收得到東西。**「宣告要驗但沒設密鑰」是全部擋掉，不是不驗。** */
function HookVerify({ hook }: { hook: WebhookUrl }) {
  if (hook.verify === 'none') return <span className="hook-tag">不驗簽章</span>;
  if (hook.secretSet) return <span className="hook-tag hook-tag-ok">已設定簽章密鑰</span>;
  return (
    <span className="hook-tag hook-tag-warn">
      <AlertTriangle size={12} /> 還沒設密鑰——現在每一則請求都會被擋下
    </span>
  );
}

function SecretForm({
  projectId,
  hook,
  onDone,
  onCancel,
  onError,
}: {
  projectId: string;
  hook: WebhookUrl;
  onDone: () => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      await setWebhookSecret(projectId, hook.blockId, value);
      setValue(''); // 明文不留在 state 裡
      onDone();
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await clearWebhookSecret(projectId, hook.blockId);
      onDone();
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="hook-secret-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        <span className="hook-secret-label">
          <code>{hook.path}</code> 的簽章密鑰
        </span>
        {/* 對面（GitHub 那類）產生簽章用的就是這一把。 */}
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="貼上對方設定頁那一把"
        />
      </label>
      <div className="hook-actions">
        <button type="submit" className="button button-primary" disabled={!value.trim() || busy}>
          存起來
        </button>
        {hook.secretSet && (
          <button type="button" className="button" onClick={() => void clear()} disabled={busy}>
            <Trash2 size={13} strokeWidth={2.5} /> 拿掉
          </button>
        )}
        <button type="button" className="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </form>
  );
}

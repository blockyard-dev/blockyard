/**
 * 「金鑰」全域入口（D28、§12.1）。
 *
 * **一把一把地管**：每一列是一把金鑰，右邊是它的狀態（末四碼或「未設定」）與
 * 一顆動作按鈕。新增／更換走同一個小對話框，`.env` 匯入退到最下面收起來——
 * 一次貼一整份仍然是最快的路，但它不再是**唯一**的路。
 *
 * 早期版本只有「唯讀清單＋貼 `.env`」。改掉的理由是實際用起來反直覺：使用者
 * 手上是一把金鑰，而介面要求他先把它寫成 `OPENAI_API_KEY=…` 這一行——那是
 * 讓人去適應儲存格式，而不是讓介面去接住他手上的東西。
 *
 * **明文在這裡怎麼處理**：列表只拿得到末四碼。複製按鈕會去打 `/reveal` 拿完整
 * 的那一把，但它**只進剪貼簿**——不進 React state、不進 DOM，所以畫面上永遠
 * 沒有一串躺著的金鑰可以被肩後偷看或截圖到（見 `backend/blocky/api/keys.py`
 * 對 D28 這兩條線的區分）。值的輸入框是 `type="password"`，送出後立刻清掉。
 *
 * 版面照 `ProcedureModal` 的 `.modal-backdrop`/`.modal` 殼子。新增畫面是**同
 * 一個對話框的另一個模式**而不是疊第二層：疊兩層 backdrop 之後 Esc 該關哪一
 * 層、焦點該回到哪裡，兩個問題都沒有好答案。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, KeyRound, Plus, RotateCw, Trash2, X } from 'lucide-react';
import {
  deleteKey,
  fetchKeys,
  importEnvKeys,
  putKey,
  revealKey,
  type ImportEnvResult,
  type KeyEntry,
} from '../api/client';
import { focusableIn, modalKeyAction, nextFocusIndex } from './modalKeys';
import { useKeysUi, type KeysTarget } from './keysStore';

export function KeysEntry() {
  const open = useKeysUi((s) => s.open);
  const target = useKeysUi((s) => s.target);
  const openKeys = useKeysUi((s) => s.openKeys);
  const closeKeys = useKeysUi((s) => s.closeKeys);

  return (
    <>
      <button type="button" className="button" onClick={() => openKeys()}>
        <KeyRound size={14} strokeWidth={2.5} /> 金鑰
      </button>
      {open && <KeysModal target={target} onClose={closeKeys} />}
    </>
  );
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; keys: KeyEntry[] }
  | { status: 'error'; message: string };

/** 正在編輯哪一把（新增或更換都是這個）。`null` 代表回到清單。 */
type Editing = { entry: KeyEntry; locked: boolean } | null;

function KeysModal({ target, onClose }: { target: KeysTarget | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [editing, setEditing] = useState<Editing>(null);
  const [envOpen, setEnvOpen] = useState(false);
  const [envText, setEnvText] = useState('');
  const [importResult, setImportResult] = useState<ImportEnvResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const keys = await fetchKeys();
      setState({ status: 'ready', keys });
      return keys;
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 帶著 target 開啟（從執行紀錄的「去設定」按鈕過來）：直接進到新增畫面，
  // 而且**鎖住**是哪一把——使用者是為了這一把才點進來的，讓他在選單裡再選
  // 一次同一個東西沒有意義，選錯了更糟。
  const targetKey = target ? `${target.extId}.${target.key}` : null;
  useEffect(() => {
    if (!target) return;
    setEditing({
      entry: {
        extId: target.extId,
        extName: target.extName,
        key: target.key,
        label: target.label,
        envVar: target.envVar,
        configured: false,
        suffix: null,
      },
      locked: true,
    });
    // target 本身是不可變的快照，用它的身分當依賴就夠。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target_ = event.target instanceof Element ? event.target : null;
      const action = modalKeyAction({
        key: event.key,
        shiftKey: event.shiftKey,
        editing: false,
        inWorkspace: false,
        target: target_ ? target_.tagName.toLowerCase() : null,
      });
      if (action === null || action === 'submit') return;
      event.preventDefault();
      // Esc 在新增畫面裡先退回清單，再按一次才關掉整個面板——半路關掉一個
      // 剛貼好值的對話框是這裡最不該發生的事。
      if (action === 'cancel') {
        if (editing) setEditing(null);
        else onClose();
      } else moveFocus(dialogRef.current, action === 'focus-prev');
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose, editing]);

  const keys = state.status === 'ready' ? state.keys : [];

  const save = async (entry: KeyEntry, value: string) => {
    setBusy(true);
    try {
      await putKey(entry.extId, entry.key, value);
      await load();
      setEditing(null);
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: KeyEntry) => {
    setBusy(true);
    try {
      await deleteKey(entry.extId, entry.key);
      await load();
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const submitImport = async () => {
    if (!envText.trim() || importing) return;
    setImporting(true);
    setImportResult(null);
    try {
      const result = await importEnvKeys(envText);
      setImportResult(result);
      setEnvText('');
      await load();
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="金鑰"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="modal-head">
          <h2>{editing ? (editing.entry.configured ? '更換金鑰' : '新增金鑰') : '金鑰'}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="關閉">
            <X size={16} strokeWidth={2.5} />
          </button>
        </header>

        {editing ? (
          <KeyForm
            editing={editing}
            candidates={keys}
            busy={busy}
            onPick={(entry) => setEditing({ entry, locked: false })}
            onCancel={() => setEditing(null)}
            onSave={save}
          />
        ) : (
          <div className="keys-body">
            {state.status === 'loading' && <p className="modal-hint">載入中…</p>}
            {state.status === 'error' && <p className="modal-hint">出錯了：{state.message}</p>}

            {state.status === 'ready' && (
              <>
                <div className="keys-toolbar">
                  <span className="keys-count">
                    {keys.filter((k) => k.configured).length} / {keys.length} 已設定
                  </span>
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={keys.length === 0}
                    onClick={() => {
                      const first = keys.find((k) => !k.configured) ?? keys[0];
                      if (first) setEditing({ entry: first, locked: false });
                    }}
                  >
                    <Plus size={14} strokeWidth={2.5} /> 新增金鑰
                  </button>
                </div>

                {keys.length === 0 ? (
                  <p className="keys-empty">目前沒有積木包宣告需要金鑰的設定項。</p>
                ) : (
                  <ul className="keys-list">
                    {keys.map((k) => (
                      <li key={`${k.extId}.${k.key}`}>
                        <div className="keys-row-main">
                          <span className="keys-label">
                            {k.extName} · {k.label ?? k.key}
                          </span>
                          {k.envVar && <code className="keys-env">{k.envVar}</code>}
                        </div>
                        <span className={`keys-state${k.configured ? ' keys-state-on' : ''}`}>
                          {k.configured ? (k.suffix ? `…${k.suffix}` : '已設定') : '未設定'}
                        </span>
                        <div className="keys-row-actions">
                          {k.configured && <CopyKeyButton entry={k} disabled={busy} />}
                          <button
                            type="button"
                            className="keys-icon-button"
                            disabled={busy}
                            title={k.configured ? '更換' : '設定'}
                            aria-label={`${k.configured ? '更換' : '設定'} ${k.extName} 的 ${k.label ?? k.key}`}
                            onClick={() => setEditing({ entry: k, locked: false })}
                          >
                            {k.configured ? <RotateCw size={14} /> : <Plus size={14} />}
                          </button>
                          {k.configured && (
                            <button
                              type="button"
                              className="keys-icon-button keys-icon-danger"
                              disabled={busy}
                              title="刪除"
                              aria-label={`刪除 ${k.extName} 的 ${k.label ?? k.key}`}
                              onClick={() => void remove(k)}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {/* 一次貼一整份仍然是最快的路，但它不再是唯一的路，所以收起來。 */}
                <button
                  type="button"
                  className="keys-env-toggle"
                  aria-expanded={envOpen}
                  onClick={() => setEnvOpen((v) => !v)}
                >
                  <span className="section-caret">{envOpen ? '▾' : '▸'}</span> 從 .env 一次匯入
                </button>
                {envOpen && (
                  <>
                    <textarea
                      className="keys-import-textarea"
                      placeholder="OPENAI_API_KEY=sk-..."
                      value={envText}
                      onChange={(e) => setEnvText(e.target.value)}
                      rows={4}
                    />
                    <button
                      type="button"
                      className="button"
                      onClick={() => void submitImport()}
                      disabled={importing || !envText.trim()}
                    >
                      {importing ? '匯入中…' : '匯入'}
                    </button>
                    {importResult && (
                      <div className="keys-import-result">
                        {importResult.written.length > 0 && (
                          <p>
                            寫入了 {importResult.written.length} 項：
                            {importResult.written.map((w) => w.envVar).join('、')}
                          </p>
                        )}
                        {importResult.unmatched.length > 0 && (
                          <p>
                            這幾行沒有被吃到（沒有積木包宣告過這個變數名）：
                            {importResult.unmatched.join('、')}
                          </p>
                        )}
                        {importResult.written.length === 0 &&
                          importResult.unmatched.length === 0 && <p>沒有讀到任何一行。</p>}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {!editing && (
          <footer className="modal-foot">
            <button type="button" className="button" onClick={onClose}>
              關閉
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

/**
 * 把一份文字送進剪貼簿，走「**在使用者手勢還有效的時候就把 promise 交出去**」
 * 這條路。
 *
 * `await fetch(...)` 之後再呼叫 `clipboard.writeText()` 是這裡最自然、也最容易
 * 壞的寫法：Chrome 的剪貼簿寫入要求 transient user activation，而那個視窗會被
 * 一次網路來回耗掉，症狀是 `NotAllowedError` 而按鈕看起來只是沒反應。
 * `ClipboardItem` 收 promise 就是為了這個情況存在的——同步交出一個還沒 resolve
 * 的值，瀏覽器記住手勢，等它好了再寫。
 *
 * 舊瀏覽器沒有 promise 版的 `ClipboardItem` 時退回 `writeText`；它可能因為上面
 * 那個理由失敗，所以失敗要**看得見**（見下面的 `failed`），不能默默吞掉。
 */
async function copyText(pending: Promise<string>): Promise<void> {
  const canQueuePromise =
    typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';

  if (canQueuePromise) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/plain': pending.then((t) => new Blob([t], { type: 'text/plain' })) }),
      ]);
      return;
    } catch {
      // 有些瀏覽器認得 ClipboardItem 卻不吃 promise 型的值。退回去再試一次，
      // 這時值已經在手上了。
    }
  }
  await navigator.clipboard.writeText(await pending);
}

/**
 * 一列上的複製按鈕。
 *
 * 值**不存進 state**：`revealKey()` 的結果直接流進剪貼簿，函式一結束就沒有任何
 * 地方還握著它。留下來的只有一個「剛剛複製過」的狀態。
 */
function CopyKeyButton({ entry, disabled }: { entry: KeyEntry; disabled: boolean }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');

  // 「已複製」的勾停 2 秒再自己退回複製圖示。元件在退回之前被卸載（面板關掉、
  // 列表重載）的話 timer 要跟著清掉，不然 React 會對一個不存在的元件 setState。
  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);

  const copy = async () => {
    try {
      // fetch 不 await：promise 直接交給剪貼簿，使用者的手勢才不會過期。
      await copyText(revealKey(entry.extId, entry.key));
      setState('done');
    } catch {
      setState('failed');
    }
  };

  return (
    <button
      type="button"
      className={`keys-icon-button${state === 'failed' ? ' keys-icon-failed' : ''}`}
      disabled={disabled}
      title={state === 'failed' ? '複製失敗，這個瀏覽器擋住了剪貼簿' : '複製金鑰'}
      aria-label={`複製 ${entry.extName} 的 ${entry.label ?? entry.key}`}
      onClick={() => void copy()}
    >
      {/* 失敗要看得見。`failed` 畫成跟 `idle` 一樣的複製圖示，症狀就是「按了
          沒反應」——那是最難查的一種，因為它跟「什麼都沒發生」長得一模一樣。 */}
      {state === 'done' ? (
        <Check size={14} className="keys-copied" />
      ) : state === 'failed' ? (
        <AlertTriangle size={14} />
      ) : (
        <Copy size={14} />
      )}
    </button>
  );
}

/**
 * 新增／更換一把的表單。
 *
 * 上面那格**不是自由文字**——Vercel 那種介面裡「Key Name」是使用者自己取的，
 * 而這裡的金鑰是**積木包宣告**出來的（`manifest.yaml` 的 `config`），發明一個
 * 名字寫進去只會得到一把沒有任何積木讀得到的金鑰。所以它是一個選單；從執行
 * 紀錄點進來時已經知道是哪一把，就鎖成唯讀。
 */
function KeyForm({
  editing,
  candidates,
  busy,
  onPick,
  onCancel,
  onSave,
}: {
  editing: NonNullable<Editing>;
  candidates: KeyEntry[];
  busy: boolean;
  onPick: (entry: KeyEntry) => void;
  onCancel: () => void;
  onSave: (entry: KeyEntry, value: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const valueRef = useRef<HTMLInputElement>(null);
  const { entry, locked } = editing;

  // 「等著輸入下面那格數值」——上面那格已經填好了，焦點就該直接在值上面。
  useEffect(() => {
    valueRef.current?.focus();
  }, [entry.extId, entry.key]);

  const id = useMemo(() => `${entry.extId}.${entry.key}`, [entry.extId, entry.key]);

  const submit = () => {
    if (!value.trim() || busy) return;
    void onSave(entry, value).then(() => setValue(''));
  };

  return (
    <div className="keys-body">
      <label className="keys-field">
        <span className="keys-field-label">金鑰</span>
        {locked || candidates.length <= 1 ? (
          <div className="keys-locked">
            <span className="keys-label">
              {entry.extName} · {entry.label ?? entry.key}
            </span>
            {entry.envVar && <code className="keys-env">{entry.envVar}</code>}
          </div>
        ) : (
          <select
            className="keys-select"
            value={id}
            onChange={(e) => {
              const next = candidates.find((k) => `${k.extId}.${k.key}` === e.target.value);
              if (next) onPick(next);
            }}
          >
            {candidates.map((k) => (
              <option key={`${k.extId}.${k.key}`} value={`${k.extId}.${k.key}`}>
                {k.extName} · {k.label ?? k.key}
                {k.envVar ? `（${k.envVar}）` : ''}
                {k.configured ? ' — 已設定' : ''}
              </option>
            ))}
          </select>
        )}
      </label>

      <label className="keys-field">
        <span className="keys-field-label">值</span>
        <input
          ref={valueRef}
          className="keys-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={entry.envVar === 'OPENAI_API_KEY' ? 'sk-…' : '貼上金鑰'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
      </label>

      <p className="modal-hint keys-field-hint">
        存進這台電腦的鑰匙圈，不會寫進專案檔，所以分享專案不會把它一起送出去。
        {entry.configured && ' 存檔後會蓋掉現在那一把。'}
      </p>

      <footer className="modal-foot">
        <button type="button" className="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={submit}
          disabled={busy || !value.trim()}
        >
          {busy ? '儲存中…' : '儲存'}
        </button>
      </footer>
    </div>
  );
}

function moveFocus(root: HTMLElement | null, backwards: boolean): void {
  if (!root) return;
  const items = focusableIn(root);
  const current = items.findIndex((el) => el === document.activeElement);
  const next = items[nextFocusIndex(items.length, current, backwards)];
  next?.focus();
}

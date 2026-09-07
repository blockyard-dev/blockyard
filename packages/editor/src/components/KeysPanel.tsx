/**
 * 「金鑰」入口（D28、§12.1）。**每一把都屬於現在打開的那個專案**（§16 Q23）。
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
 * 沒有一串躺著的金鑰可以被肩後偷看或截圖到（見 `backend/blockyard/api/keys.py`
 * 對 D28 這兩條線的區分）。值的輸入框是 `type="password"`，送出後立刻清掉。
 *
 * 版面照 `ProcedureModal` 的 `.modal-backdrop`/`.modal` 殼子。新增畫面是**同
 * 一個對話框的另一個模式**而不是疊第二層：疊兩層 backdrop 之後 Esc 該關哪一
 * 層、焦點該回到哪裡，兩個問題都沒有好答案。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  RotateCw,
  Trash2,
} from 'lucide-react';
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
import { ModalActions } from './ModalActions';
import { configuredIds, useKeysUi, type KeysTarget } from './keysStore';
import { currentLocale, list, number, t } from '../i18n';
import { localizeManifest, type TranslatableManifest } from '../i18n/manifest';
import type { Manifest } from '../types/manifest';

export function KeysEntry({
  projectName,
  manifests = [],
}: {
  projectName?: string;
  manifests?: readonly Manifest[];
}) {
  const open = useKeysUi((s) => s.open);
  const target = useKeysUi((s) => s.target);
  const openKeys = useKeysUi((s) => s.openKeys);
  const closeKeys = useKeysUi((s) => s.closeKeys);

  return (
    <>
      {/* 只有圖示：說明交給 title／aria-label（工具列上同一批入口都是這樣）。 */}
      <button
        type="button"
        className="button button-icon"
        onClick={() => openKeys()}
        aria-label={t('keys.label')}
        title={t('keys.label')}
      >
        <KeyRound size={15} strokeWidth={2.5} />
      </button>
      {open && <KeysModal
        target={target}
        projectName={projectName}
        manifests={manifests}
        onClose={closeKeys}
      />}
    </>
  );
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; keys: KeyEntry[] }
  | { status: 'error'; message: string };

/** 正在編輯哪一把（新增或更換都是這個）。`null` 代表回到清單。 */
type Editing = { entry: KeyEntry; locked: boolean } | null;

function KeysModal({
  target,
  projectName,
  manifests,
  onClose,
}: {
  target: KeysTarget | null;
  /** 這幾把是誰的。載入中／出錯時給不出名字，那時候寫的是「這個專案」。 */
  projectName?: string;
  manifests: readonly Manifest[];
  onClose: () => void;
}) {
  const setConfigured = useKeysUi((s) => s.setConfigured);
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
      const keys = localizeKeys(await fetchKeys(), manifests);
      setState({ status: 'ready', keys });
      // **面板是唯一會改動金鑰的地方**，所以每一次重讀都順手把名單公布出去
      // ——工具箱那顆「設定 Bot Token」就是靠它決定自己還要不要在（D25、
      // `toolbox.ts::isDone`）。新增、更換、刪除、`.env` 匯入全部走這個函式，
      // 所以四條路都不必各自記得公布一次。
      setConfigured(configuredIds(keys));
      return keys;
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }, [manifests, setConfigured]);

  useEffect(() => {
    void load();
  }, [load]);

  // 帶著 target 開啟（執行紀錄的「去設定」、工具箱的 `open_config` 按鈕）：直接
  // 進到那一把的畫面，而且**鎖住**是哪一把——使用者是為了這一把才點進來的，讓
  // 他在選單裡再選一次同一個東西沒有意義，選錯了更糟。
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
        // 這兩格**先當作沒設定**，等清單回來再對齊（見下一個 effect）。target
        // 是點進來的那一刻手上有的東西，而它說不出「這一把現在有沒有值」——
        // 那是後端才知道的事。
        configured: false,
        suffix: null,
      },
      locked: true,
    });
    // target 本身是不可變的快照，用它的身分當依賴就夠。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  // 清單回來之後，把鎖定的那一把換成後端那一份。
  //
  // **這不是多此一舉**：工具箱的「設定 Bot Token」按鈕隨時按得到，而它最常被
  // 按的第二個時機是「我以為我設好了」。少了這一段，一把已經設定好的金鑰會被
  // 畫成「新增金鑰」、不顯示末四碼、也不說存下去會蓋掉現在那一把——三句話全部
  // 是錯的，而畫面看起來完全正常。（執行紀錄那條路也走這裡，只是那邊的 target
  // 幾乎一定真的還沒設定，所以看不出差別。）
  useEffect(() => {
    if (state.status !== 'ready' || !editing?.locked) return;
    const { extId, key } = editing.entry;
    const real = state.keys.find((k) => k.extId === extId && k.key === key);
    if (!real || real === editing.entry) return;
    setEditing({ entry: real, locked: true });
  }, [state, editing]);

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
        aria-label={t('keys.label')}
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="modal-head">
          {/* 沒有右上角那顆叉。這個面板的底下就有一顆「關閉」（`.modal-foot`），
              而同一個對話框裡放兩個出口，只會讓使用者在按之前先想一秒哪一顆才
              是對的。Esc 也還在（見上面那段 `modalKeyAction`）。 */}
          <h2>{editing ? (editing.entry.configured ? t('keys.change') : t('keys.add')) : t('keys.label')}</h2>
        </header>

        {/* **這幾把是誰的**（§16 Q23）。少了這一行，在 A 專案填過 token 的人
            打開 B 專案會看到一整排「未設定」，而畫面上沒有任何東西說得出為
            什麼——那正是這個專案最不想要的那種症狀。 */}
        <p className="modal-hint keys-scope">
          {t('keys.scope', { project: projectName ?? t('keys.thisProject') })}
        </p>

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
            {state.status === 'loading' && <p className="modal-hint">{t('common.loading')}</p>}
            {state.status === 'error' && <p className="modal-hint">{t('keys.loadError', { message: state.message })}</p>}

            {state.status === 'ready' && (
              <>
                <div className="keys-toolbar">
                  <span className="keys-count">
                    {t('keys.configuredSummary', {
                      configured: number(keys.filter((k) => k.configured).length),
                      total: number(keys.length),
                    })}
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
                    <Plus size={14} strokeWidth={2.5} /> {t('keys.add')}
                  </button>
                </div>

                {keys.length === 0 ? (
                  <p className="keys-empty">{t('keys.empty')}</p>
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
                          {k.configured ? (k.suffix ? `…${k.suffix}` : t('keys.configured')) : t('keys.notConfigured')}
                        </span>
                        <div className="keys-row-actions">
                          {k.configured && <CopyKeyButton entry={k} disabled={busy} />}
                          <button
                            type="button"
                            className="keys-icon-button"
                            disabled={busy}
                            title={k.configured ? t('keys.replace') : t('keys.configure')}
                            aria-label={t('keys.editAria', {
                              action: k.configured ? t('keys.replace') : t('keys.configure'),
                              extension: k.extName,
                              key: k.label ?? k.key,
                            })}
                            onClick={() => setEditing({ entry: k, locked: false })}
                          >
                            {k.configured ? <RotateCw size={14} /> : <Plus size={14} />}
                          </button>
                          {k.configured && (
                            <button
                              type="button"
                              className="keys-icon-button keys-icon-danger"
                              disabled={busy}
                              title={t('keys.delete')}
                              aria-label={t('keys.deleteAria', { extension: k.extName, key: k.label ?? k.key })}
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
                  <span className="section-caret">{envOpen ? '▾' : '▸'}</span> {t('keys.importEnv')}
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
                      {importing ? t('keys.importing') : t('keys.import')}
                    </button>
                    {importResult && (
                      <div className="keys-import-result">
                        {importResult.written.length > 0 && (
                          <p>
                            {t('keys.importWritten', {
                              count: number(importResult.written.length),
                              names: list(importResult.written.map((w) => w.envVar)),
                            })}
                          </p>
                        )}
                        {importResult.unmatched.length > 0 && (
                          <p>
                            {t('keys.importUnmatched', { names: list(importResult.unmatched) })}
                          </p>
                        )}
                        {importResult.written.length === 0 &&
                          importResult.unmatched.length === 0 && <p>{t('keys.importEmpty')}</p>}
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
              {t('common.close')}
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
      title={state === 'failed' ? t('keys.copyFailed') : t('keys.copy')}
      aria-label={t('keys.copyAria', { extension: entry.extName, key: entry.label ?? entry.key })}
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
  /** 值是不是攤開來看得見。預設不是——但**看得見這件事要拿得到**，見下面那顆
   * 眼睛。 */
  const [reveal, setReveal] = useState(false);
  const valueRef = useRef<HTMLInputElement>(null);
  const { entry, locked } = editing;

  // 「等著輸入下面那格數值」——上面那格已經填好了，焦點就該直接在值上面。
  // 換一把金鑰就把眼睛闔回去：上一把攤開過，不代表下一把也該攤開。
  useEffect(() => {
    valueRef.current?.focus();
    setReveal(false);
  }, [entry.extId, entry.key]);

  const id = useMemo(() => `${entry.extId}.${entry.key}`, [entry.extId, entry.key]);

  const submit = () => {
    if (!value.trim() || busy) return;
    void onSave(entry, value).then(() => setValue(''));
  };

  return (
    <div className="keys-body">
      <label className="keys-field">
        <span className="keys-field-label">{t('keys.fieldKey')}</span>
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
                {k.envVar ? t('keys.optionEnv', { envVar: k.envVar }) : ''}
                {k.configured ? t('keys.optionConfigured') : ''}
              </option>
            ))}
          </select>
        )}
      </label>

      <label className="keys-field">
        <span className="keys-field-label">{t('keys.fieldValue')}</span>
        <div className="keys-input-wrap">
          <input
            ref={valueRef}
            className="keys-input"
            // 攤開的時候是 `text`：`type="password"` 沒有「顯示」這個開關，換
            // 型別是唯一做得到的方式（也是所有瀏覽器的內建眼睛在做的事）。
            type={reveal ? 'text' : 'password'}
            // **`off` 在密碼欄位上擋不住瀏覽器**（Chrome 一直都是這樣：它把
            // `off` 當成「網站猜錯了」而忽略）。症狀是使用者明明剛把這把金鑰
            // 刪掉，一進新增畫面卻看到一格已經填好的圓點——那是密碼管理員填
            // 的，不是我們的 state，而使用者沒有辦法分辨這兩件事。
            // `new-password` 是規格裡專門給「這一格是要**新**設一把」的值，
            // 而那正是這個表單在做的事。後面幾個 data-* 是 1Password／
            // LastPass／Bitwarden 各自的退場開關——它們不看 autocomplete。
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore="true"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            placeholder={entry.envVar === 'OPENAI_API_KEY' ? 'sk-…' : t('keys.paste')}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
          />
          {/* 眼睛。**這一格與列表上那顆複製按鈕不是同一件事**：那邊攤開的是
              已經存在鑰匙圈裡的東西（所以它只進剪貼簿、不進 DOM），這裡攤開
              的是使用者此刻自己打／貼進來的字，它本來就在他手上。貼一長串
              金鑰進圓點裡而不能核對一眼，是這個表單最容易讓人重來一次的地方。 */}
          <button
            type="button"
            className="keys-reveal"
            onClick={() => setReveal((v) => !v)}
            aria-label={reveal ? t('keys.hideKey') : t('keys.showKey')}
            aria-pressed={reveal}
            title={reveal ? t('keys.hide') : t('keys.show')}
          >
            {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </label>

      <p className="modal-hint keys-field-hint">
        {t('keys.storageHint')}
        {entry.configured && t('keys.overwriteHint')}
      </p>

      <ModalActions
        confirmLabel={t('keys.save')}
        busyLabel={t('keys.saving')}
        busy={busy}
        disabled={!value.trim()}
        onConfirm={submit}
        onCancel={onCancel}
      />
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

function localizeKeys(entries: KeyEntry[], manifests: readonly Manifest[]): KeyEntry[] {
  const localized = new Map(manifests.map((manifest) => {
    const view = localizeManifest(
      manifest,
      (manifest as TranslatableManifest).locales,
      currentLocale(),
    );
    return [view.id, view] as const;
  }));
  return entries.map((entry) => {
    const manifest = localized.get(entry.extId);
    const config = manifest?.config?.find((item) => item.key === entry.key);
    return manifest
      ? { ...entry, extName: manifest.name, label: config?.label ?? entry.label }
      : entry;
  });
}

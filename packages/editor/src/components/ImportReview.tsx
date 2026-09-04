/**
 * 安裝前的審閱畫面（§12.1、P3 第 2 步）。
 *
 * §12.1 的第一列寫的是「安裝前完整顯示原始碼，**不可略過**」，而這一頁就是那
 * 句話。它的形狀由那句話決定：
 *
 * **原始碼不是一個要點開的區塊，它是這一頁的主體。** 摺疊起來、給一顆「檢視
 * 程式碼」的按鈕也說得通，而那正是「可略過」——一個沒有人按的按鈕與沒有那份
 * 程式碼是一樣的。所以右邊那一整欄從一開始就是 `main.py`，而左邊是檔案清單。
 *
 * **安裝那顆按鈕在最上面，不在原始碼捲完之後。** 相反的做法（要捲到底才按得到）
 * 是一種假的儀式：它換來的不是「使用者讀完了」，是「使用者學會了怎麼快速捲到
 * 底」，而且它讓一個已經看過這個包三次的人每次都要再捲一遍。
 *
 * **摘要在按鈕旁邊，程式碼在下面。** 使用者讀得懂的是「這個包會連上網路、會多
 * 出 3 顆積木」，讀不懂的是 200 行 Python——所以宣告那幾列排在前面，而靜態掃描
 * （`codescan.py`）的作用是把那 200 行裡值得看的幾行**指出來**，不是替他讀。
 *
 * 這一頁是**擴充功能面板的另一個狀態**，不是另一條路：按下取消回到那一頁，而
 * 搜尋框裡的字還在——使用者看完一個包之後的下一個動作多半是「那我裝別的」。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, FileCode, Loader2, ShieldCheck } from 'lucide-react';
import type { ImportReview as Review } from '../api/client';
import {
  formatSize,
  looseFindings,
  mismatchedFindings,
  permissionRows,
  summarize,
} from './importRules';
import { focusableIn, modalKeyAction, nextFocusIndex } from './modalKeys';

export interface ImportReviewProps {
  review: Review;
  /** 安裝中（按鈕轉圈、整頁按不動）。 */
  busy: boolean;
  /** 安裝失敗那一句。 */
  error: string | null;
  onInstall(): void;
  onCancel(): void;
}

export function ImportReviewScreen({ review, busy, error, onInstall, onCancel }: ImportReviewProps) {
  const [openFile, setOpenFile] = useState(() => review.sources[0]?.path ?? '');
  const dialogRef = useRef<HTMLDivElement>(null);
  const installRef = useRef<HTMLButtonElement>(null);
  const codeRef = useRef<HTMLPreElement>(null);

  const rows = useMemo(() => permissionRows(review), [review]);
  const mismatched = useMemo(() => mismatchedFindings(review), [review]);
  const loose = useMemo(() => looseFindings(review), [review]);
  const shown = review.sources.find((s) => s.path === openFile) ?? review.sources[0];

  // 開場焦點落在「安裝」——**但不是因為那是建議的動作**：它是這一頁唯一一顆
  // 會改變這台機器的按鈕，而鍵盤使用者要知道自己的 Enter 現在指著什麼。
  useEffect(() => {
    installRef.current?.focus();
  }, []);
  // 換一個檔案時程式碼要從頭看起。少了這行，點開 `manifest.yaml` 會停在上一個
  // 檔案捲到的那一行，而那是一個看起來像「這個檔案就這麼長」的畫面。
  //
  // `scrollTop = 0` 而不是 `scrollTo(0, 0)`：後者在 jsdom 裡不存在，而那讓這個
  // 元件連「掛得起來嗎」都測不了。兩者在瀏覽器裡對一個不橫向捲的區塊是同一件事。
  useEffect(() => {
    if (codeRef.current) codeRef.current.scrollTop = 0;
  }, [openFile]);

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
      if (!busy) onCancel();
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
    <div
      className="import-review"
      role="dialog"
      aria-modal="true"
      aria-label={`安裝 ${review.name}`}
      ref={dialogRef}
      onKeyDown={onKeyDown}
    >
      <header className="import-head">
        <button type="button" className="gallery-back" onClick={onCancel} disabled={busy}>
          <ArrowLeft size={20} strokeWidth={2.5} /> 取消
        </button>
        <div className="import-title">
          <h2>
            {review.name} <span className="import-version">v{review.version}</span>
          </h2>
          <p>
            {review.id}
            {review.author ? ` · ${review.author}` : ''} · 會多出 {summarize(review)}
          </p>
        </div>
        {review.installed ? (
          // §16 Q24 還沒答。**在這裡就說**，而不是等他讀完再拒絕。
          <span className="import-blocked">
            已經裝過 v{review.installed.version}——更新／替換還沒接上
          </span>
        ) : (
          <button
            type="button"
            ref={installRef}
            className="button is-primary import-install"
            onClick={onInstall}
            disabled={busy}
          >
            {busy ? <Loader2 size={14} strokeWidth={2.5} className="import-spin" /> : null}
            {busy ? '安裝中…' : '安裝'}
          </button>
        )}
      </header>

      {error && <p className="import-error">{error}</p>}
      {busy && review.requirements.length > 0 && (
        // 有 `requirements` 的包要建一支 venv 並下載依賴，那可能是幾十秒。一個
        // 沒有說話的轉圈與當掉在畫面上長得一模一樣（第 17 條）。
        <p className="import-note">正在幫它準備一個獨立的 Python 環境，第一次會久一點…</p>
      )}

      <div className="import-body">
        <section className="import-summary">
          {review.description && <p className="import-desc">{review.description}</p>}

          <h3>
            <ShieldCheck size={14} strokeWidth={2.5} /> 這個包會做什麼
          </h3>
          {rows.length === 0 ? (
            <p className="import-none">沒有宣告任何權限，程式碼裡也沒有掃到對應的呼叫。</p>
          ) : (
            <ul className="import-perms">
              {rows.map((row) => (
                <li key={row.permission} className={row.declared ? '' : 'is-mismatch'}>
                  <span className="import-perm-label">{row.label}</span>
                  <span className="import-perm-note">
                    {row.declared
                      ? row.seen > 0
                        ? `宣告了，程式碼裡看到 ${row.seen} 處`
                        : '宣告了'
                      : `沒有宣告，但程式碼裡看到 ${row.seen} 處`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {mismatched.length > 0 && (
            <p className="import-warn">
              <AlertTriangle size={14} strokeWidth={2.5} />
              有 {mismatched.length} 個地方在做沒有宣告過的事。最無害的解釋是作者忘了寫宣告——
              但那份宣告是你唯一拿到的摘要，所以值得看一眼下面那幾行。
            </p>
          )}

          {loose.length > 0 && (
            <>
              <h3>另外值得看一眼的</h3>
              <ul className="import-findings">
                {loose.map((f, i) => (
                  <li key={`${f.path}:${f.line}:${i}`}>
                    <button type="button" onClick={() => setOpenFile(f.path)}>
                      {f.path}:{f.line}
                    </button>
                    <span>{f.message}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {mismatched.length > 0 && (
            <ul className="import-findings">
              {mismatched.map((f, i) => (
                <li key={`${f.path}:${f.line}:${i}`} className="is-mismatch">
                  <button type="button" onClick={() => setOpenFile(f.path)}>
                    {f.path}:{f.line}
                  </button>
                  <span>{f.message}</span>
                </li>
              ))}
            </ul>
          )}

          {review.requirements.length > 0 && (
            <>
              <h3>會裝進一支獨立環境的套件</h3>
              <ul className="import-list">
                {review.requirements.map((r) => (
                  <li key={r}>
                    <code>{r}</code>
                  </li>
                ))}
              </ul>
            </>
          )}

          {review.config.length > 0 && (
            <>
              <h3>裝好之後要填的</h3>
              <ul className="import-list">
                {review.config.map((c) => (
                  <li key={c.key}>
                    {c.label ?? c.key}
                    {c.type === 'secret' ? '（金鑰，存進系統鑰匙圈）' : ''}
                  </li>
                ))}
              </ul>
            </>
          )}

          {review.urls.length > 0 && (
            <>
              {/* 工具箱上那顆按鈕按下去瀏覽器會開它，而那一刻沒有人會再問一次。 */}
              <h3>工具箱上的按鈕會開的網址</h3>
              <ul className="import-list">
                {review.urls.map((u) => (
                  <li key={u}>
                    <code>{u}</code>
                  </li>
                ))}
              </ul>
            </>
          )}

          {review.blocks.length > 0 && (
            <>
              <h3>會多出這幾顆積木</h3>
              <ul className="import-list">
                {review.blocks.map((b) => (
                  <li key={b.opcode}>{b.text}</li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="import-code">
          <div className="import-files">
            {review.files.map((f) => {
              const readable = review.sources.some((s) => s.path === f.path);
              return (
                <button
                  key={f.path}
                  type="button"
                  className={`import-file${f.path === shown?.path ? ' is-on' : ''}`}
                  onClick={() => readable && setOpenFile(f.path)}
                  // 攤不開的（圖片、字型）仍然要列出來——「這個 zip 裡到底有什麼」
                  // 是這一頁要回答的第一個問題。但點它沒有意義。
                  disabled={!readable}
                  title={readable ? f.path : `${f.path}（不是文字檔）`}
                >
                  <FileCode size={13} strokeWidth={2.5} />
                  <span className="import-file-name">{f.path}</span>
                  <span className="import-file-size">{formatSize(f.size)}</span>
                </button>
              );
            })}
            {review.omitted.length > 0 && (
              <p className="import-omitted">
                另外 {review.omitted.length} 個文字檔沒有攤開（太大或讀不成文字）。
              </p>
            )}
          </div>
          <pre className="import-source" ref={codeRef} tabIndex={0} aria-label="原始碼">
            <code>{shown?.text ?? ''}</code>
            {shown?.truncated && <div className="import-truncated">（這個檔案太長，只顯示前面一段）</div>}
          </pre>
        </section>
      </div>
    </div>
  );
}

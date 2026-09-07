/** 安裝摘要：来源、功能、依賴，以及更新對畫布的影響。 */
import { useEffect, useMemo, useRef } from 'react';
import { AlertTriangle, ArrowLeft, Loader2, RotateCw } from 'lucide-react';
import type { ExtensionDiff, ImportReview as Review } from '../api/client';
import type { UpdateVerdict } from './importRules';
import {
  changeWords,
  summarize,
  updateVerdict,
} from './importRules';
import { focusableIn, modalKeyAction, nextFocusIndex } from './modalKeys';
import { number, t } from '../i18n';

export interface ImportReviewProps {
  review: Review;
  /** 安裝中（按鈕轉圈、整頁按不動）。 */
  busy: boolean;
  /** 安裝失敗那一句。 */
  error: string | null;
  /** 「這幾種積木，畫布上各有幾顆」（§4 的差集要它，`App` 才數得出來）。 */
  countOpcodes(opcodes: string[]): Record<string, number>;
  /** 「滑到那幾顆去」。被擋下來的更新要一樣可解（§4）。 */
  onGlideTo(opcode: string): void;
  onInstall(): void;
  onCancel(): void;
  /**
   * 「第 2 個，共 3 個」——**一份專案帶了好幾個包**的時候（
   * `docs/project-storage-design.md` §7）。一個包一頁的規則沒有變，多的只是
   * 一句「還有幾個」：少了它，使用者不知道自己按下「下一個」之後會走到哪裡。
   */
  progress?: { at: number; total: number } | null;
  /** 安裝那顆按鈕上的字。多包那條路上它是「安裝這個，下一個」。 */
  installLabel?: string;
  /** 多包安裝時，安裝其餘插件。 */
  onSkipRest?: (() => void) | null;
  skipLabel?: string;
}

export function ImportReviewScreen({
  review,
  busy,
  error,
  countOpcodes,
  onGlideTo,
  onInstall,
  onCancel,
  progress = null,
  installLabel,
  onSkipRest = null,
  skipLabel,
}: ImportReviewProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const installRef = useRef<HTMLButtonElement>(null);

  /**
   * 差集 ∩ 畫布（§4 那張表的兩半合起來）。
   *
   * `gone` 裡**畫布上真的有的**那幾顆是擋的理由——跟「還有 3 顆在用，不准刪」
   * 是同一句話。沒人用到的照樣列出來，但那只是「只說一聲」那一列。
   */
  const update = review.installed?.diff ?? null;
  const usage = useMemo(
    () =>
      update
        ? countOpcodes([
            ...update.gone.map((g) => g.opcode),
            ...update.changed.map((c) => c.opcode),
          ])
        : {},
    // `countOpcodes` 是 `App` 每次 render 都新做的一個 closure，放進相依會讓
    // 這裡每次都重算一次工作區——而畫布在這一頁底下，這段時間它不會變。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [update],
  );
  const verdict = update ? updateVerdict(update, usage) : null;
  // 開場焦點落在「安裝」——**但不是因為那是建議的動作**：它是這一頁唯一一顆
  // 會改變這台機器的按鈕，而鍵盤使用者要知道自己的 Enter 現在指著什麼。
  useEffect(() => {
    installRef.current?.focus();
  }, []);

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
      aria-label={t('import.installAria', { name: review.name })}
      ref={dialogRef}
      onKeyDown={onKeyDown}
    >
      <header className="import-head">
        <button type="button" className="gallery-back" onClick={onCancel} disabled={busy}>
          <ArrowLeft size={20} strokeWidth={2.5} /> {t('import.cancel')}
        </button>
        <div className="import-title">
          <h2>
            {review.name} <span className="import-version">v{review.version}</span>
          </h2>
          <p>
            {progress ? t('import.progress', { at: number(progress.at), total: number(progress.total) }) : ''}
            {review.id}
            {review.author ? ` · ${review.author}` : ''} · {t('import.adds', { summary: summarize(review) })}
          </p>
        </div>
        {verdict && verdict.blocking.length > 0 ? (
          // **擋**：新版少了畫布上正在用的積木。跟「還有 3 顆在用，不准刪」是
          // 同一句話——而它一樣可解，下面那一段列得出是哪幾顆、滑得過去。
          <span className="import-blocked">
            {t('import.updateBlocked')}
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
            {busy
              ? review.installed
                ? t('import.updating')
                : t('import.installing')
              : review.installed
                ? t('import.updateTo', { version: review.version })
                : (installLabel ?? t('import.install'))}
          </button>
        )}
      </header>

      {error && <p className="import-error">{error}</p>}
      {busy && review.requirements.length > 0 && (
        // 有 `requirements` 的包要建一支 venv 並下載依賴，那可能是幾十秒。一個
        // 沒有說話的轉圈與當掉在畫面上長得一模一樣（第 17 條）。
        <p className="import-note">{t('import.preparing')}</p>
      )}

      <div className="import-body">
        <section className="import-summary">
          {review.description && <p className="import-desc">{review.description}</p>}

          {update && verdict && (
            <UpdateDiff
              diff={update}
              usage={usage}
              verdict={verdict}
              from={review.installed?.version ?? ''}
              onGlideTo={onGlideTo}
            />
          )}

          <h3>{t('import.source')}</h3>
          <p>{review.origin.label}</p>
          {review.origin.url && <p>{review.origin.url}</p>}
          {review.origin.commit && <p><code>{review.origin.commit}</code></p>}
          {review.editor && <p>{t('import.editorPlugin')}</p>}

          {review.requirements.length > 0 && (
            <>
              <h3>{t('import.requirements')}</h3>
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
              <h3>{t('import.config')}</h3>
              <ul className="import-list">
                {review.config.map((c) => (
                  <li key={c.key}>
                    {c.label ?? c.key}
                    {c.type === 'secret' ? t('import.secretConfig') : ''}
                  </li>
                ))}
              </ul>
            </>
          )}

          {review.urls.length > 0 && (
            <>
              {/* 工具箱上那顆按鈕按下去瀏覽器會開它，而那一刻沒有人會再問一次。 */}
              <h3>{t('import.urls')}</h3>
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
              <h3>{t('import.blocks')}</h3>
              <ul className="import-list">
                {review.blocks.map((b) => (
                  <li key={b.opcode}>{b.text}</li>
                ))}
              </ul>
            </>
          )}
        </section>

      </div>

      {onSkipRest && (
        // 頁面底部，所以他至少捲過了這一個包的摘要（見 `onSkipRest` 那段）。
        <footer className="import-foot">
          <button type="button" className="button" onClick={onSkipRest} disabled={busy}>
            {skipLabel ?? t('import.skipRest')}
          </button>
        </footer>
      )}
    </div>
  );
}

/**
 * 「跟你手上那一版比起來，這一版差在哪」（§4）。
 *
 * 三段，照嚴重度由上而下，而**分段的規則不是「變動的種類」是「誰會受影響」**：
 * 同樣是「少了一顆積木」，畫布上有的那幾顆會擋住更新，沒人用到的只是一行字。
 * 這也是為什麼這個元件同時吃 `diff`（後端算的）與 `usage`（`App` 數的）——
 * §4 那張表的兩欄各在一邊。
 */
function UpdateDiff({
  diff,
  usage,
  verdict,
  from,
  onGlideTo,
}: {
  diff: ExtensionDiff;
  usage: Record<string, number>;
  verdict: UpdateVerdict;
  from: string;
  onGlideTo(opcode: string): void;
}) {
  const { blocking, warning, quietGone, nothingDeclared } = verdict;

  return (
    <>
      <h3>
        <RotateCw size={14} strokeWidth={2.5} /> {t('import.updateHeading', { from, to: diff.version.to })}
      </h3>

      {nothingDeclared && (
        // 兩份一模一樣的宣告。**這仍然是一次真的更新**（程式碼可能全改了，而
        // manifest 看不出來——§8：分不出來的就不假裝分得出來），所以不說「沒有
        // 變化」，只說宣告沒變。
        <p className="import-none">{t('import.sameDeclarations')}</p>
      )}

      {blocking.length > 0 && (
        <div className="import-diff is-blocking">
          <h4>
            <AlertTriangle size={13} strokeWidth={2.5} /> {t('import.missingUsed')}
          </h4>
          <ul>
            {blocking.map((g) => (
              <li key={g.opcode}>
                <button type="button" onClick={() => onGlideTo(g.opcode)}>
                  {g.text}
                </button>
                {t('import.canvasUsage', { count: number(usage[g.opcode] ?? 0) })}
                {g.why === 'shape' ? t('import.shapeChanged') : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {warning.length > 0 && (
        <div className="import-diff is-warning">
          <h4>
            <AlertTriangle size={13} strokeWidth={2.5} /> {t('import.usedChanged')}
          </h4>
          <ul>
            {warning.map((c) => (
              <li key={c.opcode}>
                <button type="button" onClick={() => onGlideTo(c.opcode)}>
                  {c.text}
                </button>
                {t('import.usedChange', { count: number(usage[c.opcode] ?? 0), changes: changeWords(c) })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(quietGone.length > 0 ||
        diff.added.length > 0 ||
        diff.requirementsChanged) && (
        <div className="import-diff">
          <h4>{t('import.otherChanges')}</h4>
          <ul>
            {diff.requirementsChanged && <li>{t('import.requirementsChanged')}</li>}
            {quietGone.map((g) => (
              <li key={g.opcode}>{t('import.removedUnused', { text: g.text })}</li>
            ))}
            {diff.added.map((b) => (
              <li key={b.opcode}>{t('import.addedBlock', { text: b.text })}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

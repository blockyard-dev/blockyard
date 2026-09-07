/**
 * 收下一份別人帶來的專案（`docs/project-storage-design.md` §7）。
 *
 * **這一頁不發明任何新機制**：一份 bundle 就是「一個新專案 + N 次已經蓋好的
 * 那條安裝管線」，而每一個要看的包走的是與 `.zip` 完全相同的那一頁審閱畫面
 * （`ImportReviewScreen`）。一條只有匯入才走的安裝路，遲早會是「從專案檔裝的
 * 包比較少檢查」。
 *
 * 三種包，三種待遇（後端算的，見 `api/bundle.py`）：
 *
 * * **一樣的**（digest 相同）——完全不出現。這一條讓最常見的路沒有摩擦：一份
 *   只用官方包的專案，收的人一個審閱畫面都不會看到。
 * * **不一樣的**（同 id、不同內容）——跳過，**並且說出來**。覆蓋是更新，不能
 *   靠匯入偷渡。
 * * **沒裝過的**——一個包一頁，完整原始碼（§12.1）。
 *
 * 所以這個元件有兩個畫面：一頁「會發生什麼事」的清單，以及那一疊審閱頁。
 * **什麼都不必說的時候兩頁都不出現**——直接開出那個專案。
 */
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Loader2, Package } from 'lucide-react';
import {
  cancelBundleImport,
  finishBundleImport,
  installBundledPack,
  type BundleReview,
} from '../api/projects';
import { ImportReviewScreen } from './ImportReview';
import { number, t } from '../i18n';

export interface ProjectImportProps {
  review: BundleReview;
  /**
   * 「這幾種積木，畫布上各有幾顆」——審閱頁的差集要它。
   *
   * **這條路上永遠用不到**，所以有預設值：一份 bundle 只裝得了 `new` 的包
   * （同 id 的一律 409，覆蓋是更新那條路，§7），而差集只有更新才有。而且這一頁
   * 站在主選單上——**那裡根本沒有畫布可以數**。給一個誠實的 0 比要求呼叫端編一個
   * 假的答案好。
   */
  countOpcodes?(opcodes: string[]): Record<string, number>;
  onGlideTo?(opcode: string): void;
  /** 開好了。呼叫端負責切過去（那是一次整頁重載，見 `projectsStore`）。 */
  onOpened(projectId: string, message: string): void;
  onCancel(): void;
}

export function ProjectImport({
  review,
  countOpcodes = () => ({}),
  onGlideTo = () => {},
  onOpened,
  onCancel,
}: ProjectImportProps) {
  /** 要一個一個看的那幾個。順序就是 bundle 裡的順序。 */
  const pending = review.packs.filter((p) => p.status === 'new' && p.review);
  const skipped = review.packs.filter((p) => p.status === 'different');
  const same = review.packs.filter((p) => p.status === 'same');

  /** `-1` = 還在那頁清單上；`>= 0` = 正在看第幾個。 */
  const [at, setAt] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 已經裝好的那幾個 id。**擋重覆**：同一個包裝第二次後端會 409。 */
  const doneRef = useRef<Set<string>>(new Set());
  /** 自動開場只跑一次（StrictMode 會把 effect 跑兩遍）。 */
  const autoRef = useRef(false);

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const opened = await finishBundleImport(review.token);
      onOpened(
        opened.id,
        t('projectImport.done', {
          name: opened.name,
          skipped: skipped.length > 0
            ? t('projectImport.skippedNotice', { count: number(skipped.length) })
            : '',
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  /**
   * **沒有任何話要說的時候，這一頁不出現。**
   *
   * 「三分鐘做一個 Discord bot」那份 demo 帶的都是官方包，digest 一樣、也沒有
   * 東西被跳過——那一刻多一頁「按下去繼續」，就是為了一件沒有發生的事要求
   * 一次點擊。
   */
  useEffect(() => {
    if (autoRef.current) return;
    if (pending.length === 0 && skipped.length === 0 && review.sameName.length === 0) {
      autoRef.current = true;
      void finish();
    }
    // 只看這一份 review：它在這個元件的一生裡不會變（換一份 bundle 是換一次
    // 掛載）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review]);

  const cancel = () => {
    cancelBundleImport(review.token);
    onCancel();
  };

  /** 裝一個包，然後往下一個走。最後一個裝完就開專案。 */
  const installOne = async (extId: string) => {
    setBusy(true);
    setError(null);
    try {
      if (!doneRef.current.has(extId)) {
        await installBundledPack(review.token, extId);
        doneRef.current.add(extId);
      }
      setBusy(false);
      if (at + 1 < pending.length) setAt(at + 1);
      else void finish();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  /** 那條出口：剩下的不看了，一次裝完（§7）。 */
  const installRest = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const pack of pending.slice(at)) {
        if (doneRef.current.has(pack.id)) continue;
        await installBundledPack(review.token, pack.id);
        doneRef.current.add(pack.id);
      }
      void finish();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const current = at >= 0 ? pending[at] : null;
  if (current?.review) {
    const left = pending.length - at - 1;
    return (
      <ImportReviewScreen
        review={current.review}
        busy={busy}
        error={error}
        countOpcodes={countOpcodes}
        onGlideTo={onGlideTo}
        progress={{ at: at + 1, total: pending.length }}
        installLabel={left > 0 ? t('projectImport.installNext') : t('projectImport.installOpen')}
        onInstall={() => void installOne(current.id)}
        onCancel={cancel}
        // **最後一個沒有「其餘」**：那顆按鈕在那一頁上只會是同一件事的第二個
        // 說法，而它的字（「略過其餘 0 份」）本身就是錯的。
        onSkipRest={left > 0 ? () => void installRest() : null}
        skipLabel={t('projectImport.installRest', { count: number(left) })}
      />
    );
  }

  return (
    <div className="gallery" role="dialog" aria-modal="true" aria-label={t('projectImport.title')}>
      <header className="gallery-head">
        <button type="button" className="gallery-back" onClick={cancel} disabled={busy}>
          <ArrowLeft size={20} strokeWidth={2.5} /> {t('common.cancel')}
        </button>
        <h2>{t('projectImport.namedTitle', { name: review.name })}</h2>
        <button
          type="button"
          className="button gallery-import"
          onClick={() => (pending.length > 0 ? setAt(0) : void finish())}
          disabled={busy}
        >
          {busy && <Loader2 size={14} strokeWidth={2.5} className="import-spin" />}
          {pending.length > 0 ? t('projectImport.reviewFirst') : t('projectImport.open')}
        </button>
      </header>

      <div className="import-plan">
        {error && (
          <p className="gallery-alert" role="alert">
            <AlertTriangle size={14} strokeWidth={2.5} /> {error}
          </p>
        )}

        {review.sameName.length > 0 && (
          // §10：id 是 opaque 的，所以技術上一定並存——畫面上要說得出這件事，
          // 不然使用者以為自己剛剛覆蓋了什麼。
          <p className="import-plan-note">
            {t('projectImport.sameName', { count: number(review.sameName.length) })}
          </p>
        )}

        {pending.length > 0 && (
          <section>
            <h3>
              <Package size={14} strokeWidth={2.5} /> {t('projectImport.newPacks', { count: number(pending.length) })}
            </h3>
            <p className="import-plan-note">
              {t('projectImport.codeWarning')}
            </p>
            <ul className="import-plan-list">
              {pending.map((p) => (
                <li key={p.id}>
                  <strong>{p.name}</strong> <code>{p.id}</code> v{p.version}
                </li>
              ))}
            </ul>
          </section>
        )}

        {skipped.length > 0 && (
          <section>
            <h3>
              <AlertTriangle size={14} strokeWidth={2.5} /> {t('projectImport.skipped', { count: number(skipped.length) })}
            </h3>
            <p className="import-plan-note">
              {t('projectImport.differentWarning')}
            </p>
            <ul className="import-plan-list">
              {skipped.map((p) => (
                <li key={p.id}>
                  <strong>{p.name}</strong> <code>{p.id}</code>
                  {t('projectImport.versionCompare', { bundled: p.version, installed: p.installedVersion ?? '' })}
                </li>
              ))}
            </ul>
          </section>
        )}

        {same.length > 0 && (
          <p className="import-plan-note">
            {t('projectImport.samePacks', { count: number(same.length) })}
          </p>
        )}
      </div>
    </div>
  );
}

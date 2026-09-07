/**
 * 變數監看面板與 log（§8.3 的 `var.set` 那一列、§15 驗收 1 的「變數面板即時變動」）。
 *
 * §8.5 說變數清單的來源是「掃描工作區」，不是 IR 的 `variables` map。這裡的
 * 來源比那更即時：**執行中的 `var.set` 事件**。兩者不衝突——掃描工作區回答的是
 * 「這份專案用到哪些變數」（第 6 步的 autocomplete 要用），這裡回答的是
 * 「現在它們是多少」，而後者只有 Run 知道。
 */
import { useCallback, useRef, useState } from 'react';
import { readPref, writePref } from '../prefs';
import { useRunStore, type LogLine } from '../run/store';
import { JsonTree } from './JsonTree';
import { ExtPanel } from './ExtPanel';
import { PanelWindow } from './PanelWindow';
import { useKeysUi } from './keysStore';
import { number, t } from '../i18n';

/** §8.3：變數面板預設開著，但要能關。開關記在偏好裡，**不進 IR**（§16 Q15）。 */
const VARIABLES_OPEN = 'variables-panel-open';

/** 面板寬度的偏好 key。跟 `flyoutWidth` 一樣是偏好，不是專案的一部分。 */
const WIDTH_PREF = 'runPanelWidth';

/** 預設寬度，對應原本寫死的 `17rem`。 */
const DEFAULT_WIDTH = 272;

/** 再窄下去 JSON 樹會逐字換行，讀不成句子。 */
const MIN_WIDTH = 180;

/** 拉太寬就不是「面板」了。畫布至少要留這麼多（跟 `FlyoutResizer` 同一個數）。 */
const CANVAS_MIN_PX = 240;

/** 現在看的是哪一頁。記在偏好裡，與寬度、變數開關同一本帳（§16 Q15）。 */
const TAB_PREF = 'runPanelTab';

/** `執行` 那一頁，或某一塊面板的標題。 */
const RUN_TAB = '\u0000run';

/**
 * 分頁列：`執行` + **每一塊面板各一格**，一次看一塊、佔滿整片。
 *
 * **變數與輸出刻意留在同一頁**（`執行`）。除錯時最常見的動作是「看變數變成
 * 什麼，同時看 log 說了什麼」（§15 驗收 1 那句「積木逐顆高亮、變數面板即時
 * 變動」講的就是這個同時性）；拆成兩頁就是逼人二選一。
 *
 * 分頁的數量因此由**資料**決定，而標題是使用者打的字、還可以插值——所以分頁列
 * 橫向捲（CSS 那邊），而塊數上限在 store（`PANEL_LIMIT`）。這是知情的取捨：
 * 一次看一塊、每塊都滿版，比一疊擠在一起的小卡片有用。
 */

/** 已啟用的包宣告的那幾格（§8.3）。分頁列把它們與資料生出來的那些併起來顯示。 */
export interface DeclaredPanel {
  extId: string;
  panelId: string;
  name: string;
  entry: string;
}

/** 分頁的 key。用 `extId/panelId` 而不是名字——名字是 manifest 寫的，會重複。 */
const keyOf = (p: DeclaredPanel) => `${p.extId}/${p.panelId}`;

export function RunPanel({ declared = [] }: { declared?: DeclaredPanel[] }) {
  const status = useRunStore((s) => s.status);
  const variables = useRunStore((s) => s.variables);
  const logs = useRunStore((s) => s.logs);
  const dropped = useRunStore((s) => s.dropped);
  const extPanels = useRunStore((s) => s.extPanels);
  const [windowOpen, setWindowOpen] = useState(false);
  const [tab, setTab] = useState<string>(() => readPref<string>(TAB_PREF, RUN_TAB));
  const [varsOpen, setVarsOpen] = useState(() => readPref(VARIABLES_OPEN, true));
  const [width, setWidth] = useState(() => readPref(WIDTH_PREF, DEFAULT_WIDTH));
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const apply = useCallback((next: number) => {
    const max = Math.max(MIN_WIDTH, window.innerWidth - CANVAS_MIN_PX);
    const clamped = Math.round(Math.min(Math.max(next, MIN_WIDTH), max));
    setWidth(clamped);
    return clamped;
  }, []);

  const pick = (next: string) => {
    setTab(next);
    writePref(TAB_PREF, next);
  };

  const toggleVars = () => {
    setVarsOpen((open) => {
      writePref(VARIABLES_OPEN, !open);
      return !open;
    });
  };

  // **分頁就是宣告出來的那幾格。** 一個包啟用著，它宣告的面板就在——不會因為
  // 這次執行沒畫東西就消失，也不會因為標題插值長出第二十四格。
  const activeDeclared = declared.find((d) => keyOf(d) === tab) ?? null;
  const showRun = !activeDeclared;
  const panelProps = activeDeclared && {
    extId: activeDeclared.extId,
    panelId: activeDeclared.panelId,
    entry: activeDeclared.entry,
    outbox: extPanels.get(tab)?.messages ?? [],
    truncated: extPanels.get(tab)?.truncated ?? false,
  };

  if (status === 'idle') return null;

  return (
    <aside className="run-panel" style={{ width }}>
      {/* 左緣的把手。跟積木面板那條（`FlyoutResizer`）是同一個手勢，方向相反：
          這片貼右邊，所以往左拖是「變寬」。畫在 aside 裡面而不是 stage 上，
          因為它的位置就是這片的左緣——沒有第二本帳要對。 */}
      <div
        className="run-panel-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('run.resize')}
        title={t('run.resizeHelp')}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { startX: event.clientX, startWidth: width };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start) return;
          apply(start.startWidth - (event.clientX - start.startX));
        }}
        onPointerUp={(event) => {
          if (!drag.current) return;
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          // 只在放開時寫偏好：拖曳中每一幀都寫 localStorage 是同步 I/O。
          writePref(WIDTH_PREF, width);
        }}
        onDoubleClick={() => {
          writePref(WIDTH_PREF, apply(DEFAULT_WIDTH));
        }}
      />
      {/* 分頁列。**藏起來的那一頁發生了事，畫面上要說得出來**——這是 D33
          修過的形狀（一則訊息的 Run 只有零點幾毫秒，使用者看到一片安靜）。
          所以非當前分頁帶一個數字，與變數那一段摺起來時的 `section-count`
          是同一個東西。 */}
      <div className="run-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={showRun}
          className={`run-tab${showRun ? ' is-on' : ''}`}
          onClick={() => pick(RUN_TAB)}
        >
          {t('run.title')}
        </button>
        {declared.map((d) => {
          const key = keyOf(d);
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`run-tab${tab === key ? ' is-on' : ''}`}
              onClick={() => pick(key)}
              title={t('run.panelTitle', { name: d.name, extId: d.extId })}
            >
              {d.name}
            </button>
          );
        })}
      </div>

      {activeDeclared && panelProps ? (
        <section className="run-section run-section-panels">
          {/* **編輯器不畫面板的內容。** 它只給那個包一格 受信任的 iframe，
              裡面畫什麼（折線圖、three.js、地圖）完全是那個包的 `ui/` 的事。
              少了這條，每加一種圖表就要改編輯器一次。 */}
          <div className="panel-view">
            {/* 跳出去的入口。**不在積木上**——彈出視窗是「看」的動作，寫進 IR
                的話換一台機器打開同一份專案，它會執著於在一扇不存在的窗裡畫圖。
                而它非得是點擊不可：`window.open` 的授權會過期。 */}
            <button
              type="button"
              className="panel-popout"
              onClick={() => setWindowOpen((open) => !open)}
              aria-label={windowOpen ? t('run.popIn') : t('run.popOut')}
              title={windowOpen ? t('run.popInAction') : t('run.popOut')}
            >
              {windowOpen ? '⤡' : '↗'}
            </button>
            {windowOpen ? (
              <p className="run-empty">{t('run.popped')}</p>
            ) : (
              <ExtPanel {...panelProps} />
            )}
          </div>
          {windowOpen && (
            // 搬進另一個 document 一定會重載（規格），所以那個 iframe 是新的一個
            // ——重播把它補回來。`key` 換掉是刻意的：不換的話 React 會試著沿用
            // 同一個 DOM 節點，而它已經不是同一份文件了。
            <PanelWindow onClose={() => setWindowOpen(false)}>
              <ExtPanel key={`${tab}#window`} {...panelProps} />
            </PanelWindow>
          )}
        </section>
      ) : (
      <>
      <section className="run-section">
        {/* 執行中的即時數值對除錯很有用，但它同時是一個一直在動的東西；
            不除錯的時候它只是在旁邊閃。所以要能關（§8.3）。 */}
        <h2>
          <button
            type="button"
            className="section-toggle"
            onClick={toggleVars}
            aria-expanded={varsOpen}
          >
            <span className="section-caret">{varsOpen ? '▾' : '▸'}</span> {t('run.variables')}
            {!varsOpen && variables.size > 0 && (
              <span className="section-count">{variables.size}</span>
            )}
          </button>
        </h2>
        {varsOpen &&
          (variables.size === 0 ? (
            <p className="run-empty">{t('run.noVariables')}</p>
          ) : (
            <ul className="var-list">
              {[...variables].map(([name, value]) => (
                <li key={name}>
                  <span className="var-name">{name}</span>
                  <JsonTree value={value} depth={1} />
                </li>
              ))}
            </ul>
          ))}
      </section>

      <section className="run-section run-section-logs">
        <h2>{t('common.output')}</h2>
        {logs.length === 0 ? (
          <p className="run-empty">{t('run.noOutput')}</p>
        ) : (
          <ol className="log-list">
            {logs.map((line) => (
              <li key={line.id} className={`log-${line.level}`}>
                {line.text}
                {/* 錯誤附帶的補救動作（§6.1）。「還沒設定金鑰」的正確結局是一顆
                    按鈕，不是一句叫使用者自己去右上角找面板、自己記得變數名的
                    話。認不得的 kind 就當作沒有——payload 一路經過積木包的
                    process，前端只認白名單。 */}
                {line.action?.kind === 'configure_secret' && (
                  <LogAction action={line.action} />
                )}
              </li>
            ))}
          </ol>
        )}
        {dropped > 0 && (
          // §6.2：丟掉可以，靜靜地丟掉不行。
          <p className="run-dropped">{t('run.dropped', { count: number(dropped) })}</p>
        )}
      </section>
      </>
      )}
    </aside>
  );
}


/** log 那一列上的補救按鈕。目前只有一種 kind，但形狀是為了會有第二種。 */
function LogAction({ action }: { action: NonNullable<LogLine['action']> }) {
  const openKeys = useKeysUi((s) => s.openKeys);
  const what = action.label ?? action.envVar ?? action.key;
  return (
    <button
      type="button"
      className="log-action"
      onClick={() =>
        openKeys({
          extId: action.extId,
          extName: action.extName,
          key: action.key,
          label: action.label,
          envVar: action.envVar,
        })
      }
    >
      {t('run.configureWhat', { what })}
    </button>
  );
}

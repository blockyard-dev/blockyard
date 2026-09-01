/**
 * 變數監看面板與 log（§8.3 的 `var.set` 那一列、§15 驗收 1 的「變數面板即時變動」）。
 *
 * §8.5 說變數清單的來源是「掃描工作區」，不是 IR 的 `variables` map。這裡的
 * 來源比那更即時：**執行中的 `var.set` 事件**。兩者不衝突——掃描工作區回答的是
 * 「這份專案用到哪些變數」（第 6 步的 autocomplete 要用），這裡回答的是
 * 「現在它們是多少」，而後者只有 Run 知道。
 */
import { useState } from 'react';
import { readPref, writePref } from '../prefs';
import { useRunStore, type LogLine } from '../run/store';
import { JsonTree } from './JsonTree';
import { useKeysUi } from './keysStore';

/** §8.3：變數面板預設開著，但要能關。開關記在偏好裡，**不進 IR**（§16 Q15）。 */
const VARIABLES_OPEN = 'variables-panel-open';

export function RunPanel() {
  const status = useRunStore((s) => s.status);
  const variables = useRunStore((s) => s.variables);
  const logs = useRunStore((s) => s.logs);
  const dropped = useRunStore((s) => s.dropped);
  const [varsOpen, setVarsOpen] = useState(() => readPref(VARIABLES_OPEN, true));

  const toggleVars = () => {
    setVarsOpen((open) => {
      writePref(VARIABLES_OPEN, !open);
      return !open;
    });
  };

  if (status === 'idle') return null;

  return (
    <aside className="run-panel">
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
            <span className="section-caret">{varsOpen ? '▾' : '▸'}</span> 變數
            {!varsOpen && variables.size > 0 && (
              <span className="section-count">{variables.size}</span>
            )}
          </button>
        </h2>
        {varsOpen &&
          (variables.size === 0 ? (
            <p className="run-empty">還沒有變數被設定。</p>
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
        <h2>輸出</h2>
        {logs.length === 0 ? (
          <p className="run-empty">還沒有輸出。</p>
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
          <p className="run-dropped">跟不上，後端丟棄了 {dropped.toLocaleString()} 筆事件</p>
        )}
      </section>
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
      去設定{what}
    </button>
  );
}

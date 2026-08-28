/**
 * 變數監看面板與 log（§8.3 的 `var.set` 那一列、§15 驗收 1 的「變數面板即時變動」）。
 *
 * §8.5 說變數清單的來源是「掃描工作區」，不是 IR 的 `variables` map。這裡的
 * 來源比那更即時：**執行中的 `var.set` 事件**。兩者不衝突——掃描工作區回答的是
 * 「這份專案用到哪些變數」（第 6 步的 autocomplete 要用），這裡回答的是
 * 「現在它們是多少」，而後者只有 Run 知道。
 */
import { useRunStore } from '../run/store';
import { JsonTree } from './JsonTree';

export function RunPanel() {
  const status = useRunStore((s) => s.status);
  const variables = useRunStore((s) => s.variables);
  const logs = useRunStore((s) => s.logs);
  const dropped = useRunStore((s) => s.dropped);

  if (status === 'idle') return null;

  return (
    <aside className="run-panel">
      <section className="run-section">
        <h2>變數</h2>
        {variables.size === 0 ? (
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
        )}
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

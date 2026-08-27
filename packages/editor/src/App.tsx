/**
 * P0b 第 3 步的殼：載入 manifest → 註冊 → 畫出工作區。
 *
 * 這一步還沒有專案的概念（存讀檔是第 4 步，執行是第 5 步），所以上方只有一條
 * 說明目前載進來多少東西的橫幅——它同時是「積木包裝好了沒」最快的回答。
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchExtensions } from './api/client';
import { registerManifests, type Registration } from './blockly/setup';
import { WorkspaceView } from './components/WorkspaceView';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; registration: Registration };

export function App() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetchExtensions(controller.signal)
      .then((manifests) => {
        setState({ status: 'ready', registration: registerManifests(manifests) });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: 'error', message: describe(error) });
      });
    return () => controller.abort();
  }, []);

  const summary = useMemo(() => {
    if (state.status !== 'ready') return null;
    const { groups, blocks } = state.registration;
    const builtin = groups.filter((g) => g.builtin).length;
    return `${groups.length} 個命名空間（內建 ${builtin}）· ${blocks.length} 顆積木`;
  }, [state]);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Blocky Workflow</span>
        {summary && <span className="summary">{summary}</span>}
      </header>

      {state.status === 'loading' && <Notice>載入積木宣告⋯</Notice>}

      {state.status === 'error' && (
        <Notice tone="error">
          <strong>連不上後端。</strong>
          <p>{state.message}</p>
          <p>
            先在另一個終端機跑 <code>cd backend &amp;&amp; .venv/bin/python -m blocky.cli serve</code>
            ，它會綁在 <code>127.0.0.1:8787</code>（dev server 代理過去）。
          </p>
        </Notice>
      )}

      {state.status === 'ready' && <WorkspaceView toolbox={state.registration.toolbox} />}
    </div>
  );
}

function Notice({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return <div className={tone === 'error' ? 'notice notice-error' : 'notice'}>{children}</div>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * P0b 第 5 步接上執行：載入 manifest → 註冊 → 讀專案 → 畫出工作區，
 * 存檔走 `ir/serialize.ts` → `PUT /api/projects/{id}`，
 * 執行走 `POST /api/runs` → `ws://…/ws/run/{runId}` → §8.3 的視覺回饋。
 *
 * **執行 = 先存檔再跑**。後端跑的是已存檔的那一份（`runs/manager.py` 開頭那段
 * 註解），所以按下執行必然先送一次 PUT——順帶讓 §4 的載入期驗證在執行之前就
 * 把壞掉的積木標紅，而不是等到 runtime 才說「未知變數」。
 *
 * 單專案模式（`PROJECT_ID` 固定）：專案列表、切換專案是之後的事。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Blockly from 'blockly/core';
import { ApiError, fetchExtensions, fetchProject, saveProject } from './api/client';
import { RunSocket, startRun, stopRun } from './api/runs';
import { registerManifests, type Registration } from './blockly/setup';
import { registerProcedures } from './blockly/procedures';
import { buildContext, type ConversionContext } from './ir/context';
import { loadProject } from './ir/deserialize';
import { serializeWorkspace } from './ir/serialize';
import { RunDecorator } from './run/decorate';
import { useRunStore } from './run/store';
import { RunBubbles } from './components/RunBubbles';
import { RunPanel } from './components/RunPanel';
import { WorkspaceView } from './components/WorkspaceView';
import type { BlockyProjectIR as ProjectIR } from './types/project';

const PROJECT_ID = 'prj_local';

function blankProject(): ProjectIR {
  return {
    formatVersion: 1,
    meta: { id: PROJECT_ID, name: '未命名專案' },
    extensions: [],
    variables: {},
    procedures: {},
    scripts: [],
    blocks: {},
  };
}

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; registration: Registration; project: ProjectIR; ctx: ConversionContext };

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

export function App() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const decoratorRef = useRef<RunDecorator | null>(null);
  const socketRef = useRef<RunSocket | null>(null);
  const [workspace, setWorkspace] = useState<Blockly.WorkspaceSvg | null>(null);

  const runStatus = useRunStore((s) => s.status);
  const runId = useRunStore((s) => s.runId);
  const runMessage = useRunStore((s) => s.message);
  const runBlocks = useRunStore((s) => s.blocks);
  const running = runStatus === 'starting' || runStatus === 'running';

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const manifests = await fetchExtensions(controller.signal);
      const registration = registerManifests(manifests);
      const loaded = await fetchProject(PROJECT_ID, controller.signal);
      const project = loaded ?? blankProject();
      const procedureBlocks = registerProcedures(project.procedures ?? {});
      const ctx = buildContext([...registration.blocks, ...procedureBlocks]);
      setState({ status: 'ready', registration, project, ctx });
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setState({ status: 'error', message: describe(error) });
    });
    return () => controller.abort();
  }, []);

  // 事件 → 積木外框。§8.2 說 workspace 是 uncontrolled，所以這條路徑刻意不經過
  // React 的 render：store 的 Map 換掉時直接改 SVG 的 class。
  useEffect(() => {
    decoratorRef.current?.sync(runBlocks);
  }, [runBlocks]);

  useEffect(() => () => socketRef.current?.close(), []);

  const handleWorkspaceReady = useCallback(
    (ws: Blockly.WorkspaceSvg) => {
      workspaceRef.current = ws;
      decoratorRef.current = new RunDecorator(ws);
      setWorkspace(ws);
      if (state.status === 'ready') loadProject(state.project, ws, state.ctx);
    },
    [state],
  );

  /** 存檔。回傳成功與否——執行要靠它決定要不要繼續。 */
  const save = useCallback(async (): Promise<boolean> => {
    if (state.status !== 'ready') return false;
    const ws = workspaceRef.current;
    if (!ws) return false;

    setSaveState({ status: 'saving' });
    // 上一次存檔標紅的警告，這次重新驗證前先清掉——不然改對的積木會一直
    // 顯示過期的錯誤。**帶 id 清**：不帶的話會連落單堆疊的警告（§4.1）一起
    // 拆掉，於是存一次檔畫布上的 ⚠ 就全部不見了。
    for (const block of ws.getAllBlocks(false)) block.setWarningText(null);

    const project = serializeWorkspace(ws, state.ctx, {
      formatVersion: state.project.formatVersion,
      meta: state.project.meta,
      extensions: state.project.extensions,
      procedures: state.project.procedures,
    });

    try {
      await saveProject(PROJECT_ID, project);
      setSaveState({ status: 'saved' });
      return true;
    } catch (error: unknown) {
      // 422 帶 blockId：後端已經算出是哪一顆積木不合法（§4.2 的 D20 形狀
      // 驗證、§4.7 的插值運算式擋修），直接把警告標在那顆積木上，比
      // 只顯示一行錯誤文字快得多。
      if (error instanceof ApiError && error.detail?.blockId) {
        const block = ws.getBlockById(error.detail.blockId);
        block?.setWarningText(error.detail.message);
        block?.select();
      }
      setSaveState({ status: 'error', message: describe(error) });
      return false;
    }
  }, [state]);

  const handleRun = useCallback(async () => {
    const store = useRunStore.getState();
    socketRef.current?.close();
    socketRef.current = null;
    decoratorRef.current?.clear();
    store.begin();

    if (!(await save())) {
      store.fail('存檔沒過，沒有東西可以跑');
      return;
    }

    try {
      const run = await startRun(PROJECT_ID);
      store.attach(run);
      socketRef.current = new RunSocket(run.runId, {
        onFrame: (frame) => useRunStore.getState().apply(frame),
        onClose: (clean) => {
          const s = useRunStore.getState();
          // Run 還在跑卻斷線：使用者要知道畫面停在半路，而不是以為它跑完了。
          if (s.status === 'running' || s.status === 'starting') {
            s.finish(clean ? 'cancelled' : 'error', clean ? undefined : '事件連線中斷');
          }
        },
      });
    } catch (error: unknown) {
      store.fail(describe(error));
    }
  }, [save]);

  const handleStop = useCallback(() => {
    if (runId) void stopRun(runId);
  }, [runId]);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Blocky Workflow</span>
        {state.status === 'ready' && (
          <span className="summary">
            {state.registration.groups.length} 個命名空間（內建{' '}
            {state.registration.groups.filter((g) => g.builtin).length}）·{' '}
            {state.registration.blocks.length} 顆積木
          </span>
        )}
        {state.status === 'ready' && (
          <div className="actions">
            <button
              type="button"
              className="button"
              onClick={() => void save()}
              disabled={saveState.status === 'saving' || running}
            >
              {saveState.status === 'saving' ? '存檔中…' : '存檔'}
            </button>
            <button
              type="button"
              className="button button-run"
              onClick={() => void handleRun()}
              disabled={running}
            >
              ▶ 執行
            </button>
            <button type="button" className="button" onClick={handleStop} disabled={!running}>
              ■ 停止
            </button>
          </div>
        )}
        <RunStatus />
        {saveState.status === 'error' && (
          <span className="save-status save-status-error">{saveState.message}</span>
        )}
        {saveState.status === 'saved' && runStatus === 'idle' && (
          <span className="save-status save-status-ok">已存檔</span>
        )}
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

      {state.status === 'ready' && (
        <div className="stage">
          <WorkspaceView toolbox={state.registration.toolbox} onReady={handleWorkspaceReady} />
          <RunBubbles workspace={workspace} />
          <RunPanel />
        </div>
      )}
      {runMessage && runStatus === 'error' && <span className="sr-only">{runMessage}</span>}
    </div>
  );
}

const RUN_LABEL: Record<string, string> = {
  starting: '準備中⋯',
  running: '執行中⋯',
  ok: '執行完成',
  error: '執行失敗',
  cancelled: '已停止',
};

function RunStatus() {
  const status = useRunStore((s) => s.status);
  const message = useRunStore((s) => s.message);
  if (status === 'idle') return null;
  return (
    <span className={`run-status run-status-${status}`}>
      {RUN_LABEL[status] ?? status}
      {status === 'error' && message ? `：${message}` : ''}
    </span>
  );
}

function Notice({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return <div className={tone === 'error' ? 'notice notice-error' : 'notice'}>{children}</div>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

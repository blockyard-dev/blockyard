/**
 * P0b 第 4 步接上存讀檔：載入 manifest → 註冊 → 讀專案 → 畫出工作區，
 * 存檔走 `ir/serialize.ts` → `PUT /api/projects/{id}`。
 *
 * 單專案模式（`PROJECT_ID` 固定）：專案列表、切換專案是之後的事，這一步只
 * 要把 IR ↔ Blockly 這條轉換層接上真正的後端，讓「存檔再讀回來」是一個
 * 真正閉環的迴圈。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Blockly from 'blockly/core';
import { ApiError, fetchExtensions, fetchProject, saveProject } from './api/client';
import { registerManifests, type Registration } from './blockly/setup';
import { registerProcedures } from './blockly/procedures';
import { buildContext, type ConversionContext } from './ir/context';
import { loadProject } from './ir/deserialize';
import { serializeWorkspace } from './ir/serialize';
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

  const handleWorkspaceReady = useCallback(
    (workspace: Blockly.WorkspaceSvg) => {
      workspaceRef.current = workspace;
      if (state.status === 'ready') loadProject(state.project, workspace, state.ctx);
    },
    [state],
  );

  const handleSave = useCallback(() => {
    if (state.status !== 'ready') return;
    const workspace = workspaceRef.current;
    if (!workspace) return;

    setSaveState({ status: 'saving' });
    // 上一次存檔標紅的警告，這次重新驗證前先清掉——不然改對的積木會一直
    // 顯示過期的錯誤。
    for (const block of workspace.getAllBlocks(false)) block.setWarningText(null);

    const project = serializeWorkspace(workspace, state.ctx, {
      formatVersion: state.project.formatVersion,
      meta: state.project.meta,
      extensions: state.project.extensions,
      procedures: state.project.procedures,
    });

    saveProject(PROJECT_ID, project)
      .then(() => setSaveState({ status: 'saved' }))
      .catch((error: unknown) => {
        // 422 帶 blockId：後端已經算出是哪一顆積木不合法（§4.2 的 D20 形狀
        // 驗證、§4.7 的插值運算式擋修），直接把警告標在那顆積木上，比
        // 只顯示一行錯誤文字快得多。
        if (error instanceof ApiError && error.detail?.blockId) {
          const block = workspace.getBlockById(error.detail.blockId);
          block?.setWarningText(error.detail.message);
          block?.select();
        }
        setSaveState({ status: 'error', message: describe(error) });
      });
  }, [state]);

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
          <button
            type="button"
            className="save-button"
            onClick={handleSave}
            disabled={saveState.status === 'saving'}
          >
            {saveState.status === 'saving' ? '存檔中…' : '存檔'}
          </button>
        )}
        {saveState.status === 'saved' && <span className="save-status save-status-ok">已存檔</span>}
        {saveState.status === 'error' && (
          <span className="save-status save-status-error">{saveState.message}</span>
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
        <WorkspaceView toolbox={state.registration.toolbox} onReady={handleWorkspaceReady} />
      )}
    </div>
  );
}

function Notice({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return <div className={tone === 'error' ? 'notice notice-error' : 'notice'}>{children}</div>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

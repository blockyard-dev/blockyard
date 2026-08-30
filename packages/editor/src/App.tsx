/**
 * 載入 manifest → 註冊 → 讀專案 → 畫出工作區，存檔走 `ir/serialize.ts` →
 * `PUT /api/projects/{id}`，執行走 `POST /api/runs` → `ws://…/ws/run/{runId}`
 * → §8.3 的視覺回饋。
 *
 * **執行 = 先存檔再跑**。後端跑的是已存檔的那一份（`runs/manager.py` 開頭那段
 * 註解），所以按下執行必然先送一次 PUT——順帶讓 §4 的載入期驗證在執行之前就
 * 把壞掉的積木標紅，而不是等到 runtime 才說「未知變數」。
 *
 * 綠旗與 §5.1 的「點一下就跑」是**同一條路**（`beginRun`），差別只有多送一個
 * `blockId`。不另開「試跑」路徑：那樣 §6.2 的流量控制與 §5.5 的停止都要各做
 * 兩次。
 *
 * 單專案模式（`PROJECT_ID` 固定）：專案列表、切換專案是之後的事。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Square } from 'lucide-react';
import * as Blockly from 'blockly/core';
import { ApiError, fetchExtensions, fetchProject, saveProject } from './api/client';
import { RunSocket, startRun, stopRun } from './api/runs';
import { buildProjectToolbox, registerManifests, type Registration } from './blockly/setup';
import {
  callType,
  definitionType,
  isDefinitionType,
  procIdFromType,
  registerProcedures,
} from './blockly/procedures';
import { displayName } from './blockly/signature';
import { applyProcedure } from './blockly/apply';
import { watchOrphans } from './blockly/reshape';
import { fillDefinitionParams, watchDefinitionParams } from './blockly/params';
import { buttonCallbackKey } from './blockly/toolbox';
import { ProcedureModal, type ProcedureDialogTarget } from './components/ProcedureModal';
import { CheckRunner } from './ir/checks';
import { buildContext, type ConversionContext } from './ir/context';
import { loadProject } from './ir/deserialize';
import { serializeWorkspace } from './ir/serialize';
import { RunDecorator } from './run/decorate';
import { useRunStore } from './run/store';
import { ExtensionsEntry } from './components/ExtensionsEntry';
import { RunBubbles } from './components/RunBubbles';
import { FlyoutResizer } from './components/FlyoutResizer';
import { RunPanel } from './components/RunPanel';
import { WorkspaceView } from './components/WorkspaceView';
import type { ButtonSpec } from './types/manifest';
import type { BlockyProjectIR as ProjectIR, Procedure } from './types/project';

const PROJECT_ID = 'prj_local';

/**
 * 存檔驗證（422）標在積木上的訊息用的 id。Blockly 的 warning 可以有多筆，
 * 各自一個 id——**清除時一定要帶 id**：`setWarningText(null)` 不帶 id 是
 * 「把整顆警告圖示拆掉」，會連 `FieldText.ts` 的欄位警告也一起清掉。
 */
const SAVE_WARNING_ID = 'blocky-save';

/**
 * 靜態檢查（`ir/checks.ts`）的節流。
 *
 * 它掃全工作區，而編輯時的事件很密——打一個字就是一次 `CHANGE`。第 6 步的
 * `FieldText` 已經在每次值變動時重跑一次自己的語法分析，兩個疊起來就是
 * PROGRESS 點名的那筆帳。這裡的答案是節流而不是增量：增量要維護「哪些積木
 * 受哪次改動影響」的依賴圖，而變數檢查的依賴本來就是全域的（改一格名字會讓
 * 另一頭的引用從紅變綠）。人眼看不出 200ms，而依賴圖的錯誤會安靜地留下
 * 過期的警告。
 */
const CHECK_DELAY_MS = 200;

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
  | {
      status: 'ready';
      registration: Registration;
      project: ProjectIR;
      ctx: ConversionContext;
      /** 專案的工具箱 = 靜態宣告 + 這個專案的函式（§8.5）。函式一改就換一份。 */
      toolbox: Record<string, unknown>;
    };

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

export function App() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  /**
   * 一句話的提示，蓋在畫布上（刪不掉的函式、刪掉了哪個函式）。
   *
   * 不用 `window.alert`：它是原生 modal，會擋住整個編輯器，而這些訊息都是
   * 「順帶說一聲」等級的。也不標成積木上的警告圖示——那個機制留下的教訓是
   * 「掛上去容易、清掉難」（見 §4.1 落單積木那一段）。
   */
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  /**
   * 帽子上的參數積木要知道的唯一一件事：現在有哪些函式。
   *
   * 走 ref 的理由與按鈕回呼相同——listener 註冊在工作區上，活得比 render 久。
   */
  const paramsRef = useRef<Record<string, Procedure>>({});
  const decoratorRef = useRef<RunDecorator | null>(null);
  const socketRef = useRef<RunSocket | null>(null);
  const checkerRef = useRef<CheckRunner | null>(null);
  const [workspace, setWorkspace] = useState<Blockly.WorkspaceSvg | null>(null);
  /** 「創建積木」對話框（§8.5）。`null` = 沒開。 */
  const [dialog, setDialog] = useState<ProcedureDialogTarget | null>(null);

  paramsRef.current = state.status === 'ready' ? state.project.procedures ?? {} : {};

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
      const procedures = project.procedures ?? {};
      const procedureBlocks = registerProcedures(procedures);
      const ctx = buildContext([...registration.blocks, ...procedureBlocks]);
      const toolbox = buildProjectToolbox(registration, procedureBlocks);
      setState({ status: 'ready', registration, project, ctx, toolbox });
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
      checkerRef.current = new CheckRunner(ws);
      watchOrphans(ws);
      // 帽子上的參數晶片（§4.6）。它們不在 IR 裡，所以載入之後要自己長出來，
      // 之後由 listener 補上被擠掉的那些。
      // 拖進垃圾桶走與右鍵「刪除這個積木…」同一個函式（見 `deleteRef`）。
      watchDefinitionParams(ws, () => paramsRef.current, (id) => deleteRef.current(id));
      setWorkspace(ws);
      if (state.status === 'ready') {
        loadProject(state.project, ws, state.ctx);
        fillDefinitionParams(ws, state.project.procedures ?? {}, (id) => deleteRef.current(id));
      }
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
    // 顯示過期的錯誤。**帶 id 清**：不帶的話會連 `FieldText.ts` 的欄位警告
    // 一起拆掉。
    for (const block of ws.getAllBlocks(false)) block.setWarningText(null, SAVE_WARNING_ID);

    // `extensions` 不在這裡：它由 `serializeWorkspace` 從畫布上的積木算出來
    // （§13.3）。拉一顆積木包的積木出來就等於宣告用到了它。
    const project = serializeWorkspace(ws, state.ctx, {
      formatVersion: state.project.formatVersion,
      meta: state.project.meta,
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
        block?.setWarningText(error.detail.message, SAVE_WARNING_ID);
        block?.select();
      }
      setSaveState({ status: 'error', message: describe(error) });
      return false;
    }
  }, [state]);

  /**
   * 開一次 Run。`blockId` 給了就是 §5.1 的「點一下就跑」。
   *
   * 綠旗與點擊走同一條路——差別只有多送一個 `blockId`。前一個 Run 先停掉：
   * 編輯器同時只顯示一個 Run（一個 socket、一份高亮），不停的話畫面上看不見
   * 的那個 `forever` 迴圈會繼續在後端轉。
   */
  const beginRun = useCallback(
    async (blockId?: string) => {
      const store = useRunStore.getState();
      const previous = store.runId;
      if (previous && (store.status === 'running' || store.status === 'starting')) {
        void stopRun(previous);
      }
      socketRef.current?.close();
      socketRef.current = null;
      decoratorRef.current?.clear();
      store.begin();

      if (!(await save())) {
        store.fail('存檔沒過，沒有東西可以跑');
        return;
      }

      try {
        const run = await startRun(PROJECT_ID, { blockId });
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
    },
    [save],
  );

  const handleStop = useCallback(() => {
    if (runId) void stopRun(runId);
  }, [runId]);

  /**
   * 對話框按下確定。畫布上的那幾步在 `blockly/apply.ts`（那裡才是順序的家，
   * 理由見那份註解）；這裡只剩「關掉對話框」與「把結果放進 state」。
   */
  const handleProcedureSubmit = useCallback(
    (target: ProcedureDialogTarget, edited: Pick<Procedure, 'name' | 'params' | 'returns'>) => {
      setDialog(null);
      if (state.status !== 'ready') return;
      const ws = workspaceRef.current;
      if (!ws) return;

      const applied = applyProcedure({
        workspace: ws,
        procedures: state.project.procedures ?? {},
        procId: target.id,
        edited,
        blocks: state.registration.blocks,
        onTrash: (id) => deleteRef.current(id),
      });

      setState({
        ...state,
        project: { ...state.project, procedures: applied.procedures },
        ctx: applied.ctx,
        toolbox: buildProjectToolbox(state.registration, applied.procedureBlocks),
      });
    },
    [state],
  );

  /**
   * 工具箱按鈕（D25）。
   *
   * 動作字彙表在 manifest 那一側封頂（`extensions/manifest.py` 的
   * `ButtonAction`），這裡只是把宣告接到動作上——所以這條路不會長出「積木包
   * 送一段程式碼進來」那個選項。
   *
   * `create_procedure` 是**內建限定**的動作（§8.5），它開的是 React 的對話框
   * 而不是外面的世界，所以在這裡分岔；其餘的宣告式動作沒有 React 的東西要碰，
   * 由 `runButton` 處理。
   *
   * 註冊的是一顆**穩定的 closure**，實際的行為從 `buttonRef` 讀（與下面的
   * `registerEditMenu` 同一個寫法）。回呼活在 **Blockly 的工作區**上，而工作區
   * 活得比模組久（`WorkspaceView` 的 inject effect 相依是 `[]`）：直接註冊當下
   * 的 closure 的話，vite 換掉這個模組之後 effect 的相依（`workspace`、`state`）
   * 都沒變，effect 不重跑，於是 Blockly 手上留著**改好之前**那一份——症狀是按鈕
   * 按下去跑的是舊行為，而重新整理就好，最難查的那種。
   */
  const buttonRef = useRef<(button: ButtonSpec) => void>(null!);
  buttonRef.current = (button: ButtonSpec) => {
    if (button.action === 'create_procedure') setDialog({ id: null });
    else runButton(button);
  };

  // 按鈕**清單**變了才要重新註冊，而它只在載入完 manifest 那一刻變一次。
  const groups = state.status === 'ready' ? state.registration.groups : null;
  useEffect(() => {
    if (!workspace || !groups) return;
    for (const group of groups) {
      for (const button of group.buttons) {
        workspace.registerButtonCallback(buttonCallbackKey(group.id, button.id), () =>
          buttonRef.current(button),
        );
      }
    }
    return () => {
      for (const group of groups) {
        for (const button of group.buttons) {
          workspace.removeButtonCallback(buttonCallbackKey(group.id, button.id));
        }
      }
    };
  }, [workspace, groups]);

  /**
   * 定義積木的右鍵「編輯」——與建立走**同一個對話框**。
   *
   * 註冊在全域的 `ContextMenuRegistry` 上，所以只註冊一次、由 ref 讀到當下的
   * 專案（跟著每次 render 重新註冊會在 Blockly 的註冊表上留下垃圾）。
   */
  const editRef = useRef<(procId: string) => void>(null!);
  editRef.current = (procId: string) => {
    if (state.status !== 'ready') return;
    const procedure = state.project.procedures?.[procId];
    if (procedure) setDialog({ id: procId, procedure });
  };

  /**
   * 「刪除這個積木…」：刪掉定義帽子 **=** 刪掉那個函式（§4.6）。
   *
   * 兩條規則：
   *
   * | 畫布上還有呼叫積木 | **不准刪**，並指出還有幾顆、選取第一顆 |
   * | 沒有 | 定義帽子連同函式體一起消失，那筆 `procedures` 也是——工具箱當場少一顆 |
   *
   * 「還在用」**只算 `procedure.call#<id>`**。函式體裡那些 `取得 (參數名)` 不算：
   * 它們是普通的 `data.get`，名字剛好與參數同名而已，刪掉函式之後仍然是合法的
   * 積木（讀一個沒被設定過的變數，由 §4.5 的靜態檢查去講）。
   *
   * 這條規則不只是體感，它擋的是一個真的壞掉的 IR：`mutation.proc` 指到一筆
   * 不存在的 `procedures` 時，執行期才會拿到「找不到函式定義」。反過來說，這
   * 也是「刪掉定義就一起刪掉那筆宣告」必須成對的理由——只刪一半就是製造孤兒。
   */
  const deleteRef = useRef<(procId: string) => void>(null!);
  deleteRef.current = (procId: string) => {
    if (state.status !== 'ready') return;
    const ws = workspaceRef.current;
    if (!ws) return;

    const procedures = { ...(state.project.procedures ?? {}) };
    const proc = procedures[procId];
    const label = proc ? displayName(proc) : procId;

    const callers = ws.getBlocksByType(callType(procId), false) as Blockly.BlockSvg[];
    const first = callers[0];
    if (first) {
      // 「還有 3 個地方在用」如果找不到那三個地方，等於沒說——**把畫面捲到
      // 第一顆呼叫積木上**，與存檔 422 把警告標到那顆積木上是同一件事。
      //
      // 只捲，不 `select()`。這條路是右鍵選單叫起來的，而選單關掉時 Blockly 會
      // 把焦點還給被按右鍵的那顆積木；程式呼叫的 `select()` 搶不贏它，卻會留下
      // 一圈清不掉的 `.blocklySelected`——實測連按三次就是三個黃框，而
      // `getSelected()` 從頭到尾都是定義帽子。延後一輪（甚至 50ms）也一樣。
      ws.centerOnBlock(first.id);
      setToast(
        `還有 ${callers.length} 個地方在呼叫「${label}」，要先把它們刪掉。已經捲到第一顆。`,
      );
      return;
    }

    // `dispose(false)`：連同函式體一起收掉（`healStack` 給 true 會把函式體
    // 留在畫布上變成一疊落單積木）。定義帽子是 `deletable: false` 的，但那個
    // 旗標擋的是使用者的三條刪除路徑，不是 `dispose`。
    ws.getBlocksByType(definitionType(procId), false)[0]?.dispose(false);
    delete procedures[procId];

    const procedureBlocks = registerProcedures(procedures);
    setState({
      ...state,
      project: { ...state.project, procedures },
      ctx: buildContext([...state.registration.blocks, ...procedureBlocks]),
      toolbox: buildProjectToolbox(state.registration, procedureBlocks),
    });
    setToast(`已刪除函式「${label}」。`);
  };

  useEffect(() => registerEditMenu(editRef), []);
  useEffect(() => registerDeleteMenu(deleteRef), []);

  /**
   * §5.1 的「點一下就跑」。
   *
   * 點到影子積木時往上找一顆真的積木：影子的值存在父積木的 `inputs` 裡
   * （§4.2），它自己沒有 blockId 可以送給後端。點欄位不會走到這裡——Blockly
   * 的 gesture 對欄位發的是 `doFieldClick`，不發 CLICK 事件。
   */
  /**
   * 執行前的靜態檢查（§4.5、§4.6、§8.5）。載入完先跑一次，之後每次編輯節流重跑。
   *
   * `isUiEvent` 的那些（點選、捲動、縮放）跳過：它們改的是視角不是積木，而
   * 這個檢查只看積木。
   */
  useEffect(() => {
    if (!workspace || state.status !== 'ready') return;
    const checker = checkerRef.current;
    const input = { ctx: state.ctx, procedures: state.project.procedures ?? {} };

    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        checker?.run(input);
      }, CHECK_DELAY_MS);
    };

    schedule();
    const listener = (event: Blockly.Events.Abstract) => {
      if (!event.isUiEvent) schedule();
    };
    workspace.addChangeListener(listener);
    return () => {
      workspace.removeChangeListener(listener);
      if (timer !== null) clearTimeout(timer);
    };
  }, [workspace, state]);

  useEffect(() => {
    if (!workspace || state.status !== 'ready') return;

    const listener = (event: Blockly.Events.Abstract) => {
      if (event.type !== Blockly.Events.CLICK) return;
      const click = event as Blockly.Events.Click;
      // flyout 裡的積木有自己的 workspace：點工具箱是「拿一顆出來」，不是執行
      if (click.targetType !== 'block' || click.workspaceId !== workspace.id) return;
      let block = click.blockId ? workspace.getBlockById(click.blockId) : null;
      while (block?.isShadow()) block = block.getParent();
      if (block) void beginRun(block.id);
    };

    workspace.addChangeListener(listener);
    return () => workspace.removeChangeListener(listener);
  }, [workspace, state, beginRun]);

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
              onClick={() => void beginRun()}
              disabled={running}
            >
              <Play size={14} strokeWidth={2.5} fill="currentColor" /> 執行
            </button>
            <button type="button" className="button" onClick={handleStop} disabled={!running}>
              <Square size={13} strokeWidth={2.5} fill="currentColor" /> 停止
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
          <WorkspaceView toolbox={state.toolbox} onReady={handleWorkspaceReady} />
          <FlyoutResizer workspace={workspace} />
          <ExtensionsEntry groups={state.registration.groups} />
          <RunBubbles workspace={workspace} />
          <RunPanel />
          {toast !== null && (
            <button type="button" className="toast" onClick={() => setToast(null)}>
              {toast}
            </button>
          )}
          {dialog && (
            <ProcedureModal
              target={dialog}
              onCancel={() => setDialog(null)}
              onSubmit={(proc) => handleProcedureSubmit(dialog, proc)}
            />
          )}
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

/** 宣告式按鈕的動作（D25 的 (a) 層）。 */
function runButton(button: ButtonSpec): void {
  switch (button.action) {
    case 'open_url':
      // scheme 已經在 manifest 的載入期擋過（只收 http(s)），這裡再擋一次：
      // `window.open` 是真的會執行 `javascript:` 的地方，而縱深防禦的成本是
      // 一行。
      if (button.url && /^https?:\/\//.test(button.url)) {
        window.open(button.url, '_blank', 'noopener,noreferrer');
      }
      return;
    default:
      // `open_config`（§12.1 的設定面板）與 `call`（§7.3 的 @button）都要等
      // P1 的積木包 Host。到那之前沒有人宣告得出這兩種按鈕，所以這裡是一句
      // 誠實的「還沒接上」而不是一個假的成功。
      console.warn(`[blocky] 按鈕動作 ${button.action} 還沒接上`);
  }
}

const EDIT_MENU_ID = 'blocky_procedure_edit';
const DELETE_MENU_ID = 'blocky_procedure_delete';

/**
 * 「編輯這個積木」：定義帽子的右鍵選單。
 *
 * `procedure.definition#p_x` 的 proc id 嵌在 Blockly 的 type 字串裡
 * （`procedures.ts`），所以選單不需要另外一份對照表。
 */
function registerEditMenu(ref: React.RefObject<(procId: string) => void>): () => void {
  const registry = Blockly.ContextMenuRegistry.registry;
  if (registry.getItem(EDIT_MENU_ID)) registry.unregister(EDIT_MENU_ID);

  registry.register({
    id: EDIT_MENU_ID,
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: 5,
    preconditionFn: (scope) =>
      scope.block && isDefinitionType(scope.block.type) ? 'enabled' : 'hidden',
    displayText: () => '編輯這個積木…',
    callback: (scope) => {
      const procId = scope.block ? procIdFromType(scope.block.type) : null;
      if (procId) ref.current(procId);
    },
  });

  return () => registry.unregister(EDIT_MENU_ID);
}

/**
 * 「刪除這個積木…」：定義帽子**唯一**的刪除入口（`procedures.ts` 的
 * `UNDELETABLE_EXTENSION` 關掉了另外三條）。規則見 `deleteRef`。
 *
 * 與編輯同一個寫法：註冊在全域的 `ContextMenuRegistry` 上，一次就好，由 ref
 * 讀到當下的專案。
 */
function registerDeleteMenu(ref: React.RefObject<(procId: string) => void>): () => void {
  const registry = Blockly.ContextMenuRegistry.registry;
  if (registry.getItem(DELETE_MENU_ID)) registry.unregister(DELETE_MENU_ID);

  registry.register({
    id: DELETE_MENU_ID,
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: 6,
    preconditionFn: (scope) =>
      scope.block && isDefinitionType(scope.block.type) ? 'enabled' : 'hidden',
    displayText: () => '刪除這個積木…',
    callback: (scope) => {
      const procId = scope.block ? procIdFromType(scope.block.type) : null;
      if (procId) ref.current(procId);
    },
  });

  return () => registry.unregister(DELETE_MENU_ID);
}

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
import { Ear, History, Link2, Play, Square } from 'lucide-react';
import * as Blockly from 'blockly/core';
import { ApiError, fetchExtensions, fetchKeys, fetchProject, saveProject } from './api/client';
import { ProjectSocket, RunSocket, startRun, stopRun } from './api/runs';
import {
  NOT_LISTENING,
  activateProject,
  deactivateProject,
  fetchTriggerState,
  listeningStateOf,
  type ListeningState,
} from './api/triggers';
import type { RunSummary } from './api/runs';
import { buildProjectToolbox, registerManifests, type Registration } from './blockly/setup';
import type { RegisteredBlock } from './blockly/define';
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
import { glideToBlock } from './blockly/motion';
import { blocksUsing } from './blockly/usage';
import { syncTrashedProcedures } from './blockly/lifecycle';
import { fillDefinitionParams, watchDefinitionParams } from './blockly/params';
import { buttonCallbackKey, configTarget, type ToolboxGroup } from './blockly/toolbox';
import { ProcedureModal, type ProcedureDialogTarget } from './components/ProcedureModal';
import { CheckRunner } from './ir/checks';
import { buildContext, type ConversionContext } from './ir/context';
import { loadProject } from './ir/deserialize';
import { serializeWorkspace } from './ir/serialize';
import { RunDecorator } from './run/decorate';
import { useRunStore } from './run/store';
import { ExtensionsEntry } from './components/ExtensionsEntry';
import { ExtensionsGallery } from './components/ExtensionsGallery';
import { ExtensionMenu, useExtensionMenu } from './components/ExtensionMenu';
import { useExtensionsUi } from './components/extensionsStore';
import { KeysEntry } from './components/KeysPanel';
import { configuredIds, useKeysUi, type KeysTarget } from './components/keysStore';
import { RunBubbles } from './components/RunBubbles';
import { FlyoutResizer } from './components/FlyoutResizer';
import { WebhookPanel } from './components/WebhookPanel';
import { HistoryPanel } from './components/HistoryPanel';
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
      /** 這個專案的函式積木。**工具箱重建時要它**——金鑰設定好之後那顆
       * `open_config` 按鈕要收起來，而那次重建不是由函式的改動引起的，手邊
       * 沒有別的地方拿得到這一份（重算一次等於把所有函式積木再註冊一輪）。 */
      procedureBlocks: RegisteredBlock[];
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

  /**
   * 每個看過的函式的**最後一份簽章，含已經刪掉的**。`syncTrashedProcedures`
   * 要把一筆宣告放回去時，名稱與參數只有這裡還記得——IR 說不出它們（帽子的
   * 孔是畫面不是內容，§4.6），而 state 在刪掉的那一刻就沒有了。
   */
  const archiveRef = useRef<Record<string, Procedure>>({});
  for (const [id, proc] of Object.entries(paramsRef.current)) archiveRef.current[id] = proc;

  /**
   * 走過「刪除這個積木…」的那幾個函式。**只有它們的宣告跟著帽子走**，理由見
   * `blockly/lifecycle.ts`：另外兩種「帽子與宣告對不上」都是舊專案，而那條路
   * `ir/serialize.ts` 明講要保留。
   */
  const trashedRef = useRef<Set<string>>(new Set());

  const runStatus = useRunStore((s) => s.status);
  const runId = useRunStore((s) => s.runId);
  const runMessage = useRunStore((s) => s.message);
  const runBlocks = useRunStore((s) => s.blocks);
  const running = runStatus === 'starting' || runStatus === 'running';

  /**
   * 已經設定好的那幾把金鑰（`keysStore`）。
   *
   * 工具箱要看它：`open_config` 的按鈕**設定完就收起來**（`toolbox.ts::isDone`）。
   * ref 那一份給另外三個重建工具箱的地方用——它們是因為函式改了才重建的，要的
   * 是「現在這份名單」，不是再問一次後端。
   */
  const configured = useKeysUi((s) => s.configured);
  const configuredRef = useRef(configured);
  configuredRef.current = configured;
  /**
   * 手上這份工具箱是用**哪兩份名單**畫的（金鑰、積木包）。
   *
   * 開場那一份**已經是用新名單畫好的**（載入 effect 先問過金鑰才畫），而下面
   * 那個 effect 在名單第一次從空的變成真的那一刻還是會醒來——沒有這個 ref，它
   * 會再畫一份一模一樣的工具箱，而 `updateToolbox` 會把 flyout 捲回頂端。
   */
  const toolboxFor = useRef({ configured, enabled: null as ReadonlySet<string> | null });

  /**
   * 工具箱上有哪幾個積木包（`extensionsStore`、D31）。
   *
   * 與金鑰名單走同一條路，因為它們對工具箱做的是同一件事：**改變上架的東西**。
   * 兩份名單合成一個 ref 而不是各記各的，是為了讓「這份工具箱是用什麼畫的」
   * 只有一個答案——兩個 ref 就有兩個「畫過了嗎」，而它們會在不同的時刻各自
   * 說對一半。
   */
  const enabled = useExtensionsUi((s) => s.enabled);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const galleryOpen = useExtensionsUi((s) => s.open);
  /** 工具箱分類上的右鍵選單（面板裡那張卡自己有一份，同一個元件）。 */
  const { menu: extMenu, openMenu: openExtMenu, closeMenu: closeExtMenu } = useExtensionMenu();

  // 名單變了就重畫工具箱：`open_config` 的按鈕在這一步消失（設定好了）或回來
  // （刪掉了），積木包的分類在這一步上架或收起來。
  // 只換 toolbox，畫布不動——`WorkspaceView` 走的是 `updateToolbox`。
  useEffect(() => {
    if (toolboxFor.current.configured === configured && toolboxFor.current.enabled === enabled) {
      return;
    }
    toolboxFor.current = { configured, enabled };
    setState((prev) =>
      prev.status === 'ready'
        ? {
            ...prev,
            toolbox: buildProjectToolbox(
              prev.registration,
              prev.procedureBlocks,
              configured,
              enabled,
            ),
          }
        : prev,
    );
  }, [configured, enabled]);

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
      // 金鑰的狀態要在畫第一份工具箱**之前**就在手上，不然已經設定好的那個
      // 包會先畫出一顆「設定 Bot Token」，再在下一輪把它收掉——一顆閃一下就
      // 不見的按鈕比一顆一直在的按鈕更難理解。
      // 讀不到就當作一把都沒設定：那只會讓按鈕多留著，而按下去仍然是對的。
      const keys = await fetchKeys(controller.signal).catch((e: unknown) => {
        // **中止不是「讀不到」**：吞掉它的話，這條路會繼續往下走到 setState，
        // 而那個元件已經不在了（dev 的 StrictMode 會真的走到這裡）。
        if (controller.signal.aborted) throw e;
        return [];
      });
      useKeysUi.getState().setConfigured(configuredIds(keys));
      // **這個專案用到的積木包一定要在名單裡**（D31）：IR 的 `extensions` 是從
      // 畫布上的積木算出來的（§13.3），所以打開一份用了 `http` 的專案時，那個
      // 分類必須跟著回來——不然畫布上有積木，而工具箱裡沒有任何地方生得出它。
      useExtensionsUi.getState().initEnabled((project.extensions ?? []).map((e) => e.id));
      // 從 store 讀回來，不是用剛剛那一份：這份工具箱是用**哪兩個 Set 物件**
      // 畫的，上面 `toolboxFor` 那個 ref 要比對得起來。
      const keysConfigured = useKeysUi.getState().configured;
      const packsEnabled = useExtensionsUi.getState().enabled;
      toolboxFor.current = { configured: keysConfigured, enabled: packsEnabled };
      const toolbox = buildProjectToolbox(
        registration,
        procedureBlocks,
        keysConfigured,
        packsEnabled,
      );
      setState({ status: 'ready', registration, project, ctx, procedureBlocks, toolbox });
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

  /**
   * 開場先問後端「這個專案現在是不是 active」（§9.2）。
   *
   * **P2 之前這一段不需要存在。** 那時的「監聽」是後端 process 的記憶體，跟這個
   * 分頁同生共死，所以用 `useState` 記著是誠實的。P2 把 active 搬進 SQLite 之後
   * 那句話就不成立了：關掉瀏覽器它照樣跑、後端重啟它自己回來——而畫面卻從
   * `{ on: false }` 開始，於是那顆按鈕會說「監聽」，而它其實**正在監聽**。
   *
   * 一顆說謊的按鈕比沒有按鈕糟：使用者會再按一次（那是無害的重新同步），但他
   * 也可能以為排程沒開，然後去別的地方找為什麼沒跑。
   */
  useEffect(() => {
    let alive = true;
    fetchTriggerState(PROJECT_ID)
      .then((state) => {
        if (alive && state.active) setListening(listeningStateOf(state));
      })
      // 問不到就維持「沒在跑」。這不是要往使用者臉上丟一句錯誤的時機——
      // 後端連不上的話，載入專案那條路已經會說話了。
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

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
      // undo／redo 把定義帽子搬進搬出畫布時，那筆 `procedures` 宣告要跟著走
      // （見 `syncRef`）。掛在 create／delete 上而不是只有 delete：redo 走的
      // 是刪除，undo 走的是建立，而它們是同一條規則的兩個方向。
      ws.addChangeListener((event: Blockly.Events.Abstract) => {
        if (
          event.type === Blockly.Events.BLOCK_CREATE
          || event.type === Blockly.Events.BLOCK_DELETE
        ) {
          syncRef.current();
        }
      });
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
   * 監聽（§9、P1 第 4 步第 3 段）。
   *
   * **跟「執行」分成兩列，因為它們是兩件事**：執行是「現在跑一次」，監聽是
   * 「一直聽著，外面發生事情就跑」。同一顆按鈕的話，「停止」到底停的是哪一個
   * 講不清楚——而使用者會需要「讓它繼續聽著，但把手上這次跑掉的停掉」。
   *
   * `hats` 是後端接上了哪幾顆。空陣列代表**這份畫布上沒有 hat**，不是失敗；
   * 那句話要說出來，否則按下去什麼都沒發生會被當成壞掉。
   */
  const [listening, setListening] = useState<ListeningState>(NOT_LISTENING);
  const [hooksOpen, setHooksOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  /**
   * 接上一個 Run 的事件流。
   *
   * 綠旗、「點一下就跑」與 **hat 觸發的 Run** 走同一條——後者是後端自己起的
   * （`listeners.py`），前端只是把 socket 接過去。抽出來是因為它本來就該只有
   * 一份：編輯器同時只顯示一個 Run（一個 socket、一份高亮）。
   */
  const attach = useCallback((run: RunSummary) => {
    socketRef.current?.close();
    useRunStore.getState().attach(run);
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
  }, []);

  const beginListening = useCallback(async () => {
    // 監聽跑的也是**已存檔的那一份**（同執行，`runs/manager.py` 開頭那段）。
    // 不先存的話，使用者剛拉出來的那顆 hat 後端根本看不到，而症狀是「按了監聽
    // 但它說沒有 hat」。
    if (!(await save())) {
      setListening({ ...NOT_LISTENING, message: '存檔沒過，沒有東西可以聽' });
      return;
    }
    try {
      setListening(listeningStateOf(await activateProject(PROJECT_ID)));
    } catch (error: unknown) {
      setListening({ ...NOT_LISTENING, message: describe(error) });
    }
  }, [save]);

  const endListening = useCallback(async () => {
    setListening(NOT_LISTENING);
    setHooksOpen(false);
    await deactivateProject(PROJECT_ID).catch(() => {});
  }, []);

  /** 設完密鑰之後重讀狀態——`secretSet` 是後端算的，前端猜不得。 */
  const refreshHooks = useCallback(async () => {
    const state = await fetchTriggerState(PROJECT_ID).catch(() => null);
    if (state) setListening((prev) => ({ ...prev, webhooks: state.webhooks ?? [] }));
  }, []);

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
        attach(await startRun(PROJECT_ID, { blockId }));
      } catch (error: unknown) {
        store.fail(describe(error));
      }

      // **只有綠旗會順手把監聽打開，「點一下就跑」不會。**
      //
      // 兩件事分成兩列是為了讓它們停得開，而綠旗順手打開監聽是因為「按下執行」
      // 對一個畫布上有 hat 的人就是「這東西開始運作」。**但點一顆 reporter 不是
      // 那個意思**——那是 §5.1 的探索動作（「這顆積木現在會算出什麼」），跟「讓
      // 這份流程常駐起來」沒有關係。分不開的話，每點一次積木就去接一次事件來源，
      // 而那在有 hat 的專案上是一條真的長連線。
      if (blockId !== undefined || !useRunStore.getState().runId) return;
      void beginListening();
    },
    [attach, beginListening, save],
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
        procedureBlocks: applied.procedureBlocks,
        toolbox: buildProjectToolbox(
          state.registration,
          applied.procedureBlocks,
          configuredRef.current,
          enabledRef.current,
        ),
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
  const openKeys = useKeysUi((s) => s.openKeys);
  const buttonRef = useRef<(group: ToolboxGroup, button: ButtonSpec) => void>(null!);
  buttonRef.current = (group: ToolboxGroup, button: ButtonSpec) => {
    if (button.action === 'create_procedure') setDialog({ id: null });
    // `open_config`：跳到金鑰面板，這一把已經填好（`secretTarget`）。與執行紀錄
    // 上那顆「去設定」按鈕開的是同一個畫面、同一條路——差別只在時機：那一顆在
    // 「跑起來才發現沒設定」之後，這一顆在使用者拉出積木、發現下拉問不出東西的
    // 那一刻就在手邊。
    else if (button.action === 'open_config') openKeys(secretTarget(group));
    else runButton(button);
  };

  // 按鈕**清單**變了才要重新註冊，而它只在載入完 manifest 那一刻變一次。
  const groups = state.status === 'ready' ? state.registration.groups : null;

  /**
   * 工具箱分類上的右鍵（D31）。**這是刪除一個積木包的主要入口**——分類欄上那顆
   * 色圓點才是使用者每天看得到這個包的地方，而「對著它按右鍵」與「對著函式的
   * 定義帽子按右鍵」是同一個手勢。
   *
   * 掛在 injection div 上做委派，而不是逐格掛：分類的 DOM 是 Blockly 畫的，
   * 工具箱一重建（加了一個包、多了一顆函式）那些節點就換人了，逐格掛的 listener
   * 會安靜地留在被丟掉的節點上。
   *
   * **哪一格 = 哪一個命名空間**由 Blockly 自己回答：`buildToolbox` 把
   * `toolboxitemid` 設成 group 的 id，所以這裡不必去讀分類名的文字（名字是
   * manifest 寫的，可以重複，而且會被 i18n 換掉）。
   *
   * 內建分類不接（`!group.builtin`）：它們沒有「刪掉」這個選項，攔下右鍵只會
   * 給出一個兩條都不能點的選單。
   */
  useEffect(() => {
    if (!workspace || !groups) return;
    const div = workspace.getInjectionDiv();
    const onContextMenu = (e: MouseEvent) => {
      const toolbox = workspace.getToolbox() as Blockly.Toolbox | null;
      const target = e.target as Element | null;
      if (!toolbox || !target) return;
      const item = toolbox.getToolboxItems().find((entry) => entry.getDiv()?.contains(target));
      const group = item ? groups.find((g) => g.id === item.getId() && !g.builtin) : undefined;
      if (!group) return;
      e.preventDefault();
      openExtMenu(group, e.clientX, e.clientY);
    };
    div.addEventListener('contextmenu', onContextMenu);
    return () => div.removeEventListener('contextmenu', onContextMenu);
  }, [workspace, groups, openExtMenu]);

  useEffect(() => {
    if (!workspace || !groups) return;
    for (const group of groups) {
      for (const button of group.buttons) {
        workspace.registerButtonCallback(buttonCallbackKey(group.id, button.button), () =>
          buttonRef.current(group, button),
        );
      }
    }
    return () => {
      for (const group of groups) {
        for (const button of group.buttons) {
          workspace.removeButtonCallback(buttonCallbackKey(group.id, button.button));
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
      // **滑過去，不是跳過去**（`blockly/motion.ts`）。使用者沒有動畫布，畫面
      // 卻換了一批積木，而一次瞬間位移說不出「你原本在這裡、現在到那裡」——
      // 他要回得去，中間那幾幀就是那句話。時間與曲線與 flyout 那條共用。
      //
      // 只捲，不 `select()`。這條路是右鍵選單叫起來的，而選單關掉時 Blockly 會
      // 把焦點還給被按右鍵的那顆積木；程式呼叫的 `select()` 搶不贏它，卻會留下
      // 一圈清不掉的 `.blocklySelected`——實測連按三次就是三個黃框，而
      // `getSelected()` 從頭到尾都是定義帽子。延後一輪（甚至 50ms）也一樣。
      glideToBlock(ws, first.id);
      setToast(
        `還有 ${callers.length} 個地方在呼叫「${label}」，要先把它們刪掉。已經捲到第一顆。`,
      );
      return;
    }

    // `dispose(false)`：連同函式體一起收掉（`healStack` 給 true 會把函式體
    // 留在畫布上變成一疊落單積木）。定義帽子是 `deletable: false` 的，但那個
    // 旗標擋的是使用者的三條刪除路徑，不是 `dispose`。
    //
    // 這一下**進得了 undo 堆疊**，而 `delete procedures[procId]` 進不去——記
    // 一筆，讓 `syncRef` 之後認得出「這顆帽子回來了，宣告該跟著回來」。
    trashedRef.current.add(procId);
    ws.getBlocksByType(definitionType(procId), false)[0]?.dispose(false);
    delete procedures[procId];

    const procedureBlocks = registerProcedures(procedures);
    setState({
      ...state,
      project: { ...state.project, procedures },
      ctx: buildContext([...state.registration.blocks, ...procedureBlocks]),
      procedureBlocks,
      toolbox: buildProjectToolbox(
        state.registration,
        procedureBlocks,
        configuredRef.current,
        enabledRef.current,
      ),
    });
    setToast(`已刪除函式「${label}」。`);
  };

  /**
   * 「刪除這個擴充功能」（D31）。**與刪除一個函式定義是同一條規則**：
   *
   * | 畫布上還有它的積木 | **不准刪**，關掉面板、捲到其中一顆、說還有幾顆 |
   * | 沒有 | 從名單裡拿掉，工具箱當場少一個分類 |
   *
   * 為什麼要擋：刪掉之後那個分類就不在工具箱上了，而畫布上那些積木還在跑
   * （註冊沒有被拿掉，D31）——使用者會有一批**改得動、卻再也生不出第二顆**的
   * 積木，而畫面上沒有任何地方說得出那是為什麼。函式那條路擋的是同一件事。
   *
   * 它同時把 D31 的兩條規則變成一致的：載入專案時「這個專案用到的包一定要在
   * 名單裡」會把包加回來——如果刪除不擋，使用者刪掉一個正在用的包，下次開專案
   * 它又自己回來了，而那看起來就是「刪除沒有用」。
   *
   * **不刪磁碟上的任何東西。** `extensions/` 底下那個資料夾還在，面板上那張卡
   * 也還在（只是回到「＋ 加入」）。真的卸載要等 P3 第 2 步——裝得進來才談得上
   * 拔得掉。
   *
   * **擋下來時是逐顆走訪，不是永遠停在第一顆**（`usageWalkRef`）：使用者被擋住
   * 之後要做的事是「把它們一顆一顆刪掉」，而畫面上一次只看得到一顆。再按一次
   * 刪除就跳下一顆——那讓這條擋規則同時是一份清單，而不只是一句拒絕。
   */
  const usageWalkRef = useRef<Record<string, number>>({});
  const deleteExtensionRef = useRef<(group: ToolboxGroup) => void>(null!);
  deleteExtensionRef.current = (group: ToolboxGroup) => {
    const ws = workspaceRef.current;
    if (!ws) return;
    const closeGallery = useExtensionsUi.getState().closeGallery;
    const used = blocksUsing(ws, group);
    const first = used[0];

    // 兩條路都先關掉面板：畫布在它底下，捲到哪一顆、少了哪一個分類，
    // 面板開著的時候一件都看不見（那條提示也在它底下）。
    closeGallery();

    if (first) {
      // 「還有 3 顆」如果找不到那三顆，等於沒說——滑過去，不是跳過去
      // （`blockly/motion.ts`，同 `deleteRef` 的理由）。
      //
      // 走訪的位置記在 id 上而不是積木上：使用者刪掉的那一顆會從 `used` 裡
      // 消失，所以只有「第幾個」活得過下一次點擊，`% used.length` 讓它在名單
      // 縮短時自己回到範圍內。
      const at = ((usageWalkRef.current[group.id] ?? -1) + 1) % used.length;
      usageWalkRef.current[group.id] = at;
      glideToBlock(ws, (used[at] ?? first).id);
      setToast(
        `畫布上還有 ${used.length} 顆「${group.name}」的積木，要先把它們刪掉才能刪掉這個擴充功能。` +
          `已經捲到第 ${at + 1} 顆——再按一次刪除會跳到下一顆。`,
      );
      return;
    }

    delete usageWalkRef.current[group.id];
    useExtensionsUi.getState().remove(group.id);
    setToast(`已刪除擴充功能「${group.name}」。它還在面板上，隨時可以再加回來。`);
  };

  /**
   * **宣告跟著定義帽子走**（`blockly/lifecycle.ts`）。
   *
   * 刪掉一個函式動了兩本帳，而 Ctrl+Z 只退得回 Blockly 那一本——不補這一句，
   * undo 之後畫布上會留著一顆帽子，而那個函式已經不存在了：工具箱少一顆呼叫
   * 積木、存檔會把它退化成一個名字是 proc id 的空殼、拖到垃圾桶也沒有反應
   * （`TrashAwareDragStrategy` 存不進序列化狀態）。
   *
   * 問的是「畫布上現在有沒有那顆帽子」而不是「剛剛發生了什麼」，所以 redo
   * 免費對了，連按好幾次 undo／redo 也是。
   *
   * `fillDefinitionParams` 一定要跟著跑：帽子回來時孔裡那幾顆是序列化長出來
   * 的半成品，而**帽子自己的拖曳策略也是這一步掛回去的**。
   */
  const syncRef = useRef<() => void>(null!);
  /**
   * 補孔自己會發 `BLOCK_CREATE`，而那條 listener 就是叫起這個函式的人。
   *
   * 重入的那一次讀到的是**同一份 closure**（`setState` 要下一次 render 才看得
   * 到），所以它會算出同一個答案、再補一次孔——目前那一步是冪等的，於是這個
   * 旗標擋掉的是「以後某天不是了」。同一顆積木被還原兩次的症狀是換掉的積木
   * id，而那正是 §8.4 說 IR 指著它的東西。
   */
  const syncingRef = useRef(false);
  syncRef.current = () => {
    if (syncingRef.current) return;
    if (state.status !== 'ready' || trashedRef.current.size === 0) return;
    const ws = workspaceRef.current;
    if (!ws) return;

    const procedures = syncTrashedProcedures(
      ws,
      trashedRef.current,
      state.project.procedures ?? {},
      archiveRef.current,
    );
    if (!procedures) return;

    const procedureBlocks = registerProcedures(procedures);
    setState({
      ...state,
      project: { ...state.project, procedures },
      ctx: buildContext([...state.registration.blocks, ...procedureBlocks]),
      procedureBlocks,
      toolbox: buildProjectToolbox(
        state.registration,
        procedureBlocks,
        configuredRef.current,
        enabledRef.current,
      ),
    });
    syncingRef.current = true;
    try {
      fillDefinitionParams(ws, procedures, (id) => deleteRef.current(id));
    } finally {
      syncingRef.current = false;
    }
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
   * 監聽中：接上**專案**通道，後端自己起的那些 Run 就會自己送過來（§9）。
   *
   * hat 觸發的 Run 前端沒有那個 runId——它是外面發生一件事之後由後端起的。
   * 原本是每 1.5 秒問一次「有沒有新的 Run」，而那條路有一個修不掉的洞：一則
   * Discord 訊息的 Run 只有零點幾毫秒，所以**問到它時它一定已經結束了**，而
   * 結束的 Run 接不上 WebSocket。改讀它落地的事件只補得到 log 與錯誤——變數
   * 與高亮不落地（§6.3），畫面上仍然是半個。
   *
   * 所以順序反過來：**在 Run 開始之前就接著**。那條通道欠的三個答案寫在後端
   * （`api/runs.py::project_events`）：專案 id 在路徑上、frame 帶 runId；斷線
   * 不補；不留 backlog。
   *
   * 斷了就重連（1 秒）。監聽是一個會掛整天的狀態，而後端重啟是開發時每天都
   * 會發生的事——不重連的話，畫面會從那一刻起安靜到使用者自己想到要重整。
   */
  useEffect(() => {
    if (!listening.on) return;
    let cancelled = false;
    let socket: ProjectSocket | null = null;
    let retry: number | null = null;

    const connect = () => {
      if (cancelled) return;
      socket = new ProjectSocket(PROJECT_ID, {
        onFrame: (frame) => useRunStore.getState().applyProject(frame),
        onClose: (clean) => {
          if (cancelled || clean) return;
          retry = window.setTimeout(connect, 1000);
        },
      });
    };
    connect();

    return () => {
      cancelled = true;
      if (retry !== null) window.clearTimeout(retry);
      socket?.close();
    };
  }, [listening.on]);

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
        {/* 「已加入 N」是這一行唯一會動的數字（D31）。少了它，標頭說的是
            「載入了 12 個命名空間」而工具箱上只有 10 個——兩句話都對，中間那個
            差額沒有人負責解釋。 */}
        {state.status === 'ready' && (
          <span className="summary">
            {state.registration.groups.length} 個命名空間（內建{' '}
            {state.registration.groups.filter((g) => g.builtin).length} · 已加入積木包{' '}
            {state.registration.groups.filter((g) => !g.builtin && enabled.has(g.id)).length}）·{' '}
            {state.registration.blocks.length} 顆積木
          </span>
        )}
        {state.status === 'ready' && (
          <div className="actions">
            {/* 執行狀態擺在最前面：它講的是「執行」那顆按鈕做出來的事，站在這
                一組的開頭比站在工具列尾端（金鑰後面）更接近它的來源。而且它
                是這一列唯一會長出來又縮回去的東西，放在 `margin-left: auto`
                的那一側，長度變化推的是自己左邊的空白，不是右邊那六顆按鈕。 */}
            <RunStatus />
            <button
              type="button"
              className="button"
              onClick={() => void save()}
              disabled={saveState.status === 'saving' || running}
            >
              {saveState.status === 'saving' ? '存檔中…' : '存檔'}
            </button>
            {/* 執行與停止是**同一顆**。這兩件事互斥（沒在跑不能停、在跑不能再
                按執行），所以兩顆按鈕之中永遠有一顆是灰的——那顆灰的什麼都不
                說，只是佔著位置讓使用者每次都得先確認自己該按哪一顆。合成一
                顆之後「現在按下去會發生什麼」由它自己的樣子回答。

                位置不會跳：兩顆共用一個 `min-width`（見 `index.css`），所以
                切換時右邊那排不會跟著挪。 */}
            {running ? (
              <button type="button" className="button button-stop" onClick={handleStop}>
                <Square size={13} strokeWidth={2.5} fill="currentColor" /> 停止
              </button>
            ) : (
              <button type="button" className="button button-run" onClick={() => void beginRun()}>
                <Play size={14} strokeWidth={2.5} fill="currentColor" /> 執行
              </button>
            )}

            {/* 第二列：監聽。跟執行分開，因為「跑一次」與「一直聽著」是兩件
                事，而使用者會需要「讓它繼續聽著，但把手上這次跑掉的停掉」。

                只有圖示，說明交給 title／aria-label：這一列有六個入口，六段
                中文標籤會把工具列撐到換行，而「監聽／執行紀錄／金鑰」這三顆
                的圖示本身就認得出來（耳朵、時鐘、鑰匙）。 */}
            <span className="actions-divider" aria-hidden="true" />
            {/* 帽子**一直都在**，沒在監聽時只是不寫數字。理由是手感不是語意：
                它要是跟著監聽開關進出，按下耳朵的那一刻整條工具列會往左跳一
                格，而那一跳正好發生在使用者剛按完、眼睛還盯著那顆按鈕的時候。

                數字本身照樣誠實——沒有事件積木就是 0，不是藏起來。「聽著幾顆」
                與「一顆都沒有」是同一個問題的兩個答案，藏掉後者只會讀成「這
                個數字還沒算出來」。 */}
            <HatCount count={listening.on ? listening.hats.length : null} hint={listening.message} />
            {listening.on ? (
              // 還是耳朵，只是綠的：這一顆是**狀態**，而「它在聽」的圖像就是
              // 耳朵。換成暫停符號等於把狀態換成動作，畫面上就再也沒有東西
              // 在說「現在是聽著的」了——顏色一個人扛不動這件事。
              <button
                type="button"
                className="button button-icon button-listening"
                onClick={() => void endListening()}
                aria-label="監聽中，按一下暫停"
                title="監聽中，按一下暫停"
              >
                <Ear size={15} strokeWidth={2.5} />
              </button>
            ) : (
              <button
                type="button"
                className="button button-icon"
                onClick={() => void beginListening()}
                aria-label="監聽"
                title="監聽：讓事件積木一直聽著"
              >
                <Ear size={15} strokeWidth={2.5} />
              </button>
            )}
            {listening.on && listening.webhooks.length > 0 && (
              // 網址不直接攤在工具列上：它是一串 32 位亂碼加路徑，擺出來只會
              // 把整條工具列撐開，而使用者要的是「複製它」而不是「讀它」。
              <button type="button" className="button" onClick={() => setHooksOpen(true)}>
                <Link2 size={13} strokeWidth={2.5} /> Webhook 網址
                <span className="keys-count">{listening.webhooks.length}</span>
              </button>
            )}

            {/* 執行紀錄跟「執行／監聽」分開：那兩顆是「讓它跑」，這顆是
                「回頭看它跑過什麼」——而後者在沒有東西在跑的時候也要進得去
                （§6.3 的整個用意就是跨 Run、跨重啟）。 */}
            <span className="actions-divider" aria-hidden="true" />
            <button
              type="button"
              className="button button-icon"
              onClick={() => setHistoryOpen(true)}
              aria-label="執行紀錄"
              title="執行紀錄"
            >
              <History size={15} strokeWidth={2.5} />
            </button>
          </div>
        )}
        {historyOpen && (
          <HistoryPanel projectId={PROJECT_ID} onClose={() => setHistoryOpen(false)} />
        )}
        {hooksOpen && (
          <WebhookPanel
            projectId={PROJECT_ID}
            webhooks={listening.webhooks}
            onClose={() => setHooksOpen(false)}
            onChanged={() => void refreshHooks()}
          />
        )}
        {/* 右上角的全域入口（D28）：不綁定某個專案，載入中／出錯時也該進得去。 */}
        <KeysEntry />
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
          <ExtensionsEntry />
          {extMenu && (
            <ExtensionMenu
              target={extMenu}
              installed={enabled.has(extMenu.group.id)}
              onDelete={(group) => {
                closeExtMenu();
                deleteExtensionRef.current(group);
              }}
            />
          )}
          {galleryOpen && (
            <ExtensionsGallery
              groups={state.registration.groups}
              onChanged={setToast}
              onDelete={(group) => deleteExtensionRef.current(group)}
            />
          )}
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

/**
 * 監聽中掛著幾顆事件積木——畫成那顆積木本身的形狀。
 *
 * 前一版寫的是「聽著 N 顆事件積木」，一句得讀完才知道在講什麼的話。使用者在
 * 畫布上認事件積木靠的是**那頂帽子**（`define.ts` 的 `style.hat`），所以這裡直
 * 接把帽子畫出來、數字寫在肚子上：不必翻譯，一眼就對得起來。
 *
 * 灰色而不是分類色：這顆是「有幾顆」的計數，不代表其中任何一顆的命名空間，
 * 隨便挑一個顏色只會讓人以為它在指某一類。
 *
 * `d` 是**從畫布上那顆事件積木身上抄下來的**（Blockly 13 的 geras render，
 * 整條路徑往右下位移 2／20 讓描邊有地方畫），不是照著眼睛比例畫的近似——比例
 * 一旦有出入，「這個計數說的是那種積木」這件事就得靠讀者自己相信。所以要動
 * 這條路徑之前先去 render 一顆真的來對。
 */
function HatCount({ count, hint }: { count: number | null; hint?: string }) {
  /** `null` = 沒在監聽。空字串讓下面的寬度與 `<text>` 一起收掉。 */
  const text = count === null ? '' : count.toLocaleString();
  // 帽子那道弧固定 96 寬，所以 112 是它撐得住的最小身體。空的跟一兩位數都落
  // 在這個下限上——這正是「按下耳朵不會位移」的來源。三位數以上才加寬，不加
  // 的話數字會壓到下緣那個 notch 上。
  const bodyWidth = Math.max(112, 64 + text.length * 24);
  // 「開著但一顆都沒有」那句話（`listeningStateOf` 的 message）搬進 tooltip：
  // 工具列上它只需要是一個 0，但「按了為什麼沒反應」的答案不能因此消失。
  const label =
    count === null
      ? '沒有在監聽'
      : hint
        ? `監聽中：${hint}`
        : `監聽中，聽著 ${text} 顆事件積木`;
  return (
    <span className={count === null ? 'hat-count hat-count-off' : 'hat-count'} title={label}>
      <svg
        viewBox={`0 0 ${bodyWidth + 4} 80`}
        width={((bodyWidth + 4) / 80) * 30}
        height={30}
        role="img"
        aria-label={label}
      >
        <path
          className="hat-count-body"
          d={`m 2,20 c 25,-22 71,-22 96,0 H ${bodyWidth - 2} a 4,4 0 0,1 4,4 v 40 a 4,4 0 0,1 -4,4 H 50 c -2 0 -3 1 -4 2 l -4 4 c -1 1 -2 2 -4 2 h -12 c -2 0 -3 -1 -4 -2 l -4 -4 c -1 -1 -2 -2 -4 -2 H 6 a 4,4 0 0,1 -4,-4 z`}
        />
        {/* 身體是 y 20→68，所以正中央在 44。x 用身體的中線，不是 Blockly 那個
            「欄位區的中線」——那顆積木左邊還有 notch 要讓，這顆沒有。 */}
        {text !== '' && (
          <text
            className="hat-count-text"
            x={2 + bodyWidth / 2}
            y={44}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {text}
          </text>
        )}
      </svg>
    </span>
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

/**
 * `open_config` 要打開的那一把（D28 的 `KeysTarget`）。
 *
 * **哪一把由 manifest 說，不是按鈕說**：`ButtonSpec` 上只有 id、label、action
 * ——刻意的，一顆按鈕能指定金鑰就等於一個包能送使用者去設定別人的那一把。所以
 * 這裡讀的是這個分類自己宣告的 `config`。
 *
 * 一個包宣告兩把 secret 時取第一把；沒有宣告任何一把時回 `undefined`，那會開
 * 一個**沒有鎖定任何一格**的金鑰面板。後者不是「什麼都不做」——一顆按下去沒有
 * 反應的按鈕比一個開錯格子的面板更難懂，而那個面板上至少列著全部的金鑰。
 */
function secretTarget(group: ToolboxGroup): KeysTarget | undefined {
  const secret = configTarget(group);
  if (!secret) return undefined;
  return {
    extId: group.id,
    extName: group.name,
    key: secret.key,
    label: secret.label ?? null,
    envVar: secret.envVar ?? null,
  };
}

/** 宣告式按鈕的動作（D25 的 (a) 層）裡，**不需要碰 React 的**那幾種。
 *
 * `create_procedure` 與 `open_config` 都要開編輯器自己的畫面，所以它們留在
 * `buttonRef` 那邊（那裡才有 state 與 store）。 */
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
      // 只剩 `call`（§7.3 的 @button）：它要打後端，而目前沒有包宣告得出來。
      // 一句誠實的「還沒接上」而不是一個假的成功。
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

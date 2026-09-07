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
 * **這個分頁打開的是哪一個專案**，由 `project/current.ts` 說（一個 localStorage
 * 裡的 opaque id，§3）。切換專案是一次整頁重載，所以在這個檔案裡它仍然是一個
 * 常數——`PROJECT_ID` 在一次載入之內不會變，而那正是這裡每一條路（存檔、執行、
 * 監聽、執行紀錄、webhook）都可以直接用它的原因。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, ChevronLeft, Ear, Link2, Play, Save, Square } from 'lucide-react';
import * as Blockly from 'blockly/core';
import {
  ApiError,
  downloadExtension,
  fetchExtensions,
  fetchKeys,
  fetchProject,
  saveProject,
  saveProjectPreview,
  uninstallExtension,
} from './api/client';
import { prefetchCovers } from './components/extensionsCovers';
import { ProjectSocket, RunSocket, startRun, stopRun } from './api/runs';
import {
  NOT_LISTENING,
  listeningHatsOf,
  activateProject,
  deactivateProject,
  fetchTriggerState,
  listeningStateOf,
  type ListeningState,
} from './api/triggers';
import type { RunSummary } from './api/runs';
import {
  buildProjectToolbox,
  changedManifestIds,
  registerManifests,
  type Registration,
} from './blockly/setup';
import { isRemovable } from './blockly/toolbox';
import type { RegisteredBlock } from './blockly/define';
import {
  callType,
  definitionType,
  isCallType,
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
import { rebuildCanvas } from './blockly/rebuild';
import { captureWorkspacePreview } from './blockly/preview';
import {
  downloadWorkspaceBlocks,
  registerWorkspaceExportMenus,
  type BlockExportFormat,
} from './blockly/export';
import { buttonCallbackKey, configTarget, type ToolboxGroup } from './blockly/toolbox';
import { ProcedureModal, type ProcedureDialogTarget } from './components/ProcedureModal';
import { Toast } from './components/Toast';
import { CheckRunner } from './ir/checks';
import { buildContext, type ConversionContext } from './ir/context';
import { loadProject } from './ir/deserialize';
import { serializeBlock, serializeWorkspace, type ScratchIR } from './ir/serialize';
import { RunDecorator } from './run/decorate';
import { useRunStore } from './run/store';
import { currentProjectId, forgetLastOpened } from './project/current';
import { ExtensionsEntry } from './components/ExtensionsEntry';
import { ExtensionsGallery } from './components/ExtensionsGallery';
import { ExtensionMenu, useExtensionMenu } from './components/ExtensionMenu';
import { useExtensionsUi } from './components/extensionsStore';
import { useReceipts } from './components/receiptsStore';
import { UninstallConfirm } from './components/UninstallConfirm';
import { ConfirmDialog } from './components/ConfirmDialog';
import { KeysEntry } from './components/KeysPanel';
import { configuredIds, useKeysUi, type KeysTarget } from './components/keysStore';
import { RunBubbles } from './components/RunBubbles';
import { FlyoutResizer } from './components/FlyoutResizer';
import { ToolboxScrollbar } from './components/ToolboxScrollbar';
import { WebhookPanel } from './components/WebhookPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { SettingsEntry } from './components/SettingsEntry';
import { RunPanel } from './components/RunPanel';
import { WorkspaceView } from './components/WorkspaceView';
import { JsonParsePrompts } from './components/JsonParsePrompts';
import { LIST_PATH, go, missingProjectPath, replace } from './project/routes';
import type { ButtonSpec, Manifest } from './types/manifest';
import type { BlockyardProjectIR as ProjectIR, Procedure } from './types/project';

import { EditorRuntime, disabledExtensions, rescueMode, saveAndReload, setExtensionEnabled } from './extensions/runtime';
import type { EditorHost } from './extensions/types';
import { PluginActions, PluginPanels } from './extensions/PluginUI';
import { applyEditorIR } from './extensions/transaction';
import { currentLocale, list, number, t } from './i18n';
import { localizeManifest, type TranslatableManifest } from './i18n/manifest';

/**
 * 這一次載入打開的專案。**一次載入之內是常數**：換一個專案會把整頁重載
 * （`projectsStore.switchTo`），所以下面每一條路都不必問「現在是哪一個」。
 */
const PROJECT_ID = currentProjectId();

/**
 * 存檔驗證（422）標在積木上的訊息用的 id。Blockly 的 warning 可以有多筆，
 * 各自一個 id——**清除時一定要帶 id**：`setWarningText(null)` 不帶 id 是
 * 「把整顆警告圖示拆掉」，會連 `FieldText.ts` 的欄位警告也一起清掉。
 */
const SAVE_WARNING_ID = 'blockyard-save';

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
  const stateRef = useRef(state);
  stateRef.current = state;
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  /**
   * 畫布上有沒有還沒存檔的改動。
   *
   * **這不只是一個提示，它是「監聽聽的是舊版」那件事的答案。** 後端跑的、聽的
   * 都是**已存檔的那一份**（`runs/manager.py::start` 讀的是 store，不是瀏覽器
   * 手上那份），而存檔本身就會 resync 一次 trigger
   * （`api/projects.py::put_project`）——所以「改了畫布但監聽沒跟上」從來不是
   * 同步壞掉，是那些改動根本還沒存進去。畫面上沒有任何東西說這件事，於是它
   * 看起來像 bug；`dirty` 就是那句話。
   *
   * 用**內容比對**而不是「有事件就標髒」：undo 回到存檔時的樣子就該重新乾淨，
   * 而捲動視角、點選積木不該算改動。代價是每 200ms 序列化一次全畫布——與旁邊
   * 那個靜態檢查同一個量級，所以兩件事掛在同一個節流上（見下面那個 effect）。
   */
  const [dirty, setDirty] = useState(false);
  /** 上一次真的存進後端的那份 IR 的 JSON。`null` = 還沒有基準（見那個 effect）。 */
  const savedRef = useRef<string | null>(null);
  /** 成功存檔了幾次。監聽中的那份 trigger 狀態要跟著它重讀。 */
  const [savedRevision, setSavedRevision] = useState(0);
  /**
   * 一句話的提示，蓋在畫布上（刪不掉的函式、刪掉了哪個函式）。
   *
   * 畫的人是 `Toast`（與主選單那一頁共用同一個六秒）。也不標成積木上的警告
   * 圖示——那個機制留下的教訓是「掛上去容易、清掉難」（見 §4.1 落單積木那一段）。
   */
  const [toast, setToast] = useState<string | null>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  /**
   * 帽子上的參數積木要知道的唯一一件事：現在有哪些函式。
   *
   * 走 ref 的理由與按鈕回呼相同——listener 註冊在工作區上，活得比 render 久。
   */
  const paramsRef = useRef<Record<string, Procedure>>({});
  const decoratorRef = useRef<RunDecorator | null>(null);
  const socketRef = useRef<RunSocket | null>(null);
  /** 監聽開著沒有。回呼活得比 render 久，所以要有一份 ref（同 `paramsRef`）。 */
  /**
   * 現在這一刻的監聽狀態。**存整份而不是只存 `on`**：`confirmUpdate` 要問的是
   * 「監聽中的 hat 有沒有一顆是這個包的」，而那個答案在 `hats` 裡。
   */
  const listeningRef = useRef<ListeningState>(NOT_LISTENING);
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
  /** 上一次從後端拿到的宣告。已知缺口 1 的比較基準，見下面那條 effect。 */
  const manifestsRef = useRef<Manifest[]>([]);
  // `syncExtensions` 同時只跑一個。ref 而不是 state：它不畫任何東西，而一個
  // 會觸發 render 的旗標會讓那個 callback 每次都是新的。
  const extSyncingRef = useRef(false);

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
  /**
   * 收據：**這幾個資料夾是誰搬進來的**（§2）。
   *
   * 這裡要它只為了一件事——右鍵選單上有沒有「解除安裝⋯」那一條。沒有收據的
   * 包是使用者自己放進資料夾的，我們不碰（`extensionsSource.ts::canUninstall`），
   * 而**面板上那張卡與這裡的選單必須給出同一個答案**，所以兩邊讀的是同一份
   * store，不是各自 fetch 一次。
   */
  const receipts = useReceipts((s) => s.receipts);
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
      manifestsRef.current = manifests;
      const localized = manifests.map((manifest) =>
        localizeManifest(manifest, (manifest as TranslatableManifest).locales, currentLocale()),
      );
      const registration = registerManifests(localized, undefined, currentLocale());
      // 封面先抓進快取。擴充功能面板是按下去才掛載的，等到那時候才發請求，看到的
      // 就是「面板先出來、圖晚一拍補上」——而現在使用者正在看畫布，這幾個請求不跟
      // 任何東西搶。
      prefetchCovers(registration.groups);
      const loaded = await fetchProject(PROJECT_ID, controller.signal);
      // **這個網址指到一份不存在的專案**——回主選單，不要生一張白紙出來。
      //
      // 原本這裡是 `loaded ?? blankProject()`，而那在 P0b 是對的：id 寫死、
      // 第一次啟動本來就沒有專案。多專案之後同一行的意思變成「打開一個死掉的
      // 網址會看到一張空白畫布，而第一次存檔就把那份被刪掉的專案復活」——
      // 使用者從 `/` 進來（它導去的是記著的那一份）就撞得到，因為那一份可能
      // 已經在別的分頁被刪掉了。
      if (loaded === null) {
        forgetLastOpened();
        replace(missingProjectPath(PROJECT_ID));
        return;
      }
      const project = loaded;
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

  /**
   * **後端的積木集合變了，這個分頁自己會發現**（PROGRESS 已知缺口 1）。
   *
   * `/api/extensions` 原本只在開場問一次，所以重啟後端之後那個分頁的工具箱與
   * 擴充功能面板都還是舊的，而畫面上**沒有任何訊號說它過期了**——症狀是「照你
   * 說的做，可是沒有那顆積木」。
   *
   * 掛在**視窗重新取得焦點**上，因為那就是那件事發生的形狀：改一份宣告 → 切到
   * 終端機重啟後端 → 切回瀏覽器。這一刻問一次，比任何輪詢都準，而且不改宣告的
   * 日子裡它一次網路請求都不會多發（回應一樣就什麼都不做）。
   *
   * 只重新註冊**變過的**那幾個命名空間（`changedManifestIds`）。整批重定義會把
   * Blockly 的全域註冊表洗一遍，而畫布上那些積木的定義早就套用過了——洗它們既
   * 沒有效果，又讓「這顆積木用的是哪一版定義」變成一個每次都要重新回答的問題。
   *
   * **背景那一路畫布不動**（`rebuild` 沒給）：只換工具箱與轉換 context，新的
   * 積木拉得出來、改過的積木從工具箱拉出來就是新形狀，而已經在畫布上的那些維持
   * 原樣。在使用者沒要求的時候動他的畫布，比晚一點才說更糟。
   *
   * **使用者親手更新那一路要動**（`rebuild: true`，`docs/extension-design.md`
   * §4）。同一句話的另一半：他剛剛按下更新、審閱畫面剛剛才告訴他哪幾顆積木會
   * 受影響——那不是「沒要求」。不重畫的話症狀是「我更新了，可是畫布上那顆的字
   * 還是舊的」，而使用者能做的唯一一件事是重新整理頁面，然後永遠不知道為什麼。
   *
   * 重建走的是**開一個專案那條路**（`rebuildCanvas`：導出 IR → 用新的 ctx 讀
   * 回來），而它讀不起來的時候一個字都不動——見那個模組的「為什麼要先空跑」。
   */
  /**
   * 重問一次後端的積木集合，變了就重新註冊。
   *
   * **兩個呼叫端共用同一段**：視窗重新取得焦點（下面那個 effect），以及從電腦
   * 裝好一個包的那一刻（`ExtensionsGallery` 的 `onInstalled`）。兩件事在後端是
   * 同一件事——`/api/extensions` 的回應變了——所以它們在前端也該是同一段程式碼。
   * 為匯入另寫一條註冊路，等於讓「裝一個包」與「重啟後端」有兩種可能不一樣的
   * 結果，而那種差異只有在其中一條壞掉時才會被發現。
   */
  const syncExtensions = useCallback(async (options?: { rebuild?: boolean }) => {
    // 同時只跑一個：切走切回很快的時候，第二次問到的東西會比第一次舊。
    if (extSyncingRef.current) return;
    extSyncingRef.current = true;
    try {
      const next = await fetchExtensions();
      const previous = manifestsRef.current;
      if (changedManifestIds(previous, next).size === 0 && previous.length === next.length) {
        return;
      }
      // **畫布要在重新註冊之前導出來。** `registerManifests` 一跑，
      // `Blockly.Blocks` 就是新的了；而畫布上那幾顆仍然是舊定義建出來的，只有
      // 現在這份 `ctx` 讀得懂它們。
      const before = options?.rebuild ? snapshotRef.current() : null;
      manifestsRef.current = next;
      const localized = next.map((manifest) =>
        localizeManifest(manifest, (manifest as TranslatableManifest).locales, currentLocale()),
      );
      const localizedPrevious = previous.map((manifest) =>
        localizeManifest(manifest, (manifest as TranslatableManifest).locales, currentLocale()),
      );
      const registration = registerManifests(localized, localizedPrevious, currentLocale());
      // 這條是「後端的包變了」那一路（多了一個包、或作者換掉了封面）。
      prefetchCovers(registration.groups);
      if (before) rebuildRef.current(before, registration);
      const prev = stateRef.current;
      const updated: State = prev.status === 'ready'
          ? {
            ...prev,
            registration,
            ctx: buildContext([...registration.blocks, ...prev.procedureBlocks]),
            toolbox: buildProjectToolbox(
              registration,
              prev.procedureBlocks,
              toolboxFor.current.configured,
              toolboxFor.current.enabled ?? undefined,
            ),
          }
          : prev;
      stateRef.current = updated;
      setState(updated);
    } catch (error) {
      if (options?.rebuild) throw error;
      // 後端還沒起來就是問不到——下次切回來再問。這條路上沒有值得打斷
      // 使用者的東西：他手上那份畫布完全沒有受影響。
      //
      // 匯入那條路不吞錯：裝好了卻沒出現在工具箱上是**看得見**的失敗，而它
      // 已經有一個負責說話的地方（審閱畫面）。這裡吞掉的是「重問失敗」，而
      // 那一刻包已經在磁碟上了——重新整理就會有。
    } finally {
      extSyncingRef.current = false;
    }
  }, []);

  // 收據跟著積木清單一起到位。**放在 `ready` 而不是開場的第一個 effect**：
  // 這份資料只決定一條選單條目要不要出現，而在畫面畫得出來之前沒有人看得到
  // 那條選單。
  useEffect(() => {
    if (state.status !== 'ready') return;
    const controller = new AbortController();
    void useReceipts.getState().reload(controller.signal);
    return () => controller.abort();
  }, [state.status]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    const onFocus = () => {
      if (!document.hidden) void syncExtensions();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [state.status, syncExtensions]);

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
      .catch(() => { });
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

  /**
   * 現在這份畫布的 IR。**存檔與「改過了沒有」共用同一條。**
   *
   * 兩邊各寫一次序列化參數的話，`meta` 或 `procedures` 只要有一格對不上，比對
   * 就會永遠說「改過了」——而那顆星星會從此拿不掉，變成一個沒有人相信的提示。
   */
  const snapshotProject = useCallback((): ProjectIR | null => {
    const state = stateRef.current;
    const ws = workspaceRef.current;
    if (!ws || state.status !== 'ready') return null;
    // `extensions` 不在這裡：它由 `serializeWorkspace` 從畫布上的積木算出來
    // （§13.3）。拉一顆積木包的積木出來就等於宣告用到了它。
    return serializeWorkspace(ws, state.ctx, {
      formatVersion: state.project.formatVersion,
      meta: state.project.meta,
      procedures: state.project.procedures,
    });
  }, [state]);

  /**
   * `syncExtensions` 拿得到「現在這份畫布」與「重畫它」的那兩條路。
   *
   * 走 ref 而不是相依：`syncExtensions` 是一個 `useCallback([])`（它掛在 window
   * 的 focus 上，重建就要重掛一次），而這兩件事都要看最新的 `state`。同一個
   * 手法在這個檔案裡已經用了好幾次（`deleteRef`、`syncRef`）。
   */
  const snapshotRef = useRef<() => ProjectIR | null>(null!);
  snapshotRef.current = snapshotProject;

  /**
   * 更新完一個積木包之後，把畫布用**新的定義**重畫一次
   * （`docs/extension-design.md` §4、`blockly/rebuild.ts`）。
   *
   * `project` 是**重新註冊之前**導出來的那一份（只有舊的 ctx 讀得懂畫布上那幾
   * 顆），`registration` 是剛註冊好的新宣告。兩者的時間差就是這個函式存在的
   * 全部理由。
   */
  const rebuildRef = useRef<(project: ProjectIR, registration: Registration) => void>(null!);
  rebuildRef.current = (project, registration) => {
    const ws = workspaceRef.current;
    if (!ws || state.status !== 'ready') return;
    // **捲到哪裡、放多大要留著**（`rebuildCanvas` 只管積木那一層）。使用者的
    // 眼睛停在他剛剛更新的那個包的積木上，而把畫布捲回原點等於要他自己找回來
    // ——那一下比舊的字還煩。
    const { scrollX, scrollY, scale } = ws;
    const ok = rebuildCanvas({
      workspace: ws,
      project,
      ctx: buildContext([...registration.blocks, ...state.procedureBlocks]),
      // 帽子上的參數晶片不在 IR 裡，載入之後要自己長回來——與開專案那條路
      // 同一句（`handleWorkspaceReady`）。
      after: (loaded) =>
        fillDefinitionParams(
          loaded as Blockly.WorkspaceSvg,
          project.procedures ?? {},
          (id) => deleteRef.current(id),
        ),
    });
    if (ok) {
      ws.setScale(scale);
      ws.scroll(scrollX, scrollY);
    }
    if (!ok) {
      // **一個字都沒動**，所以要說出使用者接下來能做什麼。走到這裡的情況是
      // 新版少了畫布上某顆積木還在用的那格參數——審閱畫面警告過的正是它。
      setToast(t('editor.updateReloadRequired'));
    }
  };

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

    const project = snapshotProject();
    if (!project) return false;

    try {
      // 截的是這一下按存檔時看見的畫布。先產圖、再寫 IR；只有 IR 通過後端驗證
      // 之後才換封面，避免一次失敗的存檔留下與實際內容對不起來的圖片。
      const preview = await captureWorkspacePreview(ws).catch(() => null);
      await saveProject(PROJECT_ID, project);
      if (preview) {
        // 封面是衍生資料；它寫失敗不能把已經成功落盤的專案說成「沒存到」。
        await saveProjectPreview(PROJECT_ID, preview).catch((error) => {
          console.warn('專案已存檔，但預覽圖片保存失敗', error);
        });
      }
      // 這一份就是後端手上的那一份——「畫布改過了沒有」從這裡重新起算。
      // **存成功才記**：存壞的那一次後端還留著舊的，而畫布上那些改動確實
      // 還沒進去，那時候標成乾淨等於把使用者騙回原本那個 bug。
      savedRef.current = JSON.stringify(project);
      setDirty(false);
      setSavedRevision((n) => n + 1);
      setSaveState({ status: 'saved' });
      return true;
    } catch (error: unknown) {
      // 422 帶 blockId：後端已經算出是哪一顆積木不合法（§4.2 的 D20 形狀
      // 驗證、§4.7 的插值運算式擋修），直接把警告標在那顆積木上，比
      // 只顯示一行錯誤文字快得多。
      if (error instanceof ApiError && error.detail?.blockId) {
        const block = ws.getBlockById(error.detail.blockId);
        block?.setWarningText(error.message, SAVE_WARNING_ID);
        block?.select();
      }
      setSaveState({ status: 'error', message: describe(error) });
      return false;
    }
  }, [state, snapshotProject]);

  /**
   * 回到主選單。**沒存的先存起來**。
   *
   * 離開這一頁是一次真的導覽，所以沒存的改動會直接消失——而這個編輯器裡
   * 「執行之前先存檔」早就是既有的約定（`beginRun`），這裡走的是同一條。
   *
   * **存不進去就不走**：那時候畫布上有一顆被標紅的積木，而使用者要看的是它，
   * 不是另一頁。那句話要說出口，否則症狀是「我按了返回，可是沒反應」。
   */
  const leaveToList = useCallback(async (): Promise<void> => {
    if (dirty && !(await save())) {
      setToast(t('editor.leaveSaveFailed'));
      return;
    }
    go(LIST_PATH);
  }, [dirty, save]);

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
  listeningRef.current = listening;
  const [hooksOpen, setHooksOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  /** 接上一個 Run 的 `/ws/run` 通道。**只有 `attach` 與交棒回來時會用。** */
  const attachSocket = useCallback((runId: string) => {
    socketRef.current?.close();
    useRunStore.getState().own(runId);
    const socket: RunSocket = new RunSocket(runId, {
      onFrame: (frame) => useRunStore.getState().apply(frame),
      onClose: (clean) => {
        // **只清自己那一筆。** 關掉舊 socket 的 `onclose` 是下一輪才到的，那時
        // 這兩格可能已經記著下一個 Run 了。清得掉才有下一句：`ownedRunId` 是
        // 「這個 Run 有沒有人接著」的唯一答案，留著一筆死的，監聽關掉時就不會
        // 去接手。
        const s = useRunStore.getState();
        if (s.ownedRunId === runId) s.own(null);
        if (socketRef.current === socket) socketRef.current = null;
        // Run 還在跑卻斷線：使用者要知道畫面停在半路，而不是以為它跑完了。
        if (s.status === 'running' || s.status === 'starting') {
          s.finish(clean ? 'cancelled' : 'error', clean ? undefined : t('editor.connectionLost'));
        }
      },
    });
    socketRef.current = socket;
  }, []);

  /**
   * 接上一個 Run 的事件流。綠旗與「點一下就跑」走這一條。
   *
   * **監聽開著的時候不開 run 通道。** 後端每一個 Run 都往專案通道送
   * （`runs/manager.py` 的 `hub.publish`，不分是誰起的），所以那時候這個 Run
   * 的 frame 已經在路上了——再接一條就是同一份事件套用兩次，而 log 是累加的：
   * 症狀是每一行都印兩次（實測，D33 之後）。高亮與變數是覆寫式的，所以只有
   * log 會露出來。
   *
   * hat 觸發的 Run 不經過這裡：它是後端自己起的，前端沒有那個 runId，而那正是
   * 專案通道存在的理由（D33）。
   */
  const attach = useCallback(
    (run: RunSummary) => {
      useRunStore.getState().attach(run);
      if (listeningRef.current.on) return;
      attachSocket(run.runId);
    },
    [attachSocket],
  );

  /**
   * 監聽關掉、而手上這個 Run 還在跑：把它接回 run 通道。
   *
   * 「一個 Run 的事件只從一個地方進來」的另一半：監聽開著時那個地方是專案
   * 通道，而按下停止監聽的當下它就沒了。不接回來的話畫面從那一刻起安靜，而
   * Run 還在後端跑——那是最糟的一種畫面，因為它看起來像跑完了。
   */
  useEffect(() => {
    if (listening.on) return;
    const { runId: current, ownedRunId, status } = useRunStore.getState();
    if (ownedRunId) return; // 已經有人接著（Run 先開始、監聽後來才關掉的那條路）
    if (current && (status === 'running' || status === 'starting')) attachSocket(current);
  }, [listening.on, attachSocket]);

  const beginListening = useCallback(async () => {
    // 監聽跑的也是**已存檔的那一份**（同執行，`runs/manager.py` 開頭那段）。
    // 不先存的話，使用者剛拉出來的那顆 hat 後端根本看不到，而症狀是「按了監聽
    // 但它說沒有 hat」。
    if (!(await save())) {
      setListening({ ...NOT_LISTENING, message: t('editor.listenSaveFailed') });
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
    await deactivateProject(PROJECT_ID).catch(() => { });
  }, []);

  /**
   * 「更新這個包之前，要不要先暫停監聽？」（`docs/extension-design.md` §4）
   *
   * **問題不是禮貌，是正確性。** 正在監聽的那一組子行程早就把 `main.py`
   * import 進去了，而它重建的條件是「積木包的集合變了」——更新前後那個集合
   * 一樣，所以不停掉的話，磁碟上換了新的、跑的還是舊的，而畫面上沒有任何
   * 地方說得出那是為什麼。
   *
   * **只有真的相關才問**（`listeningHatsOf`）：後端只為提供 hat 的那幾個包開
   * 子行程，而 hat 觸發起的 Run 走的是一個全新的 registry。所以「聽著 Discord
   * 的訊息時更新 `http`」不該跳出任何東西——一個每次都出現的確認框，三次之後
   * 就沒有人在讀了。
   *
   * 回一個 Promise 是因為呼叫端（審閱畫面上那顆按鈕）要**等使用者按完**才知道
   * 要不要繼續。resolver 存在 state 裡而不是 ref：這一格同時也是「對話框開著
   * 嗎」，兩個各記一份就會有「框關了但 promise 還掛著」那種狀態。
   */
  const [pausePrompt, setPausePrompt] = useState<{
    extId: string;
    hats: string[];
    resolve: (go: boolean) => void;
  } | null>(null);
  const pausedForUpdateRef = useRef(false);

  const confirmUpdate = useCallback(
    (extId: string): Promise<boolean> => {
      const hats = listeningHatsOf(listeningRef.current, extId);
      if (hats.length === 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => setPausePrompt({ extId, hats, resolve }));
    },
    [],
  );

  /**
   * 為了更新停掉的監聽要接回去。
   *
   * **兩個出口，一個旗標**：更新真的走完了（`onInstalled`），以及使用者中途
   * 放棄了（面板關掉）。旗標是那件事唯一的紀錄，所以兩條路都讀它、都清它——
   * 各記一份的話，「取消之後監聽再也沒回來」會是一個沒有人重現得出來的 bug。
   */
  const resumeListening = useCallback(async () => {
    if (!pausedForUpdateRef.current) return;
    pausedForUpdateRef.current = false;
    await beginListening();
  }, [beginListening]);

  useEffect(() => {
    // 面板關掉而旗標還在 = 使用者按了「仍要更新」之後又放棄了。
    if (!galleryOpen) void resumeListening();
  }, [galleryOpen, resumeListening]);

  /** 按下「仍要更新」：先停監聽，再讓匯入那條路繼續走。 */
  const acceptPause = async () => {
    const prompt = pausePrompt;
    if (!prompt) return;
    setPausePrompt(null);
    await endListening();
    // 更新完之後要接回去（`onInstalled` 那條路的最後一步）。使用者本來在監聽，
    // 他按下的是「暫停」不是「關掉」。
    pausedForUpdateRef.current = true;
    prompt.resolve(true);
  };

  /**
   * 存檔之後，監聽中的那份狀態要重讀（§9.2 的「專案編輯後 diff」）。
   *
   * 後端在 `PUT /api/projects` 裡自己 resync 了 trigger，所以**存檔就是套用**
   * ——但工具列上那頂帽子的數字是 `beginListening` 那一刻拿的。新拉一顆 hat
   * 出來存檔，後端確實接上了，而畫面還寫著舊的數字：那會讓人以為存檔沒有用，
   * 然後去按停止再按一次監聽（而那才是真的會掉訊息的動作）。
   *
   * 掛在 `savedRevision` 而不是 `dirty` 上：要重讀的時機是「存進去了」，不是
   * 「畫布變乾淨了」——存檔失敗時後端沒有變，沒有東西要重讀。
   */
  useEffect(() => {
    if (!listening.on || savedRevision === 0) return;
    let alive = true;
    fetchTriggerState(PROJECT_ID)
      .then((summary) => {
        if (alive) setListening(listeningStateOf(summary));
      })
      // 讀不到就留著舊的數字。存檔那條路已經說過話了，這裡再丟一句錯誤只會
      // 蓋掉真正的那一句。
      .catch(() => { });
    return () => {
      alive = false;
    };
  }, [savedRevision, listening.on]);

  /** 設完密鑰之後重讀狀態——`secretSet` 是後端算的，前端猜不得。 */
  const refreshHooks = useCallback(async () => {
    const state = await fetchTriggerState(PROJECT_ID).catch(() => null);
    if (state) setListening((prev) => ({ ...prev, webhooks: state.webhooks ?? [] }));
  }, []);

  /**
   * 開一次 Run。`blockId` 給了就是 §5.1 的「點一下就跑」，再帶一份 `scratch`
   * 就是**在工具箱裡**點的那一顆（那顆積木不在存檔裡，見 `runs/scratch.py`）。
   *
   * 綠旗與點擊走同一條路——差別只有多送一個 `blockId`。前一個 Run 先停掉：
   * 編輯器同時只顯示一個 Run（一個 socket、一份高亮），不停的話畫面上看不見
   * 的那個 `forever` 迴圈會繼續在後端轉。
   */
  const beginRun = useCallback(
    async (blockId?: string, scratch?: ScratchIR) => {
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
        store.fail(t('editor.runSaveFailed'));
        return;
      }

      try {
        attach(await startRun(PROJECT_ID, { blockId, scratch }));
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


  const pluginHostRef = useRef<EditorHost>(null!);
  pluginHostRef.current = {
    workspace: {
      getIR: () => {
        const project = snapshotRef.current();
        if (!project) throw new Error(t('editor.workspaceNotReady'));
        return structuredClone(project);
      },
      applyIR: async (project) => {
        const current = stateRef.current;
        const ws = workspaceRef.current;
        if (current.status !== 'ready' || !ws) throw new Error(t('editor.workspaceNotReady'));
        await applyEditorIR(project, {
          workspace: ws, blocks: current.registration.blocks,
          snapshot: () => pluginHostRef.current.workspace.getIR(),
          validate: async (candidate) => {
            const response = await fetch(`/api/projects/${PROJECT_ID}/validate`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(candidate),
            });
            if (!response.ok) {
              const body = await response.json();
              throw new Error(body.detail?.message ?? t('editor.workspaceValidationFailed'));
            }
          },
          afterLoad: (loaded, next) => fillDefinitionParams(loaded as Blockly.WorkspaceSvg, next.procedures ?? {}, (id) => deleteRef.current(id)),
          commit: (next) => {
            const previous = stateRef.current;
            if (previous.status !== 'ready') throw new Error(t('editor.workspaceNotReady'));
            const procedureBlocks = registerProcedures(next.procedures ?? {});
            paramsRef.current = next.procedures ?? {};
            const updated: State = {
              ...previous, project: next, procedureBlocks,
              ctx: buildContext([...previous.registration.blocks, ...procedureBlocks]),
              toolbox: buildProjectToolbox(previous.registration, procedureBlocks, toolboxFor.current.configured, toolboxFor.current.enabled ?? undefined),
            };
            stateRef.current = updated;
            setState(updated);
            setDirty(true);
          },
        });
      },
      getSelection: () => {
        const selected = Blockly.common.getSelected();
        return selected instanceof Blockly.BlockSvg && selected.workspace === workspaceRef.current ? selected.id : null;
      },
      select: (id) => {
        if (id === null) { Blockly.common.getSelected()?.unselect(); return; }
        const block = workspaceRef.current?.getBlockById(id);
        if (!block) throw new Error(t('editor.blockNotFound', { id }));
        block.select();
      },
      focus: (id) => {
        const ws = workspaceRef.current;
        const block = ws?.getBlockById(id);
        if (!ws || !block) throw new Error(t('editor.blockNotFound', { id }));
        glideToBlock(ws, block.id);
      },
    },
    project: {
      current: () => {
        const current = stateRef.current;
        return { id: PROJECT_ID, name: current.status === 'ready' ? current.project.meta?.name ?? null : null };
      },
      save: async () => { if (!(await save())) throw new Error(t('editor.saveFailedCanvasKept')); },
    },
    run: async () => {
      await beginRun();
      const run = useRunStore.getState();
      if (run.status === 'error') throw new Error(run.message ?? t('editor.runFailed'));
    },
    stop: async () => { const id = useRunStore.getState().runId; if (id) await stopRun(id); },
  };
  const [pluginRuntime] = useState(() => new EditorRuntime({
    workspace: {
      getIR: () => pluginHostRef.current.workspace.getIR(),
      applyIR: (p) => pluginHostRef.current.workspace.applyIR(p),
      getSelection: () => pluginHostRef.current.workspace.getSelection(),
      select: (id) => pluginHostRef.current.workspace.select(id),
      focus: (id) => pluginHostRef.current.workspace.focus(id),
    },
    project: { current: () => pluginHostRef.current.project.current(), save: () => pluginHostRef.current.project.save() },
    run: () => pluginHostRef.current.run(), stop: () => pluginHostRef.current.stop(),
  }));
  const pluginState = useSyncExternalStore(pluginRuntime.subscribe, pluginRuntime.getSnapshot);
  const [disabledPlugins, setDisabledPlugins] = useState(disabledExtensions);
  const [reloadPending, setReloadPending] = useState<string | null>(null);
  const reloadPlugins = async () => {
    try {
      await saveAndReload(() => pluginHostRef.current.project.save(), () => window.location.reload(), () => JSON.stringify(pluginHostRef.current.workspace.getIR()));
    } catch (error) { setReloadPending(`${describe(error)} ${t('editor.pluginReloadPending')}`); }
  };
  const togglePlugin = async (id: string) => {
    setExtensionEnabled(id, disabledPlugins.has(id));
    setDisabledPlugins(disabledExtensions());
    await reloadPlugins();
  };
  useEffect(() => {
    if (!workspace || state.status !== 'ready') return;
    // Deferring one task avoids activating user code in StrictMode's discarded effect.
    const timer = window.setTimeout(() => {
      void pluginRuntime.load(manifestsRef.current, window.location.search).then(() => {
        pluginRuntime.emit('project.changed', pluginHostRef.current.project.current());
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [workspace, state.status, pluginRuntime]);
  useEffect(() => {
    const cleanup = () => { void pluginRuntime.dispose(); };
    window.addEventListener('keydown', pluginRuntime.handleKey);
    window.addEventListener('pagehide', cleanup);
    return () => {
      window.removeEventListener('keydown', pluginRuntime.handleKey);
      window.removeEventListener('pagehide', cleanup);
    };
  }, [pluginRuntime]);
  useEffect(() => {
    if (!workspace) return;
    const changed = (event: Blockly.Events.Abstract) => {
      if (!event.isUiEvent) pluginRuntime.emit('workspace.changed', undefined);
      if (event.type === Blockly.Events.SELECTED) pluginRuntime.emit('selection.changed', pluginHostRef.current.workspace.getSelection());
    };
    workspace.addChangeListener(changed);
    return () => workspace.removeChangeListener(changed);
  }, [workspace, pluginRuntime]);
  useEffect(() => { pluginRuntime.emit('run.changed', { status: runStatus, runId }); }, [pluginRuntime, runStatus, runId]);
  const executeEditorCommand = (id: string) => void pluginRuntime.execute(id).catch((error) => setToast(describe(error)));

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
   * 收不起來的分類不接（`isRemovable`）：它們沒有「刪掉」這個選項，攔下右鍵
   * 只會給出一個兩條都不能點的選單。**判準跟卡片牆共用同一個函式**——第一版
   * 這裡寫死 `!builtin`，於是 `panel` 在面板上加得進來、右鍵卻刪不掉。
   */
  useEffect(() => {
    if (!workspace || !groups) return;
    const div = workspace.getInjectionDiv();
    const onContextMenu = (e: MouseEvent) => {
      const toolbox = workspace.getToolbox() as Blockly.Toolbox | null;
      const target = e.target as Element | null;
      if (!toolbox || !target) return;
      const item = toolbox.getToolboxItems().find((entry) => entry.getDiv()?.contains(target));
      const group = item
        ? groups.find((g) => g.id === item.getId() && isRemovable(g))
        : undefined;
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
      setToast(t('editor.procedureInUse', { count: number(callers.length), name: label }));
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
    setToast(t('editor.procedureDeleted', { name: label }));
  };

  /**
   * **一個包有三個動詞，而它們動的是三層不同的帳**
   * （D31、`docs/extension-design.md` §1）：
   *
   * | 動詞 | 動的是 | 住在哪 |
   * |---|---|---|
   * | 從工具箱移除 | 我現在想不想看到它 | `localStorage` 的那份名單 |
   * | 更新／替換 | 磁碟上那份程式碼 | `extensions/<id>/` |
   * | 解除安裝 | 同上，但是搬走 | 同上 ＋ 垃圾桶 |
   *
   * 以前只有第一個，而它叫「刪除」——那個字讓使用者以為自己做了第三件事，
   * 於是他去開檔案總管。**這裡三個各有各的名字，而下面三段程式碼的差別就是
   * 那張表。**
   *
   * 前兩層共用同一條擋規則（`blocksUsing`），因為它們會壞掉的東西是同一個：
   * 畫布上那些**改得動、卻再也生不出第二顆**的積木。
   */

  /**
   * 「從工具箱移除」。**與刪除一個函式定義是同一條規則**：
   *
   * | 畫布上還有它的積木 | **不准移除**，關掉面板、捲到其中一顆、說還有幾顆 |
   * | 沒有 | 從名單裡拿掉，工具箱當場少一個分類 |
   *
   * 為什麼要擋：移除之後那個分類就不在工具箱上了，而畫布上那些積木還在跑
   * （註冊沒有被拿掉，D31）——使用者會有一批**改得動、卻再也生不出第二顆**的
   * 積木，而畫面上沒有任何地方說得出那是為什麼。函式那條路擋的是同一件事。
   *
   * 它同時把 D31 的兩條規則變成一致的：載入專案時「這個專案用到的包一定要在
   * 名單裡」會把包加回來——如果移除不擋，使用者移除一個正在用的包，下次開專案
   * 它又自己回來了，而那看起來就是「移除沒有用」。
   *
   * **不刪磁碟上的任何東西。** `extensions/` 底下那個資料夾還在，面板上那張卡
   * 也還在（只是回到「＋ 加入」）。真的拔掉走的是下面那條「解除安裝」。
   *
   * **擋下來時是逐顆走訪，不是永遠停在第一顆**（`usageWalkRef`）：使用者被擋住
   * 之後要做的事是「把它們一顆一顆刪掉」，而畫面上一次只看得到一顆。再按一次
   * 就跳下一顆——那讓這條擋規則同時是一份清單，而不只是一句拒絕。
   */
  const usageWalkRef = useRef<Record<string, number>>({});
  const removeExtensionRef = useRef<(group: ToolboxGroup) => void>(null!);
  removeExtensionRef.current = (group: ToolboxGroup) => {
    if (!blockUsage(group, t('editor.removeExtensionTitle', { name: group.name }))) return;
    delete usageWalkRef.current[group.id];
    useExtensionsUi.getState().remove(group.id);
    // 它宣告的面板分頁也跟著不見——那份清單是從 `enabled` 算出來的
    // （見下面 `<RunPanel declared=…>`），所以這裡不必額外做什麼。
    setToast(t('editor.extensionRemoved', { name: group.name }));
  };

  /**
   * 「還有幾顆在用」那條擋規則，**三個動詞共用一份**。
   *
   * 回 `true` = 沒有人在用，可以走下去。回 `false` 的那一路已經自己說完話了
   * （關面板、滑到那一顆、setToast）。
   *
   * 抽出來不是為了少寫幾行，是因為**它們必須是同一句話**：使用者被「移除」
   * 擋下來之後改按「解除安裝」，得到的如果是另一種說法或另一個計數，那份
   * 一致感就沒了——而那份一致感正是他相信「這個工具知道自己在做什麼」的來源。
   */
  const blockUsage = (group: ToolboxGroup, what: string): boolean => {
    const ws = workspaceRef.current;
    if (!ws) return false;
    const closeGallery = useExtensionsUi.getState().closeGallery;
    const used = blocksUsing(ws, group);
    const first = used[0];

    // 兩條路都先關掉面板：畫布在它底下，捲到哪一顆、少了哪一個分類，
    // 面板開著的時候一件都看不見（那條提示也在它底下）。
    closeGallery();
    if (!first) return true;

    // 「還有 3 顆」如果找不到那三顆，等於沒說——滑過去，不是跳過去
    // （`blockly/motion.ts`，同 `deleteRef` 的理由）。
    //
    // 走訪的位置記在 id 上而不是積木上：使用者刪掉的那一顆會從 `used` 裡
    // 消失，所以只有「第幾個」活得過下一次點擊，`% used.length` 讓它在名單
    // 縮短時自己回到範圍內。
    const at = ((usageWalkRef.current[group.id] ?? -1) + 1) % used.length;
    usageWalkRef.current[group.id] = at;
    glideToBlock(ws, (used[at] ?? first).id);
    setToast(t('editor.extensionUsed', {
      count: number(used.length),
      name: group.name,
      action: what,
      at: number(at + 1),
    }));
    return false;
  };

  /**
   * 「更新／替換⋯」。這裡只做一件事：**把擴充功能面板打開，並告訴它現在要換
   * 的是哪一個包**。
   *
   * 真正的流程（挑檔案或貼網址 → 審閱 → 差集 → 按下更新）住在那一頁，因為
   * 它與第一次安裝**是同一條管線**（§3）。在這裡另寫一條，等於讓「更新」與
   * 「安裝」有兩份可能不一樣的驗證。
   *
   * **這一條不擋。** 更新不會讓畫布上的積木失去來源——除非新版少了那顆積木，
   * 而那件事要等審閱畫面算出差集才知道（§4）。在還不知道會少什麼之前就擋，
   * 擋掉的是使用者「正是為了修那個包才要更新」的那一次。
   */
  const updateExtensionRef = useRef<(group: ToolboxGroup) => void>(null!);
  updateExtensionRef.current = (group: ToolboxGroup) => {
    useExtensionsUi.getState().startUpdate(group.id);
  };

  /**
   * 「解除安裝⋯」。**擋規則比移除更嚴的那一條**（§5）：移除只是收起來，解除
   * 安裝會讓畫布上那些積木在下次載入時退化成 §13.3 的佔位符。
   *
   * 過了擋規則之後**不直接動手**，先攤出收據（`UninstallConfirm`）：這一格上
   * 的三個數字（何時從哪裡裝的、哪一版、畫布上有幾顆）就是使用者需要的全部。
   */
  const [uninstalling, setUninstalling] = useState<ToolboxGroup | null>(null);
  const [uninstallBusy, setUninstallBusy] = useState(false);
  const [uninstallError, setUninstallError] = useState<string | null>(null);
  const uninstallExtensionRef = useRef<(group: ToolboxGroup) => void>(null!);
  uninstallExtensionRef.current = (group: ToolboxGroup) => {
    if (!blockUsage(group, t('editor.uninstallTitle', { name: group.name }))) return;
    delete usageWalkRef.current[group.id];
    setUninstallError(null);
    setUninstalling(group);
  };

  /** 按下那一格上的「解除安裝」。 */
  const confirmUninstall = async (group: ToolboxGroup) => {
    setUninstallBusy(true);
    setUninstallError(null);
    try {
      const hadEditor = !!manifestsRef.current.find((m) => m.id === group.id)?.editor;
      const done = await uninstallExtension(group.id);
      // **順序**：先把工具箱那一層收乾淨，再重問後端。反過來的話，`/api/extensions`
      // 少了一個包、而名單上還留著它的 id，那一格會在兩次 render 之間指向一個
      // 不存在的分類。
      useExtensionsUi.getState().remove(group.id);
      await syncExtensions();
      void useReceipts.getState().reload();
      setUninstalling(null);
      if (hadEditor) await reloadPlugins();
      // 垃圾桶在哪要說出口：那是按錯了唯一的退路，而現在還沒有一頁 UI 在看它。
      setToast(t('editor.uninstalled', { name: `${group.name} v${done.version}`, trash: done.trash }));
    } catch (e) {
      setUninstallError(e instanceof Error ? e.message : String(e));
    } finally {
      setUninstallBusy(false);
    }
  };

  /**
   * 「這幾種積木，畫布上各有幾顆」——更新那條路上的差集要它（§4）。
   *
   * **Blockly 的積木型別名稱就是 opcode，一字不差**（`blockly/define.ts`），
   * 所以這裡不需要任何轉換表。`blocksUsing` 問的是「這個分類的每一種積木」，
   * 這裡問的是指名的那幾種——同一件事的兩個粒度。
   */
  const countOpcodes = (opcodes: string[]): Record<string, number> => {
    const ws = workspaceRef.current;
    const out: Record<string, number> = {};
    for (const opcode of opcodes) {
      out[opcode] = ws ? ws.getBlocksByType(opcode, true).length : 0;
    }
    return out;
  };

  /**
   * 「滑到那幾顆去」。§4 說被擋下來的更新要**一樣可解**：使用者要做的事是把
   * 那幾顆積木處理掉，而畫面上一次只看得到一顆。
   *
   * 與 `blockUsage` 共用 `usageWalkRef`——那份「第幾顆」是同一個計數，因為
   * 使用者眼裡它就是同一件事（「再按一次跳下一顆」）。
   */
  const glideToOpcode = (opcode: string) => {
    const ws = workspaceRef.current;
    if (!ws) return;
    const found = ws.getBlocksByType(opcode, true);
    const first = found[0];
    if (!first) return;
    useExtensionsUi.getState().closeGallery();
    const at = ((usageWalkRef.current[opcode] ?? -1) + 1) % found.length;
    usageWalkRef.current[opcode] = at;
    glideToBlock(ws, (found[at] ?? first).id);
    setToast(t('editor.opcodeUsed', { count: number(found.length), at: number(at + 1) }));
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
  const exportBlocksRef = useRef<(format: BlockExportFormat) => void>(null!);
  exportBlocksRef.current = (format) => {
    const ws = workspaceRef.current;
    if (!ws || state.status !== 'ready') return;
    void downloadWorkspaceBlocks(ws, format, state.project.meta?.name ?? 'blocks').catch((error) => {
      setToast(error instanceof Error ? error.message : String(error));
    });
  };
  useEffect(() => registerWorkspaceExportMenus((format) => exportBlocksRef.current(format)), []);

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
          // 監聽開著時這是手上那個 Run 的唯一來源（`attach` 不再開 run 通道），
          // 所以斷線就等於畫面停在半路——與 `RunSocket` 同一句話。
          const s = useRunStore.getState();
          if (s.status === 'running' || s.status === 'starting') {
            s.finish('error', t('editor.connectionLost'));
          }
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
   * 執行前的靜態檢查（§4.5、§4.6、§8.5），外加「畫布改過了沒有」。
   *
   * 兩件事共用一個節流不是為了省一個 listener，是因為它們掃的是同一份東西：
   * 各自掛一條的話，同一次編輯會把全畫布走兩趟，而 PROGRESS 上那筆帳就是這樣
   * 記起來的。
   *
   * `isUiEvent` 的那些（點選、捲動、縮放）跳過：它們改的是視角不是積木——而
   * 「改過了沒有」問的也正是積木，捲動一下就說有未存檔的改動是說謊。
   */
  useEffect(() => {
    if (!workspace || state.status !== 'ready') return;
    const checker = checkerRef.current;
    const input = { ctx: state.ctx, procedures: state.project.procedures ?? {} };

    /**
     * 「改過了沒有」＝ 現在的 IR 跟上一次存進去的那份不一樣。
     *
     * **第一次算出來的那份就是基準**（`savedRef` 還是 `null` 的那一次）。不能
     * 在載入的當下記：`loadProject` 是一路 `append` 出來的，那些 BLOCK_CREATE
     * 事件下一個 macrotask 才送到，掛旗子的做法會讓每個專案一打開就是髒的。
     * 等節流那 200ms 過去，帽子上的參數晶片（`watchDefinitionParams`）也補完
     * 了，這時的畫布才真的是「剛打開的樣子」。
     */
    const syncDirty = () => {
      const project = snapshotProject();
      if (!project) return;
      const json = JSON.stringify(project);
      if (savedRef.current === null) savedRef.current = json;
      setDirty(json !== savedRef.current);
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        checker?.run(input);
        syncDirty();
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
  }, [workspace, state, snapshotProject]);

  /**
   * §5.1 的「點一下就跑」。**畫布上與工具箱裡的都算。**
   *
   * 點到影子積木時往上找一顆真的積木：影子的值存在父積木的 `inputs` 裡
   * （§4.2），它自己沒有 blockId 可以送給後端。點欄位不會走到這裡——Blockly
   * 的 gesture 對欄位發的是 `doFieldClick`，不發 CLICK 事件。
   *
   * **工具箱裡那一顆也跑得動**，而那是「拉一顆出來點一下」的下一步：試一顆
   * 積木不必先在畫布上留下它，試完也不必收拾。差別只在那顆積木不在存檔裡，
   * 所以它自己那一小段 IR 要跟著請求走（`serializeBlock` → `scratch`），由
   * 後端併進載入用的那一份（`runs/scratch.py`）——存檔的檔案不動，畫布也不動。
   * 高亮與值氣泡照樣冒在那顆積木身上（`run/decorate.ts` 會問工具箱那一份
   * 工作區）。
   */
  useEffect(() => {
    if (!workspace || state.status !== 'ready') return;
    const ctx = state.ctx;
    // flyout 裡的積木有**自己的**工作區，而事件只送給它自己的 listener——所以
    // 兩邊各掛一次，同一個 handler 靠 `workspaceId` 分辨這一下點在哪裡。
    const flyout = workspace.getFlyout()?.getWorkspace() ?? null;

    const listener = (event: Blockly.Events.Abstract) => {
      if (event.type !== Blockly.Events.CLICK) return;
      const click = event as Blockly.Events.Click;
      if (click.targetType !== 'block' || !click.blockId) return;

      const inFlyout = click.workspaceId !== workspace.id;
      const source = inFlyout ? flyout : workspace;
      if (!source || click.workspaceId !== source.id) return;

      let block = source.getBlockById(click.blockId);
      while (block?.isShadow()) block = block.getParent();
      if (!block) return;

      if (!inFlyout) {
        void beginRun(block.id);
        return;
      }

      // **工具箱裡的帽子不跑。** 帽子的意思是「外面發生事情的時候」，它自己
      // 從來不被執行（§5.1），而工具箱裡那一顆底下什麼都沒接——跑它等於開一個
      // 註定空手而回的 Run。順帶擋掉一件看不出來的事：一顆與畫布上同路徑的
      // `when_webhook` 併進去會撞上「同路徑兩顆」那條驗證（§9.3），於是點一下
      // 帽子換來一句 422，而使用者其實什麼都沒做錯。
      if (ctx.blockOf(block.type)?.spec.type === 'hat') return;
      void beginRun(block.id, serializeBlock(block, ctx));
    };

    workspace.addChangeListener(listener);
    flyout?.addChangeListener(listener);
    return () => {
      workspace.removeChangeListener(listener);
      flyout?.removeChangeListener(listener);
    };
  }, [workspace, state, beginRun]);

  /**
   * 耳朵上那句話。監聽中而畫布又改過了的時候，它要說的是**它在聽的是哪一份**
   * ——不是「你有東西沒存」（那句話存檔按鈕自己會說），而是「你看到的跟它在跑
   * 的不是同一份，而解法是存檔，不是把監聽關掉再開」。後者是使用者原本會做的
   * 事，而它對 Discord 那種長連線是真的有代價的（斷線重連期間的訊息就沒了）。
   */
  const listeningLabel =
    listening.on && dirty
      ? t('editor.listenStale')
      : t('editor.listeningPause');

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <img className="brand-icon" src="/icon.svg" alt="" />
          blockyard
        </span>
        {/* **返回在編輯器這一側，而它的目標是主選單**（`project/routes.ts`）。
            一顆按鈕同時說兩件事：我在哪一份裡（名字）、以及上面還有一層（箭頭）。
            分成「一句名字 + 一顆返回」的話，畫面上會多一個沒有人按的按鈕與一句
            沒有人讀的字。

            載入中／出錯時也畫得出來（那時候寫的是 id）：一份打不開的專案正是
            最需要「回去換一個」的時候。

            **會先存檔**（`leaveProject`）——離開這一頁就是離開這張畫布，而這個
            編輯器裡「執行之前先存檔」早就是既有的約定。存不進去就不走，並且說
            為什麼：那時候使用者要看的是被標紅的那顆積木。 */}
        <button
          type="button"
          className="button project-switch"
          onClick={() => void leaveToList()}
          title={t('editor.backToProjects')}
        >
          <ChevronLeft size={14} strokeWidth={2.5} />
          {state.status === 'ready' ? (state.project.meta?.name ?? t('projects.untitled')) : PROJECT_ID}
        </button>
        {state.status === 'ready' && (
          <div className="actions">
            {/* 執行狀態擺在最前面：它講的是「執行」那顆按鈕做出來的事，站在這
                一組的開頭比站在工具列尾端（金鑰後面）更接近它的來源。而且它
                是這一列唯一會長出來又縮回去的東西，放在 `margin-left: auto`
                的那一側，長度變化推的是自己左邊的空白，不是右邊那六顆按鈕。 */}
            <RunStatus />
            {/* 存檔按鈕自己說「現在存了沒有」：乾淨是打勾，有改動是磁片。
                這件事以前寫在工具列最右邊那句「已存檔」上，而它有兩個毛病——
                它離按鈕很遠（中間隔著整排按鈕與金鑰入口），而且它只說得出
                「存過了」，說不出「有東西還沒存」。後者才是要緊的那一半：
                執行與監聽跑的都是**已存檔的那一份**。

                乾淨時是灰的：沒有東西可以存，按下去只是把一份一模一樣的 IR
                再送一次。寬度釘死（見 `index.css`），不然每打一個字整排按鈕
                都會跟著挪一格。 */}
            <button
              type="button"
              className="button button-save"
              onClick={() => executeEditorCommand('editor.save')}
              disabled={saveState.status === 'saving' || running || !dirty}
              title={
                dirty
                  ? t('editor.saveDirtyHelp')
                  : t('editor.saveCleanHelp')
              }
            >
              {saveState.status === 'saving' ? (
                <>
                  <Save size={13} strokeWidth={2.5} /> {t('editor.saving')}
                </>
              ) : dirty ? (
                <>
                  <Save size={13} strokeWidth={2.5} /> {t('editor.save')}
                </>
              ) : (
                <>
                  <Check size={14} strokeWidth={3} /> {t('editor.saved')}
                </>
              )}
            </button>
            {/* 執行與停止是**同一顆**。這兩件事互斥（沒在跑不能停、在跑不能再
                按執行），所以兩顆按鈕之中永遠有一顆是灰的——那顆灰的什麼都不
                說，只是佔著位置讓使用者每次都得先確認自己該按哪一顆。合成一
                顆之後「現在按下去會發生什麼」由它自己的樣子回答。

                位置不會跳：兩顆共用一個 `min-width`（見 `index.css`），所以
                切換時右邊那排不會跟著挪。 */}
            {running ? (
              <button type="button" className="button button-stop" onClick={() => executeEditorCommand('editor.stop')}>
                <Square size={13} strokeWidth={2.5} fill="currentColor" /> {t('editor.stop')}
              </button>
            ) : (
              <button type="button" className="button button-run" onClick={() => executeEditorCommand('editor.run')}>
                <Play size={14} strokeWidth={2.5} fill="currentColor" /> {t('editor.run')}
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
                className={
                  dirty
                    ? 'button button-icon button-listening button-listening-stale'
                    : 'button button-icon button-listening'
                }
                onClick={() => void endListening()}
                aria-label={listeningLabel}
                title={listeningLabel}
              >
                {/* 改過了就在耳朵前面加一顆星（`*耳朵`）——分頁標題上那個
                    「這份檔案還沒存」的記號，同一個約定。

                    排在流裡面而不是絕對定位的角標：`*` 這個字本來就畫在字身
                    的上緣，所以它自己就落在耳朵的左上角，不必去算 top／left
                    ——而角標那種做法在這顆 1.9rem 的按鈕上一定會壓到耳朵的
                    線條。星星本身不是按鈕：這顆耳朵是監聽的開關，讓它在有
                    星星的時候改做別的事，等於同一個位置有兩種結果。 */}
                {dirty && (
                  <span className="listening-stale" aria-hidden="true">
                    *
                  </span>
                )}
                <Ear size={15} strokeWidth={2.5} />
              </button>
            ) : (
              <button
                type="button"
                className="button button-icon"
                onClick={() => void beginListening()}
                aria-label={t('editor.listen')}
                title={t('editor.listenHelp')}
              >
                <Ear size={15} strokeWidth={2.5} />
              </button>
            )}
            {listening.on && listening.webhooks.length > 0 && (
              // 網址不直接攤在工具列上：它是一串 32 位亂碼加路徑，擺出來只會
              // 把整條工具列撐開，而使用者要的是「複製它」而不是「讀它」。
              <button type="button" className="button" onClick={() => setHooksOpen(true)}>
                <Link2 size={13} strokeWidth={2.5} /> {t('webhook.title')}
                <span className="keys-count">{number(listening.webhooks.length)}</span>
              </button>
            )}

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
        {/* 右上角的入口（D28）。**金鑰現在屬於這個專案**（§16 Q23），但這顆
            按鈕仍然在載入中／出錯時進得去——一份打不開的專案很可能正是因為
            某一把金鑰還沒填。 */}
        <PluginActions runtime={pluginRuntime} />
        <KeysEntry
          projectName={state.status === 'ready' ? (state.project.meta?.name ?? undefined) : undefined}
          manifests={manifestsRef.current}
        />
        <SettingsEntry
          historyEnabled={state.status === 'ready'}
          onOpenHistory={() => setHistoryOpen(true)}
          onSave={save}
        />
        {saveState.status === 'error' && (
          <span className="save-status save-status-error">{saveState.message}</span>
        )}
      </header>

      {reloadPending && <div className="plugin-reload" role="alert">{reloadPending}<button className="button" onClick={() => void reloadPlugins()}>{t('editor.reloadPlugins')}</button></div>}
      {rescueMode(window.location.search) && <div className="plugin-reload">{t('editor.rescueMode')}</div>}
      {state.status === 'loading' && <Notice>{t('editor.loadingManifests')}</Notice>}

      {state.status === 'error' && (
        <Notice tone="error">
          <strong>{t('editor.backendUnavailable')}</strong>
          <p>{state.message}</p>
          <p>
            {t('editor.backendStartBefore')} <code>cd backend &amp;&amp; .venv/bin/python -m blockyard.cli serve</code>
            {t('editor.backendStartAfter')}
          </p>
        </Notice>
      )}

      {state.status === 'ready' && (
        <div className="stage">
          <WorkspaceView toolbox={state.toolbox} onReady={handleWorkspaceReady} />
          <FlyoutResizer workspace={workspace} />
          <ToolboxScrollbar workspace={workspace} />
          <ExtensionsEntry />
          {extMenu && (
            <ExtensionMenu
              target={extMenu}
              installed={enabled.has(extMenu.group.id)}
              receipt={receipts.get(extMenu.group.id)}
              onRemove={(group) => {
                closeExtMenu();
                removeExtensionRef.current(group);
              }}
              onUpdate={(group) => {
                closeExtMenu();
                updateExtensionRef.current(group);
              }}
              onExport={(group) => {
                closeExtMenu();
                downloadExtension(group.id);
                setToast(t('extensions.exporting', { name: group.name }));
              }}
              onUninstall={(group) => {
                closeExtMenu();
                uninstallExtensionRef.current(group);
              }}
            />
          )}
          {galleryOpen && (
            <ExtensionsGallery
              groups={state.registration.groups}
              editorPlugins={manifestsRef.current
                .filter((m) => m.editor)
                .map((m) => localizeManifest(m, (m as TranslatableManifest).locales, currentLocale()))
                .map((m) => ({ id: m.id, name: m.name }))}
              disabledPlugins={disabledPlugins}
              pluginProblems={pluginState.problems}
              onTogglePlugin={(id) => void togglePlugin(id)}
              onChanged={setToast}
              onRemove={(group) => removeExtensionRef.current(group)}
              onUninstall={(group) => uninstallExtensionRef.current(group)}
              // **`rebuild: true` 只有這一條路給**：使用者剛按下安裝／更新，
              // 而畫布上那幾顆舊定義建出來的積木要跟著換（§4）。背景那條
              // （切回瀏覽器時重問一次）維持不動畫布。
              //
              // 接回監聽排在重畫**之後**：`beginListening` 會先存檔，而該存的
              // 是更新完的那一份畫布。
              onInstalled={async (id) => {
                const hadEditor = !!manifestsRef.current.find((m) => m.id === id)?.editor;
                await syncExtensions({ rebuild: true });
                await resumeListening();
                if (hadEditor || manifestsRef.current.find((m) => m.id === id)?.editor) {
                  setExtensionEnabled(id, true);
                  setDisabledPlugins(disabledExtensions());
                  await reloadPlugins();
                }
              }}
              confirmUpdate={confirmUpdate}
              // 「這一版少了 `http.head`」是後端說的，「而你正在用它 3 次」只有
              // 這裡數得出來——那份工作區還沒存檔（§4 的差集）。
              countOpcodes={(opcodes) => countOpcodes(opcodes)}
              onGlideTo={(opcode) => glideToOpcode(opcode)}
            />
          )}
          {pausePrompt && (
            <ConfirmDialog
              title={t('editor.pauseUpdateTitle')}
              confirmLabel={t('editor.pauseUpdateAction')}
              cancelLabel={t('common.cancel')}
              onConfirm={() => void acceptPause()}
              onCancel={() => {
                const resolve = pausePrompt.resolve;
                setPausePrompt(null);
                resolve(false);
              }}
            >
              <p>{t('editor.pauseUpdateHats', {
                id: pausePrompt.extId,
                count: number(pausePrompt.hats.length),
                blocks: list(pausePrompt.hats
                  .map((opcode) => blockTextOf(state, opcode) ?? opcode)),
              })}</p>
              <p>{t('editor.pauseUpdateReason')}</p>
              <p>{t('editor.pauseUpdateEffect')}</p>
            </ConfirmDialog>
          )}
          {uninstalling && (
            <UninstallConfirm
              name={uninstalling.name}
              extId={uninstalling.id}
              version={uninstalling.version}
              receipt={receipts.get(uninstalling.id)}
              used={0}
              busy={uninstallBusy}
              error={uninstallError}
              onConfirm={() => void confirmUninstall(uninstalling)}
              onCancel={() => setUninstalling(null)}
            />
          )}
          <PluginPanels runtime={pluginRuntime} />
          <RunBubbles workspace={workspace} />
          <JsonParsePrompts workspace={workspace} ctx={state.ctx} />
          {/* 分頁列上那幾格是**宣告**出來的：已啟用的包的 `panels`。它們與
              「執行時畫出來的那些」是兩本帳（身分不同），在 `RunPanel` 併起來。 */}
          <RunPanel
            declared={(rescueMode(window.location.search) ? [] : state.registration.groups)
              .filter((g) => !isRemovable(g) || enabled.has(g.id))
              .flatMap((g) =>
                g.panels.map((p) => ({
                  extId: g.id,
                  panelId: p.id,
                  name: p.name,
                  entry: p.entry,
                })),
              )}
          />
          {toast !== null && <Toast text={toast} onDismiss={() => setToast(null)} />}
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
  const text = count === null ? '' : number(count);
  // 帽子那道弧固定 96 寬，所以 112 是它撐得住的最小身體。空的跟一兩位數都落
  // 在這個下限上——這正是「按下耳朵不會位移」的來源。三位數以上才加寬，不加
  // 的話數字會壓到下緣那個 notch 上。
  const bodyWidth = Math.max(112, 64 + text.length * 24);
  // 「開著但一顆都沒有」那句話（`listeningStateOf` 的 message）搬進 tooltip：
  // 工具列上它只需要是一個 0，但「按了為什麼沒反應」的答案不能因此消失。
  const label =
    count === null
      ? t('editor.notListening')
      : hint
        ? t('editor.listeningHint', { hint })
        : t('editor.listeningCount', { count: text });
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

function RunStatus() {
  const status = useRunStore((s) => s.status);
  const message = useRunStore((s) => s.message);
  if (status === 'idle') return null;
  return (
    <span className={`run-status run-status-${status}`}>
      {runStatusLabel(status)}
      {status === 'error' && message ? `：${message}` : ''}
    </span>
  );
}

function runStatusLabel(status: string): string {
  switch (status) {
    case 'starting': return t('run.status.starting');
    case 'running': return t('run.status.running');
    case 'ok': return t('run.status.ok');
    case 'error': return t('run.status.error');
    case 'cancelled': return t('run.status.cancelled');
    default: return status;
  }
}

function Notice({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return <div className={tone === 'error' ? 'notice notice-error' : 'notice'}>{children}</div>;
}

/**
 * 一個 opcode 在積木上長什麼樣子。認不得就回 `null`。
 *
 * 對話框上要說的是使用者看得到的那句話（`當 Discord 收到訊息 (message)`），
 * 不是 `discord.message`——後者是我們的字彙，不是他的。
 */
function blockTextOf(state: State, opcode: string): string | null {
  if (state.status !== 'ready') return null;
  return state.registration.blocks.find((b) => b.type === opcode)?.spec.text ?? null;
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
      // scheme 已經在 manifest 的載入期擋過（http(s) 或站內 docs），這裡再擋一次：
      // `window.open` 是真的會執行 `javascript:` 的地方，而縱深防禦的成本是
      // 一行。站內路徑只收 `/docs/`，`//host` 這種 protocol-relative URL 不會通過。
      if (button.url && (/^https?:\/\//.test(button.url) || button.url.startsWith('/docs/'))) {
        window.open(button.url, '_blank', 'noopener,noreferrer');
      }
      return;
    default:
      // 只剩 `call`（§7.3 的 @button）：它要打後端，而目前沒有包宣告得出來。
      // 一句誠實的「還沒接上」而不是一個假的成功。
      console.warn(`[blockyard] 按鈕動作 ${button.action} 還沒接上`);
  }
}

const EDIT_MENU_ID = 'blockyard_procedure_edit';
const DELETE_MENU_ID = 'blockyard_procedure_delete';

/**
 * 這一顆積木右鍵按得出「編輯這個積木…」嗎？
 *
 * 兩個地方按得出來：畫布上的**定義帽子**，以及**工具箱裡那顆 `呼叫 X`**——
 * 後者是使用者每天看得到這個函式的地方（定義帽子可能捲在畫布的另一頭，
 * 甚至還沒被找到），而右鍵是這個編輯器裡「對著東西本人動它」的手勢。
 *
 * 畫布上的呼叫積木**不接**：那裡右鍵的主詞是「我按到的這一顆」，而這個項目
 * 改的是別的地方那份定義——一個手勢兩個主詞，比少一個入口更難懂。
 */
function editableProcedureBlock(block: Blockly.BlockSvg): boolean {
  if (isDefinitionType(block.type)) return true;
  return block.isInFlyout && isCallType(block.type);
}

/**
 * 「編輯這個積木」：定義帽子與工具箱裡呼叫積木的右鍵選單（見
 * `editableProcedureBlock`）。
 *
 * `procedure.definition#p_x`／`procedure.call#p_x` 的 proc id 嵌在 Blockly 的
 * type 字串裡（`procedures.ts`），所以選單不需要另外一份對照表。
 */
function registerEditMenu(ref: React.RefObject<(procId: string) => void>): () => void {
  const registry = Blockly.ContextMenuRegistry.registry;
  if (registry.getItem(EDIT_MENU_ID)) registry.unregister(EDIT_MENU_ID);

  registry.register({
    id: EDIT_MENU_ID,
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: 5,
    preconditionFn: (scope) =>
      scope.block && editableProcedureBlock(scope.block) ? 'enabled' : 'hidden',
    displayText: () => t('procedure.editMenu'),
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
    displayText: () => t('procedure.deleteMenu'),
    callback: (scope) => {
      const procId = scope.block ? procIdFromType(scope.block.type) : null;
      if (procId) ref.current(procId);
    },
  });

  return () => registry.unregister(DELETE_MENU_ID);
}

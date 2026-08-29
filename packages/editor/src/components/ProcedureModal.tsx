/**
 * 「創建積木」對話框（§8.5、D25、D26）。
 *
 * 版面照 Scratch 的 Make a Block：上半是一顆**可以直接在上面打字的預覽積木**，
 * 下半是三顆新增按鈕與回傳值設定。建立與編輯是同一個對話框——按鈕開的是建立，
 * 定義積木的右鍵開的是編輯。
 *
 * **文字的真相在積木上，結構的真相在 `draft` 裡。** 每個按鍵都回寫 state 會讓
 * 預覽積木重建，而重建就是把使用者正在編輯的欄位關掉；所以只有結構要變（加
 * 一格、刪一格、換型別、改回傳值、按確定）之前才回讀一次欄位。這是這個檔案
 * 唯一一條不直觀的規則，`mutate` 把它收在一個地方。
 *
 * 確定之前**什麼都還沒發生**：沒有註冊型別、沒有積木上畫布、`procedures` 一
 * 個字都沒改。取消就是關掉——這正是 D25 把建立入口從「拖一顆出來」改成按鈕
 * 換到的東西（拖出來的作法中間會存在一個「還沒有名字的函式」）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Blockly from 'blockly/core';
import { ChevronLeft, ChevronRight, Trash2, X } from 'lucide-react';
import { blockyTheme } from '../blockly/theme';
import {
  DECLARATION_TYPE,
  buildDeclaration,
  defineDeclarationShadows,
  readSegmentTexts,
  segmentIndexAt,
  segmentRect,
} from '../blockly/declaration';
import {
  addLabel,
  addParam,
  applyTexts,
  blankDraft,
  draftIssue,
  fromProcedure,
  isParam,
  moveSegment,
  removeSegment,
  segmentActions,
  setSegmentType,
  toProcedure,
  type Draft,
  type ParamType,
} from '../procedures/draft';
import { focusableIn, modalKeyAction, nextFocusIndex } from './modalKeys';
import type { Procedure, Returns } from '../types/project';

export interface ProcedureDialogTarget {
  /** 既有函式的 id；建立時是 `null`。 */
  id: string | null;
  procedure?: Procedure;
}

interface Props {
  target: ProcedureDialogTarget;
  onCancel: () => void;
  onSubmit: (proc: Pick<Procedure, 'name' | 'params' | 'returns'>) => void;
}

/**
 * 六種型別，一套說法。
 *
 * 回傳值的下拉與參數的右鍵用**同一份**：使用者沒有理由在兩個地方看到兩套詞。
 * 預設 `any`（「任何值」）：型別只改靜態檢查的嚴格度（§8.5 的警告只標「執行期
 * 一定會炸」的組合），不知道就別誤報。
 */
const VALUE_TYPES: { value: ParamType; label: string }[] = [
  { value: 'any', label: '任何值' },
  { value: 'number', label: '數字' },
  { value: 'string', label: '文字' },
  { value: 'boolean', label: '是非' },
  { value: 'list', label: '清單' },
  { value: 'object', label: '物件' },
];

const WORKSPACE_OPTIONS: Partial<Blockly.BlocklyOptions> = {
  renderer: 'zelos',
  theme: blockyTheme,
  media: 'media/',
  sounds: false,
  trashcan: false,
  // 預覽區沒有工具箱、不捲動、不縮放：裡面只有一顆積木，而它不能被拖走。
  move: { drag: false, wheel: false, scrollbars: false },
  zoom: { startScale: 0.75, controls: false, wheel: false },
};

export function ProcedureModal({ target, onCancel, onSubmit }: Props) {
  const [draft, setDraft] = useState<Draft>(() =>
    target.procedure ? fromProcedure(target.procedure) : blankDraft(),
  );
  const hostRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  /** 浮動工具列的定位原點。它畫在預覽區的**上緣之外**，所以 wrap 不能裁切。 */
  const wrapRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const blockRef = useRef<Blockly.BlockSvg | null>(null);
  /** 使用者現在點進了第幾段（`null` = 沒有），浮動工具列貼著它。 */
  const [active, setActive] = useState<number | null>(null);
  const [toolbarAt, setToolbarAt] = useState<{ left: number; top: number } | null>(null);
  // 右鍵選單註冊一次就好，但它要呼叫到**當下**的 draft，所以走 ref。
  const menuRef = useRef<{ draft: Draft; mutate: (fn: (d: Draft) => Draft) => void }>(null!);

  /**
   * 改結構之前先把積木上的字讀回來，不然「打了名字又按下添加輸入方塊」會把
   * 剛打的字丟掉——那是最容易踩到的一種資料遺失，因為使用者不會覺得自己做錯
   * 了什麼。
   */
  const mutate = useCallback((fn: (draft: Draft) => Draft) => {
    setDraft((current) => {
      const block = blockRef.current;
      const synced = block ? applyTexts(current, readSegmentTexts(block, current)) : current;
      return fn(synced);
    });
  }, []);

  menuRef.current = { draft, mutate };

  // 工作區只建一次。React 的 render 與 Blockly 是兩套東西（§8.2），
  // workspace 不進 state。
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    defineDeclarationShadows();
    // **`inject` 會把「主工作區」換成這一個。** `Blockly.common` 只記一個
    // `mainWorkspace`，最後 inject 的那個就是它——於是對話框開著的時候
    // `getMainWorkspace()` 回的是這顆迷你工作區，而關掉之後它指向一個**已經
    // dispose 的**工作區（`dispose()` 不會把它還回去）。實測都重現了。
    //
    // 現在還沒有人讀 `getMainWorkspace()`，但 Blockly 自己的很多預設路徑會
    // （右鍵選單、鍵盤快捷鍵、`Blockly.serialization` 的預設參數），所以這是
    // 一顆埋著的地雷而不是一件小事。開之前記下來，關的時候還回去。
    const previousMain = Blockly.common.getMainWorkspace();
    const workspace = Blockly.inject(host, WORKSPACE_OPTIONS);
    workspaceRef.current = workspace;
    // 預覽區會跟著對話框寬度變（視窗縮放、捲軸出現），而「置中」是一個相對
    // 於視野的位置——量完新的視野就要重算一次，不然積木會偏。
    const observer = new ResizeObserver(() => {
      Blockly.svgResize(workspace);
      if (blockRef.current) centerPreview(workspace, blockRef.current);
      // 積木移動了，貼著它的工具列也要跟上（它的位置是量出來的）。
      repositionRef.current();
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      workspace.dispose();
      // `Workspace` 沒有 `isDisposed`，但 `dispose()` 會把自己從全域註冊表裡
      // 移掉——查得到就是還活著。
      if (previousMain && Blockly.Workspace.getById(previousMain.id)) {
        Blockly.common.setMainWorkspace(previousMain);
      }
      workspaceRef.current = null;
      blockRef.current = null;
    };
  }, []);

  // 結構變了就重建那顆積木。`draft` 的 identity 只在結構真的變了才換，所以
  // 這條 effect 不會在打字時跑。
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const built = buildDeclaration(draft);
    workspace.clear();
    const block = Blockly.serialization.blocks.append(
      built.state,
      workspace,
    ) as Blockly.BlockSvg;
    // 它是一份宣告，不是畫布上的積木：拖不走、刪不掉，也沒有人會把它存進 IR。
    block.setMovable(false);
    block.setDeletable(false);
    blockRef.current = block;
    centerPreview(workspace, block);
  }, [draft]);

  useEffect(() => registerSegmentMenu(menuRef), []);

  /**
   * 工具列貼在那一格的正上方。位置**量出來**（§8.5）：`segmentRect` 給的是
   * viewport 座標，減掉 wrap 的原點就是這一層的座標——用 `absolute` 而不是
   * `fixed`，是因為對話框自己會在背景那一層捲動，而 `fixed` 不跟著捲。
   *
   * 這條 effect 宣告在重建那顆積木的 effect **後面**：兩條都吃 `draft`，而
   * effect 照宣告順序跑，量的必須是重建之後的積木。
   */
  const reposition = useCallback(() => {
    const block = blockRef.current;
    const wrap = wrapRef.current;
    const rect = active !== null && block ? segmentRect(block, draft, active) : null;
    if (!rect || !wrap) {
      setToolbarAt(null);
      return;
    }
    const origin = wrap.getBoundingClientRect();
    setToolbarAt({ left: rect.left + rect.width / 2 - origin.left, top: rect.top - origin.top });
  }, [active, draft]);

  const repositionRef = useRef<() => void>(() => {});
  repositionRef.current = reposition;
  useEffect(() => reposition(), [reposition]);

  /**
   * 「點進哪一格」靠的是 pointerdown，不是欄位編輯器的生命週期。
   *
   * 兩個理由：Blockly 沒有「哪一格的編輯器開了」這種事件（`Events.CLICK` 的
   * `targetType` 沒有 field），而使用者的動作本來就是**點**——同一下 pointer
   * 既打開欄位編輯器也選中這一格，不必兩邊對時。
   *
   * 兩個例外要放行，不然工具列會在自己被用到的那一刻消失：點在 `WidgetDiv`
   * 裡（那是這一格正開著的編輯器），以及點在工具列自己身上。
   */
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (toolbarRef.current?.contains(target)) return;
      if (Blockly.WidgetDiv.getDiv()?.contains(target)) return;
      const block = blockRef.current;
      setActive(block ? segmentIndexAt(block, target) : null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  const issue = draftIssue(draft);
  const submit = useCallback(() => {
    const block = blockRef.current;
    const synced = block ? applyTexts(draft, readSegmentTexts(block, draft)) : draft;
    const problem = draftIssue(synced);
    if (problem) {
      setDraft(synced);
      return;
    }
    onSubmit(toProcedure(synced));
  }, [draft, onSubmit]);

  /**
   * 鍵盤路徑（§8.5）：Esc 關、Enter 確定、Tab 走不出對話框。
   *
   * 掛在 `document` 上而不是對話框那個 div 上：這是一個 modal，它要接的是
   * 「現在這一刻的鍵盤」，而焦點可能落在 Blockly 畫出來的東西上——那些不在
   * React 管的樹裡。該不該接由 `modalKeyAction` 判斷（欄位編輯器開著時一個
   * 鍵都不接：那一刻 Esc 與 Enter 是 Blockly 的）。
   *
   * **capture 是必要的，不是保險。** 實測：欄位編輯器開著時按 Esc，Blockly
   * 先收掉 `WidgetDiv`，等到 bubble 這一輪 `isVisible()` 已經是 false——於是
   * 「Esc 只關掉這一格」變成「Esc 關掉整個對話框，而使用者剛打的字全沒了」。
   * 問的是「現在」的狀態，就得在 Blockly 改它之前問。FieldText 的
   * autocomplete 也 capture 在 `document` 上，但它是欄位打開時才註冊的，晚於
   * 這一條——同一個元素上的 capture 依註冊順序，所以這一條一定先跑，而它在
   * 編輯中一律放行。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const action = modalKeyAction({
        key: event.key,
        shiftKey: event.shiftKey,
        editing: Blockly.WidgetDiv.isVisible(),
        inWorkspace: target !== null && hostRef.current?.contains(target) === true,
        target: target ? target.tagName.toLowerCase() : null,
      });
      if (action === null) return;
      event.preventDefault();
      if (action === 'cancel') onCancel();
      else if (action === 'submit') submit();
      else moveFocus(dialogRef.current, action === 'focus-prev');
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel, submit]);

  // 開啟時焦點進到對話框裡。沒有這一下，Tab 的第一下是從頁面上某個看不見的
  // 地方開始的，而 focus trap 只在焦點已經在裡面時才成立。
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const moveActive = (delta: number) => {
    if (active === null) return;
    const at = active;
    mutate((d) => moveSegment(d, at, delta));
    // 工具列跟著那一段走：連按兩下左移，要把同一格再往左推一格。
    setActive(at + delta);
  };

  const removeActive = () => {
    if (active === null) return;
    const at = active;
    mutate((d) => removeSegment(d, at));
    // 刪掉之後那一格不存在了。讓後面的一段遞補進工具列，等於把「再按一次」
    // 變成刪掉一段沒被指名的東西——收起來比較誠實。
    setActive(null);
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="建立一個積木"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="modal-head">
          <h2>{target.id ? '編輯積木' : '建立一個積木'}</h2>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="關閉">
            <X size={16} strokeWidth={2.5} />
          </button>
        </header>

        <div className="modal-preview-wrap" ref={wrapRef}>
          <div className="modal-preview" ref={hostRef} />
          {toolbarAt && active !== null && (
            <SegmentToolbar
              ref={toolbarRef}
              at={toolbarAt}
              actions={segmentActions(draft, active)}
              onMove={moveActive}
              onRemove={removeActive}
            />
          )}
        </div>

        <div className="modal-adders">
          <AdderButton
            label="添加輸入方塊"
            sub="數字或文字"
            shape="round"
            onClick={() => mutate((d) => addParam(d, 'any'))}
          />
          <AdderButton
            label="添加輸入方塊"
            sub="布林值"
            shape="hex"
            onClick={() => mutate((d) => addParam(d, 'boolean'))}
          />
          <AdderButton
            label="添加說明文字"
            sub="text"
            shape="text"
            onClick={() => mutate(addLabel)}
          />
        </div>

        <label className="modal-returns">
          <input
            type="checkbox"
            checked={draft.returns != null}
            onChange={(e) => mutate((d) => ({ ...d, returns: e.target.checked ? 'any' : null }))}
          />
          這個積木會回傳值
        </label>
        {draft.returns != null && (
          <label className="modal-return-type">
            回傳
            <select
              value={draft.returns}
              onChange={(e) => mutate((d) => ({ ...d, returns: e.target.value as Returns }))}
            >
              {VALUE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <p className="modal-hint">
          {/* §8.5 的那條分工，寫成一句話：文字在積木上、位置與存在在浮動列、
              型別在右鍵。 */}
          {issue ?? '在積木上直接打字改名字；點一格會浮出移動與刪除，按右鍵可以換型別。'}
        </p>

        <footer className="modal-foot">
          <button type="button" className="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="button button-run" onClick={submit} disabled={!!issue}>
            確定
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * 把預覽積木擺在預覽區的正中間。
 *
 * 量的是**畫出來的外框**（`getBoundingRectangle`）而不是積木的 XY：帽子形狀
 * 的積木左上角不等於它的原點，照 XY 算會偏掉半個帽子。算完只 `moveBy` 差值，
 * 所以這個函式重複呼叫是安全的（重建之後、預覽區改寬之後各叫一次）。
 */
function centerPreview(workspace: Blockly.WorkspaceSvg, block: Blockly.BlockSvg): void {
  const view = workspace.getMetricsManager().getViewMetrics(true);
  if (!view.width || !view.height) return;
  const rect = block.getBoundingRectangle();
  const dx = view.left + (view.width - (rect.right - rect.left)) / 2 - rect.left;
  const dy = view.top + (view.height - (rect.bottom - rect.top)) / 2 - rect.top;
  block.moveBy(dx, dy);
}

/**
 * 分段的浮動工具列（§8.5）：左移、刪除、右移。
 *
 * 它補的是兩個洞——**順序原本做不到**（只能刪掉再加，而新的一段永遠排到最
 * 後）、**刪除原本看不見**（唯一的入口是右鍵，而使用者沒有理由知道預覽積木
 * 上有右鍵選單）。順帶修掉第三件：「哪一格」原本是隱含的，工具列貼著它。
 *
 * **按鈕綁 `pointerdown` 並 `preventDefault()`**。工具列開在欄位編輯器開著的
 * 時候，而 Blockly 的 `WidgetDiv` 是靠焦點活著的（實測：它只掛 focusin /
 * focusout）——一般的按鈕會先把焦點搶走，於是「點按鈕」變成「把欄位關掉」，
 * 那一下再也到不了按鈕。`preventDefault` 讓瀏覽器根本不移動焦點。代價是
 * `click` 不會發生（pointerdown 的預設行為裡包含後續的滑鼠事件），所以動作
 * 只能掛在 pointerdown 上。**這條依賴 Blockly 的內部作法，換版時要複驗。**
 */
/**
 * 三顆按鈕共用一組尺寸。
 *
 * lucide 是 Feather 那一系的細線條，而 zelos / Scratch 這套是粗胖圓角的——用
 * 預設的 `strokeWidth: 2` 畫在 24px 上會顯得單薄。壓成 16px、線寬 2.25 之後，
 * 垃圾桶與 chevron 的**視覺重量**才跟旁邊的積木對得起來。
 */
const ICON = { size: 16, strokeWidth: 2.25 } as const;

const SegmentToolbar = ({
  ref,
  at,
  actions,
  onMove,
  onRemove,
}: {
  ref: React.RefObject<HTMLDivElement | null>;
  at: { left: number; top: number };
  actions: { left: boolean; remove: boolean; right: boolean };
  onMove: (delta: number) => void;
  onRemove: () => void;
}) => (
  <div className="segment-toolbar" ref={ref} style={{ left: at.left, top: at.top }}>
    {/* 端點的箭頭**不畫**而不是畫成灰色：三個圖示的一列裡，一個灰掉的箭頭
        讀起來像壞了（§8.5）。 */}
    {actions.left && (
      <SegmentButton label="往左移一格" onPress={() => onMove(-1)}>
        <ChevronLeft {...ICON} />
      </SegmentButton>
    )}
    {actions.remove && (
      <SegmentButton label="刪掉這一格" onPress={onRemove}>
        <Trash2 {...ICON} />
      </SegmentButton>
    )}
    {actions.right && (
      <SegmentButton label="往右移一格" onPress={() => onMove(1)}>
        <ChevronRight {...ICON} />
      </SegmentButton>
    )}
  </div>
);

function SegmentButton({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="segment-button"
      aria-label={label}
      title={label}
      // 滑鼠專用：它只在使用者點進一格時存在，而那一刻焦點是欄位的。放進
      // Tab 順序等於讓 focus trap 繞經一排隨時會消失的按鈕。
      tabIndex={-1}
      onPointerDown={(event) => {
        event.preventDefault();
        onPress();
      }}
    >
      {children}
    </button>
  );
}

/**
 * focus trap 的 DOM 那一半（算術在 `modalKeys.ts`）。
 *
 * 焦點在預覽工作區裡（Blockly 的東西不在清單裡，見 `focusableIn`）時
 * `current` 是 −1，於是 Tab 落到第一個控制項、Shift+Tab 落到最後一個——與
 * 「從對話框外面 Tab 進來」同一條規則。
 */
function moveFocus(root: HTMLElement | null, backwards: boolean): void {
  if (!root) return;
  const items = focusableIn(root);
  const current = items.findIndex((el) => el === document.activeElement);
  const next = items[nextFocusIndex(items.length, current, backwards)];
  next?.focus();
}

function AdderButton({
  label,
  sub,
  shape,
  onClick,
}: {
  label: string;
  sub: string;
  shape: 'round' | 'hex' | 'text';
  onClick: () => void;
}) {
  return (
    <button type="button" className="modal-adder" onClick={onClick}>
      <span className={`modal-adder-icon modal-adder-${shape}`}>{shape === 'text' ? sub : ''}</span>
      <span className="modal-adder-label">{label}</span>
      <span className="modal-adder-sub">{sub}</span>
    </button>
  );
}

/**
 * 右鍵選單上「改成⋯」的那幾項。
 *
 * 六種都列（目前是這一格的那一項會自己隱藏）。只有 `boolean` 會改變畫面——
 * 六角形孔；其餘只改靜態檢查的嚴格度與影子的樣子。三顆新增按鈕維持 Scratch
 * 的兩顆，因為**形狀只有兩種**；細分是這裡的事。
 */
const TYPE_ITEMS = VALUE_TYPES;

const MENU_PREFIX = 'blocky_declaration_';

/**
 * 預覽積木上的右鍵選單：刪掉這一格、換型別。
 *
 * 與 `literals.ts` / `FieldText` 同一招——`ContextMenuRegistry` 的 scope 只給
 * 得出**積木**，但 `preconditionFn` 拿得到開啟選單的原始事件，而 precondition
 * 一定跑在 displayText 與 callback 之前。
 *
 * 註冊一次、由 ref 讀到當下的 draft：選單項目是全域註冊表裡的東西，跟著每次
 * render 重新註冊會在 Blockly 的註冊表上留下垃圾。
 */
function registerSegmentMenu(
  ref: React.RefObject<{ draft: Draft; mutate: (fn: (d: Draft) => Draft) => void }>,
): () => void {
  const registry = Blockly.ContextMenuRegistry.registry;
  let index: number | null = null;

  const scopeIndex = (scope: { block?: Blockly.BlockSvg }, event: Event): number | null => {
    const block = scope.block;
    // 只在對話框那顆積木上出現：這些項目在畫布上沒有意義。
    if (!block || block.type !== DECLARATION_TYPE) return null;
    return segmentIndexAt(block, event.target);
  };

  const ids: string[] = [];
  const register = (item: Blockly.ContextMenuRegistry.RegistryItem) => {
    if (registry.getItem(item.id)) registry.unregister(item.id);
    registry.register(item);
    ids.push(item.id);
  };

  register({
    id: `${MENU_PREFIX}remove`,
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: 10,
    preconditionFn: (scope, event) => {
      index = scopeIndex(scope, event);
      if (index === null) return 'hidden';
      // 最後一段刪掉就沒有積木了。留著它比讓使用者做出一顆沒有名字的積木好。
      return ref.current.draft.segments.length > 1 ? 'enabled' : 'hidden';
    },
    displayText: () => '刪掉這一格',
    callback: () => {
      const at = index;
      if (at !== null) ref.current.mutate((d) => removeSegment(d, at));
    },
  });

  TYPE_ITEMS.forEach((item, i) => {
    register({
      id: `${MENU_PREFIX}type_${item.value}`,
      scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
      weight: 11 + i,
      preconditionFn: (scope, event) => {
        index = scopeIndex(scope, event);
        const segment = index === null ? null : ref.current.draft.segments[index];
        if (!segment || !isParam(segment)) return 'hidden';
        // 目前就是這個型別的話不列——「改成是非」出現在一格布林上只是雜訊。
        return segment.type === item.value ? 'hidden' : 'enabled';
      },
      displayText: () => `改成 ${item.label}`,
      callback: () => {
        const at = index;
        if (at !== null) ref.current.mutate((d) => setSegmentType(d, at, item.value));
      },
    });
  });

  return () => ids.forEach((id) => registry.unregister(id));
}

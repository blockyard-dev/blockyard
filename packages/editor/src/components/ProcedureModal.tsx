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
import { blockyTheme } from '../blockly/theme';
import {
  DECLARATION_TYPE,
  buildDeclaration,
  defineDeclarationShadows,
  readSegmentTexts,
  segmentIndexAt,
} from '../blockly/declaration';
import {
  addLabel,
  addParam,
  applyTexts,
  blankDraft,
  draftIssue,
  fromProcedure,
  isParam,
  removeSegment,
  setSegmentType,
  toProcedure,
  type Draft,
  type ParamType,
} from '../procedures/draft';
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
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const blockRef = useRef<Blockly.BlockSvg | null>(null);
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
    const observer = new ResizeObserver(() => Blockly.svgResize(workspace));
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
    block.moveBy(24, 24);
    blockRef.current = block;
  }, [draft]);

  useEffect(() => registerSegmentMenu(menuRef), []);

  const issue = draftIssue(draft);
  const submit = () => {
    const block = blockRef.current;
    const synced = block ? applyTexts(draft, readSegmentTexts(block, draft)) : draft;
    const problem = draftIssue(synced);
    if (problem) {
      setDraft(synced);
      return;
    }
    onSubmit(toProcedure(synced));
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label="建立一個積木">
        <header className="modal-head">
          <h2>{target.id ? '編輯積木' : '建立一個積木'}</h2>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="關閉">
            ×
          </button>
        </header>

        <div className="modal-preview" ref={hostRef} />

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
          {issue ?? '在積木上直接打字改名字；在一格上按右鍵可以刪掉它或換型別。'}
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

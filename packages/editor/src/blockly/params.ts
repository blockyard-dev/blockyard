/**
 * 定義帽子上的參數：**拖一下就有一份**（§4.6）。
 *
 * 第四輪實測回饋的原話是「我希望是這樣可以拖出來的，而不是 取得(變數)」，
 * 附的是 Scratch 定義積木的圖——參數就掛在帽子上，而拖出來的是**同一顆光禿禿
 * 的膠囊**（Scratch 的 `argument_reporter_string_number`），不是一顆
 * `取得 (名稱)`。
 *
 * 所以帽子上那顆與拖出來那顆是**同一個型別**（`procedure.param#<proc>.<param>`，
 * 見 `procedures.ts`）：使用者看到的與拿到的一模一樣，中間沒有變形。差別只有
 * 帽子上那顆
 *
 * - **拖它等於複製**：覆寫 `BlockDragStrategy.getTargetBlock()`。它的 JSDoc 寫
 *   的正是「*This may create and return a newly instantiated block when e.g.
 *   dragging from a flyout*」——flyout 的「拖出去等於複製一份」就是這個掛勾。
 *   回傳一顆新造的同型積木，帽子上那顆就留在原地。
 * - **刪不掉**（`deletable: false`），與定義帽子本身同一個理由。
 * - **不進 IR**：`procedures[].params` 已經是那份資料的唯一來源，帽子的孔是
 *   畫面不是內容（`ir/serialize.ts`、`signature.ts::definitionText`）。
 *
 * 它必須是**真的積木**（`BlockSvg`）：欄位掛不上 drag strategy，而影子不可
 * 拖曳（`getTargetBlock` 對影子的處理是回傳它的父積木）。
 */
import * as Blockly from 'blockly/core';
import { definitionType, isParamType, paramRefFromType, paramType } from './procedures';
import { paramsOf } from './signature';
import type { Procedure } from '../types/project';

/**
 * 拖它 = 複製一份。
 *
 * `startDrag` 的第一件事就是 `const alternateTarget = this.getTargetBlock();
 * if (alternateTarget !== this.block) return alternateTarget.startDrag(e);`
 * ——所以回傳一顆別的積木，整個拖曳就改為作用在它身上，而 `Dragger` 會重新
 * 從它讀 `startLoc`。把新積木放在原來的位置，手感就與「直接拖走它」一樣。
 *
 * 複製品是**乾淨的**：`deletable` 回到 true，也沒有這個 strategy（它是我們在
 * `fillDefinitionParams` 裡逐顆掛上去的，不是型別的一部分）——不然拖出來那顆
 * 也會變成拖不走、只能再複製。
 *
 * 父類別的 `block` 是 private，所以自己留一份 `source`。
 */
class CopyOnDragStrategy extends Blockly.dragging.BlockDragStrategy {
  constructor(private readonly source: Blockly.BlockSvg) {
    super(source);
  }

  protected override getTargetBlock(): Blockly.BlockSvg {
    const workspace = this.source.workspace as Blockly.WorkspaceSvg;
    const copy = Blockly.serialization.blocks.append(
      { type: this.source.type },
      workspace,
    ) as Blockly.BlockSvg;
    copy.moveTo(this.source.getRelativeToSurfaceXY());
    return copy;
  }
}

/**
 * 定義帽子拖到垃圾桶 = 走與右鍵「刪除這個積木…」**同一條規則**。
 *
 * 帽子是 `deletable: false` 的（`procedures.ts` 的 `UNDELETABLE_EXTENSION`），
 * 所以 Blockly 自己永遠不會刪掉它——那是刻意的，刪掉定義同時要刪掉那筆
 * `procedures`，而「還有人在用就不准刪」需要一個講得出理由的地方。
 *
 * 代價是拖進垃圾桶**什麼事都不會發生**（實測回饋第 1 條）：`DeleteArea.wouldDelete`
 * 問的是 `block.isDeletable()`，false 就不算刪除；而 `DragTarget.shouldPreventMove`
 * 預設回 false，於是那顆積木就**停在垃圾桶上面**——最糟的一種回饋，因為它看起來
 * 像成功了。
 *
 * 所以自己接：`endDrag` 時看指標底下是不是一個 DELETE_AREA，是的話先把積木退回
 * 原位（規則可能說「不准刪」，而那時候它不該留在垃圾桶上），再把決定權交給
 * `onTrash`——也就是右鍵那條路的同一個函式。
 *
 * 唯一還缺的是垃圾桶的開蓋動畫：`Trashcan.onDragOver` 開不開蓋看的也是
 * `wouldDelete_`。純視覺，記在 PROGRESS 第 2 節。
 */
class TrashAwareDragStrategy extends Blockly.dragging.BlockDragStrategy {
  constructor(
    private readonly source: Blockly.BlockSvg,
    private readonly onTrash: () => void,
  ) {
    super(source);
  }

  override endDrag(
    e: PointerEvent | KeyboardEvent | undefined,
    disposition: Blockly.DragDisposition,
  ): void {
    if (e instanceof PointerEvent && this.overDeleteArea(e)) {
      this.revertDrag();
      super.endDrag(e, Blockly.DragDisposition.REVERT);
      this.onTrash();
      return;
    }
    super.endDrag(e, disposition);
  }

  private overDeleteArea(e: PointerEvent): boolean {
    const workspace = this.source.workspace as Blockly.WorkspaceSvg;
    const target = workspace.getDragTarget(
      new Blockly.utils.Coordinate(e.clientX, e.clientY),
    );
    if (!target) return false;
    return workspace
      .getComponentManager()
      .hasCapability(target.id, Blockly.ComponentManager.Capability.DELETE_AREA);
  }
}

/**
 * 帽子上那顆，而不是使用者自己拖出來的那顆。
 *
 * 用「刪不掉」認人：兩者是同一個型別，而 `deletable: false` 是我們只掛在帽子
 * 那顆上的記號。認錯了就會去動使用者的積木。
 */
function isChip(block: Blockly.Block): boolean {
  return isParamType(block.type) && !block.isDeletable();
}

/**
 * 一顆 `procedure.param#` 積木「是帽子上那顆」需要的兩件事。
 *
 * 拆出來是因為**它有第二個呼叫端**：undo 把定義帽子放回來時，孔裡那幾顆是從
 * 序列化狀態長出來的——型別對、位置對、`deletable: false` 也跟著回來了
 * （`blocks.save` 存得下它），但**拖曳策略存不下來**。少了它那顆膠囊看起來
 * 完全正常，拖一下卻是把它從帽子上扯下來，而不是複製一份。
 *
 * 所以「怎麼才算一顆晶片」只能有一個地方知道，新建與修復共用它。
 */
function makeChip(block: Blockly.Block): void {
  block.setDeletable(false);
  // 無畫面的工作區（測試、`ir/roundtrip`）沒有 SVG 也沒有拖曳——那兩件事
  // 只有 `BlockSvg` 有。序列化那一半在兩邊完全相同，這正是要驗的東西。
  if (block instanceof Blockly.BlockSvg) block.setDragStrategy(new CopyOnDragStrategy(block));
}

/**
 * 把每個定義帽子的孔填滿，並清掉被擠出來的那顆。
 *
 * 冪等：已經填好的孔不動它（重填會換掉積木 id，而使用者可能正拖著它）。載入
 * 完、建立／編輯函式之後、以及積木移動時（`watchDefinitionParams`）都會跑。
 */
export function fillDefinitionParams(
  workspace: Blockly.Workspace,
  procedures: Record<string, Procedure>,
  onTrash?: (procId: string) => void,
): void {
  // 被擠出來的那顆（使用者把別的積木丟進參數的孔）。它是 `deletable: false`
  // 的——不收掉的話畫布上就留下一顆刪不掉的孤兒，而下面的補孔又會再生一顆。
  //
  // **只收 `procedures` 裡那幾個函式的**：呼叫端傳一筆是合法的
  // （`reshapeProcedure` 只重塑一個函式），而收掉一顆下面那圈迴圈不會補回去的
  // 晶片，就是靜默刪掉畫布上的東西。
  for (const block of workspace.getAllBlocks(false)) {
    if (!isChip(block) || block.getParent() !== null) continue;
    const ref = paramRefFromType(block.type);
    if (ref && ref.procId in procedures) block.dispose(false);
  }

  for (const [procId, proc] of Object.entries(procedures)) {
    for (const hat of workspace.getBlocksByType(definitionType(procId), false)) {
      if (onTrash && hat instanceof Blockly.BlockSvg) {
        hat.setDragStrategy(new TrashAwareDragStrategy(hat, () => onTrash(procId)));
      }
      for (const param of paramsOf(proc)) {
        const type = paramType(procId, param.id);
        const input = hat.getInput(param.id);
        if (!input?.connection) continue;

        // 孔裡已經有東西：**型別對得上就是那顆晶片**，把它修好而不是換掉。
        // 換掉會換掉積木 id，而使用者可能正拖著它（這個函式在每次積木移動時
        // 都會跑）。型別對不上的是使用者自己丟進來的積木——那是上面那圈
        // 「被擠出來的晶片」要處理的事，不是這裡。
        const existing = input.connection.targetBlock();
        if (existing) {
          if (existing.type === type) makeChip(existing);
          continue;
        }

        const chip = workspace.newBlock(type);
        if (chip instanceof Blockly.BlockSvg) {
          chip.initSvg();
          chip.render();
        }
        makeChip(chip);
        input.connection.connect(chip.outputConnection!);
      }
    }
  }
}

/**
 * 積木一動就重新補孔。
 *
 * 需要它的只有一件事：使用者**把別的積木丟進參數的孔**，帽子上那顆被擠出來
 * 變成頂層積木。正常的拖曳不會走到這裡（拖它拿到的是複製品，帽子上那顆一動
 * 也不動）。
 *
 * 用 listener 而不是「把那個孔鎖死」：Blockly 的連接檢查對 `output: null` 的
 * reporter 一律放行（那正是 §8.5 要的——型別提示用警告不用形狀），所以擋不住。
 * 與 `reshape.ts::watchOrphans` 同一個形狀：**自己記帳、自己收拾**。
 */
export function watchDefinitionParams(
  workspace: Blockly.Workspace,
  read: () => Record<string, Procedure>,
  onTrash?: (procId: string) => void,
): () => void {
  const listener = (event: Blockly.Events.Abstract) => {
    if (event.type !== Blockly.Events.BLOCK_MOVE) return;
    // 便宜的前置判斷：只有真的有一顆被擠出來時才做那趟掃描。
    const bumped = workspace
      .getAllBlocks(false)
      .some((b) => isChip(b) && b.getParent() === null);
    if (!bumped) return;
    fillDefinitionParams(workspace, read(), onTrash);
  };
  workspace.addChangeListener(listener);
  return () => workspace.removeChangeListener(listener);
}

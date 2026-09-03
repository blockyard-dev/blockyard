/**
 * 按住 Alt／Option 拖曳 = **把這顆積木連同它底下那一整串複製一份**。
 *
 * Blockly 內建的複製是鍵盤上的 `D`（`SHORTCUTS_DUPLICATE`），它有兩個地方對不上
 * 這個編輯器。第一，**它只複製那一顆**（`toCopyData()` 走的是
 * `addNextBlocks: false`），而使用者要複製的幾乎都是「從這一顆到底下那一段」
 * ——`設 b 為 1` 加它後面那個 `重複 10 次`是一件事，不是兩件。第二，按 D 之前
 * 得先把積木選起來，而**在這個編輯器裡點一下積木是執行它**（`App.tsx` 的
 * `Events.CLICK`），所以那一下點擊是有副作用的。
 *
 * 拖曳兩個問題都沒有：手已經在那顆積木上，而「這顆與它底下那串」本來就是拖曳
 * 的範圍——Alt 只是把「搬走」換成「留一份在原地」，複製的範圍完全不必另外
 * 教。這也是 Figma、檔案總管一路過來的同一個手勢。
 *
 * **掛在 `Dragger` 而不是逐顆積木的 `BlockDragStrategy` 上。** strategy 是一顆
 * 一顆掛的（`params.ts` 的晶片就是那樣掛的），而這一條要對畫布上每一顆積木成立
 * ——包含使用者下一秒才從 flyout 拖出來的那顆。`Dragger` 只有一個、由
 * `plugins.blockDragger` 指定（`theme.ts`），而它的 `onDragStart` 回傳的正是
 * 「這次真正被拖的東西」：換掉它，整個拖曳就作用在複製品上，原件連一次
 * `startDrag` 都沒收到，所以它不會被拔離父積木、也不會進拖曳層。
 */
import * as Blockly from 'blockly/core';

/** `theme.ts` 的 `plugins.blockDragger` 指的就是這個名字。 */
export const DUPLICATING_DRAGGER = 'BlockyDuplicatingDragger';

class DuplicatingDragger extends Blockly.dragging.Dragger {
  /**
   * 這次拖曳自己開的事件群組，沒有複製就是 null。
   *
   * 有它才是**一次 Ctrl+Z 收回一次複製**：複製品的 `BLOCK_CREATE` 與放手時的
   * `BLOCK_MOVE` 是兩個事件，不同群組的話使用者要按兩次——而第一次按完畫面上
   * 是「複製品跳回原件身上」，看起來像壞掉。
   */
  private group: string | null = null;

  override onDragStart(e?: PointerEvent | KeyboardEvent): Blockly.IDraggable {
    const source = this.draggable;
    if (e instanceof PointerEvent && e.altKey && source instanceof Blockly.BlockSvg) {
      const group = Blockly.utils.idGenerator.genUid();
      Blockly.Events.setGroup(group);
      // **Ctrl／⌘ 的意思照舊，只是換成對複製品生效。** 那顆鍵在 Blockly 裡已經
      // 有一個意思了：`BlockDragStrategy.shouldHealStack` ——「只拖這一顆，底下
      // 那串留下」。兩顆一起按就是「只複製這一顆」，同一句話。
      //
      // 不接這一條的話那個組合會產生一個看起來像壞掉的狀態：複製一整串，然後
      // 只把第一顆拖走——剩下那串複製品就**原封不動疊在原件上面**。
      const copy = duplicateStack(source, { withNext: !(e.ctrlKey || e.metaKey) });
      if (copy) {
        this.group = group;
        this.draggable = copy;
      } else {
        Blockly.Events.setGroup(false);
      }
    }
    return super.onDragStart(e);
  }

  override onDragEnd(e?: PointerEvent | KeyboardEvent): void {
    try {
      super.onDragEnd(e);
    } finally {
      this.closeGroup();
    }
  }

  /**
   * 拖曳被取消（Esc、拖出視窗）走這裡。`Gesture.cancel()` 之後也還會叫
   * `onDragEnd`，但這條路自己收乾淨——群組沒關掉的話，後面**所有**事件都會
   * 記到這一次複製的帳上，而使用者按一次 Ctrl+Z 會看到十分鐘的工作一起消失。
   */
  override onDragRevert(): void {
    try {
      super.onDragRevert();
    } finally {
      this.closeGroup();
    }
  }

  private closeGroup(): void {
    if (this.group === null) return;
    this.group = null;
    Blockly.Events.setGroup(false);
  }
}

/**
 * 複製一顆積木與**它底下那一整串**，放在原件的正上方。
 *
 * 放在原位是這個手勢的手感來源：使用者按下的位置就是原件，複製品疊在同一個
 * 地方接手拖曳，畫面上看起來就是「原件留下了、手上這份跟著走」。
 *
 * 回傳 null = 這顆不該複製，拖曳照原樣進行（搬動它）：
 *
 * - **flyout 裡的**：拖出去本來就是新的一顆（`BlockDragStrategy.getTargetBlock`），
 *   Alt 不必也不該再插一手。
 * - **影子積木**：它不是使用者的東西，拖它拿到的是它的父積木。
 * - **刪不掉的**：`deletable: false` 是這個專案給「身分被別的地方管著」的積木
 *   的記號——函式定義帽子（`procedures.ts`）與帽子上的參數晶片（`params.ts`）。
 *   複製一顆定義帽子會生出第二顆宣告同一個 `procId` 的積木，複製一顆晶片會生出
 *   一顆刪不掉的孤兒。兩者都不是使用者想要的東西，而它們的共同記號已經在了。
 *
 * 型別跟著進來的那一顆走（畫布上是 `BlockSvg`，無畫面的工作區是 `Block`）：這
 * 整個函式只碰序列化，而序列化那一半在兩邊完全相同——那正是測試驗得到的部分
 * （同 `params.ts::makeChip` 的分界）。
 */
export function duplicateStack<T extends Blockly.Block>(
  block: T,
  { withNext = true }: { withNext?: boolean } = {},
): T | null {
  if (block.isInFlyout || block.isShadow() || !block.isDeletable()) return null;

  const state = Blockly.serialization.blocks.save(block, {
    // 底下那一串就是這一條（Blockly 自己的複製是 `addNextBlocks: false`）。
    addNextBlocks: withNext,
    // 座標存的是**畫布座標**（`getRelativeToSurfaceXY`），所以從一串中間抓一顆
    // 出來複製，複製品也落在那一顆原本的位置上，不是回到原點。
    addCoordinates: true,
    // 複製品要自己的 id。留著原 id 的話得靠 `Block` 建構子撞號時重配——那是
    // 對的行為，但這裡不必倚賴它。
    saveIds: false,
  });
  if (!state) return null;

  // `data` 是**腳本 id**（`ir/deserialize.ts` 寫進去、`ir/serialize.ts` 讀）。
  // 它會跟著複製走，於是複製一整條腳本就有兩條腳本宣稱自己是 `sc_1`——存檔時
  // 的 `scriptIdOf` 補得回來，但補的是「後看到的那一條」，等於誰換身分由掃描
  // 順序決定。這裡直接不帶走它：複製出來的是**另一條腳本**，本來就該領新號。
  delete state.data;

  return Blockly.serialization.blocks.append(state, block.workspace, {
    // 少了它複製品進不了 undo 堆疊，於是 Ctrl+Z 只把它移回原位、拿不掉它。
    recordUndo: true,
  }) as T;
}

Blockly.registry.register(
  Blockly.registry.Type.BLOCK_DRAGGER,
  DUPLICATING_DRAGGER,
  DuplicatingDragger,
  true,
);

/**
 * 內建的 `D` 鍵複製**拿掉**。
 *
 * 留著它就是同一件事有兩個入口，而那兩個入口做的還不是同一件事：`D` 只複製
 * 選起來的那一顆，Alt 拖曳複製的是那一顆以下整串。使用者用哪一個得到什麼，
 * 取決於他當時用的是鍵盤還是滑鼠——那不是一條說得出口的規則。
 *
 * 而且 `D` 的前置動作在這個編輯器裡是有代價的：要先把積木選起來，而**點一下
 * 積木是執行它**（`App.tsx` 的 `Events.CLICK`）。
 *
 * 只拆快捷鍵，不拆右鍵選單的「複製」——那一項是看得見的入口，而看得見的東西
 * 不會在使用者不知情的時候發生。
 */
Blockly.ShortcutRegistry.registry.unregister(Blockly.ShortcutItems.names.DUPLICATE);

/**
 * 剩下那條「複製」的預設範圍**也是整串**。
 *
 * 右鍵選單的「複製」與 Ctrl+C 走的是同一個入口（`BlockSvg.toCopyData()`），而
 * 它的 `addNextBlocks` 預設是 `false`——於是同一個編輯器裡「複製」會有兩種
 * 範圍，取決於使用者用的是滑鼠手勢還是選單。這個編輯器裡積木的單位是
 * **「這一顆到它底下那一串」**（拖曳就是那樣走的），複製沒有理由是唯一的例外。
 *
 * 補在方法的預設值上，而不是去覆寫選單項與快捷鍵各一份：那個旗標本來就是
 * Blockly 開給呼叫端的（`toCopyData(addNextBlocks)`），我們只是換掉它預設站在
 * 哪一邊，而所有經過它的路徑一次全部一致。
 *
 * `typeCounts`（積木數量上限用的）維持原樣只算這一顆——這份專案沒有設
 * `maxBlocks`，那個數字現在沒有消費者。
 */
const toCopyData = Blockly.BlockSvg.prototype.toCopyData;
Blockly.BlockSvg.prototype.toCopyData = function (addNextBlocks = true) {
  return toCopyData.call(this, addNextBlocks);
};

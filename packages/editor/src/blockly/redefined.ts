/**
 * 「這個 type 的定義在這一場裡被換過。」
 *
 * **一句話的規則，但它擋的是一個很難查的症狀。** continuous-toolbox 的 flyout
 * 會把上一批積木依 `type` 收起來重用（`RecyclableBlockFlyoutInflater`），而那
 * 假設**同一個 type 永遠長同一個樣子**。整個編輯器裡有兩件事會打破那個假設：
 *
 * 1. **函式積木**——改一次簽章就是同一組 type 換一份定義。那一條在
 *    `theme.ts` 早就處理了（`procIdFromType`），因為它天天發生。
 * 2. **更新一個積木包**——`docs/extension-design.md` §4 那條路做完之後，
 *    `demo.echo` 也變成「同一個 type、換一份定義」。**在那之前這件事不可能
 *    發生**：換掉磁碟上的包要重啟後端，而那意味著重新整理頁面。
 *
 * 兩者是同一個形狀，所以它們該共用同一條規則——這個模組就是把第二種寫下來。
 *
 * **進來就不出去。** 一個被換過定義的 type 從此不回收，而不是「換過的那一次
 * 不回收」：後者要回答「什麼時候可以放回去」，而那個答案取決於 flyout 這一刻
 * 畫到哪裡、哪幾顆還在池子裡——一個沒有人看得見、卻會偶爾錯一次的狀態。代價
 * 是那幾顆積木每次開分類都要重畫，而那是使用者親手更新過的那個包裡的幾顆。
 *
 * 模組層的一份可變狀態是刻意的：它跟著 `Blockly.Blocks` 這份全域註冊表走，
 * 而那本來就是一份全域的東西。存進 React state 會讓「畫布上這顆積木的定義是
 * 哪一版」多一個可能不同步的答案。
 */

const redefined = new Set<string>();

/**
 * 這幾個 type 剛剛被重新定義過。
 *
 * **只在「不是第一次」的時候叫**：開場那一次註冊不算重新定義（那時候還沒有
 * 任何東西畫出來，也沒有池子），而把 95 顆內建積木全部標成不回收，等於為了
 * 一件沒有發生的事付一整場的代價。
 */
export function markRedefined(types: Iterable<string>): void {
  for (const type of types) redefined.add(type);
}

export function wasRedefined(type: string): boolean {
  return redefined.has(type);
}

/** 測試用：把這份全域狀態清乾淨。 */
export function forgetRedefined(): void {
  redefined.clear();
}

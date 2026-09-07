/**
 * 一句話的回執：**我剛剛做完的那件事**。點一下、或六秒後自己走。
 *
 * 不用 `window.alert`：它是原生 modal，會擋住整個畫面，而這些訊息都是「順帶說
 * 一聲」等級的——使用者不必回答它，也不該被它擋住下一個動作。
 *
 * **它只說做完的事。** 「你為什麼會在這裡」那種話留在原地（主選單那條
 * `.gallery-notice`：被踢回來時的「找不到專案 X」）——一句使用者還沒讀完就
 * 消失的解釋，等於沒說。
 *
 * 抽成一個元件而不是兩邊各寫一份，是為了那個**六秒**：它是同一件事，而兩份
 * 計時器遲早會變成兩個不一樣的秒數，然後沒有人記得哪一個才是對的。
 */
import { useEffect, useRef } from 'react';

export function Toast({
  text,
  onDismiss,
  page = false,
}: {
  text: string;
  onDismiss: () => void;
  /**
   * **整頁的那一條**（主選單）：釘在視窗底部中央。
   *
   * 兩個地方位置不一樣，而兩次都是同一個判準——**別蓋住它正在講的那個東西**。
   * 畫布那一條在上方，因為它貼的是畫布容器的上緣、也就是工具列底下（改成
   * `fixed` 會蓋在工具列上）。主選單那一頁上方中央是標題「專案」，而那一頁
   * 自己會捲（`.gallery` 是 `overflow: auto`，`absolute` 會跟著卡片捲出畫面）
   * ——所以是 `fixed`，而且落在底部。
   */
  page?: boolean;
}) {
  // 回呼走 ref：呼叫端傳的通常是一個 inline 的箭頭函式，放進相依裡的話每次
  // render 都會重設計時器——症狀是這條提示永遠不會自己消失。
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const timer = setTimeout(() => dismiss.current(), 6000);
    return () => clearTimeout(timer);
  }, [text]);

  return (
    <button type="button" className={page ? 'toast is-page' : 'toast'} onClick={onDismiss}>
      {text}
    </button>
  );
}

/**
 * 擴充功能面板的搜尋（純函式那一半，同 `modalKeys.ts` 的分法）。
 *
 * 比對三個欄位：**名字、id、說明**。id 要在裡面是因為畫面上不顯示它，而使用者
 * 手上多半就是那個字（`http`、`openai`——文件、資料夾名、錯誤訊息裡出現的都是
 * 它）；說明要在裡面是因為「發請求」找得到 HTTP 才是搜尋該做的事。
 *
 * 不做模糊比對（編輯距離、字首縮寫）：這裡的清單是一整個畫面裝得下的十幾張卡，
 * 而模糊比對的代價是「為什麼這個也算命中」變成一個沒有人答得出來的問題。
 */
export interface Searchable {
  id: string;
  name: string;
  description: string | null;
}

export function matchesQuery(item: Searchable, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return [item.name, item.id, item.description ?? ''].some((field) =>
    field.toLowerCase().includes(q),
  );
}

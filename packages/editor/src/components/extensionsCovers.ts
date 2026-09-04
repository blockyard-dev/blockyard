/**
 * 封面圖的網址與預載（§8.1、D31）。
 *
 * 存在的理由是**時機**：封面畫在擴充功能面板上，而那一頁是使用者按下去才掛載
 * 的——等到 `<img>` 進 DOM 才開始下載，看到的就是「面板先出來、圖晚一拍補上」。
 * 圖片有多小都一樣，那一拍是「請求現在才發出去」的時間，不是頻寬。
 *
 * 所以在**積木包清單一到手**的時候就先把圖抓進瀏覽器的快取（`App.tsx` 載完
 * `GET /api/extensions` 那一步）。那時候使用者正在看畫布，這幾個請求不跟任何東西
 * 搶——等他真的打開那一頁，圖已經在手上了。
 *
 * 這件事只有配上後端的 `Cache-Control: no-cache` 才成立（見
 * `api/extensions.py::get_cover`）：原本那行是 `no-store`，意思是「不准留」，
 * 預載抓回來的東西會被丟掉，**每次**打開面板都重抓一次。
 */
import type { ToolboxGroup } from '../blockly/toolbox';

/**
 * 封面的網址。
 *
 * **路徑不由前端組**：端點自己去 manifest 讀 `cover`（見 `ToolboxGroup.cover`），
 * 所以這裡只需要 id。寫成一個函式是因為預載與 `<img src>` 必須是**同一個字串**
 * ——差一個字元就是兩筆快取，而預載就完全沒有效果了。
 */
export function coverUrl(id: string): string {
  return `/api/extensions/${id}/cover`;
}

/** 有宣告封面的包。 */
export function withCover(groups: readonly ToolboxGroup[]): ToolboxGroup[] {
  return groups.filter((g) => g.cover !== null);
}

/**
 * 把封面先抓進快取。
 *
 * `new Image()` 而不是 `<link rel="prefetch">`：後者要塞進 `<head>`、要自己收，
 * 而且各家瀏覽器對「prefetch 的優先序」處理不一。這裡要的就是一個最普通的圖片
 * 請求，`new Image()` 就是那個。
 *
 * **失敗不處理**：預載失敗的下一步是使用者打開面板、`<img>` 自己再試一次，而它
 * 那邊已經有 `onError`（退回名字的第一個字）。在這裡多接一個 handler，唯一的效果
 * 是把同一件事處理兩次。
 *
 * 沒有瀏覽器（測試、SSR）就什麼都不做。
 */
export function prefetchCovers(groups: readonly ToolboxGroup[]): void {
  if (typeof Image === 'undefined') return;
  for (const group of withCover(groups)) {
    new Image().src = coverUrl(group.id);
  }
}

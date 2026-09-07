# 全信任插件與編輯器擴充

狀態：全信任模型、兩段式安裝摘要、主頁 JS 與 Editor API v1 已實作。
積木語意、IR 與 Python Host 合約仍由 [design.md](design.md) 定義。

## 1. 信任模型與四份狀態

使用者自行安裝的插件視為受信任程式碼。ZIP、GitHub、手動資料夾都不需要官方核准。
安裝不掃描原始碼，不要求程式碼審閱，不提供逐項授權。舊 manifest 的 `permissions`
接受後忽略，不出現在 schema、API 或安裝摘要；`ctx.http` 對所有 Python 插件開放。

Python 以使用者權限執行。前端插件以主頁的 ES module 執行，可直接使用 DOM、CSS、
fetch 與瀏覽器可存取的資料。Editor API 是相容性介面，不是安全邊界；直接依賴
React 內部結構或任意 DOM 選擇器的修改不保證跨版本相容。

| 狀態 | 存放位置 | 動作 |
|---|---|---|
| 已安裝 | `~/.blockyard/extensions/<id>/` | 安裝、更新、解除安裝 |
| 前端插件啟用 | 瀏覽器偏好 `extensions.editor.disabled`，存停用名單 | 啟用／停用介面擴充 |
| 工具箱可見 | 各專案的 `extensions.enabled.<projectId>` 偏好 | 加入／移除分類 |
| 專案使用的積木包 | IR 的 `extensions`，從畫布計算 | 無手動開關 |

插件安裝後自動啟用；手動放入的插件也在下一次開啟編輯器時載入。收起工具箱分類
不會停用主頁 JS。開啟專案仍只把使用的包加入工具箱，不從專案資料自動下載程式碼。
目前偏好以瀏覽器為單位，並非跨瀏覽器的機器設定。

## 2. 一條安裝管線

```
ZIP / GitHub → 暫存與格式驗證 → 安裝摘要 → Python 依賴（若有）→ 安裝目錄與收據
手動資料夾 → discovery → 啟動時載入
```

保留 `POST /api/extensions/import`、`POST /api/extensions/import/github` 與
`POST /api/extensions/import/{token}`。第一次回摘要與 token，第二次安裝同一份 bytes。
取消與暫存清理維持原 API。摘要包含來源、版本、作者、描述、依賴、積木、面板、設定、
按鈕連結、editor 入口及更新差異；不傳原始碼、檔案列表、掃描結果或權限。

解壓路徑、檔案大小、包內 symlink 邊界、manifest 合約與名稱衝突檢查保留。
安裝不執行 JS；前端在核心就緒後才載入入口。Python 依賴仍先準備好，再搬入目錄。
純前端包不建立 venv，也不啟動 Python worker。

官方包從 `backend/blockyard/_bundled/` 鋪到使用者目錄；收據標 `origin: official`。
開發官方包可使用 `blockyard serve --extensions backend/blockyard/_bundled`。
repo 根的 `extensions/` 是作者草稿與範例目錄；本次附有純 JS 的 `editor_demo`。

### 收據、更新與解除安裝

`.blockyard-source.json` 記錄 origin、label、url、ref、commit、version、digest 與 installedAt。
来源由安裝器寫，包不能替自己提供收據。收據不計入內容 digest，也不是中央索引。
沒有收據的資料夾仍屬於作者，UI 不更新或解除安裝它。

更新比較積木與依賴：刪除或改形狀且畫布仍使用的積木擋下；參數變更列出警告；
未使用的變化只列摘要。不再比較權限。使用中事件包的更新仍先取得暫停監聽的確認，
更新、重畫後再接回；其他包不打斷無關監聽。

舊包先搬入 `~/.blockyard/trash/`，換檔失敗則搬回。venv 不做雙份回滾；依賴
降版可能影響舊包，下一次載入依 requirements lock 修復，不保證新版依賴向後相容。
解除安裝同樣搬到垃圾桶，刪掉可重建的 venv。官方包的墓碑防止下次啟動自動裝回，
現有「裝回來」入口保留。完成訊息給出垃圾桶路徑。

更新時 flyout 不回收改過定義的 type；既有畫布先試讀再重建，失敗保留原畫布。
包更新可中斷 undo 歷史；下節的 Editor API 畫布修改則是可 undo 的動作。

## 3. 包格式與主頁 JS

```yaml
manifestVersion: 1
id: my_editor
name: 我的編輯器工具
version: 0.1.0
editor:
  entry: ui/editor.js
  apiVersion: 1
```

`editor` 可省略，舊 Python 包無須更改。entry 必須是包內存在的 `.js` 或 `.mjs`，
支援相對 import；第三方 JS 依賴由作者自行打包，不使用編輯器的 React 私有實例。
只有 JS／HTML 的包可省略 `main.py`；宣告積木、Python 按鈕 handler 或 requirements
的包必須提供它。語言內建命名空間與 Python 積木參數限制維持不變。

```js
export function activate(editor) {
  editor.commands.register('save', () => editor.project.save());
  editor.ui.registerToolbarButton({
    id: 'saveButton', label: '存檔', command: 'my_editor.save',
  });
}
export function deactivate() {
  // 清除直接建立的計時器、DOM 等；API 註冊項由 runtime 清除。
}
```

編輯器核心與畫布就緒後，依插件 ID 排序逐一 import、呼叫 `activate(editor)`。
同一個文件內不重複載入。apiVersion 不相容、缺少 activate 或啟動例外顯示在擴充
功能面板；失敗插件的 API 註冊清除，其他插件繼續載入。

原有 `panels[].entry` HTML 面板保留 iframe、ready/message/call v1 協定及重播。
iframe 不再有 sandbox，資源回應不再送限制聯網的 CSP。iframe 是文件與樣式容器，
不是安全隔離。`postMessage` 仍比對來源視窗與協定版本，避免不同面板串話。

## 4. Editor API v1

完整型別：[`types.ts`](../packages/editor/src/extensions/types.ts)。API 註冊 id 是
插件內的英文字母開頭、英數／底線／連字號；runtime 加上 `<extensionId>.` 前綴。
同插件所有 API 註冊項共用命名空間，重複 id 立即拋錯。命令引用使用完整 id。
註冊與事件訂閱回傳冪等清除函式；停用或啟動失敗時由 runtime 統一清除。

| API | 行為 |
|---|---|
| `commands.register(id, handler)` / `execute(id, ...args)` | handler 可非同步；內建命令為 `editor.save`、`editor.run`、`editor.stop` |
| `ui.registerMenu({id,label,command})` | 加入頂部插件選單 |
| `ui.registerToolbarButton({id,label,command})` | 加入頂部工具列 |
| `ui.registerPanel({id,title,mount})` | 加入插件面板分頁；mount 收 DOM 容器並可回清除函式，支援彈出視窗 |
| `ui.registerShortcut({id,keys,command})` | `Mod+Shift+k` 等組合；Mod 接受 Ctrl／Meta，輸入欄位、組字與 repeat 不觸發 |
| `ui.registerStyle(id, css)` | 插入可清除的主頁 style，支援主題覆寫 |
| `workspace.getIR()` / `applyIR(project)` | 讀取副本；非同步驗證後套用一個可 undo 的完整畫布動作 |
| `workspace.getSelection()` / `select(id \| null)` / `focus(id)` | 單一積木選取或定位；不存在的 id 拋錯 |
| `project.current()` / `save()` | 目前 id／name；存檔失敗 reject |
| `events.on(name, handler)` | `project.changed`、`workspace.changed`、`selection.changed`、`run.changed` |

`applyIR` 透過 `POST /api/projects/{id}/validate` 共用存檔驗證，但不寫資料庫、不重接
監聽。驗證期間畫布變更則拒絕套用。先在暫存工作區試讀，成功才替換畫布；undo／redo
包含積木、函式宣告與 metadata。不自動存檔；保存由插件或使用者呼叫。
專案切換目前是整頁導覽，每份文件重新載入一次插件，啟動完成後發 project.changed。

任意 DOM 修改由作者負責復原，API 無法完整清除它。同步無限迴圈可以卡住主頁；
runtime 不承諾能中斷。此版不新增完整外殼替換協定。

## 5. 重新載入與救援

更新、停用、解除安裝帶 editor 入口的包後，先存畫布再重載頁面。舊版有 editor 而
新版拿掉入口也要重載。安裝新 editor 包亦經存檔與重載，避免與舊模組副作用混用。
存檔失敗保留當前文件並顯示「待重新載入」及重試按鈕，不讓未存內容消失。

`?extensions=off` 在 import 前跳過主頁插件；HTML 插件面板也不掛載。救援模式會
隨主選單與專案導覽保留。使用者可開啟擴充功能面板停用問題插件，再移除網址參數
恢復正常啟動。這不是 Python 執行沙箱；後端既有存檔／執行驗證仍遵守 Python Host。

## 6. 登記處與驗收

登記處繼續延後。未來索引 URL 可設定，官方只是預設；扁平 id、內容 sha256、來源
commit 與 schema_version 保留設計方向。登記處不成為 ZIP／GitHub／手動安裝的門檻。

驗收覆蓋三種來源、純 JS 不開 Python、入口存在與路徑、舊 permissions 相容、API
版本與啟動失敗、重複註冊與清理、命令共用、undo／redo、驗證失敗與並行畫布修改、
存檔失敗不重載、救援模式、原有安裝回復與 HTML 面板資源。前後端測試、schema
一致性、TypeScript 與編輯器 build 一起驗證。

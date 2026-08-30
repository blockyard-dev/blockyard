# PROGRESS

> 這份文件只做一件事：**交接**。它記「現在在哪裡、什麼還沒解決、下一步做什麼」。
> 規格與決議在 [`docs/design.md`](docs/design.md)（v0.18），實作經過在 `git log`。
> 兩邊已經有的東西，這裡不重複。

最後更新：2026-08-30

## 1. 現況

**P0 結案，P1 第 1 步完成。** P0b 的八步、九輪瀏覽器實測回饋、§15 的四條驗收全部
通過；P1 的第一個手寫積木包 `http` 跑得起來——從工具箱拉一顆 `GET` 出來、點一下，
值氣泡就展開回應物件（實測打的是 httpbin.org）。

```
cd backend && .venv/bin/python -m pytest      # 668 passed, 5 skipped（含積木包自帶的 tests/）
cd packages/editor && npm run check           # 343 passed（13 檔）+ tsc 乾淨
```

題庫覆蓋 43/88 顆內建積木（49%）。

**第 1 步做完的四件**（design.md v0.18）：`extensions/http/`（4 顆積木 + 一顆 D25
按鈕 + 自帶 tests/）、`ctx.http` 落地（host 提供、逾時與連線重試的預設值只設一次）、
`permissions: [net]` 有了第一個真的檢查、SDK 多一個 `BlockError`。

**它逼出來的那個 bug 值得記著**：`extensions` 宣告原本是存檔時的 passthrough，所以
從工具箱拉一顆 `http.get` 出來按執行，後端說「這個版本不認得積木 http.get」——使用者
每一步都做對了，錯誤卻指著積木。現在宣告由畫布算出來（§13.3）。**它是單元測試碰不到
的那一類**：前後端各自都是對的，錯在兩者之間那句沒有人負責的話。

## 2. 下一步

**P1 第 2 步：SubprocessHost + 跨 process 反向通道**（§7.5、§7.6、design.md §15 的
施工順序表）。合約測試已經對 host 參數化，`HOSTS` 加一行就跑得起來，而第 1 步的
`http` 包當場變成第二個實作的第一個真實用戶。

開工前要知道的三件：

1. **`ctx.http` 要跟著進子 process。** `extensions/httpclient.py` 是共用的那份設定，
   兩邊都呼叫它——與 `boundary.py` 同一個理由。
2. **`permissions` 的檢查目前在 host 這一側**（`inprocess.py::_http_for`）。子 process
   要嘛沿用同一段，要嘛在通道上再擋一次。
3. **動態下拉最晚要在第 3 步（`openai`）之前接上**，`http` 的 `method` 是現成的第一個
   測試對象（選項封閉、答案不會變）。

## 3. 未解決問題與已知限制

只列還會咬人的。長版理由在 `git log` 與程式碼註解裡。

### 3.1 積木包與 Host（P1）

- **`http` 沒有 conformance 題目**：§17 的題庫跑不了本地伺服器，所以那條路的回歸網
  是 `extensions/http/tests/`（含一題走引擎的端到端）。
- **逐次的 timeout 不能設**：只有 host 那份 30 秒預設值。要做就是 `request` 多一個
  `number` 參數。
- **§13.3 的佔位符前端沒做**：專案用到未安裝的包時，`deserialize` 遇到認不得的 type
  會怎樣**沒有驗過**——後端已經會給 `unknown_block`，前端那一半是空的。
- **積木包自帶的 `tests/` 靠 `testpaths = ["tests", "../extensions"]` 收**。包來自
  repo 外面時這條就不成立了。
- **manifest 是 `palette` 一份清單**（v0.19）：三種條目（`opcode` / `button` /
  `section`），`blocks` 由模型導出。**加第四種條目時記得兩邊都要認**——後端
  `manifest.py::_entry_kind`、前端 `define.ts` 的三個 narrowing 函式，共用的是「有沒有
  那個 key」這條規則，而它沒有被抽成一份東西。
- **一個包的 manifest 壞掉，整個 `GET /api/extensions` 就 500**，編輯器變成「連不上
  後端」。`discover()` 一份讀不過就整批拋——與 §13.3「不要因為一個包毀掉整份專案」
  同一個形狀，但目前只有專案那一半有守。
- **`reads` 宣告沒有消費者**（`toolbox.ts::findVariableReader` 與後端欄位都留著）。
  下次動那塊時重新決定留或刪。

### 3.2 靜態檢查（`ir/checks.ts`）

- **「有路徑未回傳」是退化版**：只守「一顆 `回傳` 都沒有」，半條路沒回傳仍然只有執行期看得到。
- **作用域是扁平的**，所以 `data.set` 同名於函式參數時不警告 shadowing（§5.4 要求）。
- **參數積木放錯地方只有執行期會說**。出口是 §4.6 的存檔期驗證：`_validate_structure`
  要認得 `procedure.param` 的 `mutation.proc` 與祖先鏈。
- **檢查不進存檔路徑**（§8.5「不阻擋連接」），孤兒警告與 `CheckRunner` 是兩本帳。

### 3.3 編輯器

- **`ui.multiline` 存不下「強制單行」**；`Shift+Enter 換行` 沒有提示；autocomplete 只補 root。
- **字面值型別切換不進 undo 堆疊**（`literals.test.ts` 有一條測試釘住這個行為，
  **它變好的那天會紅**）；切完會失去 manifest 的 `min` / `max`（存檔重載會回來）。
- **孔裡插著 reporter 時，底下那顆影子的值存不下來**（IR 的 `kind: block` 說不出它）。
  同一個縫讓 `ui.multiline` 在被蓋住的影子上也存不下來。
- **下拉欄位的值沒有載入期驗證**：`fields.op` 寫成 `"wat"` 的 IR 存得進去。
- **回傳型別只影響形狀與靜態檢查，不影響執行**；參數積木沒有型別的形狀提示（刻意，§8.5）。
- **`reshapeProcedure` 沒有 catch**：第七輪那個 bug 的症狀之所以是「東西不見了」就是
  例外漏出去。成因修好了，防護還沒加。
- **帽子的參數孔擋不住別的積木**：靠 listener 收拾，而那一瞬間丟進去的積木會被存檔
  丟掉，目前沒有提示。
- **鍵盤走不進浮動工具列與預覽積木**，所以分段的文字與順序只有滑鼠改得動（要先解決
  「Blockly 的 SVG 節點進 focus 循環會讓焦點消失」，那是 focus manager 的事）。
- **三處依賴 Blockly 內部行為，換版時要複驗**：右鍵選單的 `preconditionFn` 快取、
  `WidgetDiv` 靠焦點活著（按鈕用 `pointerdown` + `preventDefault`）、keydown 必須
  capture 才問得到「編輯器開不開著」。加上兩個 CSS hack：`.injectionDiv
  { overflow: visible }` 與欄位編輯器的 inline style（`!important`）。

### 3.4 執行期與後端

- **點一下就跑 = 每次都先存檔**（PUT + POST），沒有節流。接遠端後端要重看。
- **`block.enter` 沒帶展開後的字串**，所以「滑過欄位看到實際送出的內容」還不存在。
- **錯誤紅框淡出之後 `error` 這個 phase 還在**：同一顆積木在同一次執行裡錯第二次不會
  重新倒數（要有 `try_catch` 才做得出來，先記著）。
- **`block.error` 沒有 traceback**，§8.3 的「點擊展開」目前只展得出 hint。
- **運算積木不發子步驟事件**（§4.7b）；`var.set` 的窗口內收斂（§6.2）比文件寫的多。
- **§6.3 的 SQLite 落地沒做**：執行歷史只在記憶體、上限 50 個 Run、重啟就沒了；
  `GET /api/runs/{id}/events` 因此不存在；**`persist_*` 不跨後端重啟**（D12 明講要有）。
- **§5.5 的「清理有 5 秒上限」沒實作**，停止時只是 `cancel()`。
- **動態下拉（`source`）還是文字框**（見第 2 節）。
- **遞迴 headroom 是估的**（`PYTHON_FRAMES_PER_BLOCKY_FRAME = 24`），靠 `RecursionError` 兜底。
- **`blocky serve` 沒有正式打包測試**：只驗過 `python -m blocky.cli`。
- **偏好存 localStorage**，§16 Q15（偏好放哪）未定案。

### 3.5 測試缺口

- **版面與時間只有瀏覽器實測守著**（jsdom 量不到 `getBoundingClientRect` /
  `getComputedTextLength`）：半形單字置中、值氣泡的 hover 凍結、淡出的時間、浮動工具列
  的位置、flyout 版面、focus trap「Tab 真的停在哪」。
- **「建立一個新函式」那條路沒有單元測試**（`placeDefinition` 要畫面）。改簽章那條有——
  `params.test.ts` 走真的 `blockly/apply.ts::applyProcedure`。
- **`data.list_insert` 用 `len+1` 正規化索引，無測試**，可疑。
- **§17.2 有幾列還寫不出題目**：`concurrency` 的 drop/queue/restart、`CancelledError`
  穿透、§6.3 的落地——都要等 P2 的機制存在。
- **那 45 顆沒有題目的積木**，參數名有 AST 測試守著，缺的是「它真的跑得動」那半。

## 4. 未決題

design.md §16 的 Q1、Q3–Q9、Q11、Q12、Q14、Q15、Q17、Q19 仍未決。已決的：Q10（開發者
路線，v0.17）、Q16（第 6 步）、Q18（第五輪）。

**Q19 是排在 P2 的那一題**（`如果⋯否則如果⋯` 的 `+` `−`）：它真正要的是 manifest 的
「可重複參數群組」，而 `try_catch` 的多個 catch、HTTP 的多個 header 是同一個形狀——
要先讓 P1 的三個手寫包磨過一輪。

---

### 五件從實測裡學到、值得帶到下一輪的事

1. **「規則對了，但少走了一條路。」** 每一輪幾乎都是這個形狀，而共同點是每次都省了
   一步「使用者真的會怎麼做」，**那一步只有把東西交出去才問得到**。
2. **單元測試每一步都綠，串起來才炸。** `reshapeProcedure` 9 題、`fillDefinitionParams`
   6 題，bug 出在「`App.tsx` 把它們接起來」的那條縫上。修法是讓那三步變成一個函式
   （`blockly/apply.ts`），不是再抄一份順序去測。
3. **規則對、時機錯。** 加檢查時要問的不只是「它說的對不對」，還有**「它會在哪一刻說」**。
4. **測得到的是規則，測不到的是順序。** 凡是「我讀的狀態別人也在改」的判斷，都要問
   一次「我跑在誰前面」（Esc 那個 bug）。
5. **兩邊都對，中間那句話沒有人負責。** P1 第 1 步的 `extensions` 宣告就是這個形狀：
   前端存的是真話、後端讀的也是真話，而「畫布上多了一顆積木要改宣告」不屬於任何一邊。
   **把東西端到端跑一次是唯一問得出這種問題的方法**——而它花的時間比寫那兩份測試少。

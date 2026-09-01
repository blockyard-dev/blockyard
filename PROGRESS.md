# PROGRESS

> 這份文件只做一件事：**交接**。它記「現在在哪裡、什麼還沒解決、下一步做什麼」。
> 規格與決議在 [`docs/design.md`](docs/design.md)（v0.18），實作經過在 `git log`。
> 兩邊已經有的東西，這裡不重複。

最後更新：2026-09-01

## 1. 現況

**P0 結案，P1 第 1～3 步完成。`openai` 積木包做完了，而且是用真金鑰在瀏覽器裡
打過真的 API 的。連帶把「金鑰」面板從唯讀清單改成逐把管理（D28 因此改寫）。**

```
cd backend && .venv/bin/python -m pytest      # 757 passed, 5 skipped
cd packages/editor && npm run check           # 369 passed（16 檔）+ tsc 乾淨
```

題庫覆蓋 43/88 顆內建積木（49%，這一輪沒有新增內建積木，比例不變）。

**`openai` 積木包**（`extensions/openai/`）：`chat`（最短路徑，回一句文字）、
`chat_full`（回物件，含 `usage`／`status`／`incomplete_reason`）、
`@dropdown("openai.models")` 回策展的三顆（`gpt-5.6-luna` 是宣告的 default）。
`requirements: ["openai>=3.6,<4"]`——**它是 venv 隔離的第一個真消費者**，
`SubprocessHost` 真的建了 `~/.blocky/venvs/openai`、在裡面裝了 openai 3.6.0、
積木跑在那支直譯器下（手動驗過，不是只有 in-process 的測試）。

動手前照規矩翻了裝下來的 SDK 原始碼而不是憑記憶，翻出兩件跟計畫不一樣的事：

1. **`openai` 3.x 相依的是 `httpx2` 2.x，不是 `httpx`**——兩個不同的發行套件。
   乍看之下 §12.1 的 `http_client=ctx.http` 檢查點要垮，但 SDK 有一層 first-class
   的雙棧相容（`openai/_httpx2.py::is_legacy_httpx_async_client()`，靠
   `sys.modules["httpx"]` 做 isinstance，timeout／response 型別／例外都各自
   normalize 過），legacy client 是它明確支援的路徑。**檢查點保住了，版本鎖定
   沒動。** 順帶：這件事讓 D13「衝突不是風險而是必然」第一次有了真實案例，
   design.md 1718 行已改。
2. **`tiktoken` 會自己連網**（第一次用去 `openaipublic.blob.core.windows.net`
   抓 BPE，用 `requests`，快取在 tempdir），不經 `ctx.http`。**這一輪因此不做
   `count_tokens`**，見第 2 節。

`max_retries=0`：SDK 預設替 429／5xx 退避重試兩次，而 §7.4 的規矩是「收到回應
之後一律不重試」——這裡的代價比 `http` 那邊更直接，模型可能已經算完並且計費了。

**「金鑰」面板改成逐把管理（D28 改寫，design.md §12.1 已重寫）**：
`GET /api/keys` 多回**末四碼**、新增 `PUT`／`DELETE`／`GET …/reveal` 三個端點
（三個都先查「這個包宣告過這一把嗎」才動 keyring——不然它們就是一組從瀏覽器
往 OS 鑰匙圈塞／讀任意鍵值的通用端點）。前端 `KeysPanel.tsx` 重寫成清單 +
新增／更換／刪除／複製，`.env` 匯入收到下面。**放寬的兩條線寫在 D28 裡，理由
分開**：末四碼是因為換過金鑰之後分不出裝著哪一把；`/reveal` 不違反「不顯示
明文」是因為值只進剪貼簿、不進 DOM、不進列表回應。**「匯出成 `.env`」仍然不做。**

**錯誤現在帶得動一個點得下去的動作**：`BlockyError` 多一個 `action` 欄位（跟著
`to_dict()` 過 §7.6 的 RPC 邊界到 §6.1 的事件流），`Ctx.require_secret(key)` 在
金鑰沒設時丟 `MissingSecretError`，payload 從 manifest 讀（所以積木包偽造不了，
前端另外只認白名單 `kind`）。執行紀錄那一列因此長出一顆「去設定 API 金鑰」，
點下去開到新增畫面、那一把已鎖定、焦點在值那一格。**每個未來要金鑰的包免費
拿到同一顆按鈕**——不然每個包會各自寫一句「請到右上角……」。

**踩到的兩個坑值得記著：**

- **`pytest` 的 prepend import mode 靠「基名唯一」認模組**，所以第二個包一加
  進來（`extensions/openai/tests/test_blocks.py` 撞 `http` 的同名檔）就是
  `import file mismatch`。修在設定而不是改檔名：`addopts =
  ["--import-mode=importlib"]`，這樣包的目錄結構可以一直長得一樣。
- **剪貼簿在 `await fetch()` 之後寫不進去。** Chrome 的 `clipboard.writeText()`
  要 transient user activation，而一次網路來回就把那個視窗耗掉了，症狀是
  `NotAllowedError`、按鈕看起來只是沒反應。解法是 `ClipboardItem` 收 **promise**
  ——在手勢還有效時就把還沒 resolve 的值交出去。順帶修掉一個自己造的坑：原本
  `failed` 畫成跟 `idle` 一樣的圖示，失敗跟「什麼都沒發生」長得一模一樣。

**上一步（`http`）逼出來的那個 bug 值得記著**：`extensions` 宣告原本是存檔時的
passthrough，所以從工具箱拉一顆 `http.get` 出來按執行，後端說「這個版本不認得
積木 http.get」——使用者每一步都做對了，錯誤卻指著積木。現在宣告由畫布算出來
（§13.3）。

## 2. 下一步

**P1 第 4 步：`discord` 積木包**（design.md §15）。三個手寫包的最後一個，也是
manifest schema 定案前的最後一次打磨機會（§15 明寫 schema 要用至少 3 個手寫包
磨到穩定）。

它會第一個逼出兩件現在還不存在的東西：

1. **hat 積木／`@trigger`**（§5.4、§9）——前兩個包都只有 reporter。
2. **動態下拉要吃「同一顆積木上其他已填的參數」**：先選 server 才列得出對應的
   channel。`http.method` 與 `openai.models` 都不需要這個能力，所以它一直沒做。
   `dropdown()` 加一個 `args: dict[str, Any] = {}` 是相容變更（見 3.4）。

動手前照 `openai` 這一輪的規矩來：**先 `uv pip install discord.py`，翻裝下來的
原始碼核對呼叫方式，不要用訓練資料裡的記憶去猜。** `openai` 這一輪就是靠這一步
才發現 `httpx2` 那件事的——而那件事如果照猜的寫下去，會是一個到執行期才炸、
且訊息完全指錯方向的 bug。

`discord.py` 自己開 `aiohttp` 連線（gateway 是長連線 WebSocket，不是請求／回應），
所以 §12.1 的 `permissions: [net]` 在這個包身上**守不住** `ctx.http` 那個落點——
這件事要在 §12.1 的審閱文字上老實寫清楚，不要為了硬塞而去改 SDK 的連線層。

## 3. 未解決問題與已知限制

只列還會咬人的。長版理由在 `git log` 與程式碼註解裡。

### 3.1 積木包與 Host（P1）

- **`http` 與 `openai` 都沒有 conformance 題目**：§17 的題庫跑不了本地伺服器，所以
  那兩條路的回歸網是各自的 `tests/`（`http` 那份含一題走引擎的端到端）。
- **`openai` 沒有 `count_tokens`**：`tiktoken` 第一次用會自己去
  `openaipublic.blob.core.windows.net` 抓 BPE 檔（用 `requests`，不經 `ctx.http`，
  快取在 tempdir），那是 §12.1 `permissions: [net]` 的一個洞，也代表測試不是離線
  就能跑。要補回來就得先決定「包可以自己連網嗎」，並把 `TIKTOKEN_CACHE_DIR` 釘到
  `~/.blocky` 底下。
- **`openai` 的 `chat_full` 沒有 `temperature`**：新的 reasoning 模型會不會拒收這個
  參數，在不打真 API 的前提下驗不出來，所以沒放進第一版。**要加就得先拿真金鑰打一次**。
- **`openai` 的測試用 `InProcessHost`**，所以 `openai` 得裝在 backend 的 dev extras 裡。
  副作用：`venv.py` 的 `.pth` 把 backend 的 site-packages 接進每一支積木包 venv，
  所以**沒有自己宣告 `requirements` 的包會吃到 backend 這一份**。`openai` 自己宣告了，
  它那支 venv 裡的版本優先，現在不咬人。
- **`venv.py::_link_backend_site_packages()` 只在建立 venv 時跑一次**（`pyvenv.cfg`
  不存在才呼叫）。venv 在、`.pth` 卻不見了（手動刪、上次建到一半）就不會補回去，
  症狀是子 process 連 `blocky` 都 import 不到。改成無條件寫就沒事（它是 idempotent）。
- **逐次的 timeout 不能設**：只有 host 那份 30 秒預設值。要做就是 `request` 多一個
  `number` 參數。
- **§13.3 的佔位符前端沒做**：專案用到未安裝的包時，`deserialize` 遇到認不得的 type
  會怎樣**沒有驗過**——後端已經會給 `unknown_block`，前端那一半是空的。
- **積木包自帶的 `tests/` 靠 `testpaths = ["tests", "../extensions"]` 收**。包來自
  repo 外面時這條就不成立了。另外它靠 `addopts = ["--import-mode=importlib"]` 才容得下
  每個包都叫 `tests/test_blocks.py`——換回預設的 prepend mode 會立刻 `import file mismatch`。
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
- **動態下拉不支援「附帶同積木其他已填參數」**（design.md 1737 行提到的
  用法，例如 discord 要先選 server 再列出對應的 channel）。`http.method`
  跟 `openai.models` 都不需要這個能力，真正需要它的是 P1 第 4 步的
  `discord`；`dropdown()` 屆時加一個 `args: dict[str, Any] = {}` 是相容
  變更，不必現在就背這個參數。
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

### 六件從實測裡學到、值得帶到下一輪的事

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
6. **驗收驗了值，bug 在樣子。** 動態下拉那個回歸就是這個形狀：第 3 步的驗收寫的是
   「選 POST → 存檔 → 重新整理 → **值還在**」，而值一直都是對的——`shadowKindOf`
   認不得下拉影子，重新載入時退回通用文字影子，那一格從下拉變成文字輸入框。
   `dropdownShadow.test.ts` 現在把兩件事分開斷言，而且**拿掉修正時只有「樣子」那兩題
   會紅，「值」那兩題照樣綠**——那正是當初漏掉它的原因，寫在測試檔的開頭。
   下次寫驗收句子時要問的是：**這句話如果只有一半壞掉，我看得出來嗎。**

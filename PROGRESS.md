# PROGRESS

> 這份文件只做一件事：**交接**。它記「現在在哪裡、什麼還沒解決、下一步做什麼」。
> 規格與決議在 [`docs/design.md`](docs/design.md)（v0.26），實作經過在 `git log`。
> 兩邊已經有的東西，這裡不重複。

最後更新：2026-09-01

## 1. 現況

**P0 與 P1 全部結案。** 三個手寫積木包（`http` / `openai` / `discord`）都寫完了，
而 §11 要求的「manifest schema 先用至少 3 個手寫包磨到穩定」因此成立——schema
現在可以當成對外的形狀了。

```
cd backend && .venv/bin/python -m pytest      # 793 passed, 5 skipped
cd packages/editor && npm run check           # 382 passed（16 檔）+ tsc 乾淨
```

> **改了 `extensions/` 就要跑不帶參數的 `pytest`**（`testpaths` 同時收
> `tests` 與 `../extensions`）。只跑 `pytest tests` 會漏掉包自己的測試，而那些
> 測試會 import `main.py`——一個語法錯誤要等到瀏覽器裡按下按鈕才會出現。

題庫覆蓋 43/88 顆內建積木（49%，這一輪沒有新增內建積木，比例不變）。

### P1 的驗收（§15）

| 驗收句 | 狀態 |
|---|---|
| 新增一個資料夾、重啟後端，新積木自動出現在工具箱且可執行 | ✅ `discord` 就是這樣長出來的 |
| §17.4 的 Host 合約測試在 InProcess 與 Subprocess 兩種實作下都綠 | ✅ |
| 三個包能串成「抓 API → 丟給 LLM 摘要 → 發到 Discord」 | ✅ `http.get` 的 `.body` → `openai` 摘要 → `discord.send_message`，真憑證、真伺服器 |

**三條都成立，P1 名副其實地結案了。** 那條串起來的鏈是三個**各自跑在獨立子行程與
獨立 venv** 的包（`~/.blocky/venvs/openai` 的 httpx2 與 `~/.blocky/venvs/discord` 的
aiohttp 互不相見）在同一條堆疊上傳值——D13 那句「衝突不是風險而是必然」的反面，
現在也有實例了。

### 這一輪（P1 第 4 步，`discord`）做了什麼

`discord.py 2.7.1`（design.md 宣告的 `>=2.3,<3` 不用動）。三顆積木
（`send_message` / `get_channel_history` / `on_message`）、兩顆動態下拉
（`servers` / `channels`），全部拿真 token 在真伺服器上收發過。

**照規矩先把 SDK 裝下來翻原始碼**（不是憑訓練資料裡的記憶），翻出三件跟計畫
不一樣的事，每一件如果照猜的寫下去都會是「到執行期才炸、而且訊息指錯方向」：

1. **`Client.login()` 是純 REST 的，不開 gateway**（`client.py:647`），
   `start()` 才是 `login()` + `connect()`。所以這個包有**兩種 client**：發訊息
   與讀歷史用 login-only 那一支（不必等 `on_ready`、不必 privileged intent、
   不必養長連線），只有 `on_message` 開 WebSocket。一個 client 打天下的話，
   「發一則訊息」要付一整條 gateway 連線，而那條連線還會因為少一個 intent 失敗。
2. **`ctx.http` 在這個包身上守不住**：`HTTPClient.static_login()` 自己
   `aiohttp.ClientSession(...)` 建下去（`http.py:831`），沒有
   `AsyncOpenAI(http_client=...)` 那種注入點。**不硬塞**——改 SDK 的連線層換來
   的是一份得跟著上游版本走的補丁。代價老實寫進 §7.4 與 §12.1 了。
3. **`Message.jump_url` 在 REST 那條路上一律吐 `@me`**：它讀 `self.guild`，而
   那是 gateway 的快取（`message.py:2233`），沒有連線就永遠是空的。那條連結指向
   私訊，使用者點進去看不到訊息、會以為沒發成功——但訊息其實發出去了。自己組
   （伺服器 ID 在使用者貼進來的那條頻道網址裡就有）。gateway 那條路不必，因為
   它的快取是滿的。

順帶多了三樣**不只 `discord` 用得到**的東西：

- **`depends`（§7.2）**：動態下拉吃同一顆積木上其他已填的參數。三條一致性規則
  在載入期擋，值在 host 邊界依宣告過濾——沒有那份權威清單，那個端點就是一條
  「任意 kwargs 進到積木包」的路。
- **`Ctx.invalid_secret(key, msg)`（§12.1）**：`require_secret` 只管得到「還沒
  填」，而「填了、對方說不對」（token 被 Reset 過）更常見。兩者共用同一顆
  「去設定金鑰」按鈕，訊息由包供、payload 仍只從 manifest 來。
- **空值下拉的提示字**：`default: ""` 的動態下拉原本畫出來是一個**完全空白的
  深色膠囊**——沒文字、寬度縮到最小、連箭頭都跟著不見。文字從 `label` 導出，
  每個包免費拿到。

**交出去之後馬上被回報的兩個 bug**（PROGRESS 第 1 條每一輪都應驗）：

1. **點一顆 reporter 也會去接事件來源。** 「執行順手打開監聽」寫成了對所有
   `beginRun` 都成立，但 §5.1 的「點一下就跑」是**探索動作**（這顆積木現在會算
   出什麼），跟「讓這份流程常駐起來」無關。畫布上有 hat 的話，每點一次積木就
   開一條真的長連線。現在只有綠旗會。
2. **`open_registry` 沒有清理路徑。** 它一個一個 `load()`，而在它回傳之前，
   **握得到那些子行程的只有那個還沒交出去的 registry**——中途失敗（或整個請求
   被取消）就沒有人收得了它們。實測看到 4 個 `subprocess_worker` 活過它們的 Run。
   `except BaseException: await registry.unload_all(); raise`，測試拿掉修正會紅。

順帶把「子行程意外結束」那句話加上死因（`_why_gone`）：現在會說是自己爆掉
（結束碼）、被信號砍掉，還是連線斷了而行程還在——三種的成因完全不同，而原本
那句話三種都長一樣。

**`/api/listeners`（§9 的前身）**：把畫布上的 hat 接上事件來源，**一次 yield =
一個 Run**（走既有的 `RunManager.start(trigger=opcode, payload=...)`，引擎的
`_triggered()` 與 `ThreadScope(payload)` 本來就支援，什麼都不用新增）。前端多
一列「監聽／暫停監聽」，跟「執行」分開——兩件事分成兩列是為了讓它們**停得開**，
而按下「執行」會順手打開，使用者不必知道那是兩件事。

> **P2 第 2 步已經把它換成 `/api/triggers`**（design v0.25）：那條管的是「這個
> process 有沒有在聽」，重啟就沒了；新的管的是「這個專案是不是該跑」，寫在
> SQLite 上。兩條同時留著就是同一件事兩個入口，而其中一個還會給出過期的答案。

## 2. 下一步

**P2 — 自動化**（design.md §15）。範圍：Trigger Manager（cron / webhook / stream，
含 §4.9 的 timezone）；專案 active 狀態與後端重啟恢復；~~§6.3 的事件落地策略~~
（**第 1 步，完成**）；執行歷史與日誌檢視；`try_catch`；錯誤重試策略；**manifest
的可重複參數群組（§16 Q19）**。

**第 1 步（§6.3 落地）完成**——`storage/runs.py`（三張表）、`runs/recorder.py`
（篩選 + 批次 writer）、`GET /api/runs/{id}/events`、`SqlitePersistStore`。
先做它而不是先做 Trigger Manager，理由是三件事共用同一次 schema 決定：驗收句
「隔天檢查執行歷史有紀錄」直接依賴它、它在監聽開著時當下就在痛（50 筆很快滿）、
而 Trigger Manager 的 active 狀態與重啟恢復也要 SQLite。

**第 2 步（Trigger Manager）的骨架完成**——`storage/triggers.py`（active 那張
表）、`runs/triggers.py`（key + spec 的 diff、重啟恢復）、`/api/triggers`。P1
那張「§9.2 要的 / 這裡有嗎」的表現在只剩最後一格是叉。

**2b（cron）完成**（design v0.26）——`blocky/cron.py`（解析與排程共用一份）、
APScheduler、`timezone` 必填、`concurrency: drop`。

**下一步是 2c（webhook）**：`event.when_webhook` + FastAPI 動態路由
`/hooks/{32位隨機}/{使用者路徑}`（§9.3）。key 與 spec 的形狀跟 cron 一樣
（`opcode#blockId` + path），所以 diff 那一半不用重寫；新的是**路由要動態
增刪**，而 FastAPI 的 router 沒有現成的移除 API——那大概是這一步最花時間的地方。

**cron 留下三個已知缺口**：

1. **編輯器沒有時區的輔助**。宣告刻意沒有 default（給 UTC 會讓台北的使用者在
   下午五點觸發），所以拖出一顆 cron 積木之後**存檔一定先失敗一次**，訊息叫他
   填時區。這是對的行為，但使用者得自己知道 `Asia/Taipei` 這種寫法。真正的解
   要嘛是一顆下拉，要嘛是一個「拖出來時填入瀏覽器時區」的宣告
   （像 `defaultFrom: timezone`）——後者是一次 schema 決定，照 Q21 的同一條理由
   不該夾在別的工作裡做。
2. **`queue` 與 `restart` 沒實作**（§5.1），目前與 `parallel` 同行為。`drop`
   做了，因為 `when_cron` 宣告的就是它，而它是真的需要。
3. **interval 沒做**（§9.1 說「支援 cron 與 interval」）。目前只有五欄 crontab，
   所以最小粒度是一分鐘。

下面這兩塊是 P1 鋪好的，接的時候要接在它上面而不是重寫：
1. **`start_trigger` 的整條管線已經在生產路徑上跑過真的長連線了**（在這之前它
   只有合約測試用 `demo` 包走過）。trigger 死掉會說話（`trigger_error_text`，
   兩個 host 共用一句）。
2. **前端的「監聽」是輪詢 `GET /api/runs`**（1.5 秒）。落地之後那個端點已經
   吃得下 `?projectId=`，所以輪詢至少不再拿回全部——但**「有新的 Run 了」該怎麼
   推還沒決定**：那條通道要回答「屬於哪個專案」「斷線怎麼補」「backlog 留多久」。
   三題都還在，只是不再卡在「歷史存不存在」上。

**Q19（可重複參數群組）現在可以動了**：它等的就是「先讓 P1 的三個手寫包磨過一
輪」，而那一輪結束了。`try_catch` 的多個 catch 與 HTTP 的多個 header 是同一個
形狀。

## 3. 未解決問題與已知限制

只列還會咬人的。長版理由在 `git log` 與程式碼註解裡。

### 3.1 積木包與 Host（P1 留下的）

- **`http` / `openai` / `discord` 都沒有 conformance 題目**：§17 的題庫跑不了本地
  伺服器與外部帳號，所以那三條路的回歸網是各自的 `tests/`（`http` 那份含一題走
  引擎的端到端）。
- **`discord` 的測試靠蓋掉 `discord.http.Route.BASE`**。`openai` 有 `base_url`
  這條乾淨的路（自架相容端點是真的存在的東西，測試搭順風車）；Discord 沒有相容
  端點，所以一個 `base_url` 設定會是「為了測試而長在使用者面板上的一格」。代價是
  那份測試綁著 SDK 的一個內部名字，**換大版本時要複驗**。
- **`discord` 的 hat 沒有參數**：「只聽某個頻道」很有用，但 hat 的參數要一路穿過
  `start_trigger` 才到得了 `@trigger` 函式，而 §9.2 的 trigger 生命週期本來就是
  P2 的事。現在塞進去等於在生命週期還沒有主人的時候先決定它怎麼變。
- **`discord.on_message` 寫死濾掉自己那隻 bot 的訊息**。別的 bot 不濾
  （`${author.bot}` 交給畫布判斷）。這是全包唯一一條寫死的過濾，理由是「收到訊息
  就回一句」是這顆 hat 最直覺的第一個用法，而它會讓 bot 對著自己講到被限流。
- **`openai` 沒有 `count_tokens`**：`tiktoken` 第一次用會自己去
  `openaipublic.blob.core.windows.net` 抓 BPE 檔（用 `requests`，不經 `ctx.http`）。
  要補回來就得先決定「包可以自己連網嗎」，並把 `TIKTOKEN_CACHE_DIR` 釘到
  `~/.blocky` 底下。**注意這一題現在有前例了**：`discord` 就是一個合法地自己連網
  的包（見 §7.4），所以答案已經不是「不行」，而是「守得住的是 venv 與審閱」。
- **`openai` 的 `chat_full` 沒有 `temperature`**：新的 reasoning 模型會不會拒收這個
  參數，不打真 API 驗不出來。**要加就得先拿真金鑰打一次**。
- **`openai` 與 `discord` 的測試用 `InProcessHost`**，所以兩個包都得裝在 backend 的
  dev extras 裡。副作用：`venv.py` 的 `.pth` 把 backend 的 site-packages 接進每一支
  積木包 venv，所以**沒有自己宣告 `requirements` 的包會吃到 backend 這一份**。兩個
  包都自己宣告了，現在不咬人。
- **`venv.py::_link_backend_site_packages()` 只在建立 venv 時跑一次**（`pyvenv.cfg`
  不存在才呼叫）。venv 在、`.pth` 卻不見了就不會補回去，症狀是子 process 連
  `blocky` 都 import 不到。改成無條件寫就沒事（它是 idempotent）。
- **逐次的 timeout 不能設**：只有 host 那份 30 秒預設值。要做就是 `request` 多一個
  `number` 參數。
- **§13.3 的佔位符前端沒做**：專案用到未安裝的包時，`deserialize` 遇到認不得的 type
  會怎樣**沒有驗過**——後端已經會給 `unknown_block`，前端那一半是空的。
- **積木包自帶的 `tests/` 靠 `testpaths = ["tests", "../extensions"]` 收**。包來自
  repo 外面時這條就不成立了。另外它靠 `addopts = ["--import-mode=importlib"]` 才容得下
  每個包都叫 `tests/test_blocks.py`。
- **manifest 是 `palette` 一份清單**：三種條目（`opcode` / `button` / `section`），
  `blocks` 由模型導出。**加第四種條目時記得兩邊都要認**——後端
  `manifest.py::_entry_kind`、前端 `define.ts` 的三個 narrowing 函式，共用的是「有沒有
  那個 key」這條規則，而它沒有被抽成一份東西。
- **一個包的 manifest 壞掉，整個 `GET /api/extensions` 就 500**，編輯器變成「連不上
  後端」。`discover()` 一份讀不過就整批拋。**`main.py` 壞掉不會**（那條路只讀
  manifest），而且錯誤訊息會指名檔案與行號——實測過。
- **`@button`（D25 的 `action: call`）整條沒實作**：`blocky/__init__.py` 的白名單裡
  沒有 `button`，也沒有 `POST /api/extensions/{id}/button/{name}`。`discord` 的
  「測試連線」本來是它最自然的第一個消費者，這一輪用 `open_url` 的說明按鈕頂著。
- **`reads` 宣告沒有消費者**（`toolbox.ts::findVariableReader` 與後端欄位都留著）。
  下次動那塊時重新決定留或刪。

### 3.2 靜態檢查（`ir/checks.ts`）

- **「有路徑未回傳」是退化版**：只守「一顆 `回傳` 都沒有」，半條路沒回傳仍然只有執行期看得到。
- **作用域是扁平的**，所以 `data.set` 同名於函式參數時不警告 shadowing（§5.4 要求）。
- **參數積木放錯地方只有執行期會說**。出口是 §4.6 的存檔期驗證：`_validate_structure`
  要認得 `procedure.param` 的 `mutation.proc` 與祖先鏈。
- **檢查不進存檔路徑**（§8.5「不阻擋連接」），孤兒警告與 `CheckRunner` 是兩本帳。

### 3.3 編輯器

- **積木包新增一個參數之後，既有專案裡那一格是空的輸入孔**（§16 Q21）。填不了東西、
  看不出該放什麼。**修在 `deserialize` 是錯的**——試過，會打破 3 題 roundtrip：
  `object.get` 的 `default` 孔**刻意可以不存在**（不寫 = 找不到 key 就報錯），所以
  「IR 裡沒這個孔」不等於「這參數是新加的」。IR 目前分不出這兩件事，而那正是 Q21
  要先回答的。
- **監聽中的 Run 靠輪詢**（1.5 秒），所以 hat 觸發之後畫面上的高亮最多晚一秒多。
  壞掉的樣子是「慢了一秒」而不是「少了一則」——那是刻意選的。
- **標頭在錯誤訊息很長時會擠成兩行**（按鈕跟著換行）。資訊都在，只是難看。
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
- **鍵盤走不進浮動工具列與預覽積木**，所以分段的文字與順序只有滑鼠改得動。
- **三處依賴 Blockly 內部行為，換版時要複驗**：右鍵選單的 `preconditionFn` 快取、
  `WidgetDiv` 靠焦點活著（按鈕用 `pointerdown` + `preventDefault`）、keydown 必須
  capture 才問得到「編輯器開不開著」。加上兩個 CSS hack：`.injectionDiv
  { overflow: visible }` 與欄位編輯器的 inline style（`!important`）。

### 3.4 執行期與後端

- **「子行程意外結束」那句話原本會指錯主詞。** 回報的現場是一個**不回應的網站**
  （換一個網址就好了），而最可能的機制是：積木包卡在那個請求上 → 使用者按了停止
  或再按一次執行 → 那個 Run 收尾時 `unload` → `_kill` 砍掉還在等回應的子行程 →
  進行中的呼叫拿到 `PeerClosed`。**那不是積木包壞掉，是我們自己砍的**，而使用者
  做的動作是「停止」。現在先問「這個 worker 還是目前那一個嗎」，不是就說「還沒
  跑完，這次執行就結束了」。真正意外死掉的那條路也補了死因（`_why_gone`：結束碼
  ／被第幾號信號終止／行程還在只是連線斷了）——三種成因完全不同，而原本那句話
  三種長得一模一樣。**這條沒有測試**：它要的是「呼叫進行中把 worker 換掉」，
  而那是時序，不是規則。
- **監聽不跨後端重啟、也與瀏覽器綁在一起**（記憶體）。§9.2 要的「專案標記為
  active、trigger 常駐、重啟從 SQLite 恢復」全部是 P2。
- **點一下就跑 = 每次都先存檔**（PUT + POST），沒有節流。監聽也是（按下監聽會先存）。
- **`block.enter` 沒帶展開後的字串**，所以「滑過欄位看到實際送出的內容」還不存在。
- **錯誤紅框淡出之後 `error` 這個 phase 還在**：同一顆積木在同一次執行裡錯第二次不會
  重新倒數（要有 `try_catch` 才做得出來）。
- **`block.error` 沒有 traceback**，§8.3 的「點擊展開」目前只展得出 hint。
- **運算積木不發子步驟事件**（§4.7b）；`var.set` 的窗口內收斂（§6.2）比文件寫的多。
- ~~**§6.3 的 SQLite 落地沒做**~~ **P2 第 1 步做完了**（design v0.24）：執行歷史與
  持久值進了 SQLite、跨後端重啟存活，`GET /api/runs/{id}/events` 上線，保留策略是
  每個專案最近 200 次。**§6.3 的「Trace 模式」（使用者明確開啟後全量落地）沒做**
  ——它是那條規則的逃生口，但目前沒有人被咬到需要它。
- **§5.5 的「清理有 5 秒上限」沒實作**，停止時只是 `cancel()`。
- **遞迴 headroom 是估的**（`PYTHON_FRAMES_PER_BLOCKY_FRAME = 24`），靠 `RecursionError` 兜底。
- **`blocky serve` 沒有正式打包測試**：只驗過 `python -m blocky.cli`。
- **偏好存 localStorage**，§16 Q15（偏好放哪）未定案。

### 3.5 測試缺口

- **版面與時間只有瀏覽器實測守著**（jsdom 量不到 `getBoundingClientRect` /
  `getComputedTextLength`）：半形單字置中、值氣泡的 hover 凍結、淡出的時間、浮動工具列
  的位置、flyout 版面、focus trap「Tab 真的停在哪」。
- **動態下拉的「依賴那一格變了就重抓」那條 workspace listener 沒有單元測試**——它要
  一個真的 workspace。`load()` 那一半有測（args 進 body、快取 key 含 args、值不會被
  清掉），瀏覽器裡也實測過選伺服器 → 頻道清單跟著換。
- **「建立一個新函式」那條路沒有單元測試**（`placeDefinition` 要畫面）。改簽章那條有。
- **`data.list_insert` 用 `len+1` 正規化索引，無測試**，可疑。
- **§17.2 有幾列還寫不出題目**：`concurrency` 的 drop/queue/restart、`CancelledError`
  穿透、§6.3 的落地——都要等 P2 的機制存在。
- **那 45 顆沒有題目的積木**，參數名有 AST 測試守著，缺的是「它真的跑得動」那半。

## 4. 未決題

design.md §16 的 Q1、Q3–Q9、Q11、Q12、Q14、Q15、Q17、Q19、Q20、Q21 仍未決。
已決的：Q2（廣播訊息，不做，D14）、Q10（開發者路線，v0.17）、Q13（內建宣告放後端，
D21）、Q16（字面值型別，第 6 步）、Q18（`control.stop` 是 cap block，第五輪）。

三題現在到期了：

- **Q19（可重複參數群組）** 等的是「先讓 P1 的三個手寫包磨過一輪」——到了，排 P2。
- **Q20（`照字典序比` 要不要留）** 的判準寫的是「**P1 結束時**如果沒有任何一份真實
  專案或題庫選過 `text`，就在那時拿掉」。P1 結束了，該去數。
- **Q21（新增參數之後既有專案那一格）** 是這一輪新開的，見 3.3。

---

### 七件從實測裡學到、值得帶到下一輪的事

1. **「規則對了，但少走了一條路。」** 每一輪幾乎都是這個形狀，而共同點是每次都省了
   一步「使用者真的會怎麼做」，**那一步只有把東西交出去才問得到**。
2. **單元測試每一步都綠，串起來才炸。** 修法是讓那幾步變成一個函式，不是再抄一份
   順序去測。
3. **規則對、時機錯。** 加檢查時要問的不只是「它說的對不對」，還有**「它會在哪一刻說」**。
   這一輪的應用：動態下拉的依賴變了「只重抓、不清空這一格的值」——清空要判斷這次
   變動是不是使用者造成的，而載入專案、undo、拖動走的是同一條事件路，代價是**默默
   弄丟一個存過的值**。
4. **測得到的是規則，測不到的是順序。** 凡是「我讀的狀態別人也在改」的判斷，都要問
   一次「我跑在誰前面」。
5. **兩邊都對，中間那句話沒有人負責。** **把東西端到端跑一次是唯一問得出這種問題的
   方法**——而它花的時間比寫那兩份測試少。
6. **驗收驗了值，bug 在樣子。** 寫驗收句時要問：**這句話如果只有一半壞掉，我看得出來
   嗎。** 這一輪又中兩次，而且兩次都只有瀏覽器看得到：`default: ""` 的下拉畫出來是
   一個沒有文字、沒有箭頭、看起來不能點的空膠囊；新增參數之後既有專案那一格是一個
   填不了東西的空孔。**兩件事的單元測試都是綠的，因為值一直都是對的。**
7. **翻裝下來的原始碼，不要用訓練資料裡的記憶去猜。** 這一輪三件事都是這樣翻出來的
   （`login()` 不開 gateway、`ctx.http` 注不進去、`jump_url` 吐 `@me`），三件如果照
   猜的寫下去都會是「到執行期才炸、而且訊息指錯方向」。上一輪的 `httpx2` 也是。
   **這條規矩到目前為止的命中率是 100%。**

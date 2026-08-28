# PROGRESS

最後更新：2026-08-28（含第一次實測回饋）｜ 11 commits
｜ 後端 `cd backend && .venv/bin/python -m pytest` → 382 passed, 2 skipped（題庫 63 題）
｜ 前端 `cd packages/editor && npm test` → 86 passed（23 define + 52 round-trip + 11 run store）

## 1. 本次完成

**P0b 第 5 步：`/api/runs` + WS 事件 + §6.2 批次與聚合 + 停止 API + §8.3 視覺回饋**

**§15 驗收 1 過了。** 拉出「重複 10 次 → 改變 count 增加 1 → log」，按執行，積木
逐顆發光、變數面板即時跳動、log 一行一行冒出來；換成 `forever` 的緊迴圈，
每秒跑一百五十萬顆積木，畫面只有一顆積木在脈動、角落寫著「持續執行中
×3,055,101」，按停止立刻斷。三百萬次迭代與十次迭代對前端來說是同一種畫面成本
——那就是 §6.2 標「必須做」的全部意思。

### 後端

- `runs/broker.py` — §6.2 的三層流量控制。**規則寫成一個純函數 `collapse()`**，
  時序留給 `RunBroker`：「一個窗口內超過 20 次就聚合」「同名 `var.set` 只留最後
  一次」這種東西必須用讀得懂的方式斷言，不能靠「跑一個迴圈然後數 frame」——
  後者在慢的 CI 上會變 flaky，然後被人加上 sleep，然後就沒有人知道它在測什麼。
- `runs/manager.py` — Run 的生命週期。一個 Run = 一個 `Interpreter` + 一個
  `RunBroker` + 一個 driver task，綁在同一個 `RunHandle` 上一起生一起死。
- `api/runs.py` — `POST/GET/DELETE /api/runs`、`WS /ws/run/{runId}`。WebSocket
  的收發是**兩個並行的 task**：序列化處理的話，`{"op":"stop"}` 會排在事件後面，
  在緊迴圈裡等於「按了沒反應」。
- `engine.py` 加 `request_stop(thread_id=None)`。它與 `control.stop` 積木的
  `StopSignal` 是兩件事：後者是腳本自己走到那顆積木，前者是外面的人插手，只能
  `task.cancel()`。**能中斷緊迴圈靠的是 §5.2 每 512 顆積木一次的 `sleep(0)`**
  ——那是真正的暫停點，設計文件寫「確保取消訊號能被處理」時就是為了今天。
- `EventSink` 多了 `on_emit` / `retain`：題庫要留全部事件，實際執行要 `retain=False`
  ——一個掛著跑的 `forever` 迴圈會把幾億筆早就送出去的事件堆在記憶體裡。
- `api/validation.py` 拆出 `open_project()`：存檔驗完就關積木包，執行要讓它活到
  Run 結束。共用同一份，載入順序（先積木包再專案，D20）就不會有第二份實作。

### 前端

- `api/runs.ts` / `run/store.ts` / `run/decorate.ts` / `components/Run*.tsx`。
  事件 → 狀態 → 畫面切成三段，因為**一個事件會影響好幾個地方**：`block.error`
  同時要標紅積木、進 log、讓 topbar 說出是什麼錯。讓 WS handler 直接去碰 Blockly
  和 DOM 的話，這三件事就再也拆不開。
- 積木高亮走 SVG 的 class + CSS，不用 Blockly 的 `setHighlighted` / `addSelect`
  ——那兩個是「選取」的語意，會跟使用者自己點選積木打架。
- 值氣泡是 HTML 疊在 SVG 上，位置每個 animation frame 讀一次
  `getBoundingClientRect()` 寫進 `transform`：縮放、捲動、拖曳全部免費跟上。
- 執行 = **先存檔再跑**。後端跑的是已存檔的那一份，所以按執行必然先 PUT 一次
  ——順帶讓 §4 的載入期驗證在執行之前就把壞掉的積木標紅。

**做的過程中發現的三件事**

| 發現 | 為什麼要記 |
|---|---|
| 黃色高亮框在橘色的 `control` 積木上**幾乎看不見** | 積木顏色來自各自的 manifest（§8.1），是別人決定的——高亮就不能假設底色。改成白色描邊（在深色積木上分界）+ 外發光（在淺色積木上分界），兩者互補。這是 D21「內建與第三方走同一條路」的一個沒預料到的後果：連高亮都不能寫死配色 |
| `run.end` 走的是 `apply()` 不是 `finish()`，於是正常跑完的專案**最後兩顆積木會一直發光** | 只有「連線意外斷掉」才呼叫 `finish()`。看起來像卡住了。收尾必須跟著 `run.end` 這個事件走，不是跟著連線的生命週期走 |
| `TestClient` 不進 `with` 的話，每個 request 各起一個 event loop 再關掉 | `POST /api/runs` 建立的 Run task 會在回應送出的同一刻被那個 loop 收走，於是「執行」變成「執行然後立刻被取消」。這是這一步唯一一個會讓人以為產品碼壞掉的測試環境陷阱，寫在 fixture 的 docstring 裡 |

**設計文件補了三條**（§6.2）：`count` 是累計而非窗口內次數、聚合事件放在第一次
出現的位置（擺批次末尾會排到同一批的 `run.end` 後面）、以及第一個訂閱者接上
之前的 backlog。第三條是被逼出來的：`POST` 回應與 WebSocket 接上之間有幾毫秒
空窗，沒有緩衝就固定看不到 `run.start` 與最前面幾顆積木——而那正是使用者盯著
看的部分。相對的做法是「Run 卡住等 WebSocket 才開跑」，但那會讓執行的完成與否
取決於前端有沒有連上來，cron 觸發時就沒有人來解鎖了。

## 2. 未解決問題與已知限制

- **`var.set` 的窗口內收斂是這一步新增的規則**（同名只留最後一次），已寫進
  §6.2。它與 `block.hot` 同一個道理，但它比設計文件原本寫的多——如果之後要做
  「變數變化的歷史曲線」，這條收斂就是第一個要重新談的東西。
- **§6.3 的 SQLite 落地沒做**，所以執行歷史只在記憶體、上限 50 個 Run，重啟就
  沒了。`GET /api/runs/{id}/events`（附錄 A）因此還不存在。`persist_*`（§5.4
  第 4 層）同樣只在 process 記憶體裡，跨 Run 存活但**不跨後端重啟**——那是
  D12 明講要有的性質，目前是欠的。
- **§5.5 的「清理有 5 秒上限」沒實作**。停止時只是 `cancel()`，擴充在 `finally`
  裡拖多久就拖多久。P0b 只有內建積木、沒有東西要清，但 P1 接上 `ctx.http` 之後
  這條就會咬人。
- **`block.error` 沒有 traceback**：`BlockyError.to_dict()` 只有 type/code/
  message/blockId/hint，所以 §8.3 說的「點擊展開 traceback」目前只展得出 hint。
  完整 traceback 要跟 §6.3 的落地一起做。
- 🔴 **擋路的 bug：畫布上留一顆沒接 hat 的積木就存不了檔。**
  `ir/serialize.ts:52` 把**每一顆**頂層積木都當成一個 script，而
  `ir/schema.py:325` 要求每個 script 的 `top` 必須是事件積木 → 422。實際的工作
  方式是先拉幾顆試試看，所以這條等於逼使用者邊做邊收拾。設計文件已補上決定
  （§4.1）：**沒有 hat 的堆疊是合法 IR，只是永遠不會被 trigger 觸發**——§5.1 的
  觸發條件本來就是「top 的 opcode 等於這次的 trigger」，引擎那邊不必改一行。
  **hat 出現在堆疊中間**仍然是載入期錯誤，但那條檢查早就獨立存在
  （`_require_shape`：`next` 接的積木必須是 command 形狀），所以這裡是**刪掉一條
  檢查**而不是拆成兩條。第 5b 步第一項。
- **非字串字面值打不出來**：`data.set`、`operator.eq` 這類參數宣告成通用
  `type: string`（可以放任何 IR 值）的孔，**編輯器目前只能透過文字框打字**，而
  文字框只產得出字串——打 `99` 拿到的是 `"99"` 不是 `99`，布林與 `null` 更是沒有
  入口。這不是可以隨手修的 bug：`operator.eq` 的題庫測資明確要求字串 `"5"` 與
  數字 `5` 是不同的東西（§4.4.1），content-sniffing（看起來像數字就轉數字）會
  直接破壞那條語意。設計文件已列成 **§16 Q16** 並寫了三個候選解；**判定跟第 6 步
  一起做**，理由見 §3。
- **P1 剩下的部分刻意延後**：SubprocessHost 與跨 process 的反向通道（§7.6）、
  `ctx.http`（§7.4）、secret 值遮蔽（§12.2）、migrations（§13.2）。介面已定案、
  合約測試已對 host 參數化，SubprocessHost 接上去只要在 `HOSTS` 加一行。
- **§8.4 完成了轉換，但沒有互動編輯**：函式的 mutator 對話框、變形失敗後的孤兒
  處理、靜態警告全部還是第 7 步的事。`procedures.ts` 的每函式一組類型是撐到
  第 7 步的過渡機制，不是最終形態。
- **變數索引 `variables` 目前一律存空物件**。§4.5 說這欄位是衍生索引，刪掉重算
  不影響執行語意；變數監看面板現在的來源是**執行中的 `var.set` 事件**，不是這個
  索引，所以它繼續留空仍然是誠實的。
- **`ui.multiline` 的第三層（強制切換）還沒接上序列化**。`FieldText` 已經有
  `setForcedMultiline`（第 3 步），但 `deserialize.ts`/`serialize.ts` 都還沒讀寫
  `blocks[].ui.multiline`——右鍵選單本身也還沒做（第 6 步）。
- **動態下拉（`source`）還是文字框**。要 `POST /api/extensions/{id}/dropdown/{source}`
  （§8.1 第 4 步，還沒排進施工順序，可能跟第 6 步一起）。
- **空的變數名稱欄位很難發現**。§8.5 的 autocomplete（第 6 步）會解決。
- **輸入框預設值的機制已經有，缺的是宣告**：`define.ts` 會把 manifest 的
  `arg.default` 當影子積木的初始值（所以「改變 count 增加 **1**」的那個 1 就是
  預設值），但不少 arg 宣告成 `default: ""`（如 `data.set` 的 `value`），看起來
  就像沒有預設值。這是補宣告的工作，不是補程式碼——第 5b 步。
- **事件積木的帽子形狀不夠 Scratch**：`define.ts` 已經照 D20 依宣告套
  `style: { hat: 'cap' }`，但 Blockly 畫出來的弧度比 Scratch 的圓頂平得多，
  在畫面上不太看得出「這是起點」。純渲染問題，第 5b 步。
- **題庫覆蓋不全，而且現在是可量化的**：87 顆內建積木只有 42 顆（48%）在題庫裡
  出現過（`BASELINE_COVERED`，第 3 步記的數字，這一步沒有新增題目所以沒變）。
  `data.list_insert` 用 `len+1` 正規化索引，仍**無測試**，可疑。
- **§17.2 有幾列還寫不出題目**：`concurrency` 的 drop/queue/restart、
  `CancelledError` 穿透、§6.3 的 SQLite 落地——都要等 P2 的機制存在。
  `block.hot` 聚合這一列**已經有題目了**（`test_runs.py`）。
- **`blocky serve` 沒有正式打包測試**：`[project.scripts]` 加了，但只驗過
  `python -m blocky.cli`，沒驗過 `pip install` 之後的 `blocky` 指令。
- **遞迴 headroom 是估的**：`PYTHON_FRAMES_PER_BLOCKY_FRAME = 24`
  （`interpreter/engine.py`）為經驗值，靠 `RecursionError` 保險絲兜底。
- **Q10 目標使用者未定**（教育 vs 開發者）。不阻擋 P0b；P1 的三個手寫包開工前必須定。
- 設計文件 §16 的 Q1、Q3–Q9、Q11、Q12 仍未決；**Q16（見上）新增**。

## 3. 下一次的第一個 TODO

**P0b 第 5b 步：編輯器體感（第一次實測回饋）**（估 3～5 天）。

這一批全部來自**把編輯器交到使用者手上跑一次**，沒有一條寫得進 P0a 的規格，
但每一條都直接決定這個工具堪不堪用。設計文件已經把決定寫進 §4.1、§5.1、§8.1、
§8.3、§4.5 與 §16 Q14–Q16，這裡只列施工項。

**十件事不是平行的**，前兩項有真正的依賴，其餘八項只是舒適度（§15）。

**先做這兩項，因為做完就能用 Scratch 的方式探索積木：**

- [ ] 🔴 **落單堆疊要能存檔**（§4.1）。處置是**刪掉** `schema.py:_validate_shapes`
      裡「腳本最上面必須是事件積木」那一條，不是拆成兩條——已實測確認：hat 放在
      堆疊中間由 `_require_shape`（`next` 必須是 command 形狀）擋下，有自己的
      錯誤訊息（`event.when_flag_clicked 是事件積木，只能放在腳本最上面`），
      刪掉上面那條不影響它。**引擎一行都不用改**（`engine.py:171` 本來就只挑
      `top.opcode == trigger` 的腳本）。順帶讓落單的 reporter 也變成合法頂層堆疊
      ——那是下一項要用的。編輯器對 inert 的堆疊標 warning icon
- [ ] **點一下就跑**（§5.1）。`POST /api/runs` 多收一個 `blockId`，從該堆疊頂端
      起跑；起點是 reporter/boolean 時只求值那一顆，用 §8.3 的值氣泡顯示結果。
      走同一套 Run 機制，不另開「試跑」路徑。**這是第 5b 步唯一碰執行核心的一項**：
      `_run_thread` 目前寫死從 `hat.next` 起跑，要多一條「從 top 自己起跑」的入口，
      估計要留給它——不要被上一項的便宜騙了

**以下彼此獨立，順序隨意。共同性質是只碰宣告與呈現層（`define.ts` / `setup.ts` /
CSS / manifest YAML），不碰 IR schema 與引擎：**

- [ ] **事件積木的帽子**畫成 Scratch 的圓頂，不是 Blockly 預設那個平弧
- [ ] **工具箱固定寬度 + 一條連續捲動軸**（§8.1）。`@blockly/continuous-toolbox`
- [ ] **左下角留擴充功能入口的位置**（§8.1）。只擺一個按鈕，點下去暫時是空面板；
      P1 才接上內容
- [ ] **值氣泡對齊積木中央**（§8.3）。`RunBubbles.tsx` 現在錨在
      `getBoundingClientRect()` 的左上角，改成用 `rect.left + rect.width / 2`
- [ ] **變數面板可關**（§8.3）。開關存 localStorage，**不進 IR**（§16 Q15）
- [ ] **`data.get` 的文字改成 `取得 (名稱)`**（§4.5）。改 `data.yaml` 一行；
      題庫的 `project.json` 不受影響（積木文字不進 IR），但要跑一次全套確認
- [ ] **補齊 manifest 的 `default`**：機制已經有，缺的是宣告。順帶體檢一遍
      87 顆積木的參數命名（第 2 步那次體檢的續集）

**這一項建議延到第 6 步：**

- [ ] ~~非字串字面值（§16 Q16）~~ → 第 6 步。傾向解 (a) 是「影子積木依當下的值
      選型別 + 右鍵切換」，而右鍵選單與欄位行為正是第 6 步 `FieldText` 要重寫的
      東西（`ui.multiline` 的強制切換也在等同一個右鍵選單）。現在做等於在一個
      即將被換掉的欄位上加功能。候選解 (c)（manifest 的 `literalKinds`）確實不
      依賴 `FieldText`，但 (a) 沒做之前沒有人讀它，先宣告只是把猜測寫進 manifest

**時程**：第 5b 步是插隊進來的。這 3～5 天不會壓縮第 6 步（那一步的 1～1.5 週
已經是上修過的誠實版本，不是可以再借的預算），所以它就是把 P0b 從 4～6 週推到
**5～7 週**。這是把東西交到使用者手上必然要付的錢——付得早比付得晚便宜。

**接著才是 P0b 第 6 步：`FieldText`（§8.5）**（估 1～1.5 週）——`${}` pill、
autocomplete、多行、運算式紅線。**這是整個 P0b 唯一的高風險項**，設計文件把原估
的 2～3 天明確上修成 1～1.5 週，理由是 Blockly 的自訂 field API 在富渲染上很難纏
（popup 在 textarea 內的定位、workspace 縮放時的座標換算）。**一次做成一個類別**，
用 options 開關能力——設計文件連續兩處警告不要先做三個再合併（§8.5、§15 施工
順序），第 3 步已經照這條留好了介面，第 6 步只換實作。完成驗收 3 與 4。

第 5 步留的著力點：值氣泡的定位邏輯（`RunBubbles.tsx` 那個 rAF 迴圈）就是
autocomplete popup 會遇到的同一個問題——**在縮放中的 workspace 上把 HTML 疊到
一個 SVG 元素旁邊**。那裡已經有一個可以照抄的答案，不需要再解一次。

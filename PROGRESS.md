# PROGRESS

最後更新：2026-08-28 ｜ 11 commits
｜ 後端 `cd backend && .venv/bin/python -m pytest` → 364 passed, 2 skipped（題庫 63 題）
｜ 前端 `cd packages/editor && npm test` → 75 passed（23 define + 52 round-trip）

## 1. 本次完成

**P0b 第 4 步：IR ↔ Blockly 雙向轉換（§8.4）+ property test + 接上存讀檔**（`packages/editor/src/ir/`）

**閉環了。** 拉積木、存檔、重新整理、積木原封不動地回來；存檔踩到後端驗證錯誤，
那顆積木會標紅、topbar 顯示後端的訊息一字不差——這一步做完之前那句話（「載入期
驗證是第二道防線」）才第一次真的被走過。

- `ir/deserialize.ts` — IR → Blockly。**沒有走 Blockly 的 workspace JSON 格式**，
  直接用 `serialization.blocks.append()` 逐個 script／函式定義餵一顆巢狀 `State`
  進去，blockId 原樣當 Blockly 的 `id` 傳下去——後端 422 回的 `blockId` 因此不需要
  對照表，直接 `workspace.getBlockById()` 就能標紅。
- `ir/serialize.ts` — 反過來，讀 `serialization.blocks.save()` 的巢狀狀態攤平回
  IR 扁平的 `blocks` map。`parent` 的算法只有一條規則：「這顆積木是被哪一次遞迴
  呼叫發現的」，不管是透過 `next`、輸入孔還是 C 型堆疊。
- `ir/template.ts` — **不是** `template.py` 的移植，只搬了存檔前端必須自己決定的
  兩件事：一格文字算 `literal` 還是 `template`、`whole` 怎麼算。`refs` 照設計文件
  §4.7 的話「不要在前端算」，一律送空陣列，後端自己重新解析。
- `blockly/procedures.ts` — `procedure.definition` / `procedure.call` 是 manifest
  裡唯一 `dynamic: true` 的積木（參數來自 `project.procedures`，不是宣告）。做法是
  **每個函式各自一組積木類型**（`procedure.call#p_sum`），直接餵給 `define.ts` 原本
  就有的 `buildBlock`——形狀、影子、`%()` 展開全部免費繼承，proc id 嵌在 Blockly
  `type` 字串裡，序列化不需要另外處理 Blockly 的 mutator/extraState。**這不是第 7
  步要做的互動式 mutator**，只是讓第 4 步的轉換層對函式積木一視同仁；換函式名稱
  或參數目前得整組重新註冊，第 7 步接手時多半會換掉這個機制。
- `scripts/gen-types.mjs` 擴充成同時吃 `manifest.schema.json` 與新增的
  `project.schema.json`，產生 `src/types/project.ts`——IR 現在跟 manifest 一樣，
  型別有唯一真實來源。
- `App.tsx` 接上 `GET/PUT /api/projects/prj_local`：讀不到就是新專案；存檔按鈕跑
  `serializeWorkspace` → PUT；422 帶 `blockId` 時 `setWarningText` + `select()`
  標紅，不帶就只顯示 topbar 的錯誤文字。單專案模式，專案列表留給之後。

**Property test：63 份題庫全部跑過 `deserialize → serialize`**（`ir/roundtrip.test.ts`），
52 份要求逐欄位相等，11 份因為下面兩個理由被排除且**寫明原因**：形狀本來就擺錯
位置／opcode 不存在（Blockly 自己的連接系統擋在比後端更早一層，測不了）；或字面值
是 `boolean`／`null`／字典下拉裡沒有的選項（編輯器的文字／數字影子畫不出這些
JSON 型別，只有手寫 IR 才寫得出來）。比對前用同一條「省略欄位＝預設值」規則把
兩邊的 dropdown／boolean 欄位拉平——這條規則跟 `deserialize.ts` 補 dropdown 預設值
是同一個發現，只是產品碼負責「保留現有的值」，測試負責「不要求猜哪種寫法比較對」。

**做的過程中發現兩個不算「坑」但值得記下來的設計判斷**

| 判斷 | 為什麼 |
|---|---|
| 字面值影子（文字 vs 數字）**依值本身的 JSON 型別選，不依 manifest 宣告的 arg type** | `data.set` 的 `value` 宣告成 `type: string`，但那只是「這孔用文字框編輯」的通用宣告——`operator.eq` 的 `a`/`b` 也宣告成 `type: string`，題庫卻故意塞一個字串 `"5"` 和一個數字 `5` 進去測「型別不同就不相等」（§4.4.1）。信任宣告的話兩邊會被同一種影子吃掉，測試想量的差異反而消失；信任值本身，兩邊各自的影子類型忠實反映當下的值，`equality_does_not_coerce` 這題才測得出東西 |
| `field_dropdown` 沒有明講初始值時，Blockly 只會選**選項列表的第一個**，不是 manifest 的 `default` | `debug.log` 的 `level` 第一個選項是「除錯」，manifest 宣告的預設卻是「資訊」。`define.ts` 早就為了工具箱算過這個對照（`fieldDefaults()`），這裡直接借同一份資料在 `deserialize.ts` 補上，`serialize.ts` 不需要對稱處理——因為「省略」和「明講預設值」在 IR 裡本來就是同一件事（`t.field(b, "level", "info")` 的 fallback） |

## 2. 未解決問題與已知限制

- **新的、值得記下來的產品缺口**：`data.set`、`operator.eq` 這類參數宣告成通用
  `type: string`（可以放任何 IR 值）的孔，**編輯器目前只能透過文字框打字**，而
  文字框只產得出字串——沒有辦法直接輸入一個真正的數字 `99`（不是字串 `"99"`）、
  布林 `true`、或 `null`。這不是這一步的 bug：`operator.eq` 的題庫測資明確要求
  字串 `"5"` 與數字 `5` 是不同的東西（§4.4.1），content-sniffing（"看起來像數字
  就自動轉數字"）會直接破壞這個測試想守住的區別，所以刻意不做。想在畫布上打出一個
  數字，目前只能接一顆 `operator` 或 `type.cast` reporter。要補上的話，屬於 §8.5
  文字欄位的能力範圍（第 6 步），或需要另一種積木/欄位承載非字串字面值——**Q16
  待補一條**。
- **P1 剩下的部分刻意延後**：SubprocessHost 與跨 process 的反向通道（§7.6）、`ctx.http`（§7.4）、secret 值遮蔽（§12.2）、migrations（§13.2）。介面已定案、合約測試已對 host 參數化，SubprocessHost 接上去只要在 `HOSTS` 加一行。
- **§8.4 完成了轉換，但沒有互動編輯**：函式的 mutator 對話框（新增/刪除參數、切換回傳型別）、變形失敗後的孤兒處理、靜態警告全部還是第 7 步的事。目前拉一顆函式呼叫積木、改函式參數，都還沒有 UI——`procedures.ts` 的每函式一組類型是撐到第 7 步的過渡機制，不是最終形態。
- **變數索引 `variables` 目前一律存空物件**。§4.5 說這欄位是衍生索引，刪掉重算不影響執行語意；但變數監看面板要用到之前，先誠實地留空，好過算一份會跟著這裡的規則慢慢漂移、卻沒有人用的索引。
- **`ui.multiline` 的第三層（強制切換）還沒接上序列化**。`FieldText` 已經有 `setForcedMultiline`（第 3 步），但 `deserialize.ts`/`serialize.ts` 都還沒讀寫 `blocks[].ui.multiline`——右鍵選單本身也還沒做（第 6 步）。
- **動態下拉（`source`）還是文字框**。要 `POST /api/extensions/{id}/dropdown/{source}`（§8.1 第 4 步，還沒排進施工順序，可能跟第 6 步一起）。
- **空的變數名稱欄位很難發現**。§8.5 的 autocomplete（第 6 步）會解決。
- **P0b 剩下的後端缺口**：Run 沒有**外部**停止 API、§6.2 的 50ms 批次與 `block.hot` 聚合沒實作。兩者都在第 5 步，沒有後者 `forever` 迴圈會打爆 WebSocket。
- **題庫覆蓋不全，而且現在是可量化的**：87 顆內建積木只有 42 顆（48%）在題庫裡出現過（`BASELINE_COVERED`，第 3 步記的數字，這一步沒有新增題目所以沒變）。`data.list_insert` 用 `len+1` 正規化索引，仍**無測試**，可疑。
- **§17.2 有幾列還寫不出題目**：`concurrency` 的 drop/queue/restart、`CancelledError` 穿透、`block.hot` 聚合、§6.3 的 SQLite 落地——都要等 P0b 第 5 步／P2 的機制存在。
- **`blocky serve` 沒有正式打包測試**：`[project.scripts]` 加了，但只驗過 `python -m blocky.cli`，沒驗過 `pip install` 之後的 `blocky` 指令。
- **遞迴 headroom 是估的**：`PYTHON_FRAMES_PER_BLOCKY_FRAME = 24`（`interpreter/engine.py`）為經驗值，靠 `RecursionError` 保險絲兜底。
- **Q10 目標使用者未定**（教育 vs 開發者）。不阻擋 P0b；P1 的三個手寫包開工前必須定。
- 設計文件 §16 的 Q1、Q3–Q9、Q11、Q12 仍未決；**Q16（見上）新增**。

## 3. 下一次的第一個 TODO

**P0b 第 5 步：`/api/runs` + WS 事件 + §6.2 批次與聚合 + 停止 API**（估 1 週）。
完成設計文件 §15 驗收 1（「重複 10 次 → 改變 count 增加 1 → log」跑起來、逐顆積木
高亮、變數面板即時變動、按停止能立即中斷）。

- [ ] `POST /api/runs`：拿目前這份（已存檔的）專案、跑 `interpreter/engine.py`，
      回傳 `runId`
- [ ] WebSocket 事件通道：`block.enter` / `block.exit` / `block.error` / `var.set`
      依 §6.1 的協定推給前端；§6.2 的 50ms 批次與 `block.hot` 聚合**必須做**，
      沒有它 `forever` 迴圈會在第一秒內打爆連線
- [ ] Run 的外部停止 API（不是 `control.stop` 積木內部那個 `StopSignal`）
- [ ] 前端訂閱事件，依 §8.3 的表把積木外框發光、reporter 冒值氣泡、`block.error`
      紅框接上——這一步能直接站在 `ir/deserialize.ts` 已經有的 blockId ↔ Blockly
      block 對應關係上，不需要再建一次對照表
- [ ] 「停止」按鈕打 Run 的外部停止 API，驗證能立即中斷

第 4 步刻意留的著力點：`App.tsx` 已經拿著 `workspaceRef`（真正的 `WorkspaceSvg`）、
`ConversionContext`，第 5 步只要在收到 WS 事件時用 `workspace.getBlockById(blockId)`
找積木、疊圖示上去，不需要重新設計狀態怎麼流動。

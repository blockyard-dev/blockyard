# Blocky Workflow — 設計文件

| 項目 | 內容 |
|---|---|
| 版本 | Draft v0.2 |
| 日期 | 2026-08-27 |
| 狀態 | 待審閱 |
| 代號 | `blocky`（暫定，套件名 `blocky-runtime`） |

---

## 0. 決策摘要

| # | 決策 | 理由 |
|---|---|---|
| D1 | 積木不直接產生程式碼，先序列化成 **IR (project.json)** | 讓「解譯執行」與「匯出 Python」變成同一份資料的兩個消費者，而非兩套系統 |
| D2 | Runtime 放在**本地 Python 後端**，不放瀏覽器 | 觸發器需常駐；避免每顆積木一次 HTTP |
| D3 | 前端用 **Blockly + zelos renderer**，不用 scratch-blocks | 外觀等同 Scratch 3.0，但有 TS 型別、持續維護、建置簡單 |
| D4 | 執行語意是 **control flow**（Scratch），不是 dataflow（n8n） | 介面選了 Scratch 就必須一致；混用會四不像 |
| D5 | 積木包 = **宣告式 manifest + 純函式實作**，兩者分離 | manifest 可被 schema 驗證，是 AI 生成可靠的前提 |
| D6 | 定位為 **local-first 單機工具**，但資料模型預留多租戶欄位 | 見 §14 未決問題 Q1，此為暫定決策 |
| D7 | 變數**不用「建立變數」按鈕**，改用 `set (變數) to ()` / `change (變數) by ()` 積木內直接輸入名稱 | 工作流的變數多半是一次性中繼值，預先宣告是多餘儀式；「寫入即建立」讓積木自我描述，也讓 AI 生成流程不必先操作 UI |
| D8 | 自訂函式**支援回傳值**，以 `return ()` 終止積木實現 | 工作流本質是資料加工，不能回傳值的函式無法組合，使用者只能靠全域變數傳值——那正是 Scratch 自訂積木最痛的地方 |
| D9 | 字串輸入框支援 `${路徑}` 插值，但**只支援路徑，永不支援運算式** | 沒有插值，取一個巢狀值就得堆 `join` 巢狀積木；但一旦允許 `${a+b}`，`${}` 就會滑成一套藏在文字框裡的迷你語言，與 D4 直接衝突 |
| D10 | JSON 的 **parse 不自動、stringify 自動**，兩者都由 manifest 宣告 + Host 邊界執行 | parse 是偏函數（會失敗、型別由伺服器決定），stringify 是全函數；把責任放在 manifest 而非 extension 作者，手寫的不會忘、AI 生成的不會漏 |
| D11 | list 索引鎖死 **1-based，不可設定** | 可設定的索引基底會讓同一份專案在別人機器上語意不同，且 `${items[1]}` 就無法自我描述 |

---

## 1. 目標與非目標

### 1.1 目標
- 提供 Scratch 風格的積木編輯器，讓非工程師組出自動化流程。
- 積木可執行真實副作用：HTTP 請求、Discord 訊息、LLM 呼叫、檔案讀寫。
- 支援事件觸發：手動、排程、Webhook、外部服務長連線。
- 第三方（含 AI）可以用穩定的格式擴充積木包。
- 專案可脫離 GUI 執行（匯出後於 CLI / 伺服器常駐）。

### 1.2 非目標（v1 不做）
- 繪圖 / 角色 / 造型 / 舞台等 Scratch 遊戲功能。
- 雲端託管、帳號系統、計費。
- 即時協作編輯。
- 真正的沙箱隔離（見 §11，v1 採「知情同意 + 靜態檢查」）。
- 行動裝置編輯體驗。

### 1.3 成功標準
使用者能在 10 分鐘內完成：拉一個「每天 09:00」的 hat，接一顆 `fetch` 抓 API，用 `if` 判斷結果，再用 `discord.send_message` 發通知；關掉瀏覽器後這個流程仍會準時執行。

---

## 2. 名詞定義

| 名詞 | 定義 |
|---|---|
| **Block** | 編輯器中的一顆積木，對應一個 opcode |
| **Opcode** | 積木的唯一識別字串，格式 `namespace.name`，例如 `discord.send_message` |
| **Script** | 一串由 hat 積木起頭的積木堆疊 |
| **Thread** | Script 的一次執行實例，對應一個 `asyncio.Task` |
| **Run** | 一次完整的專案執行（可含多個 thread） |
| **IR** | Intermediate Representation，即 `project.json` |
| **Extension** | 積木包，一個資料夾，含 manifest 與實作 |
| **Trigger** | 產生事件、進而啟動 thread 的來源（cron / webhook / 長連線） |

---

## 3. 系統架構

```
┌─────────────────────── 編輯器（瀏覽器 / WebView）────────────────────┐
│  React + TS + Vite                                                  │
│  ├ Blockly Workspace (zelos renderer)                               │
│  ├ Dynamic Block Registrar   ← GET /api/extensions (manifest)       │
│  ├ Run Inspector             ← WS  /ws/run (執行事件流)              │
│  └ Credential UI             → POST /api/extensions/{id}/config     │
└───────────────────┬──────────────────────────┬──────────────────────┘
                    │ REST (存檔/載入/列表)      │ WebSocket (單向事件為主)
┌───────────────────▼──────────────────────────▼──────────────────────┐
│  本地後端 — FastAPI + asyncio (127.0.0.1:8787)                       │
│                                                                      │
│  ┌ API Layer ────────────────────────────────────────────────────┐   │
│  │  /api/projects  /api/extensions  /api/runs  /ws/run  /hooks/* │   │
│  └───────────────────────────────────────────────────────────────┘   │
│  ┌ Orchestrator ─────────────────────────────────────────────────┐   │
│  │  Run Manager: 建立 Run、管理 Thread 生命週期、廣播事件           │   │
│  └───────────────────────────────────────────────────────────────┘   │
│  ┌ Interpreter ──────────────────────────────────────────────────┐   │
│  │  IR tree-walking，async；變數作用域；控制流；錯誤處理            │   │
│  └───────────────────────────────────────────────────────────────┘   │
│  ┌ Extension Host (抽象介面) ─────────────────────────────────────┐   │
│  │  v1: InProcessHost    v2: SubprocessHost（介面不變）            │   │
│  │  Registry / Loader / Config & Secrets / Dropdown Provider      │   │
│  └───────────────────────────────────────────────────────────────┘   │
│  ┌ Trigger Manager ──────────────────────────────────────────────┐   │
│  │  Cron / Webhook / Stream(async generator) → 產生 Thread        │   │
│  └───────────────────────────────────────────────────────────────┘   │
│  ┌ Codegen ──────────────────────────────────────────────────────┐   │
│  │  IR → Bundle / IR → 可讀 Python                                │   │
│  └───────────────────────────────────────────────────────────────┘   │
│  Storage: SQLite (專案、執行歷史、憑證) + 檔案系統 (extensions/)      │
└──────────────────────────────────────────────────────────────────────┘
```

**關鍵資料流**：整份 IR 一次 POST 給後端 → 後端解譯執行 → 每顆積木產生事件推回前端 → 前端做高亮與數值氣泡。前端**不參與執行決策**，只是顯示器與編輯器。

---

## 4. IR 規格（`project.json`）

### 4.1 頂層結構

```jsonc
{
  "formatVersion": 1,
  "meta": {
    "id": "prj_01H...",
    "name": "每日新聞通知",
    "createdAt": "2026-08-27T10:00:00Z",
    "updatedAt": "2026-08-27T10:32:11Z"
  },
  "extensions": [
    { "id": "http",    "version": "1.0.0" },
    { "id": "discord", "version": "1.2.0" }
  ],
  "variables": {                      // 掃描積木自動彙整，非使用者宣告，見 §4.5
    "count": { "firstSeen": "blk_7"  },
    "items": { "firstSeen": "blk_12" }
  },
  "procedures": {
    "p_greet": {
      "name": "打招呼",
      "params": [{ "id": "a1", "name": "對象", "type": "string" }],
      "returns": null,                // null = 無回傳值，呼叫積木為 command 形狀
      "body": "blk_50",
      "definitionBlock": "blk_49"
    },
    "p_sum": {
      "name": "加總",
      "params": [{ "id": "a2", "name": "清單", "type": "list" }],
      "returns": "number",            // 有回傳值，呼叫積木為 reporter 形狀
      "body": "blk_60",
      "definitionBlock": "blk_59"
    }
  },
  "scripts": [
    { "id": "sc_1", "top": "blk_1", "x": 120, "y": 80, "enabled": true }
  ],
  "blocks": { /* 見 4.2 */ }
}
```

`blocks` 採**扁平 map**（非巢狀樹），與 Scratch 一致。理由：blockId 全域唯一，執行事件只要帶 blockId 前端就能定位；Blockly 序列化也容易對映。

`variables` **不是宣告的結果，而是索引**：存檔時掃過所有積木的變數名稱欄位彙整而成，只供變數監看面板、名稱自動完成與靜態檢查使用。刪掉整個欄位再重新產生不影響執行語意（見 §4.5）。

### 4.2 Block 結構

```jsonc
"blk_2": {
  "opcode": "discord.send_message",
  "parent": "blk_1",
  "next": "blk_4",
  "inputs": {
    "message": { "kind": "block",   "id": "blk_3" },
    "channel": { "kind": "literal", "value": "1234567890" }
  },
  "fields": {},
  "mutation": null,
  "ui": null                       // 純呈現狀態，解譯器完全忽略，見下
}
```

`inputs` 的四種 `kind`：

| kind | 用途 | 額外欄位 |
|---|---|---|
| `literal` | 使用者直接輸入的值 | `value` |
| `template` | 含 `${}` 插值的字串，見 §4.7 | `value` `refs` `whole` |
| `block` | 由 reporter/boolean 積木求值 | `id` |
| `stack` | C 型積木的內部堆疊（迴圈體、if 分支） | `id`（該堆疊第一顆積木） |

`fields` 存不可為表達式的選項（純下拉、變數選擇器）。`mutation` 存自訂積木的參數結構。

`ui` 是**可選的呈現狀態袋子**（例如「這個欄位渲染成 textarea」），有三條硬規則：

- 解譯器與 codegen **完全忽略** `ui`，刪掉整個欄位不影響任何執行結果。
- validator 允許 `ui` 內出現任意未知 key（前向相容：舊版後端開新版專案不該報錯）。
- 語意屬性不准放進 `ui`，呈現屬性不准放進 `fields`。混在一起之後，diff 專案與 AI 生成 IR 都會被雜訊淹沒。

目前定義的 key 只有一個：`ui.multiline: string[]`，列出要渲染成多行的 input 名稱（見 §7.2、§8.5）。

### 4.3 值模型與型別轉換

支援型別：`null` / `boolean` / `number` / `string` / `list` / `object`。

比 Scratch 多了 `object`，因為工作流必然要處理 API 回傳的 JSON。轉換規則明確定義（避免 Scratch 那種到處隱式轉字串的混亂）：

| 目標 | 規則 |
|---|---|
| → number | 字串可 parse 則轉；`true`→1 `false`→0；`null`→0；list/object → 錯誤 |
| → string | number 去掉尾綴 `.0`；list/object 以 JSON 序列化；`null`→`""` |
| → boolean | `false` 的值：`false` `0` `""` `null` `[]` `{}`；其餘為 true |
| list/object 索引 | 見下方「索引規則」 |

型別不符時**拋出執行期錯誤並指出 blockId**，不靜默吞掉。

#### 索引規則

list 索引 **1-based，且不可設定**（D11）。

| 索引 | 語意 |
|---|---|
| `1` … `n` | 第 1 至第 n 項 |
| `0` | **專用錯誤**：「索引從 1 開始，你是不是要 `1`？」 |
| `-1` `-2` … | 倒數第一、倒數第二（Python 直覺） |
| `last` | 最後一項（積木下拉與 `${}` 路徑可用） |
| 超出範圍 | 執行期錯誤，不回 `null` |

1-based 用不到 0，那個位置正好空出來當「0-based 誤用」的偵測器——這比任何「索引基底」設定選項都有效，而且不必付出「同一份專案在別人機器上語意不同」的代價。

object 以 key 存取（`object.get` 積木或 `${obj.key}`）；**key 不存在是錯誤**，不是 `null`（與 §4.5 讀取未定義變數的嚴格性一致）。要容錯用 `object.has`，或 `object.get` 的預設值孔。

#### 「空」與 falsy 是兩件事

上表裡 `0` 是 falsy，但 `type.is_empty`（§4.8）對 `0` 回 **false**。這是刻意的不一致：「數字 0 不是空的」才符合直覺。若不分開，使用者只能寫 `not (值)`，然後被 0 咬。

### 4.4 內建 opcode 命名空間

| namespace | 內容 |
|---|---|
| `event` | `when_flag_clicked` `when_cron` `when_webhook` `broadcast` `when_broadcast_received` |
| `control` | `if` `if_else` `repeat` `repeat_until` `forever` `for_each` `wait` `wait_until` `stop` `try_catch` |
| `data` | `set` `change` `get` `new_list`；list 操作（add/delete/insert/replace/item/length/contains）。變數無需宣告，見 §4.5 |
| `object` | `get` `set` `keys` `has` `parse_json` `to_json`；parse 永不自動，見 §4.8 |
| `operator` | 算術、比較、邏輯、字串（join/letter/length/contains/regex） |
| `procedure` | `definition`（可宣告回傳型別）、`call`（依定義呈現 command 或 reporter）、`return`（終止積木），見 §4.6 |
| `type` | `cast` `try_cast` `is` `can_cast` `of` `is_empty`，見 §4.8 |
| `debug` | `log` `inspect` |

相對於 Scratch，這裡有五處**刻意的偏離**，都是工作流場景必需：`try_catch`（§5.6）、**可回傳值的自訂函式**（§4.6）、**免宣告的變數積木**（§4.5）、**字串插值**（§4.7）、**顯式型別積木**（§4.8）。


### 4.5 變數模型（免宣告）

**沒有「建立變數」按鈕，沒有變數的動態工具箱分類。** 變數就是幾顆積木，名稱直接寫在積木裡：

| opcode | 型 | 外觀 | 說明 |
|---|---|---|---|
| `data.set` | command | `設定 [名稱] 為 (值)` | 寫入；名稱不存在則建立 |
| `data.change` | command | `改變 [名稱] 增加 (值)` | 數值累加，等同 `set name to (get name + 值)` |
| `data.get` | reporter | `(名稱)` | 讀取 |
| `data.new_list` | reporter | `(空清單)` | 給 list 型變數初始化用，`設定 [items] 為 (空清單)` |

名稱存在 `fields.name`，是**純字串，不是 variable id**：

```jsonc
"blk_7": {
  "opcode": "data.set",
  "parent": "blk_6",
  "next": "blk_8",
  "fields": { "name": "count" },
  "inputs": { "value": { "kind": "literal", "value": 0 } }
}
```

#### 為什麼不用 id

Scratch / Blockly 原生的變數模型是「id + 名稱對照表」，好處是重新命名自動同步。但代價是：變數必須先經 UI 宣告才存在，IR 裡多一層間接，而且 AI 生成或手改 `project.json` 時得自己維護對照表。這裡選擇**名稱即識別**，換來的是積木自我描述、IR 可直接手寫。

**代價要明講**（下面兩小節的規則就是在補這兩個洞）：
1. 重新命名不會自動同步 → 編輯器提供右鍵「重新命名所有引用」（純字串取代，作用域為整個專案）。
2. 打錯字不會被結構擋下 → 用嚴格的執行期語意 + 執行前靜態檢查來抓。

#### 執行語意

- **寫入即建立**：`data.set` 對不存在的名稱直接建立，初值就是寫入值。
- **讀取未建立的變數 → 執行期錯誤**，不回傳 `null`、不當作 0。錯誤訊息帶 blockId、名稱，並附上工作區中編輯距離最近的名稱建議（`未知變數 "conut"，你是指 "count" 嗎？`）。
- `data.change` 與 list 操作**同樣要求變數已存在**。`change 未建立的變數 by 1` 是錯誤，不是從 0 起算——靜默把打錯字的名稱當成新變數，正是這個設計最大的風險，不能為了少打一顆 `set` 而放掉。
- 型別由值決定，變數本身無型別；`kind: scalar | list` 的概念取消（§4.3 的值模型已足夠）。

#### 執行前靜態檢查（編輯器端，不阻擋執行）

掃描全部積木，若某名稱只出現在 `data.get` / `data.change` 而從未出現在任何 `data.set` 的 `fields.name`，該積木顯示黃色底線與提示。這在按下執行**之前**就抓到 90% 的錯字，執行期錯誤只是最後一道網。

> 註：hat 的 `yields` 欄位與 procedure 參數也算「已定義」的來源，見 §5.4 的名稱解析順序。

---

### 4.6 自訂函式與回傳值

三顆積木：

| opcode | 形狀 | 外觀 |
|---|---|---|
| `procedure.definition` | hat（定義積木） | `定義 加總 (清單)` |
| `procedure.return` | **cap block**（上凹口、下無凸點） | `回傳 (值)` |
| `procedure.call` | 依定義而定 | `加總 (清單)` — 見下 |

**呼叫積木的形狀由定義決定**：定義時在 mutator 對話框勾選「這個函式會回傳值」並選型別，`procedures[].returns` 就從 `null` 變成 `"any" | "number" | "string" | "boolean" | "list" | "object"`。

| `returns` | 呼叫積木形狀 | 用途 |
|---|---|---|
| `null` | command（可接續下一顆） | 純副作用，等同 Scratch 的自訂積木 |
| `"boolean"` | boolean（六角形） | 可直接塞進 `if` 的條件孔 |
| 其他 | reporter（圓角） | 可塞進任何值輸入孔 |

`return` 積木長這樣：

```jsonc
"blk_60": {
  "opcode": "procedure.return",
  "parent": "blk_58",
  "next": null,                          // cap block，恆為 null
  "inputs": { "value": { "kind": "block", "id": "blk_61" } }
}
```

#### 執行語意

- 執行到 `return` → **立刻結束當前 procedure frame**，值成為呼叫端的求值結果。巢狀在迴圈或 `if` 內同樣有效：unwind 的邊界是 frame，不是整個 thread（這是它與 `control.stop this script` 的差別）。
- 實作用 Python 例外 `ProcedureReturn(value)`，在 frame 邊界攔截。
- **`try_catch` 不可捕捉 `ProcedureReturn`**。`except Exception` 會把 return 吞掉，導致「函式在 try 裡 return 就沒反應」這種極難查的 bug。`ProcedureReturn` 必須繼承 `BaseException`，或在 `try_catch` 的實作中顯式 re-raise。同理適用於 `CancelledError`。
- 跑完 body 沒遇到 `return` → 回傳 `null`。若 `returns` 非 `null`，編輯器靜態檢查提示「有路徑未回傳」（警告，不阻擋）。
- `return` 放在定義積木的 body 之外（例如直接掛在 hat 底下）→ **存檔時驗證錯誤**，不是執行期才報。
- 遞迴沿用 §5.4 的深度上限 200。
- **求值順序**：reporter 形狀的呼叫積木必然帶副作用（函式體可以發 HTTP、寫變數）。解譯器一律**由左而右、深度優先**求值輸入孔，順序在 §10.2 轉譯時也必須保持（副作用型 reporter 提升為暫存變數）。

#### 事件與 UI

呼叫積木照常送 `block.enter` / `block.exit`，reporter 形狀的 `block.exit` 帶 `value` = 回傳值，前端直接以數值氣泡顯示——**函式的回傳值和內建 reporter 一樣可以即時觀察**，這是解譯執行相對於轉譯的主要好處。

---

### 4.7 字串插值（`${...}`）

任何 `type: string` 的輸入框都支援 `${路徑}` 插值。沒有它，取一個巢狀值就得堆 `join` 巢狀積木——那是 Scratch 做文字組合時最痛的地方。

#### 核心限制：只有路徑，沒有運算式

> **`${}` 內只能是「路徑」，永遠不是「運算式」。**

`${a + b}`、`${count * 2}`、`${x ? y : z}`、`${upper(name)}` 一律是**解析錯誤**，訊息直接教育：「`${}` 內不支援運算，請用積木」。

這條線要守得很硬。一旦允許算術，下一步就是函式呼叫、就是三元運算子，`${}` 會滑成一套藏在文字框裡的迷你語言——那和 D4「介面選了 Scratch 就必須一致」直接衝突。要算術就拉積木，那正是這個產品存在的理由。

> 附帶結論：**字串輸入框不該禁止任何字元**。那裡是使用者寫 Discord 訊息、URL、LLM prompt 的地方，禁掉 `.` `$` `-` 等於讓積木不能用。字元限制屬於變數名稱欄位（見下），而「使用者以為 `${}` 裡能算數學」這個真正的風險，靠上面那條解析規則 + 一句好的錯誤訊息來解，不是靠鍵盤攔截。

#### 語法

| 寫法 | 意義 |
|---|---|
| `${name}` | 讀變數，走 §5.4 的名稱解析順序（參數 → thread-local → 全域） |
| `${user.name}` | object 取 key |
| `${items[1]}` | list 取索引，**1-based**（§4.3） |
| `${items[-1]}` / `${items[last]}` | 倒數第一 / 最後一項 |
| `${resp.items[1].title}` | 混合鏈 |
| `$${` | 逸出，輸出字面的 `${`；其餘 `$` 一律字面，不需逸出 |

變數名稱只需禁掉**會讓路徑無法解析的字元**：`.` `[` `]` `{` `}` `$` 與首尾空白。中文、空格、底線一律允許。`+ - * /` 不禁——`${a+b}` 會在解析階段就被判為運算式而報錯，那個訊息比「不給你打」清楚得多。此限制實作在 §8.5 的變數名稱欄位上。

#### 整格取值 vs 字串拼接

| 欄位內容 | 結果 |
|---|---|
| `${items}` — 整格**恰好只有一個插值、沒有其他文字** | **回傳原值，保留型別**（list 就是 list） |
| `第 ${i} 筆：${title}` — 含其他文字 | 各段依 §4.3 轉字串後拼接 |

第一條是刻意的：沒有它，`${resp.items}` 就不能直接餵進 `for each`，使用者得繞一圈 `解析 JSON`。代價是同一個欄位可能回傳非字串——所以編輯器必須在該欄位以不同底色標記「這格回傳原值」（§8.5）。

#### IR 表示：第四種 `kind`

**解譯器不掃描 `literal` 找 `${`。** 那會讓一個正當寫著 `${HOME}` 的 shell 指令被偷偷替換。改成存檔時就解析完畢：

```jsonc
"message": {
  "kind": "template",
  "value": "第 ${i} 筆：${resp.items[1].title}",
  "refs": [
    { "root": "i",    "path": [] },
    { "root": "resp", "path": ["items", 1, "title"] }
  ],
  "whole": false          // true = 整格取值，保留型別
}
```

`refs` 是解析快取，三個好處：§4.5 的靜態檢查直接吃它來驗證 `i` / `resp` 是否曾被 `data.set`（現有機制零成本延伸）；§10.2 轉譯不必重新 parse；執行期錯誤能指到第幾段。`kind: "literal"` 因此維持「笨資料」——這對 AI 生成 IR 特別重要。

不含 `${}` 的字串一律存成 `literal`，不存成 `whole: false` 的空 template。

#### 生效範圍

| 參數型別 | 插值 |
|---|---|
| `string` | 開 |
| `code`（多行程式碼） | **關**——會撞到目標語言自己的 `${}`。manifest 可 `interpolate: true` 打開 |
| `number` / `boolean` / `dropdown` / `secret` / `json` | 關 |
| `data.set` 等的 `fields.name` | 關（變數名不做間接） |

`number` 欄位不開插值是刻意的：「重複 `${n}` 次」請把 `data.get` 積木插進孔裡，那才是 Scratch 的作法，而且看得見。

#### 錯誤語意（與 §4.5 一致，一律嚴格）

| 情況 | 行為 |
|---|---|
| `${nope}` 變數不存在 | 執行期錯誤，附編輯距離最近的名稱建議 |
| `${user.nickname}` key 不存在 | 執行期錯誤（要容錯請用 `object.has` 或 `object.get` 的預設值孔） |
| `${items[9]}` 越界 / `${items[0]}` | 執行期錯誤；`[0]` 用專屬訊息（§4.3） |
| `${str.foo}` 對字串取屬性 | 錯誤，訊息為：「`str` 是文字不是物件，是不是需要先用『解析 JSON』？」 |
| `${a + b}` 等運算式 | **存檔時**驗證錯誤，不是執行期才報 |

倒數第二列那句錯誤訊息值得單獨投資——它同時服務 `object.get` 誤用的場景（§4.8），是整份設計裡投入產出比最高的一行字。

---

### 4.8 型別積木

§4.3 定義了轉換規則，卻沒給使用者**主動觸發轉換**與**檢查型別**的手段。工作流一定會碰到髒資料（API 回 `"123"` 而不是 `123`），所以這組積木是必需品而非便利品。

| opcode | 形狀 | 外觀 | 語意 |
|---|---|---|---|
| `type.cast` | reporter | `將 (值) 轉為 [數字 ▼]` | 依 §4.3 轉換，**失敗即執行期錯誤** |
| `type.try_cast` | reporter | `將 (值) 轉為 [數字 ▼]，失敗時 (0)` | 轉不動就用預設值 |
| `type.is` | boolean | `(值) 的型別是 [數字 ▼] 嗎?` | 問**實際型別** |
| `type.can_cast` | boolean | `(值) 可以轉成 [數字 ▼] 嗎?` | 問**可轉換性** |
| `type.of` | reporter | `(值) 的型別` | 回 `"number"` 等字串，log / debug 用 |
| `type.is_empty` | boolean | `(值) 是空的嗎?` | `""` `[]` `{}` `null` → true；**`0` → false** |

`cast` 維持嚴格（失敗即錯誤）以符合 §4.3「不靜默吞掉」的原則；`try_cast` 則是為了避免使用者為了處理髒資料而把每個轉換都包進 `try_catch`——`if <可轉成數字> then … else …` 是四顆積木，`try_cast` 是一顆。

#### 為什麼 `is` 和 `can_cast` 必須是兩顆

`"123"` 對 `type.is [數字]` 是 **false**，對 `type.can_cast [數字]` 是 **true**。

這兩個問題在工作流裡天天都會用到，共用一顆積木的話使用者永遠猜不到答案是哪個。所以積木文字上就要用「**的型別是**」與「**可以轉成**」把差異寫在臉上，不能只寫「是…嗎」。

#### 下拉選項

| 積木 | 選項 |
|---|---|
| `type.cast` / `type.try_cast` | `數字` `文字` `布林` |
| `type.is` / `type.can_cast` | `空值` `布林` `數字` `文字` `清單` `物件` |

`cast` 的下拉**不含清單與物件**：把字串變成物件只可能是 JSON parse，而那必須是一顆看得見的 `解析 JSON` 積木（見下）。讓 `轉為物件("{\"a\":1}")` 悄悄 parse，正是這份設計一路在避免的魔法。

#### 兩個違反 JS 直覺的地方，要寫死在文件與 tooltip 裡

- **`清單` 與 `物件` 是兩種不同型別**，不像 JS `typeof []` 也回 `"object"`。`type.is [物件]` 對 `[]` 回 **false**。
- **`null` 是獨立型別**。`type.is [物件]` 對 `null` 回 **false**。

#### JSON：parse 不自動，stringify 自動

`object.parse_json` / `object.to_json` 兩顆都保留：前者給「字串本來就在變數裡」的場景，後者給「我就是要一個 JSON 字串當文字用」（塞進訊息、寫檔）。

而「積木要不要幫我自動轉」的答案在兩個方向上**刻意不對稱**。這不是不一致，是兩者的數學性質不同：

| 方向 | 自動？ | 理由 | 機制 |
|---|---|---|---|
| 回應 → 物件（parse） | **否** | 偏函數：會失敗（伺服器回 HTML 錯誤頁），且結果型別由伺服器決定。同一顆積木有時回 object 有時回 string，是災難 | 積木以 `returns` 宣告，Host 邊界**驗證**（§7.5） |
| 物件 → body（stringify） | **是** | 全函數：依 §4.3 任何值都轉得出來，沒有失敗模式；「我把物件塞進 body」的意圖也毫無歧義 | 參數以 `type: json` 宣告，Host 邊界**正規化**（§7.5） |

關鍵在於**兩個方向都在 manifest 宣告、都在同一個邊界執行**，而不是「規定每個 extension 作者自己寫防呆」。後者手寫的會忘、AI 生成的一定漏；前者只要 manifest 填對就不可能錯，而 manifest 有 schema 可驗證（D5）。

因此 `http` 這類積木包應該出兩顆積木（`取得 JSON` / `取得文字`）而不是一顆加上執行期嗅探——**畫布上一眼就看得出你手上拿的是什麼**。

---

## 5. Runtime 執行模型

### 5.1 併發模型
- 每個 Script 的一次執行 = 一個 `asyncio.Task`（稱 Thread）。
- 多個 hat 同時觸發 → 多個 Task 並行，共享全域變數。
- 同一個 hat 重複觸發時的行為由 manifest 的 `concurrency` 決定：`parallel`（預設）/ `queue` / `drop`（前一輪未結束就丟棄新事件）/ `restart`。

### 5.2 沒有 frame clock
Scratch 以 30fps 為單位讓出控制權。本專案**不採用**：這裡沒有畫面要渲染，迴圈應以最快速度執行。做法是每執行 N 顆積木（預設 512）或遇到 await 點時 `await asyncio.sleep(0)` 讓出 event loop，確保取消訊號與 WebSocket 能被處理。

### 5.3 同步阻塞的擴充函式
擴充可寫成 `def`（同步）或 `async def`。同步函式一律丟進 `ThreadPoolExecutor` 執行。

**已知限制**：執行緒中的同步呼叫**無法被中途取消**，按下「停止」時該顆積木會跑完才結束。manifest 需宣告 `blocking: true` 讓 UI 提示。長時間操作建議擴充作者提供 async 版本。

### 5.4 變數作用域

變數沒有宣告（§4.5），所以**作用域完全由名稱解析順序決定**，由內而外：

1. **Procedure 參數** — 呼叫時建立 frame，遞迴深度上限 200（超出拋錯，避免堆疊爆掉）。參數在 frame 內唯讀，`data.set` 同名視為寫全域並在編輯器警告 shadowing。
2. **Thread-local** — hat 提供的欄位（如 `on_message` 的 `content`、`author`）與 `try_catch` 綁定的 `error`，只在該 thread 可見，唯讀。
3. **全域變數** — 整個專案共享，跨 thread 可見。並發寫入以 asyncio 單執行緒語意保證原子性（不會有 torn read）。

`data.set` **一律寫入全域層**（前兩層唯讀）。也就是說：目前沒有「函式區域變數」，遞迴函式若用同名變數當暫存會互相覆蓋——見 §16 Q6。

### 5.5 停止與清理
- `stop all` / 使用者按停止 → 對所有 Task 呼叫 `cancel()`。
- `CancelledError` 允許擴充在 `finally` 做清理（關連線、刪暫存檔），但清理有 5 秒上限，逾時強制拋棄。
- Trigger 的長連線在 Run 結束後仍保持（Trigger 生命週期獨立於 Run）。

### 5.6 錯誤處理
1. 積木拋出例外 → 若在 `try_catch` 內，捕捉並綁定 `error` 變數（含 `message` / `type` / `blockId`）。
2. 否則該 Thread 中止，其餘 Thread **繼續執行**。
3. 事件 `block.error` 推給前端 → 該積木紅框 + 錯誤氣泡。
4. 完整 traceback 寫入執行歷史（SQLite），UI 可展開。
5. `try_catch` **只捕捉積木層級的錯誤**：`ProcedureReturn`（§4.6）、`CancelledError`（§5.5）、`StopScript` 三者必須穿透，不得被當成一般例外吃掉。

---

## 6. 事件協定（WebSocket）

`ws://127.0.0.1:8787/ws/run/{runId}`，後端 → 前端為主。

### 6.1 事件型別

```jsonc
{ "op": "run.start",    "runId": "r_1", "ts": 1724... }
{ "op": "thread.start", "threadId": "t_1", "scriptId": "sc_1" }
{ "op": "block.enter",  "threadId": "t_1", "blockId": "blk_2" }
{ "op": "block.exit",   "threadId": "t_1", "blockId": "blk_2",
                        "value": {"status":200}, "durationMs": 143 }
{ "op": "block.error",  "threadId": "t_1", "blockId": "blk_2",
                        "error": { "type": "HTTPError", "message": "404", "traceback": "..." } }
{ "op": "var.set",      "name": "count", "value": 3 }
{ "op": "log",          "level": "info", "text": "...", "blockId": "blk_9" }
{ "op": "thread.end",   "threadId": "t_1", "status": "ok|error|cancelled" }
{ "op": "run.end",      "runId": "r_1",  "status": "ok|error|cancelled" }
```

前端 → 後端僅有：`{"op":"stop"}`、`{"op":"stop_thread","threadId":...}`。

### 6.2 流量控制（必須做，否則迴圈會打爆 UI）
- 事件在後端以 **50ms 為窗口批次送出**（單一 WS frame 內含 event 陣列）。
- 若某 blockId 在一個窗口內觸發超過 **20 次**，改送聚合事件：
  `{"op":"block.hot","blockId":"blk_7","count":4210,"lastValue":...}` — 前端顯示為「持續執行中 ×4210」而非逐次高亮。
- `value` 欄位序列化上限 **4KB**，超過則截斷並標記 `"truncated": true`，完整值需由 `GET /api/runs/{id}/values/{blockId}` 取得。

---

## 7. Extension 規格

### 7.1 目錄結構

```
extensions/discord/
├── manifest.yaml       # 宣告：積木長相、參數、權限、依賴
├── main.py             # 實作：純函式
├── requirements.txt
├── icon.svg
├── migrations/         # 選填，opcode 變更的遷移腳本
└── tests/test_blocks.py
```

### 7.2 manifest.yaml

```yaml
manifestVersion: 1
id: discord
name: Discord
version: 1.2.0
author: "..."
color: "#5865F2"
permissions: [net]          # net | fs.read | fs.write | subprocess | env
requirements: ["discord.py>=2.3,<3"]

config:                      # 使用者需填的設定，secret 型別存進金鑰庫
  - key: bot_token
    type: secret
    label: "Bot Token"
    help: "從 Discord Developer Portal 取得"

blocks:
  - opcode: send_message
    type: command                       # command | reporter | boolean | hat
    text: "發送訊息 %(message) 到頻道 %(channel)"
    args:
      message: { type: string, default: "hello", multiline: true, rows: 4 }
      channel: { type: dropdown, source: list_channels }
    blocking: false

  - opcode: post_webhook
    type: reporter
    returns: object                     # 合約，Host 在邊界驗證，見 §7.5
    text: "POST %(url) 內容 %(body)"
    args:
      url:  { type: string }
      body: { type: json, default: "{}" }   # Host 在邊界正規化，見 §7.5

  - opcode: get_channel_history
    type: reporter
    returns: list
    text: "取得 %(channel) 最近 %(limit) 則訊息"
    args:
      channel: { type: dropdown, source: list_channels }
      limit:   { type: number, default: 10, min: 1, max: 100 }

  - opcode: on_message
    type: hat
    text: "當收到 Discord 訊息"
    yields:                             # 綁進 thread-local 的變數
      - { name: content, type: string }
      - { name: author,  type: string }
      - { name: channel, type: string }
    concurrency: parallel
```

參數型別：`string` `number` `boolean` `dropdown` `secret` `object` `list` `json` `code`（多行文字）。

#### 參數的三個修飾欄位

| 欄位 | 適用 | 說明 |
|---|---|---|
| `multiline: true` / `rows: n` | `string` `code` | 欄位渲染成 textarea 而非膠囊型輸入。積木作者最清楚 prompt、訊息內文需要多行，應主動宣告；§8.5 另有兩層 fallback |
| `interpolate: true \| false` | `string` `code` | 覆寫 §4.7 的預設（`string` 開、`code` 關） |
| `returns` | reporter / boolean 積木 | 從「文件」升格為**合約**，由 Host 在邊界驗證（§7.5） |

#### `json` 與 `object` / `list` 的差別

`object` / `list` 是**嚴格宣告**：值不是該型別就是錯誤，不做任何轉換。`json` 是**結構化資料入口**，Host 在 dispatch 前正規化（§7.5）：物件與清單直接放行，字串則嘗試 parse。

任何「要把資料送出去」的參數都應宣告成 `json`。這樣 `main.py` 裡永遠拿到 dict / list，**不必寫一行防呆**（D10）。

### 7.3 main.py

```python
from blocky import block, dropdown, trigger, on_load, on_unload

@on_load
async def setup(ctx):
    ctx.state["client"] = await connect(ctx.config["bot_token"])

@on_unload
async def teardown(ctx):
    await ctx.state["client"].close()

@block("discord.send_message")
async def send_message(ctx, message: str, channel: str) -> None:
    await ctx.state["client"].send(channel, message)
    ctx.log(f"已發送到 {channel}")

@dropdown("discord.list_channels")
async def list_channels(ctx) -> list[dict]:
    return [{"label": c.name, "value": str(c.id)}
            for c in await ctx.state["client"].fetch_channels()]

@trigger("discord.on_message")
async def on_message(ctx):
    async for msg in ctx.state["client"].stream():
        yield {"content": msg.content,
               "author": msg.author.name,
               "channel": str(msg.channel.id)}
```

**Trigger 用 async generator**：每 `yield` 一次就啟動一個 Thread，yield 的 dict 綁成 hat 的 `yields` 變數。cron 與 webhook 是內建 trigger，用同一套介面實作，沒有特例。

### 7.4 ctx 介面

| 成員 | 說明 |
|---|---|
| `ctx.config` | manifest 宣告的設定值（secret 已解密） |
| `ctx.state` | 該 extension 的常駐狀態（連線池、client） |
| `ctx.log(msg, level)` | 推 `log` 事件到前端 |
| `ctx.block_id` | 當前執行的積木 id（錯誤定位用） |
| `ctx.get_var / set_var` | 讀寫專案全域變數 |
| `ctx.http` | 共用的 httpx client（帶逾時與重試預設值） |
| `ctx.cancelled` | 協作式取消檢查點，長迴圈中應主動檢查 |

### 7.5 Extension Host 抽象（重要）

即使 v1 是 in-process，dispatch 一律經過此介面，以便 v2 換成 subprocess 而不用改 Interpreter：

```python
class ExtensionHost(Protocol):
    async def call(self, opcode: str, args: dict, ctx_token: str) -> Any: ...
    async def dropdown(self, opcode: str, source: str, ctx_token: str) -> list[dict]: ...
    async def start_trigger(self, opcode: str, sink: Callable) -> TriggerHandle: ...
    async def load(self, ext_id: str) -> None: ...
    async def unload(self, ext_id: str) -> None: ...
```

隱含約束：**args 與回傳值必須可 JSON 序列化**。從第一天就強制執行，否則 v2 換 IPC 時會發現到處在傳 Python 物件。

#### 邊界的正規化與驗證

`call` 除了 dispatch，還要在 args 進去、回傳值出來時各做一件事。這兩件事**只在此處實作一次**，extension 作者不需要、也不應該自己寫：

```python
# 進：依 manifest 的 args 型別正規化
#   type: json    → object / list 直接放行
#                   string 試 parse；失敗則錯誤「參數 body 收到的文字不是合法 JSON」
#                   其他型別 → 錯誤
#   type: number  → 依 §4.3 轉換，失敗則錯誤
#   其餘型別      → 嚴格檢查，不做轉換
#
# 出：依 manifest 的 returns 驗證
#   宣告 returns: object 卻回了 string → 立刻錯誤，訊息指向該 extension
```

回傳值驗證看似瑣碎，但它把「宣告 object 卻回了字串」擋在源頭，而不是三顆積木之後才以「文字沒有 items」的形式爆開（§4.7）。成本近乎為零（反正已經要求 JSON 可序列化），對 AI 生成的積木包尤其重要——它只要填對 manifest 就不會錯。

### 7.6 依賴隔離
每個 extension 一個獨立 venv，用 `uv venv` + `uv pip install`（速度是 pip 的數十倍，對「安裝積木包」的體驗差異很大）。v1 in-process 時以 `sys.path` 前置該 venv 的 site-packages 載入；有版本衝突風險，v2 subprocess 後自然消失。

---

## 8. 前端架構

### 8.1 動態積木註冊

啟動流程：
1. `GET /api/extensions` 取得所有 manifest。
2. 將 manifest 轉成 Blockly 的 block definition（`%(name)` → Blockly 的 `%1` + args 陣列）。
3. `Blockly.defineBlocksWithJsonArray()` 註冊，並依 `color` 產生對應的 toolbox category。
4. dropdown 型參數註冊為 dynamic dropdown，展開時才呼叫 `POST /api/extensions/{id}/dropdown/{source}`（附帶同積木其他已填參數，讓下拉可依賴前一個選項，例如先選 server 再列 channel）。結果快取 60 秒，並提供手動重新整理。

因此**新增積木不需要改前端一行程式碼**。

### 8.2 狀態管理
- `useWorkspaceStore`（zustand）：專案 meta、變數、髒標記。
- `useRunStore`：runId、thread 狀態、blockId → 執行狀態的 map、log buffer（上限 5000 筆，環形）。
- Blockly workspace 本身是 uncontrolled，不放進 React state；只在存檔/執行時 `Blockly.serialization.workspaces.save()` 導出。

### 8.3 執行時視覺回饋
| 事件 | UI 表現 |
|---|---|
| `block.enter` | 積木外框發光（Scratch 的黃框） |
| `block.exit` (reporter) | 積木上方浮出數值氣泡，2 秒後淡出 |
| `block.exit` 值為 object / list | 氣泡改為**可展開的 JSON tree**，不是截斷字串——使用者「看得到」自己拿的是物件還是文字，這是最有效的型別防呆（§8.5） |
| `block.error` | 紅框 + 錯誤氣泡，點擊展開 traceback |
| `block.hot` | 外框持續發光 + 角落顯示執行次數 |
| `var.set` | 變數監看面板即時更新 |

### 8.4 IR ↔ Blockly 轉換
Blockly 原生序列化格式與 §4 的 IR 不同（Blockly 是巢狀）。需要雙向轉換層 `ir/serialize.ts` / `ir/deserialize.ts`，並用 property-based test 確保 `deserialize(serialize(ws))` 等價。**不要**直接把 Blockly 格式當 IR 存檔——那會讓後端綁死在前端函式庫的版本上。

### 8.5 變數、函式與文字欄位的編輯器行為

這三塊是唯一**不能**照抄 Blockly 預設值的地方。

**變數（§4.5）**
- **關閉** Blockly 的 `VARIABLE` 動態分類與「建立變數」按鈕（`toolbox` 不放 `<category custom="VARIABLE">`），也不使用 `field_variable`。
- 自訂欄位 `FieldText`（見下）開啟「變數名稱」模式：可直接打字，聚焦時下拉列出**工作區中已出現過的名稱**供點選。功能上像 autocomplete，本質仍是字串欄位——序列化出來就是 `fields.name`。
- 名稱只禁掉會讓 `${}` 路徑無法解析的字元：`.` `[` `]` `{` `}` `$` 與首尾空白（§4.7）。中文、空格、底線允許；`+ - * /` 不禁。
- 右鍵選單加「重新命名此變數的所有引用」：掃全工作區同名欄位一次替換，並產生一筆可 undo 的 Blockly event group。
- 變數監看面板的清單來源 = 掃描工作區，不是 `variables` map（後者只在存檔時產生）。
- 靜態檢查（§4.5）以 Blockly 的 warning icon 呈現在積木上。

**函式（§4.6）**
- 定義積木的 mutator 對話框除了參數列，多一個「回傳值」區塊：勾選 + 型別下拉。改變它會**即時重塑工作區中所有該函式的呼叫積木**（command ↔ reporter ↔ boolean）。
- 形狀改變可能讓既有連接失效（原本接在 command 下方的積木、或原本插在孔裡的 reporter）。處理方式：斷開的積木**留在原地成為孤兒**，不刪除，並標記 warning。靜默刪掉使用者的積木是不可接受的。
- 函式分類的工具箱是動態的：`definition` 與 `return` 固定提供，`call` 積木依專案內既有定義即時產生（同 Scratch）。
- `return` 積木只在函式定義的 body 內可放置——用 `onchange` 檢查祖先鏈，放錯位置時標 warning，存檔時擋下（§4.6）。

**文字欄位 `FieldText`（§4.7、§7.2）**

變數名稱、`${}` 插值、多行渲染三件事**必須是同一個自訂 field 類別**，用 options 開關能力，而不是三個獨立的 field。這是前端最容易低估的一塊：三個分開做之後一定要合併（多行欄位裡的插值 pill 怎麼換行？autocomplete popup 在 textarea 裡怎麼定位？），先合再拆的成本遠低於反過來。

- `${}` 插值以 pill 樣式行內渲染；整格取值的欄位（`whole: true`）給不同底色，提示「這格回傳原值」（§4.7）。
- 打 `$` 跳出自動完成，來源與變數名稱下拉相同（掃描工作區）。
- `${}` 內出現運算子 → 紅色底線 + warning icon，存檔時擋下（§4.7）。
- 執行時 `block.enter` 附帶展開後的字串，滑過欄位可看到實際送出的內容。

多行渲染由三層決定（用官方 plugin `@blockly/field-multilineinput`）：

| 層級 | 機制 | 狀態存在哪 |
|---|---|---|
| 宣告 | manifest `multiline: true` / `rows: n` | manifest |
| 自動 | 值含換行、或長度 > 60 → 自動改多行 | **不存**——判斷依據就是值本身，是純函數 |
| 強制 | 右鍵「切換為多行」 | `blocks[].ui.multiline`（§4.2） |

第三層不能省：單行 field 裡按 Enter 是「提交」不是「換行」，所以**空欄位的使用者根本打不出第一個換行**，永遠觸發不了第二層。內建積木（如 `log`）沒有 manifest，也只剩這條路。

**型別提示：用警告，不用形狀**

object / list **不新增積木形狀**。理由是形狀會說謊：`data.get (response)` 是一顆橢圓，執行期卻可能是 object；變數必須能插進 object 孔，所以該孔的 check 必然得放行橢圓——放行之後，形狀唯一擋得住的只剩「直接插一個字面字串」，攔截率趨近於零，卻要付出第四種視覺文法的代價（並違背 D3/D4 的 Scratch 心智模型）。

改用三招，成本更低而效果更好：

| 手段 | 說明 |
|---|---|
| 靜態警告 | 已知 `returns` 的積木插進宣告型別不符的孔 → 黃色 warning icon，**不阻擋連接**。完全複用 §4.5 既有的 warning 機制。動態型別本來就有正當的例外，Blockly 的 connection check 只會「禁止連接」，太硬 |
| 值氣泡 | object / list 渲染成可展開的 JSON tree（§8.3） |
| 針對性錯誤訊息 | `object.get` 拿到字串時說「這是文字不是物件，是不是需要先用『解析 JSON』？」，與 §4.7 共用同一段訊息 |

宣告 `returns: object` / `list` 的 reporter 可在積木上加一個小小的 `{}` / `[]` 圖示。它反映的是**宣告**型別而非執行期型別，所以不會說謊——屬於誠實的視覺提示。

---

## 9. Trigger Manager

### 9.1 內建 trigger
| Trigger | 積木 | 實作 |
|---|---|---|
| 手動 | `event.when_flag_clicked` | 前端 POST `/api/runs` |
| 排程 | `event.when_cron (expr)` | APScheduler，支援 cron 與 interval |
| Webhook | `event.when_webhook (path)` | FastAPI 動態路由 `/hooks/{token}/{path}`，payload 綁成 `body` / `headers` / `query` |
| 擴充 | 任何 `type: hat` | extension 的 async generator |

### 9.2 生命週期
- 專案標記為 **active** 時，Trigger Manager 依據 IR 中的 hat 積木註冊所有 trigger。
- Trigger 常駐於後端 process，與瀏覽器是否開啟無關。
- 專案編輯後：diff 新舊 IR 的 hat 集合，只重啟有變動的 trigger（避免長連線無謂斷開）。
- 後端重啟時從 SQLite 恢復所有 active 專案的 trigger。

### 9.3 Webhook 安全
路徑含隨機 token（`/hooks/{32位隨機}/{使用者路徑}`），避免被掃描。可選 HMAC 簽章驗證（在 hat 積木參數中設定 secret）。

---

## 10. 匯出 Python

兩種模式，優先級不同。

### 10.1 Bundle 模式（P3 先做，工作量小）
```
export/
├── project.json
├── requirements.txt        # 內建 runtime + 所有用到的 extension 依賴
├── extensions/             # 複製用到的積木包
└── run.py
```
```python
# run.py
from blocky_runtime import Runtime
Runtime.from_file("project.json").run_forever()
```
使用者可 `python run.py`、`docker build`、丟上 VPS 常駐。**這滿足 90% 的「我要離開 GUI 自己跑」需求**，且與解譯器共用同一份程式碼，零維護成本。

### 10.2 Transpile 模式（P3 後段）
產生可讀的 Python 原始碼。

映射規則：
| IR | Python |
|---|---|
| script（單一 hat） | `async def script_1():` |
| 多個 script | `asyncio.gather(script_1(), script_2(), ...)` |
| `control.repeat(n)` | `for _ in range(n):` |
| `control.forever` | `while True:` + `await asyncio.sleep(0)` |
| `control.wait(s)` | `await asyncio.sleep(s)` |
| `data.set` / `data.change` | 模組層變數指派 / `+=`；名稱 slugify + 衝突加後綴 |
| `procedure.definition`（`returns: null`） | `async def proc_x(...) -> None:` |
| `procedure.definition`（有 `returns`） | `async def proc_x(...) -> T:`，落到函式尾端補 `return None` |
| `procedure.return` | `return <expr>` |
| reporter 形狀的 `procedure.call` | `await proc_x(...)`；巢狀在其他運算式中時提升為暫存變數以保證求值順序 |
| reporter 巢狀 | 依運算子優先級決定是否加括號；副作用型 reporter 提升為暫存變數以保證求值順序 |
| 變數 | 全域變數 → 模組層變數，名稱經 slugify + 衝突加後綴 |
| `kind: "template"`（`whole: false`） | f-string |
| `kind: "template"`（`whole: true`） | 裸運算式，保留型別 |
| `${a.b[1]}` 路徑 | helper `_path(a, "b", 1)`，內含 1-based → 0-based 轉換與越界檢查 |
| list 索引積木 | 一律經 `_path` / `_item`，**不直接下標** |
| `type.cast` / `type.try_cast` | `_cast(v, "number")` / `_try_cast(v, "number", 0)` |
| `type.is` / `can_cast` / `of` / `is_empty` | 對應 helper |
| `blocks[].ui` | 忽略（§4.2） |
| cron hat | 產生 APScheduler 樣板 |

helper 一律輸出到產出檔頂端的 `# --- blocky runtime helpers ---` 區塊。**索引基底的轉換只能存在於 `_path` 一處**——散開來就會長出 off-by-one 的鬼故事。

參考 Blockly 內建的 Python generator 架構（優先級表、變數命名、縮排管理），但輸出目標是 asyncio 而非同步程式碼。

**已知限制**：`stop all`、broadcast 的語意在轉譯後不完全等價，需在產出檔頂端以註解標示。這是可接受的——transpile 的定位是「產生可繼續手改的起點」，不是「保證等價」。

---

## 11. AI 生成積木包

### 11.1 為什麼放在 P3
manifest schema 必須先用**至少 3 個手寫積木包**（http / discord / openai）打磨到穩定。schema 一改，先前 AI 生成的內容全部作廢。

### 11.2 生成流程
```
使用者描述需求
   ↓
LLM ← 注入：manifest JSON Schema + ctx API 型別定義 + 2 個完整範例包
   ↓
產出 { manifest.yaml, main.py, requirements.txt }
   ↓ ① Schema 驗證（pydantic）——失敗則帶錯誤訊息重試，最多 3 次
   ↓ ② 靜態掃描（AST）——偵測 subprocess / eval / exec / open / socket，
   ↓                      比對 manifest 宣告的 permissions，不符則標記
   ↓ ③ 臨時 venv 安裝依賴 + import 冒煙測試
   ↓ ④ 完整程式碼攤開給使用者審閱，權限以醒目方式列出
   ↓ ⑤ 使用者確認 → 安裝到 extensions/
```

第 ④ 步不可省略也不可摺疊。這是 v1 唯一的安全防線。

### 11.3 迭代
生成後若執行出錯，把 `block.error` 的 traceback 回饋給 LLM 修正，形成修復迴圈。錯誤訊息中已含 blockId 與 opcode，定位資訊充足。

---

## 12. 安全模型

**威脅**：extension 程式碼（尤其 AI 生成或他人分享的）在使用者機器上以使用者權限執行，等同任意程式碼執行。

### 12.1 v1 措施（知情同意）
| 措施 | 內容 |
|---|---|
| 程式碼審閱 | 安裝前完整顯示原始碼，不可略過 |
| 權限宣告 | manifest 宣告 `permissions`，UI 以清單呈現 |
| 靜態掃描 | AST 偵測危險呼叫，與宣告不符時警告 |
| 憑證隔離 | secret 存於 OS keyring（`keyring` 套件），extension 只拿得到自己 config 宣告的項目 |
| 綁定 localhost | 後端預設只監聽 127.0.0.1；Webhook 需外部存取時由使用者自行決定是否開放 |
| CSRF | REST API 要求 `Origin` 檢查 + 啟動時產生的 session token |

### 12.2 v2 措施（實質隔離）
- SubprocessHost：每個 extension 獨立 process，透過 stdio JSON-RPC 通訊。
- 逐步加入 OS 層限制（Linux seccomp/namespace、macOS sandbox-exec、Windows Job Object）。
- 選配的 container 執行模式。

**架構要求**：§7.5 的 ExtensionHost 介面與「args 必須可 JSON 序列化」的約束**從 P0 就強制**，否則 v2 等同重寫。

---

## 13. 版本相容與遷移

### 13.1 不可變 opcode 原則
opcode 一經發布**永不變更語意、永不移除參數**。需要改動時：
- 新增 opcode（`send_message_v2`），舊的標記 `deprecated: true`（工具箱隱藏但既有專案仍可執行）。
- 新增選填參數是相容變更；新增必填參數不是。

### 13.2 遷移腳本
```python
# extensions/discord/migrations/1.2.0_rename_channel.py
def migrate(block: dict) -> dict:
    if block["opcode"] == "discord.send_message" and "chan" in block["inputs"]:
        block["inputs"]["channel"] = block["inputs"].pop("chan")
    return block
```
開啟專案時，比對專案記錄的 extension 版本與目前安裝版本，逐一套用區間內的遷移腳本，並提示使用者「專案已升級」。

### 13.3 缺少 extension 的處理
專案用到未安裝的積木包時：**保留該積木為佔位符**（灰色、顯示原 opcode 與參數），不刪除、不報廢整個專案。提供一鍵安裝。這是 Scratch 做得不好而 n8n 做得好的地方。

---

## 14. 專案目錄結構

```
blocky/
├── packages/
│   ├── editor/                 # React + Blockly 前端
│   │   ├── src/blocks/         # 內建積木定義
│   │   ├── src/ir/             # IR ↔ Blockly 轉換
│   │   ├── src/runtime-client/ # WS 客戶端、事件套用
│   │   └── src/components/
│   └── shared-schema/          # IR JSON Schema（前後端共用真實來源）
├── backend/
│   ├── blocky/
│   │   ├── api/                # FastAPI 路由
│   │   ├── ir/                 # pydantic 模型、驗證、遷移
│   │   ├── interpreter/        # 解譯器核心 + 內建 opcode 實作
│   │   ├── extensions/         # Host / Registry / Loader / venv 管理
│   │   ├── triggers/           # cron / webhook / stream
│   │   ├── codegen/            # bundle + transpile
│   │   └── storage/            # SQLite + keyring
│   └── tests/
├── extensions/                 # 內建與使用者安裝的積木包
│   ├── http/
│   ├── discord/
│   └── openai/
└── docs/
```

`shared-schema` 是 IR 的唯一真實來源：從 JSON Schema 產生 TS 型別與 pydantic 模型，避免前後端定義漂移。

---

## 15. Roadmap

### P0 — 骨架（目標 3～4 週）
**範圍**：Blockly zelos 編輯器；內建積木（control / data / operator / object / type / procedure / debug）；免宣告變數積木（§4.5）；自訂函式含回傳值（§4.6）；字串插值（§4.7）；型別積木（§4.8）；整合變數名稱 / 插值 / 多行的 `FieldText`（§8.5）；IR schema 與序列化；Python 解譯器；WebSocket 事件與高亮；SQLite 存讀檔。只有 `when_flag_clicked` 一種觸發。**不做**擴充系統、不做匯出。

> `FieldText` 是 P0 前端唯一的高風險項（估 2～3 天，且是三種行為的交集）。務必一次做成一個類別，不要先做三個再合併。

**驗收**：
1. 能拉出「重複 10 次 → `改變 count 增加 1` → log」，過程中**沒碰過任何「建立變數」按鈕**；執行後看到積木逐顆高亮、變數面板即時變動、按停止能立即中斷。
2. 能定義一個 `加總 (清單)` 函式，在函式體內用 `回傳 ()` 結束，並把呼叫積木塞進 `log ()` 的輸入孔拿到結果；`回傳` 放在 `重複` 迴圈裡也能正確中斷整個函式。
3. 在 `log ()` 的文字框直接打 `第 ${i} 筆：${resp.items[1].title}` 能正確取值；打 `${items[0]}` 得到「索引從 1 開始」的專屬錯誤；打 `${a + b}` 在**存檔前**就被標為錯誤。
4. 貼一段三行文字進積木欄位，欄位自動變成 textarea；空欄位可用右鍵強制切換，且切換狀態存檔重開後仍在。

> 這一階段跑通，整個專案的技術風險就解除了八成。

### P1 — 擴充系統（3～4 週）
**範圍**：manifest 格式與 loader；ExtensionHost 介面 + InProcess 實作；動態積木註冊；動態下拉；憑證管理（keyring）；uv venv 依賴隔離。手寫 `http` / `discord` / `openai` 三個包。

**驗收**：新增一個資料夾、重啟後端，新積木自動出現在工具箱且可執行；三個包能串成「抓 API → 丟給 LLM 摘要 → 發到 Discord」。

### P2 — 自動化（3～4 週）
**範圍**：Trigger Manager（cron / webhook / stream）；專案 active 狀態與後端重啟恢復；執行歷史與日誌檢視；`try_catch`；錯誤重試策略。

**驗收**：設定每天 09:00 的流程，關閉瀏覽器，隔天檢查執行歷史有紀錄且 Discord 收到訊息。**此時產品才真正等價於 n8n**。

### P3 — 擴散（4～6 週）
**範圍**：AI 生成積木包（含驗證管線）；匯出 Bundle；Transpile 模式；積木包分享/匯入；Tauri 桌面打包。

**驗收**：口述一個需求，10 分鐘內產出可用的積木包並成功執行。

**打包策略**：P0～P2 只做 `pip install blocky && blocky serve`（自動開瀏覽器）。Tauri/Electron 留到 P3，過早引入會吃掉大量時間在建置與簽章上。

---

## 16. 未決問題

| # | 問題 | 影響 | 建議 |
|---|---|---|---|
| Q1 | 單機工具 vs 可自架伺服器多人共用？ | 若要多人，權限模型、憑證隔離、執行佇列必須在 P0 進資料模型 | 暫定單機。但 SQLite schema 從 P0 就加 `owner_id` 欄位（單機時固定為 `local`），事後擴充成本趨近於零 |
| Q2 | 是否支援 Scratch 的 broadcast？ | 影響控制流複雜度 | 建議支援，這是 Scratch 使用者的既有心智模型，且實作成本低（等同事件匯流排） |
| Q3 | 專案檔要不要包含 extension 原始碼？ | 影響可攜性與安全 | 建議只記錄 id + version + 來源 URL，不內嵌程式碼（避免分享專案 = 分享任意程式碼） |
| Q4 | LLM 呼叫由誰付費？ | 影響 AI 生成功能的商業模式 | v1 使用者自帶 API key |
| Q5 | 積木文字的 i18n？ | manifest 的 `text` 欄位是否要支援多語 | 建議 P1 就把 `text` 設計成可為 `{en: "...", "zh-TW": "..."}`，事後改格式代價高 |
| Q6 | 需不需要「函式區域變數」？ | §5.4 目前 `data.set` 一律寫全域，遞迴函式用同名暫存變數會互相覆蓋 | P0 先只有「參數 + 全域」，觀察是否真的有人踩到。要加就加 `區域設定 [名稱] 為 ()` 一顆積木（寫入當前 frame），語意單純且與現有解析順序相容——但不要為了假想需求先做 |
| Q7 | 免宣告變數的錯字風險是否可接受？ | §4.5 用「執行期嚴格報錯 + 執行前靜態檢查」補洞，但終究不如 id 綁定可靠 | 先做，並在 P0 驗收時實測：故意打錯字看提示是否夠明確。若使用者仍常被咬，退路是把 `FieldText` 的變數名稱模式改成「只能從既有名稱選 + 新增」的 combo，IR 格式不用動 |
| Q8 | `${}` 要不要支援預設值（`${a.b ?? "無"}`）？ | §4.7 目前 key 不存在一律錯誤，容錯只能靠 `object.has` 或 `object.get` 的預設值孔 | **v1 不做，且這條線要守很硬**。開了預設值語法，下一步就是三元、就是函式呼叫，`${}` 會滑向一個迷你語言（違背 D9）。真的被咬再考慮 `${a.b?}` 這種「只加一個問號、不引入運算子」的最小形式 |
| Q9 | `blocks[].ui` 會不會長成雜物間？ | §4.2 允許任意未知 key，長期可能塞進一堆前端狀態 | 目前只有 `multiline` 一個 key。規則是「刪掉整個 `ui` 不影響執行結果」——任何違反這條的提案一律退回。若 key 超過 5 個就該檢討是不是有語意屬性混進來了 |

---

## 附錄 A — 端點清單

| Method | Path | 說明 |
|---|---|---|
| GET | `/api/projects` | 專案列表 |
| GET/PUT | `/api/projects/{id}` | 讀取 / 儲存 IR |
| POST | `/api/projects/{id}/active` | 啟用/停用 trigger |
| POST | `/api/runs` | 手動執行，回傳 runId |
| DELETE | `/api/runs/{id}` | 停止 |
| GET | `/api/runs/{id}/events` | 執行歷史（重播用） |
| WS | `/ws/run/{runId}` | 即時事件流 |
| GET | `/api/extensions` | 所有 manifest |
| POST | `/api/extensions/install` | 安裝（含審閱確認 token） |
| POST | `/api/extensions/{id}/dropdown/{source}` | 動態下拉 |
| PUT | `/api/extensions/{id}/config` | 設定與憑證 |
| POST | `/api/ai/generate-extension` | AI 生成（P3） |
| POST | `/api/export/{mode}` | bundle / transpile |
| ANY | `/hooks/{token}/{path}` | Webhook 入口 |
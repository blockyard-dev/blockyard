# Blocky Workflow — 設計文件

| 項目 | 內容 |
|---|---|
| 版本 | Draft v0.5 |
| 日期 | 2026-08-27 |
| 狀態 | 已審閱，P0a 完成，P0b 第 1～2 步完成 |
| 代號 | `blocky`（暫定，套件名 `blocky-runtime`） |

---

## 0.0 變更摘要

### v0.5

P0b 第 1～2 步（後端 API 殼、內建積木宣告）做完之後的修訂。全部是**把 D21 真的實作出來時撞到的東西**：

| 類別 | 變更 | 章節 |
|---|---|---|
| **補洞** | manifest 多了三種只有內建能用的宣告：`variable` / `stack` 參數型別、`field` 旗標、`dynamic` 積木。沒有它們，內建積木有一半宣告不出來 | D22、§7.2 |
| **補洞** | 內建的靜態下拉需要 `options`（選項就是宣告的一部分）；積木包的下拉維持動態的 `source`。兩者互斥 | §7.2 |
| **新增** | `Manifest.builtin` 旗標。共用同一個模型，但**共用模型不等於共用權限**——`discover()` 拒絕自稱 builtin 的積木包 | D22、§7.2 |
| **修訂** | `resolve_shape` 的內建那半改成讀宣告，不再從「handler 註冊在 `COMMANDS` 還是 `VALUES`」反推 | D20、§8.1 |
| **新增** | `backend/blocky/api/`、`backend/blocky/storage/`、`blocky serve` | §14、附錄 A |
| **新增** | `packages/shared-schema/manifest.schema.json`。D21 之後 manifest 也是前後端介面，前端的 TS 型別要從它產生 | §14 |

### v0.4

P0a 的語意核心完成、Host 邊界做完之後的修訂。前三條都是**實作撞出來的**，不是重新設計；後兩條是回到 P0b 之前的整理：

| 類別 | 變更 | 章節 |
|---|---|---|
| **修訂** | `HostChannel` 的 `log` 與 `is_cancelled` 改為同步，只有 `emit` 維持 async | D18、§7.5 |
| **修訂** | Host 邊界的參數正規化改為**套用 §4.3 那張轉換表**，不再是「除 json / number 外一律嚴格」 | D19、§7.5 |
| **補洞** | 積木形狀與位置沒有驗證的地方。執行期撞到會讓 Thread 安靜死掉——形狀錯誤不是 BlockyError，發不出 `block.error` | D20、§4.2 |
| **新增** | `backend/blocky/extensions/`：manifest schema、`ExtensionHost` / `HostChannel`、`InProcessHost`、邊界的正規化與驗證 | §7 |
| **新增** | `backend/tests/contract/`：§17.4 的 Host 合約測試，對 host 實作參數化，SubprocessHost 進來時題目一題都不用改 | §17.4 |
| **重排** | P1 的 Host 邊界（§7.5）提前在 P0b 之前做掉，其餘 P1 延後。順序回到 P0a → **P0b** → P1 | §15 |
| **修訂** | 內建積木改為宣告式，與積木包走同一條路。原本 §14 把內建定義放前端、§8.1 的積木包走後端動態註冊，同一件事有兩條路 | D21、§8.1、§14 |

### v0.3

v0.2 經審閱後的修訂。原稿的整體結構與 D1～D11 全數保留，以下是實質變動：

| 類別 | 變更 | 章節 |
|---|---|---|
| **補洞** | 全域變數的生命週期原本完全未定義。定為「一次 Run」，跨 Run 記憶改用顯式的 `persist_*` 積木 | D12、§5.4 |
| **補洞** | `number` 是 int 還是 float 未定義。釘死為 IEEE754 double，字串化跟隨 JS | D15、§4.3 |
| **補洞** | 完全沒有日期時間積木，但這是排程工具的日常。新增 `time` 命名空間，cron 補上必填 timezone | §4.9、§9.1 |
| **補洞** | 事件沒有落地策略，`forever` 迴圈會寫爆 SQLite。區分「送給前端」與「存進硬碟」 | §6.3 |
| **補洞** | secret 收進了 keyring，卻會沿著事件流與 traceback 明文外流 | §12.2 |
| **補洞** | 內建 hat（cron / webhook）沒有地方宣告 `concurrency` | §5.1 |
| **補洞** | `refs` 是快取卻存進 IR，與「IR 可手寫」的目標衝突必然漂移。定為衍生欄位，載入時一律重新解析 | §4.7 |
| **補洞** | 原稿定義了型別轉換卻沒定義**比較**語意 | D17、§4.4.1 |
| **新增** | 原稿沒有測試策略。新增一致性題庫（conformance corpus）作為規格的可執行版本 | §17 |
| **砍除** | Transpile 模式——維護第二套執行語意的代價遠超它多解決的 10% 需求 | D14、§10.2 |
| **砍除** | broadcast——唯一會產生不可追溯控制流的機制 | D14、§4.4 |
| **砍除** | `ctx.get_var / set_var`——破壞靜態檢查、process 邊界與可追溯性的後門 | D16、§7.4 |
| **提前** | SubprocessHost 從 v2 提前到 P1。in-process 的 `sys.path` 隔離在首批三個包上就會失效 | D13、§7.6 |
| **重排** | P0 拆成 P0a（語意核心，無前端）與 P0b（編輯器）。時程從樂觀的 3～4 週修正為現實的 6～9 個月全程 | §15 |
| **新增** | Q10「目標使用者到底是誰」——非工程師與工程師把 roadmap 拉向相反方向 | §16 |

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
| D12 | 全域變數的生命週期 = **一次 Run**；跨 Run 記憶另用 `data.persist_*` 積木 | 「關掉瀏覽器仍會執行」意味著 Run 會被排程反覆觸發，變數若隱式跨 Run 存活，語意就取決於後端何時重啟——那是不可推理的。把持久化變成看得見的積木，符合全文「不要魔法」的原則 |
| D13 | **SubprocessHost 提前到 P1**，v1 不做 in-process 的假隔離 | 同一個 process 內 `sys.path` 前置只有第一次 import 有效，而首批三個包（http / discord / openai）全都依賴 httpx/aiohttp——衝突不是風險而是必然。且 `ctx` 反向呼叫的 RPC 設計晚做等於重寫 |
| D14 | **砍掉 Transpile 模式與 broadcast** | 兩者都是「實作成本低、語意表面成本高」的陷阱。Bundle 模式已滿足 90% 離線需求；procedure + trigger 已覆蓋 broadcast 的用途，而 broadcast 是唯一會產生不可追溯控制流的機制 |
| D15 | `number` 語意上是 **IEEE754 double**，字串化規則跟隨 JS | Python 端 int/float 之別若洩漏到語意層，`5` 與 `5.0`、`items[1.0]` 這類問題會散落各處。釘死在 JSON 的數字模型上，未來任何第二套 runtime 都能對齊 |
| D17 | 比較不做型別轉換：`=` 型別不同即不等（不報錯），`<` 型別混用則報錯 | 「一不一樣」對任何輸入都有答案；「誰比較大」對文字與數字則沒有意義。Scratch 的隱式嗅探會讓 `"10" < "9"` 的結果取決於看不見的規則 |
| D16 | 積木只能透過 **inputs 進、return 出**；取消 `ctx.get_var/set_var` | 讓 extension 能直接改專案變數會同時破壞靜態檢查、跨 process 邊界與可追溯性，換得的便利可由「回傳值 + `data.set`」完全取代 |
| D18 | `HostChannel` 的 `log` 與 `is_cancelled` 是**同步**的，只有 `emit` 非同步 | §7.3 的 `ctx.log(...)` 沒有 await，而 log 事件必須當場落在 `block.enter` / `block.exit` 之間，否則 §17 的黃金軌跡不是決定性的。跨 process 時 extension 那一側寫 stdout 本來就是同步的，非同步的是 host 的 reader task——那是實作，不是介面。`is_cancelled` 讀的是推過來的旗標；若每次檢查都往返一次 IPC，沒有人會捨得把它放進迴圈 |
| D19 | Host 邊界套用的是 **§4.3 那張轉換表本身**，`object` / `list` 是唯一例外 | 積木包的參數孔與內建積木的參數孔在畫面上長得一模一樣，使用者沒有辦法知道哪顆會轉、哪顆不會。`object` / `list` 例外，是因為 §4.3 根本沒有「轉成物件」這一格——那只可能是 JSON parse，而 parse 必須看得見（D10）；要自動處理的參數應該宣告成 `json` |
| D21 | **內建積木也是宣告式的**：每個內建命名空間一份 manifest，與積木包共用同一套 `BlockSpec` 與同一個端點 | 前端需要 `text`、參數型別、顏色、形狀才畫得出積木。若內建的定義手寫在前端、積木包的來自後端，同一件事就有兩條路——而 §8.1「新增積木不需要改前端一行程式碼」會退化成只對第三方成立的半條承諾。§5.1 的內建 hat 早就用「合成 manifest」避免特例分支，D21 只是把同一招套到全部 87 顆。代價是補 87 份宣告（實測 9 份 YAML），換來：D20 的形狀來源從「handler 註冊在哪張表」的副產品變成一份宣告；`%(x)` ↔ args 一致性、`min`/`max`、`multiline` 全部沿用 §7.2 既有的驗證；Q5 的 i18n 將來只有一個地方要改 |
| D22 | 內建與積木包**共用一個 `Manifest` 模型**，但用 `builtin` 旗標分權：只有內建能宣告 `variable` / `stack` 參數、`field` 欄位、靜態 `options` 與 `dynamic` 積木 | D21 說「同一條路」，但直接讓積木包也走完整條路會在 §7.5 的邊界上開洞——`variable` 綁的是變數名而不是值、`stack` 是 C 型積木的內部堆疊，兩者都沒有東西能送過 process 邊界。反過來，若為內建另立一套 schema，D21 就白做了。折衷是同一個模型加一條載入期的權限線，而那條線本身有測試守（`discover()` 拒絕自稱 builtin 的包） |
| D20 | 積木**形狀**與位置在**載入期**驗證；認不得的 opcode 例外 | 形狀錯誤留到執行期，錯的那半邊可以躺著好幾個月不被走到，而且它是 ValidationError 而非 BlockyError，漏出來時發不出 `block.error`，Thread 只是安靜停掉。認不得的 opcode 反過來**必須**留到執行期，否則 §13.3 的佔位符就不成立 |

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

#### `scripts` 的每一項是「畫布上的一個頂層堆疊」，**不一定有 hat**

沒有 hat 的堆疊（Scratch 說的落單積木）是**合法的 IR**，只是永遠不會被 trigger
觸發——§5.1 的觸發條件是「top 的 opcode 等於這次的 trigger」，一顆 `data.set`
不等於任何 trigger，所以它自然就不跑，不需要任何特例。

這條必須明講，因為它決定了兩件使用者天天在做的事：

- **寫到一半的積木不該擋住存檔。** 把「沒有 hat」當成載入期錯誤，等於要求使用者
  在按存檔之前先把畫布收乾淨——而實際的工作方式是先拉幾顆試試看。§8.5 已經說過
  「靜默刪掉使用者的積木是不可接受的」，**靜默拒絕存檔是同一件事的另一面**：
  使用者的勞動成果同樣進不了磁碟。
- **落單堆疊可以單獨執行**（§5.1 的「點一下就跑」）。那是 Scratch 最重要的探索
  手段，而它的前提是這種堆疊存得下來。

真正的錯誤仍然是錯誤：**hat 出現在堆疊中間**（`parent` 不是 null）依舊在載入期
擋下，那是形狀違規，不是工作中的草稿。編輯器對沒有 hat 的堆疊標一個 warning icon
（§4.5 既有的機制），不擋任何操作。

**這兩件事本來就是兩條獨立的檢查**，不是一條要拆成兩條。hat 放在中間是由
「`next` 接的積木必須是 command 形狀」擋下的（`_require_shape`），它有自己的
錯誤訊息，說的也是對的事；而「腳本最上面必須是事件積木」是另外加的一條，
它擋的正是上面那兩件使用者天天在做的事。因此這條規則的處置是**刪掉**，不是
改寫——刪掉之後 hat 放中間仍然報錯，訊息還更準確。

刪掉它會讓第三種頂層堆疊也變成合法：**畫布上一顆落單的 reporter 或 boolean**。
這是要的——§5.1 的「點一下就跑」明講起點可以是 reporter，而它同樣得先存得下來
才問得出口。三種頂層堆疊（hat、command、reporter）從此只有一個差別：誰會被
trigger 選中。

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

#### 積木形狀在載入期驗證（D20）

每顆積木有三種形狀：`command`（接在堆疊上）、`reporter` / `boolean`（插在輸入孔裡）、`hat`（只能在腳本最上面）。形狀與位置不符是**載入期錯誤**：

| 位置 | 必須是 |
|---|---|
| `Script.top` | hat |
| `next` 的目標、`kind: stack` 的目標 | command |
| `kind: block` 的目標 | reporter / boolean |

留到執行期有兩個後果，都很難查：`if` 的另一半可以躺著錯好幾個月才被走到；而且形狀錯誤是 ValidationError 而非 BlockyError，它從 Thread 漏出來時發不出 `block.error`，前端只會看到一個安靜停掉的 Thread。§4.6 對 `return` 的位置本來就是載入期驗證，這裡只是把同一條原則套到所有積木上。

形狀從哪裡來：內建積木來自註冊表，積木包的積木來自 manifest 的 `type`（§7.2）——所以這一步必須在積木包**載入之後**才做得了。

**認不得的 opcode 不算錯。** 那是 §13.3 的佔位符：積木包還沒安裝，或這份專案來自更新版的 runtime。它保留到執行期，以 `unknown_block` 錯誤呈現。

### 4.3 值模型與型別轉換

支援型別：`null` / `boolean` / `number` / `string` / `list` / `object`。

#### `number` 是 double，不是 int（D15）

語意層**只有一種數字型別**：IEEE754 double，與 JSON 的數字模型一致。Python 實作內部可以是 `int` 或 `float`，但那是實作細節，不得洩漏到任何可觀察的行為：

| 觀察點 | 規則 |
|---|---|
| `type.of` | 一律回 `"number"`，沒有 `"int"` |
| 字串化 | 跟隨 JS `Number.prototype.toString`：`5.0` → `"5"`、`0.1+0.2` → `"0.30000000000000004"`、`1e21` → `"1e+21"` |
| 相等比較 | `5 == 5.0` 為 true |
| 索引 | `items[1.0]` 合法且等同 `items[1]`；`items[1.5]` 是錯誤（「索引必須是整數」） |
| 除法 | `10 / 2` → `5`（字串化後無 `.0`），`1 / 3` → `0.3333333333333333` |
| 安全整數 | 超出 ±2^53 的整數運算不保證精度，與 JSON 相同；不另做 bigint |

釘死在 JSON 的數字模型上，是為了讓未來任何第二套 runtime（JS、Go）都能對齊同一份 §17 的測試題庫。

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
| `event` | `when_flag_clicked` `when_cron` `when_webhook`（broadcast 已砍，見 D14） |
| `control` | `if` `if_else` `repeat` `repeat_until` `forever` `for_each` `wait` `wait_until` `stop` `try_catch` |
| `data` | `set` `change` `get` `new_list`；list 操作（add/delete/insert/replace/item/length/contains）；`persist_set` `persist_get` `persist_has` `persist_delete`（跨 Run 記憶，見 §5.4）。變數無需宣告，見 §4.5 |
| `object` | `get` `set` `keys` `has` `parse_json` `to_json`；parse 永不自動，見 §4.8 |
| `operator` | 算術、比較、邏輯、字串（join/letter/length/contains/regex） |
| `procedure` | `definition`（可宣告回傳型別）、`call`（依定義呈現 command 或 reporter）、`return`（終止積木），見 §4.6 |
| `type` | `cast` `try_cast` `is` `can_cast` `of` `is_empty`，見 §4.8 |
| `time` | `now` `format` `parse` `add` `diff` `timestamp` `timezone`，見 §4.9 |
| `debug` | `log` `inspect` |

每個命名空間有一份 manifest（`interpreter/builtins/<namespace>.yaml`），格式與積木包的 `manifest.yaml` 完全相同，差別只有沒有 `requirements` 與 `main.py`——**內建積木不是特例**（D21、§8.1）。

相對於 Scratch，這裡有六處**刻意的偏離**，都是工作流場景必需：`try_catch`（§5.6）、**可回傳值的自訂函式**（§4.6）、**免宣告的變數積木**（§4.5）、**字串插值**（§4.7）、**顯式型別積木**（§4.8）、**日期時間命名空間**（§4.9）。

反過來，有一處 Scratch 有而這裡**刻意不做**：`broadcast`（D14）。它是唯一會產生「畫布上看不出誰呼叫誰」的控制流，而 procedure（同步、有回傳值）與 trigger（非同步、有來源）已經覆蓋它的全部用途。


### 4.4.1 比較語意

§4.3 定義了轉換，卻沒定義**比較**——而比較是使用者第二常用的積木。補上：

| 積木 | 規則 |
|---|---|
| `=` `≠` | **不做型別轉換**。型別不同即不相等；list / object 走深度比較。等同 JS 的 `===` |
| `<` `>` `≤` `≥` | 兩邊都是數字 → 數值比較；兩邊都是文字 → 字典序；**型別混用 → 執行期錯誤**，訊息提示用「轉為數字」 |

兩條都刻意不學 Scratch 的「能轉數字就轉、否則比字串」。那個規則會讓
`"10" < "9"` 的答案取決於使用者看不見的嗅探結果，正是 §4.3 想避免的混亂。

不對稱是有理由的：**「這兩個東西一不一樣」對任何輸入都該有答案**，所以 `=`
不報錯、回 false；但「誰比較大」對「文字和數字」根本沒有意義，靜默給一個
答案只會讓錯誤晚三顆積木才爆開。

> `"5" = 5` 為 false 會讓部分使用者意外。這是 §4.8 型別積木存在的理由——
> 用 `將 (值) 轉為 [數字]` 明確表態，而不是讓積木猜。

---

### 4.5 變數模型（免宣告）

**沒有「建立變數」按鈕，沒有變數的動態工具箱分類。** 變數就是幾顆積木，名稱直接寫在積木裡：

| opcode | 型 | 外觀 | 說明 |
|---|---|---|---|
| `data.set` | command | `設定 [名稱] 為 (值)` | 寫入；名稱不存在則建立 |
| `data.change` | command | `改變 [名稱] 增加 (值)` | 數值累加，等同 `set name to (get name + 值)` |
| `data.get` | reporter | `取得 (名稱)` | 讀取。**帶動詞**，見下 |
| `data.new_list` | reporter | `(空清單)` | 給 list 型變數初始化用，`設定 [items] 為 (空清單)` |

`data.get` 的積木文字是 `取得 (名稱)` 而不是 Scratch 那顆光禿禿的變數膠囊。差別
來自這裡的變數模型：Scratch 的變數膠囊是一種**專屬的視覺文法**（獨一無二的橘色
圓角、只能從變數分類拖出來），看到就知道是變數；而這裡的名稱是**寫在文字欄位裡
的字串**（見下），一顆只有 `(count)` 的 reporter 跟一顆內容是 `count` 的文字積木
長得幾乎一樣。動詞是把那個區別放回畫面上最便宜的方式。

代價是每顆讀取都多吃兩個字的寬度，而讀取是全場出現次數最多的積木。接受這個代價，
因為「這顆是在讀變數還是在給一串文字」是使用者**每次讀腳本都要問一次**的問題，
而寬度只是排版。

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
- **求值順序**：reporter 形狀的呼叫積木必然帶副作用（函式體可以發 HTTP、寫變數）。解譯器一律**由左而右、深度優先**求值輸入孔。這條規則進 §17 題庫，因為它是唯一無法從畫面上看出來、但會改變結果的語意。

#### 事件與 UI

呼叫積木照常送 `block.enter` / `block.exit`，reporter 形狀的 `block.exit` 帶 `value` = 回傳值，前端直接以數值氣泡顯示——**函式的回傳值和內建 reporter 一樣可以即時觀察**，這是解譯執行相對於產生原始碼的主要好處。

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

`refs` 是解析快取，兩個好處：§4.5 的靜態檢查直接吃它來驗證 `i` / `resp` 是否曾被 `data.set`（現有機制零成本延伸）；執行期錯誤能指到第幾段。`kind: "literal"` 因此維持「笨資料」——這對 AI 生成 IR 特別重要。

#### `refs` 是衍生欄位，永不作為執行依據

既然「IR 可手寫、AI 可生成」是明確目標（D5），那 `value` 與 `refs` 就**一定會漂移**——而漂移的後果正是本節開頭想避免的「字串被偷偷替換成別的東西」。因此定一條硬規則：

- 載入專案時，後端**一律重新 parse `value`**，執行期只認重新解析的結果。
- `refs` 只用於**驗證**：與重新解析的結果不符 → 存檔／載入期報錯，指出該 blockId。
- 存檔時由後端重新產生 `refs`，不信任前端送來的版本。

也就是說，把整個 `refs` 欄位刪掉不影響任何執行結果——與 §4.2 的 `ui` 同一條原則。

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

### 4.9 日期時間積木

一個以**排程**為核心的工具卻沒有日期時間積木是說不通的：「只在平日執行」「檔名帶今天日期」「這筆資料是不是三天內的」是自動化流程的日常。這組積木進 P0，不是 P1。

| opcode | 形狀 | 外觀 | 語意 |
|---|---|---|---|
| `time.now` | reporter | `現在時間` | 回**時間戳**（見下） |
| `time.timestamp` | reporter | `(時間) 的毫秒數` | 轉成 epoch 毫秒（number） |
| `time.format` | reporter | `格式化 (時間) 為 [YYYY-MM-DD ▼]` | 依所選格式轉字串 |
| `time.parse` | reporter | `解析時間 (文字)` | ISO 8601 字串 → 時間戳；失敗即錯誤 |
| `time.add` | reporter | `(時間) 加上 (3) [天 ▼]` | 單位下拉：毫秒／秒／分／時／天／週 |
| `time.diff` | reporter | `(時間A) 與 (時間B) 相差幾 [天 ▼]` | 回 number，A − B |
| `time.part` | reporter | `(時間) 的 [星期幾 ▼]` | 年／月／日／時／分／秒／星期幾／第幾週 |

#### 時間戳的表示：object，不是 number

`time.now` 回的是一個 `object`：

```jsonc
{ "__type": "timestamp", "epochMs": 1756276800000, "tz": "Asia/Taipei" }
```

不用裸 number 的理由是**時區必須跟著值走**。若時間戳是裸數字，`格式化(現在時間)` 就得另外問「用哪個時區」，而那個問題會在每一顆時間積木上重複出現。把 tz 綁在值上，一次決定、全程正確。

代價是 `type.of` 對它回 `"object"`——這是可接受的，因為 §4.8 的型別系統本來就不打算長出第七種型別。`time.timestamp` 提供了逃生口，需要裸數字時明確要一次。

#### 時區的來源順序

1. 積木顯式指定（`time.now` 的選填時區孔）
2. 專案設定的預設時區
3. 系統時區

**`event.when_cron` 必須有 timezone 參數**（§9.1）。沒有它，同一份專案在不同機器上會在不同時刻觸發——這與 D11 拒絕「可設定索引基底」是同一個理由。

---

## 5. Runtime 執行模型

### 5.1 併發模型
- 每個 Script 的一次執行 = 一個 `asyncio.Task`（稱 Thread）。
- 多個 hat 同時觸發 → 多個 Task 並行，共享同一個 Run 的全域變數（§5.4）。
- 同一個 hat 重複觸發時的行為由 `concurrency` 決定：`parallel`（預設）/ `queue` / `drop`（前一輪未結束就丟棄新事件）/ `restart`。

#### `concurrency` 存在哪裡

擴充的 hat 由 manifest 宣告，但 `event.when_cron` / `when_webhook` 是**內建的、沒有 manifest**——而「上一輪還沒跑完就又到點了」正是最需要 `drop` / `queue` 的場景。因此：

| 來源 | 宣告位置 | 優先 |
|---|---|---|
| 擴充 hat | manifest 的 `concurrency` | 預設值 |
| 內建 hat | 內建 hat 的 manifest，格式與擴充完全相同（D21 之後這不再是特例：所有內建積木都有 manifest） | 預設值 |
| 任何 hat | IR 中該 hat block 的 `fields.concurrency` | **覆寫上者** |

讓使用者能在積木上覆寫是必要的：同一顆 `when_webhook`，用在「收單」要 `queue`，用在「刷新快取」要 `drop`。內建 hat 走合成 manifest 而非特例分支，是為了讓 §7.5 的 Host 邊界只有一條路徑。

#### 點一下就跑：手動執行單一堆疊

除了 trigger，使用者可以**直接點擊畫布上的任一顆積木**，從它所在的堆疊頂端起跑
——不管上面有沒有 hat（§4.1）。這是 Scratch 最重要的探索手段：試一顆積木不必先
接一個 hat 再按綠旗。

- 走的是**同一套 Run 機制**：同一份 §6.1 事件、同一個停止 API、同一個
  `POST /api/runs`，只是起點從 `trigger` 換成 `blockId`。不另開一條「試跑」路徑，
  否則 §6.2 的流量控制、§5.5 的停止就要各做兩次。
- 起點是 reporter 或 boolean 時，只求值那一顆，值以 §8.3 的值氣泡呈現。這是
  「這顆積木會回什麼」最直接的答案，也是 §8.5「型別提示用警告不用形狀」能成立
  的前提之一——使用者必須能**便宜地問**，否則看不見型別就只能猜。
- 全域變數的生命週期仍然是**一次 Run**（D12）：點一下跑一次就是一個 Run，讀不到
  上一次點擊留下的變數。與綠旗執行完全一致，不開特例——但這一條在探索情境下會
  不會太吵，見 §16 Q14。

### 5.2 沒有 frame clock
Scratch 以 30fps 為單位讓出控制權。本專案**不採用**：這裡沒有畫面要渲染，迴圈應以最快速度執行。做法是每執行 N 顆積木（預設 512）或遇到 await 點時 `await asyncio.sleep(0)` 讓出 event loop，確保取消訊號與 WebSocket 能被處理。

### 5.3 同步阻塞的擴充函式
擴充可寫成 `def`（同步）或 `async def`。同步函式一律丟進 `ThreadPoolExecutor` 執行。

**已知限制**：執行緒中的同步呼叫**無法被中途取消**，按下「停止」時該顆積木會跑完才結束。manifest 需宣告 `blocking: true` 讓 UI 提示。長時間操作建議擴充作者提供 async 版本。

### 5.4 變數作用域與生命週期

變數沒有宣告（§4.5），所以**作用域完全由名稱解析順序決定**，由內而外：

| # | 層 | 生命週期 | 可寫 | 可見範圍 |
|---|---|---|---|---|
| 1 | **Procedure 參數** | 一次呼叫（frame） | 唯讀 | 該 frame |
| 2 | **Thread-local** | 一個 Thread | 唯讀 | 該 Thread |
| 3 | **全域變數** | **一次 Run** | `data.set` | 該 Run 的所有 Thread |
| 4 | **持久化儲存** | **永久（SQLite）** | `data.persist_set` | 跨 Run、跨後端重啟 |

1. **Procedure 參數** — 呼叫時建立 frame，遞迴深度上限 200（超出拋錯，避免堆疊爆掉）。參數在 frame 內唯讀，`data.set` 同名視為寫全域並在編輯器警告 shadowing。
2. **Thread-local** — hat 提供的欄位（如 `on_message` 的 `content`、`author`）與 `try_catch` 綁定的 `error`，只在該 thread 可見，唯讀。
3. **全域變數** — 見下方生命週期。並發寫入以 asyncio 單執行緒語意保證原子性（不會有 torn read）。

`data.set` **一律寫入全域層**（前兩層唯讀）。也就是說：目前沒有「函式區域變數」，遞迴函式若用同名變數當暫存會互相覆蓋——見 §16 Q6。

#### 全域變數的生命週期 = 一次 Run（D12）

**Run 開始時全域層是空的，Run 結束時整個丟棄。** 這條規則必須明講，因為它是 §1.3「關掉瀏覽器仍會準時執行」的直接後果：cron 會讓同一份專案被觸發成千上萬次，若變數隱式跨 Run 存活，那 `count` 的值就取決於「後端上次重啟是什麼時候」——那是不可推理的，而且無法寫進 §17 的測試題庫。

由此推出三條：

- 每次 trigger 觸發 = 一個新 Run = 一組乾淨的全域變數。同一個 Run 內的多個 Thread 才共享。
- 因此 §4.5「讀取未建立的變數 → 錯誤」在跨 Run 場景下**符合直覺**：昨天設的值今天讀不到，是報錯而不是拿到過期資料。
- 「Webhook 設值 → cron 讀值」這種跨 Run 溝通**必須顯式**，用第 4 層。

#### 第 4 層：持久化積木

| opcode | 型 | 外觀 |
|---|---|---|
| `data.persist_set` | command | `記住 [名稱] 為 (值)` |
| `data.persist_get` | reporter | `記住的 [名稱]，沒有時 (預設值)` |
| `data.persist_has` | boolean | `記住過 [名稱] 嗎?` |
| `data.persist_delete` | command | `忘記 [名稱]` |

- 儲存於 SQLite，以專案為範圍（scope 為 `project_id`），跨 Run、跨後端重啟存活。
- 值必須可 JSON 序列化（與 §7.5 同一條約束）。
- **`persist_get` 有預設值孔而非報錯**，這是本設計中少數刻意的寬鬆：持久值的「第一次執行」必然不存在，強迫每個人先寫一顆 `persist_has` 是純粹的儀式。
- 寫入是 read-modify-write，**不保證跨 Run 的原子性**。需要計數器語意時用 `data.persist_change`（P2 再加，v1 不做）。
- 編輯器提供面板檢視／清除持久值——不然使用者永遠不知道裡面存了什麼。

這個切法讓「變數」回到 Scratch 的直覺（一次執行的暫存），而把「記憶」變成一顆**寫著「記住」的積木**。使用者看得見自己在寫入永久儲存，這正是 §4.8「parse 不自動」同一個原則的延伸。

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
  `count` 是**這個 Run 至今的累計次數**，不是這個窗口的次數：UI 要顯示的
  「×4210」問的是「總共跑了幾次」，而且累計值才會單調遞增。聚合事件放在那顆積木
  在這個窗口內**第一次出現的位置**，它取代的就是那些事件。
- 同一個變數名稱的 `var.set` 在一個窗口內只留**最後一次**。理由與 `block.hot`
  相同：變數監看面板顯示的是現值，中間那四千個值畫不出來也沒人看得到；而
  §6.3 已經說 `var.set` 不落地，它就只是個即時訊號。
- `value` 欄位序列化上限 **4KB**，超過則截斷並標記 `"truncated": true`，完整值需由 `GET /api/runs/{id}/values/{blockId}` 取得。
- **第一個訂閱者接上之前的事件先留著**（上限 2000 筆，滿了丟最舊的）。
  `POST /api/runs` 回應與前端把 WebSocket 接上之間有幾毫秒的空窗，沒有這個
  緩衝，前端會固定看不到 `run.start` 與最前面幾顆積木——而那正是使用者盯著看
  的部分。第二個訂閱者就沒有了（§6.3：這些事件不落地，錯過就是錯過）。
- 訂閱者跟不上時（佇列滿）丟最舊的 frame，並在下一個 frame 標
  `"dropped": n`。**丟掉可以，靜靜地丟掉不行**——前端要說得出畫面不完整。
  `log` 與 `block.error` 不參與聚合也不收斂：它們是 §6.3 要落地的那半。

### 6.3 落地策略：不是每個事件都要進 SQLite

§6.2 管的是「送多少給前端」，這裡管的是「存多少到硬碟」——兩者必須分開，否則一個掛著跑三天的 `forever` 迴圈會寫進幾億列。

| 事件 | 落地 |
|---|---|
| `run.start` `run.end` `thread.start` `thread.end` | **一律存**。這是執行歷史的骨架 |
| `block.error` | **一律存**，含完整 traceback |
| `log` | **一律存**，每個 Run 上限 10,000 筆，超過丟棄最舊者並標記 |
| `block.enter` `block.exit` `var.set` `block.hot` | **不存**。只在有 WS client 連著時即時送出 |

`block.enter/exit` 是**除錯用的即時訊號，不是稽核紀錄**。想事後重播的話，走「Trace 模式」：使用者明確開啟後才對該次 Run 全量落地，並強制設上限（預設 100MB 或 100 萬事件，先到為準）。

沒有這條規則，`GET /api/runs/{id}/events`（附錄 A）在 P2 的常駐場景下會是第一個炸掉的東西。

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

#### 只有內建能用的宣告（D22）

D21 說內建與積木包走同一條路，但那條路上有一段只有內建能走。原因是 §7.5 的邊界：積木包的參數必須是**能送過 process 邊界的值**，而下面這些不是。

| 宣告 | 意思 | 為什麼積木包不能用 |
|---|---|---|
| `type: variable` | 變數名稱欄位（`設定 [count] 為 ()` 的 `count`） | 它綁的是名字不是值。§4.5 的免宣告變數、§8.5 的名稱自動完成與重新命名都要跟著它走，那是編輯器與 scope 的事，不是 extension 的事 |
| `type: stack` | C 型積木的內部堆疊（§4.2 的 `StackInput`） | 積木包沒有 C 型積木——堆疊是控制流，`host.call` 送得過去的只有值 |
| `field: true` | 值存在 IR 的 `fields` 而不是 `inputs` | field 屬於積木自己、塞不進別的積木。積木包的參數一律是輸入孔 |
| `options: [...]` | 靜態下拉，選項就是宣告的一部分 | 積木包的下拉是**動態**的（`source` 指向 `@dropdown`），因為選項來自外部服務。兩者互斥：選項要嘛是問來的，要嘛是寫死的 |
| `dynamic: true` | 積木由專案資料生成（§4.6 的 `procedure.call` / `definition`） | 它的參數來自 `project.procedures`，工具箱也不列出它。另外，reporter 形狀的 dynamic 積木同時也是 command 形狀——函式沒宣告回傳型別時，呼叫積木沒有輸出孔。這是整份宣告裡唯一形狀不固定的東西 |

分權靠 `Manifest` 的 `builtin` 旗標，而旗標本身有守衛：掃描 `extensions/` 的 `discover()` 拒絕任何自稱 `builtin: true` 的包。否則寫一行就能改寫 `data.set` 的意思。

內建的宣告另外不得帶 `requirements` 與 `permissions`——它沒有 `main.py`，沒有東西可以裝、也沒有邊界可以守。

#### `json` 與 `object` / `list` 的差別

`object` / `list` 是**嚴格宣告**：值不是該型別就是錯誤，不做任何轉換。`json` 是**結構化資料入口**，Host 在 dispatch 前正規化（§7.5）：物件與清單直接放行，字串則嘗試 parse。

任何「要把資料送出去」的參數都應宣告成 `json`。這樣 `main.py` 裡永遠拿到 dict / list，**不必寫一行防呆**（D10）——連 parse 出純量都是錯誤，否則這個承諾就有例外。

其餘型別（`string` `code` `secret` `dropdown` `number` `boolean`）依 §4.3 的轉換表處理，見 D19。

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
| `ctx.http` | 共用的 httpx client（帶逾時與重試預設值） |
| `ctx.cancelled` | 協作式取消檢查點，長迴圈中應主動檢查 |

#### 沒有 `ctx.get_var / set_var`（D16）

早期草稿有這兩個 API，已刪除。積木的合約是**吃 inputs、吐 return value**，沒有例外。讓 extension 直接改專案全域變數會同時打破四件事：

1. §4.5 的靜態檢查——「這個變數被誰設過」不再可靜態判定。
2. §7.5 的 process 邊界——它是反向呼叫，是 SubprocessHost 裡最貴的一類 RPC。
3. 可追溯性——畫布上看不出這顆積木改了什麼。
4. 併發語意——寫進哪一層？呼叫端的 frame 還是全域？

而它換來的便利，`回傳值 + 一顆 data.set` 完全可以取代，且看得見。

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

隱含約束：**args 與回傳值必須可 JSON 序列化**。從第一天就強制執行，否則換 IPC 時會發現到處在傳 Python 物件。

#### 反向通道（extension → host）

`ExtensionHost` 只描述了 host → extension 的方向，但 `ctx.log`、trigger 的 `yield`、`ctx.cancelled` 都是**反過來**的。這條反向通道必須在 P1 就跟 §7.6 的 SubprocessHost 一起設計，因為它是「in-process 時看不見、跨 process 時全部要重寫」的典型：

```python
class HostChannel(Protocol):
    def log(self, ctx_token: str, level: str, message: str) -> None: ...
    async def emit(self, ctx_token: str, payload: dict) -> None: ...   # trigger yield
    def is_cancelled(self, ctx_token: str) -> bool: ...
```

**只有 `emit` 是非同步的**（D18）。`log` 同步的理由有兩個：§7.3 的 `ctx.log(...)` 沒有 await，而且 log 事件必須當場落在 `block.enter` 與 `block.exit` 之間，否則 §17 的黃金軌跡就不是決定性的。跨 process 時 extension 那一側寫 stdout 本來就是同步的，非同步的是 host 那一側的 reader task——那是 host 的內部實作，不是介面。`is_cancelled` 讀的是 host **推**過來的旗標，不是每次檢查都發一次 RPC；長迴圈裡的檢查點若要往返一次 IPC，沒有人會捨得放進迴圈。`emit` 維持 async，因為 trigger 的 yield 跨越 await 邊界且需要背壓。

in-process 實作是直接呼叫，subprocess 實作是 stdio JSON-RPC 的另一個方向。**兩種實作從 P1 就都要存在**，並用同一份 §17 的題庫驗證行為一致。

#### 邊界的正規化與驗證

`call` 除了 dispatch，還要在 args 進去、回傳值出來時各做一件事。這兩件事**只在此處實作一次**，extension 作者不需要、也不應該自己寫：

```python
# 進：依 manifest 的 args 型別正規化
#   type: json            → object / list 直接放行
#                           string 試 parse；失敗則錯誤
#                             「參數 body 收到的文字不是合法 JSON」
#                           parse 出純量也是錯誤——`json` 的承諾是「永遠拿到 dict / list」
#                           其他型別 → 錯誤
#   type: object / list   → 嚴格檢查，不做轉換（§7.2）
#   其餘型別              → **依 §4.3 的轉換表**（D19）
#                           string / code / secret / dropdown → to_string（全函數）
#                           boolean                           → to_boolean（全函數）
#                           number                            → to_number（會失敗）
#                           number 另外檢查 manifest 宣告的 min / max
#
# 出：依 manifest 的 returns 驗證
#   宣告 returns: object 卻回了 string → 立刻錯誤，訊息指向該 extension
#   command 形狀的積木回了非 null      → 錯誤（它沒有輸出孔，值無處可去）
#   回傳值不是 §4.3 的六種值（例如 set）→ 錯誤（可 JSON 序列化的約束）
```

回傳值驗證看似瑣碎，但它把「宣告 object 卻回了字串」擋在源頭，而不是三顆積木之後才以「文字沒有 items」的形式爆開（§4.7）。成本近乎為零（反正已經要求 JSON 可序列化），對 AI 生成的積木包尤其重要——它只要填對 manifest 就不會錯。

### 7.6 依賴隔離：P1 直接做 SubprocessHost（D13）

每個 extension 一個獨立 venv，用 `uv venv` + `uv pip install`（速度是 pip 的數十倍，對「安裝積木包」的體驗差異很大）。

**早期草稿打算 v1 用 `sys.path` 前置該 venv 的 site-packages、in-process 載入，把 subprocess 留到 v2。這條路已放棄**，理由是它在 P1 驗收當天就會爆：

- 同一個 process 內，`import httpx` **第一次贏，且永久生效**。後載入的 extension 拿到的是別人的版本。
- 首批要手寫的三個包——`http`（httpx）、`discord`（discord.py → aiohttp）、`openai`（httpx）——**全部依賴同一批 HTTP 函式庫**。衝突不是理論風險，是必然。
- 假的隔離比沒有隔離更糟：使用者看到「每個包有自己的 venv」的 UI，卻在執行期拿到別人的版本，這種 bug 極難診斷。

因此 P1 的 Host 實作直接是 **SubprocessHost**：每個 extension 一個 process，以 stdio JSON-RPC 雙向通訊（§7.5）。增量成本約 1～1.5 週，其中真正的工作在反向通道，而那正是晚做等於重寫的部分。

`InProcessHost` 仍然保留，但**只用於內建積木與測試**——它是 §17 題庫的快速路徑，不承載第三方程式碼。

附帶好處：§12.2 的實質隔離從「未來的架構改造」降級成「在既有 process 邊界上加 OS 限制」，那是可以漸進做的。

---

## 8. 前端架構

### 8.1 動態積木註冊

啟動流程：
1. `GET /api/extensions` 取得所有 manifest——**含內建**（D21）。內建的以命名空間為 id（`control`、`data`、…）並標記 `builtin: true`，UI 據此不顯示「解除安裝」。
2. 將 manifest 轉成 Blockly 的 block definition（`%(name)` → Blockly 的 `%1` + args 陣列）。
3. `Blockly.defineBlocksWithJsonArray()` 註冊，並依 `color` 產生對應的 toolbox category。
4. dropdown 型參數註冊為 dynamic dropdown，展開時才呼叫 `POST /api/extensions/{id}/dropdown/{source}`（附帶同積木其他已填參數，讓下拉可依賴前一個選項，例如先選 server 再列 channel）。結果快取 60 秒，並提供手動重新整理。

因此**新增積木不需要改前端一行程式碼**——這句話對內建與第三方**同樣成立**，因為兩者走的是同一條路（D21）。

#### 工具箱的版面

- **固定寬度。** 讓寬度隨每個分類最長的積木浮動，切換分類時整個畫布會左右跳動，
  而畫布正是使用者在對齊積木的地方。
- **一條連續的捲動軸**（Scratch 的作法）：所有分類接在同一個 flyout 裡，點分類是
  **捲到那一段**，不是換一份清單。這讓「我不知道那顆積木在哪一類」從一個要先答對
  才問得出口的問題，變成滑一遍就解決的問題——而那正是新使用者最常有的處境。
  官方外掛 `@blockly/continuous-toolbox` 就是做這件事的。
- 左下角保留**擴充功能入口**（Scratch 放「添加擴展」的位置）：點開是積木包的
  安裝／設定面板（§7、§12.1 的審閱確認）。P1 才接得上，但**位置現在就留著**——
  它是「新增積木包」唯一的入口，等到有東西可裝再找地方擺，多半會擺成一個藏在
  設定裡的分頁，那等於把整個擴充系統藏起來。

#### 內建積木的宣告放哪、怎麼不漂移

宣告放在 handler 旁邊：`interpreter/builtins/control.yaml` 與 `control.py` 並列，如同積木包的 `manifest.yaml` 與 `main.py` 並列。同一個資料夾、同一個檔名前綴，改一邊時另一邊就在眼前。**檔名跟著 handler 走**（`object_ns.yaml`、`time_ns.yaml`），命名空間以 manifest 的 `id` 為準——與積木包「目錄名必須等於 id」的規則不同，因為這裡是 Python 模組名在做主。

`event` 是唯一沒有 `.py` 的命名空間：hat 積木不被執行，引擎從 `hat.next` 起跑（§5.1）。它是純宣告，同時也是「引擎不認得的 hat 就是錯的」那條形狀驗證的資料來源。

形狀也從這份宣告來（D20）。**不從「handler 註冊在 `COMMANDS` 還是 `VALUES`」反推**：反推看起來省事，但它讓形狀變成實作的副產物，一顆忘了註冊的積木會變成「不認得」，而 §13.3 說不認得的 opcode 要當佔位符放行——於是形狀驗證對它默默失效。宣告是獨立的第二個來源，兩者不一致由下面第一個測試抓。

真正的漂移風險只有一個：**manifest 宣告的參數名與 handler 實際讀的 key 對不上**（`t.value(b, "condition")` vs `args: {cond: ...}`）。積木包靠 `_check_coverage` 在載入期比對 `@block` 與 manifest，但內建積木沒有 `@block` 可比。改用兩個測試守：

| 測試 | 抓什麼 |
|---|---|
| manifest 宣告的 opcode 集合 == 註冊表（`COMMANDS` / `VALUES` / `HAT_OPCODES`）中該命名空間的集合，且形狀相符 | 少宣告、多宣告、形狀寫錯 |
| §17 題庫每一份 `project.json` 裡用到的每個 input 名稱，都必須在該積木的 `args` 宣告過 | 參數名對不上——**題庫已經免費覆蓋大部分積木**，這條不必另外寫測資 |

第二個測試順帶把 §17.2 那條「約半數積木沒有專屬題目」的債變成可量化的東西：沒有題目的積木，它的參數名就沒有人守。

### 8.2 狀態管理
- `useWorkspaceStore`（zustand）：專案 meta、變數、髒標記。
- `useRunStore`：runId、thread 狀態、blockId → 執行狀態的 map、log buffer（上限 5000 筆，環形）。
- Blockly workspace 本身是 uncontrolled，不放進 React state；只在存檔/執行時 `Blockly.serialization.workspaces.save()` 導出。

### 8.3 執行時視覺回饋
| 事件 | UI 表現 |
|---|---|
| `block.enter` | 積木外框發光（Scratch 的黃框） |
| `block.exit` (reporter) | 積木**中央**上方浮出數值氣泡，2 秒後淡出 |
| `block.exit` 值為 object / list | 氣泡改為**可展開的 JSON tree**，不是截斷字串——使用者「看得到」自己拿的是物件還是文字，這是最有效的型別防呆（§8.5） |
| `block.error` | 紅框 + 錯誤氣泡，點擊展開 traceback |
| `block.hot` | 外框持續發光 + 角落顯示執行次數 |
| `var.set` | 變數監看面板即時更新（面板**可關**，見下） |

氣泡對齊積木的**中央**而不是左緣。reporter 常常插在一顆很寬的積木的某個孔裡，
靠左的氣泡會飄到跟它無關的欄位上方——看起來像在說隔壁那顆積木的事，而值氣泡
唯一的工作就是「說清楚是誰回了什麼」。

外框高亮**不能假設積木的底色**：積木顏色來自各自的 manifest（§8.1），是積木包
作者決定的，Scratch 那種黃框畫在橘色的 `control` 積木上幾乎看不見。做法是白色
描邊（在深色積木上分界）+ 外發光（在淺色積木上分界），兩者互補。

變數監看面板**要能關掉**。執行中的即時數值對除錯很有用，但它同時是一個一直在
動的東西；不除錯的時候它只是在旁邊閃。預設開啟，開關狀態記在使用者偏好而
**不進 IR**——§4.2 的 `ui` 規則是「刪掉不影響執行結果」，而這個開關連積木都不
屬於，放進專案檔會讓同一份專案在不同人手上長得不一樣。偏好存哪裡見 §16 Q15。

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
| 排程 | `event.when_cron (expr) (timezone)` | APScheduler，支援 cron 與 interval。**timezone 為必填**（§4.9）——沒有它，同一份專案在不同機器上會在不同時刻觸發 |
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

只有一種模式。原草稿的第二種（Transpile）已砍除，理由見 §10.2。

### 10.1 Bundle 模式（P3）
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

### 10.2 Transpile 模式 — **已砍除**（D14）

早期草稿規劃產生可讀的 Python 原始碼，附一張完整的 IR → Python 映射表。**v1 不做，且短期內不打算做。**

理由是文件自己已經寫出來的兩句話：

1. §10.1 承認 Bundle 模式「**滿足 90% 的『我要離開 GUI 自己跑』需求**，且與解譯器共用同一份程式碼，零維護成本」。
2. 原草稿承認 `stop all`、broadcast 的語意「轉譯後不完全等價」。

一個滿足 10% 額外需求、卻**不保證等價**的功能，代價是**永久維護第二套執行語意**——每加一顆積木都要在兩處實作，每改一條規則都要在 §17 的題庫上跑兩遍並解釋差異。這是本設計中投入產出比最差的一項，估 2～3 週且逐年攤還。

#### 如果將來真的要做

條件是「有人具體說出 Bundle 模式解決不了的需求」，而不是「產生原始碼看起來比較厲害」。屆時的定位必須寫死成：

> **一次性的 scaffold 產生器，不保證語意等價，不隨積木更新而維護。**

放在 `blocky export --scaffold` 這種明確的次要位置，而不是與 Bundle 模式並列的「兩種模式」。

#### 對其他章節的影響

- §4.6 提到「求值順序在轉譯時也必須保持」——**求值順序的規定仍然有效**（由左而右、深度優先），它是解譯器自己的語意，與是否轉譯無關。
- §4.7 的 `refs` 少了一個使用者，但另外兩個理由（靜態檢查、錯誤定位）仍然成立。
- §4.2 的 `ui` 忽略規則不變。

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

### 12.2 敏感資料的傳播邊界

§12.1 把 secret 收進 OS keyring，但那只管**靜態儲存**。真正的洩漏路徑在事件流：

- §8.5 規定 `block.enter` 附帶「展開後的字串」——使用者把 token 寫進 `${}` 或變數，展開值就沿著 WS 廣播出去。
- §6.2 規定 `block.exit` 帶 `value`（上限 4KB）——一顆 `http.get` 的回應可能含 `Authorization` 回音或 session token。
- §6.3 雖然不落地 `block.enter/exit`，但 `log` 與 `block.error` 的 traceback **會存進 SQLite 明文**，而 traceback 最常見的內容就是「帶著 header 的 request 物件」。

對一個賣點是「接 Discord bot token 和 LLM API key」的工具，這必須有明確措施：

| 措施 | 做法 |
|---|---|
| **值遮蔽** | Host（§7.5）持有本次 Run 用到的所有 secret 明文集合。事件序列化前做子字串比對，命中則替換為 `***`。粗暴但有效，成本約一天 |
| **參數遮蔽** | manifest 宣告 `type: secret` 的參數，其值**永不進入任何事件**，一律以 `***` 呈現 |
| **traceback 清洗** | 存進 SQLite 前套用同一組遮蔽規則 |
| **不記錄 request body** | `ctx.http` 的預設錯誤處理只記 status 與 URL（且 URL 去除 query string 中的 `token` / `key` / `secret` 類參數），不記 headers |

**已知限制**：子字串比對擋不住經過編碼或切割的 secret（例如 base64 後的 token）。這是知情的取捨——完整方案需要污點追蹤，成本遠超 v1 的預算。UI 上要誠實告知：「執行歷史可能含敏感資料，分享前請檢查」。

### 12.3 v2 措施（實質隔離）
- ~~SubprocessHost~~ — 已提前至 P1，見 §7.6（D13）。
- 逐步加入 OS 層限制（Linux seccomp/namespace、macOS sandbox-exec、Windows Job Object）。
- 選配的 container 執行模式。

**架構要求**：§7.5 的 ExtensionHost 介面與「args 必須可 JSON 序列化」的約束**從 P0 就強制**。由於 §7.6 已把 SubprocessHost 提前到 P1，process 邊界屆時就存在，本節剩下的工作是「在既有邊界上加 OS 限制」，可以漸進進行。

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

同一條原則延伸到**任何**認不得的 opcode（例如專案來自更新版的 runtime）：它不是載入期錯誤，而是保留為佔位符，執行到它時給出 `unknown_block` 錯誤。因此形狀驗證（§4.2）刻意跳過認不得的 opcode——否則佔位符會在開檔時就把整份專案擋掉。

---

## 14. 專案目錄結構

```
blocky/
├── packages/
│   ├── editor/                 # React + Blockly 前端
│   │   ├── src/ir/             # IR ↔ Blockly 轉換
│   │   ├── src/runtime-client/ # WS 客戶端、事件套用
│   │   └── src/components/
│   └── shared-schema/          # IR 與 manifest 的 JSON Schema（前後端共用真實來源）
├── backend/
│   ├── blocky/
│   │   ├── api/                # FastAPI 路由 + app 工廠
│   │   ├── cli.py              # `blocky serve`
│   │   ├── ir/                 # pydantic 模型、驗證、遷移
│   │   ├── interpreter/        # 解譯器核心
│   │   │   ├── declarations.py # 讀 builtins/*.yaml，形狀與宣告的入口（D21）
│   │   │   └── builtins/       # 每命名空間 control.py + control.yaml（D21）
│   │   ├── extensions/         # Host / Registry / Loader / venv 管理
│   │   ├── triggers/           # cron / webhook / stream
│   │   ├── codegen/            # bundle 匯出（transpile 已砍，見 §10.2）
│   │   └── storage/            # SQLite + keyring
│   └── tests/
│       ├── conformance/        # §17 一致性題庫（規格的可執行版本）
│       ├── unit/
│       └── contract/           # Host 邊界，InProcess 與 Subprocess 跑同一份
├── extensions/                 # 內建與使用者安裝的積木包
│   ├── http/
│   ├── discord/
│   └── openai/
└── docs/
```

`shared-schema` 是 IR **與 manifest** 的唯一真實來源：從 JSON Schema 產生 TS 型別，後端直接用 pydantic 模型，兩邊同源。manifest 也在裡面，是因為 D21 之後它同樣是前後端介面——§8.1 的動態註冊照著 `args[].type` 決定畫哪種欄位。兩份都由 `backend/tools/export_schema.py` 產生，CI 跑 `--check`。

---

## 15. Roadmap

### 施工順序的總原則

**先鎖語意，再接介面。** 前端、擴充系統、真實 API 都是「晚一步做成本不變、早一步做會反覆改」的東西；而 IR schema 與直譯器語意是「晚改成本十倍」的東西。因此 P0 刻意把前端往後排，讓語意問題在只有題庫與直譯器的環境下解決——那時候改一條規則是改一行。

### 目前進度

| 階段 | 狀態 |
|---|---|
| P0a 語意核心 | **完成**。63 題題庫、214 個測試 |
| P1 的 Host 邊界（§7.5） | **提前完成**。manifest schema、`ExtensionHost` / `HostChannel`、`InProcessHost`、邊界的正規化與驗證、24 題合約測試 |
| P0b 編輯器 | **進行中**（第 1～5 步完成，驗收 1 通過）← 現在在這裡 |
| P1 其餘（SubprocessHost、三個手寫包） | 延後 |

**為什麼 Host 邊界提前、其餘 P1 延後**：介面不能晚做，實作可以。`ExtensionHost` / `HostChannel` 兩個方向的介面與 `boundary.py` 都已經定案，合約測試也已經對 host 實作參數化——SubprocessHost 之後接上去只要在 `HOSTS` 加一行，題目一題都不用改。反過來，P1 剩下的「手寫三個包」卡在 Q10（目標使用者未定），而 P0b 不卡任何未決問題。

### P0a — 語意核心（目標 3～4 週，**無前端**）

**範圍**：`shared-schema` 的 IR JSON Schema（唯一真實來源，產生 pydantic 與 TS 型別）；§17 題庫框架與前 40 題；Python 直譯器涵蓋 `control` / `data` / `operator` / `object` / `type` / `time` / `procedure` / `debug`；免宣告變數（§4.5）；含回傳值的自訂函式（§4.6）；字串插值（§4.7）；`persist_*`（§5.4）。**沒有 HTTP server、沒有 WebSocket、沒有 Blockly。** 題庫用 CLI 直接驅動直譯器。

**驗收**：`pytest tests/conformance` 全綠，且 §17.2 表格中每一列都有對應題目。此時「這個語言是什麼」已經完全確定且可執行。

> 這一階段的產出是一份**手寫的 `project.json` 可以跑出正確事件序列**。看起來不像產品，但它是後面所有東西的地基。

### P0b — 編輯器（目標 4～6 週）

**範圍**：Blockly zelos 工作區；IR ↔ Blockly 雙向轉換（§8.4）；整合變數名稱／插值／多行的 `FieldText`（§8.5）；FastAPI + WebSocket 事件與高亮；SQLite 存讀檔；只有 `when_flag_clicked` 一種觸發。

> `FieldText` 是這階段唯一的高風險項。原稿估 2～3 天，**修正為 1～1.5 週**——它要同時做 `${}` pill 行內渲染、autocomplete popup、multiline textarea、運算式紅線，而 Blockly 的自訂 field API 在富渲染上很難纏（popup 在 textarea 內的定位、workspace 縮放時的座標換算）。務必一次做成一個類別，不要先做三個再合併。

**驗收**：
1. 能拉出「重複 10 次 → `改變 count 增加 1` → log」，過程中**沒碰過任何「建立變數」按鈕**；執行後看到積木逐顆高亮、變數面板即時變動、按停止能立即中斷。
2. 能定義一個 `加總 (清單)` 函式，在函式體內用 `回傳 ()` 結束，並把呼叫積木塞進 `log ()` 的輸入孔拿到結果；`回傳` 放在 `重複` 迴圈裡也能正確中斷整個函式。
3. 在 `log ()` 的文字框直接打 `第 ${i} 筆：${resp.items[1].title}` 能正確取值；打 `${items[0]}` 得到「索引從 1 開始」的專屬錯誤；打 `${a + b}` 在**存檔前**就被標為錯誤。
4. 貼一段三行文字進積木欄位，欄位自動變成 textarea；空欄位可用右鍵強制切換，且切換狀態存檔重開後仍在。

#### 開工前的先決條件（後端還缺的東西）

P0b 不只是前端。以下五項在 P0a 都還沒碰，全部落在這個階段：

| 缺口 | 影響 | 狀態 |
|---|---|---|
| `backend/blocky/api/` 不存在，依賴裡沒有 fastapi / uvicorn | 前端沒有東西可以連 | **完成**（第 1 步） |
| `backend/blocky/storage/` 是空目錄 | 存不了檔 | **完成**（第 1 步） |
| 內建積木還沒有 manifest（D21 已定做法，宣告待補） | 前端畫不出積木 | **完成**（第 2 步，87 顆） |
| Run 沒有**外部**停止 API（只有 `control.stop` 積木內部的 `StopSignal`） | 驗收 1 的「按停止能立即中斷」做不出來 | **完成**（第 5 步） |
| §6.2 的 50ms 批次與 `block.hot` 聚合沒實作 | `forever` 迴圈會打爆 WebSocket，這是 §6.2 標「必須做」的原因 | **完成**（第 5 步） |

#### 施工順序

| # | 步驟 | 估計 | 為什麼排這裡 |
|---|---|---|---|
| ~~1~~ | ~~後端 API 殼 + SQLite 存讀檔（`/api/projects`）、`blocky serve`~~ **完成** | 0.5 週 | IR 已經定案，這一步幾乎沒有設計風險；前端第一天就有東西可吃 |
| ~~2~~ | ~~補內建積木的 manifest（D21）+ §8.1 的兩個一致性測試 + `GET /api/extensions`~~ **完成（87 顆）** | 2～3 天 | 純後端、可立即測試，且它是第 3 步的**唯一**資料來源。先做完這步，前端才有東西可註冊 |
| ~~3~~ | ~~Blockly zelos 工作區 + 動態註冊 + 工具箱~~ **完成** | 1 週 | **第一次看到介面**。文字欄位先用最陽春的 field 佔位 |
| ~~4~~ | ~~IR ↔ Blockly 雙向轉換（§8.4）+ property test~~ **完成** | 1 週 | 做完存讀檔才閉環。題庫那 63 份 `project.json` 是現成的轉換層測資，一份都不必另寫 |
| ~~5~~ | ~~`/api/runs` + WS 事件 + §6.2 批次與聚合 + 停止 API~~ **完成** | 1 週 | 完成驗收 1 |
| 5b | **編輯器體感（第一次實測回饋）**：落單堆疊可存可跑（§4.1、§5.1）、hat 形狀、工具箱版面（§8.1）、值氣泡置中與變數面板開關（§8.3）、`取得 (名稱)`（§4.5）、補齊 manifest 的 `default` | 3～5 天 | **第一項是擋路的**：畫布上留一顆沒接 hat 的積木就存不了檔，等於逼使用者邊做邊收拾，而「先拉幾顆試試看」正是這個工具的主要使用方式。其餘是同一批回饋，一起做比分散進第 6、7 步便宜——它們都只碰宣告與呈現層，與 `FieldText` 沒有交集。**內部順序有講究，見下** |
| 6 | `FieldText`（§8.5）：`${}` pill、autocomplete、多行、運算式紅線 | 1～1.5 週 | 最高風險項，但它要在真的積木與真的縮放下才試得出來，1～4 是前置。**一次做成一個類別** |
| 7 | 函式 mutator、形狀重塑與孤兒處理、靜態警告（§8.5） | 0.5～1 週 | 完成驗收 2、3、4 |

第 5b 步的來源是**把編輯器交到使用者手上跑一次**之後的回饋。它值得單獨列一步
而不是散進第 6、7 步，理由是這批問題有一個共同性質：**每一條都只有把東西做出來
才問得出口**。「黃框在橘積木上看不見」「落單積木存不了檔」「工具箱寬度會跳」
沒有一條寫得進 P0a 的規格，卻每一條都直接決定這個工具堪不堪用。施工順序的總原則
是「先鎖語意再接介面」——介面接上之後的第一件事，就是去發現語意階段問不出來的
那些問題。

#### 第 5b 步內部的順序

十件事不是平行的。前兩項有真正的依賴，其餘八項只是舒適度。

| 順位 | 項目 | 為什麼排這裡 |
|---|---|---|
| 1 | **落單堆疊可存檔**（§4.1） | 它擋住日常操作，而且是十項裡最便宜的一項：刪掉 `_validate_shapes` 裡「腳本最上面必須是事件積木」那條，引擎一行都不用改——§5.1 的觸發條件本來就是「top 的 opcode 等於這次的 trigger」，落單堆疊自己就選不中 |
| 2 | **點一下就跑**（§5.1） | 前提是「這種堆疊存得下來」，所以必須跟在 1 後面。做完這兩項，使用者就能用 Scratch 的方式探索積木——剩下八項都是在這個能力之上的舒適度 |
| 3～9 | hat 形狀、工具箱版面、擴充入口位置、氣泡置中、面板開關、`取得 (名稱)`、補齊 `default` | 彼此獨立，順序隨意。共同性質是**只碰宣告與呈現層**：`define.ts` / `setup.ts` / CSS，或內建積木的 manifest YAML。不碰 IR schema、不碰引擎、與 `FieldText` 沒有交集 |
| 10 | 非字串字面值（§16 Q16） | **建議延到第 6 步**，見下 |

順位 1 與 2 的成本不對稱，容易估錯：**1 是刪一條檢查，2 要動引擎**。
`_run_thread` 目前寫死從 `hat.next` 起跑（hat 不執行），而「點一下就跑」的起點
就是那顆積木本身；起點是 reporter 時還要走求值而不是走 stack。這是第 5b 步唯一
真的碰到執行核心的地方，估計要留給它。

**Q16 建議不要在第 5b 步做。** 它的傾向解 (a) 是「影子積木依當下的值選型別 +
右鍵切換型別」，而右鍵選單與欄位行為正是第 6 步 `FieldText` 要重寫的東西
（`ui.multiline` 的強制切換也在等同一個右鍵選單）。現在做等於在一個即將被換掉
的欄位上加功能，然後在第 6 步再拆一次。候選解 (c)（manifest 宣告 `literalKinds`）
確實不依賴 `FieldText`，可以跟「補齊 `default`」一起宣告掉——但在 (a) 還沒做之前
沒有人讀它，先宣告只是把猜測寫進 manifest。整條留到第 6 步一起決定。

#### 第 5b 步對時程的影響

第 5b 步是插隊進來的，P0b 原估 4～6 週。這 3～5 天**不會壓縮第 6 步**（那一步的
1～1.5 週已經是上修過的誠實版本，不是可以再借的預算），所以它就是把 P0b 整體
往後推約一週。這是「把東西交到使用者手上」必然要付的錢——而且付得早比付得晚
便宜：同樣這批問題若留到第 7 步之後才發現，改的就不只是 `define.ts` 與一條
schema 檢查了。

第 6 步的排序有風險：最高風險項排在後面，違反「早點碰」的直覺。緩解方式是第 3 步就把 field 的**介面**留好（一個類別、options 開關），第 6 步只換實作——如果第 3 步偷懶用三個不同的 Blockly 內建 field，第 6 步就會變成重寫。

第 2 步看起來只是打字，但它同時把 §8.5 的三層多行機制、§7.2 的 `min` / `max`、D20 的形狀來源全部從「散在程式碼裡的隱含知識」變成一份可驗證的宣告。補宣告的過程本身就會照出目前哪些積木的參數命名不一致——那是免費的體檢。

> P0a + P0b 跑通，整個專案的技術風險就解除了八成。

### P1 — 擴充系統（4～6 週）

**範圍**：manifest 格式與 loader；ExtensionHost 介面 + **SubprocessHost**（D13）與反向通道（§7.5）；動態積木註冊；動態下拉；憑證管理（keyring）與 §12.2 的值遮蔽；uv venv 依賴隔離。

**手寫三個包的順序刻意如此**：

1. `http` — 沒有外部帳號、沒有 SDK 依賴，純粹驗證 manifest → 積木 → 執行這條路。**先用本地起的假伺服器**，不打真 API。
2. `openai` — 驗證 secret 管理與長時間請求。
3. `discord` — 最後做，因為它是唯一需要**長連線 trigger**（§7.3 的 async generator）的，複雜度最高。

**驗收**：新增一個資料夾、重啟後端，新積木自動出現在工具箱且可執行；三個包能串成「抓 API → 丟給 LLM 摘要 → 發到 Discord」；§17.4 的 Host 合約測試在 InProcess 與 Subprocess 兩種實作下都綠。

### P2 — 自動化（3～4 週）
**範圍**：Trigger Manager（cron / webhook / stream，含 §4.9 的 timezone）；專案 active 狀態與後端重啟恢復；§6.3 的事件落地策略；執行歷史與日誌檢視；`try_catch`；錯誤重試策略。

**驗收**：設定每天 09:00 的流程，關閉瀏覽器，隔天檢查執行歷史有紀錄且 Discord 收到訊息。**此時產品才真正等價於 n8n**。

### P3 — 擴散（4～6 週）
**範圍**：AI 生成積木包（含 §11.2 驗證管線）；匯出 Bundle（§10.1）；積木包分享／匯入；Tauri 桌面打包。

**驗收**：口述一個需求，10 分鐘內產出可用的積木包並成功執行。

### 時程的誠實版本

原稿的 P0 3～4 週是把前端與語意合併估的。拆開並修正 `FieldText` 後，**單人現實估計**：

| 階段 | 估計 |
|---|---|
| P0a 語意核心 | 3～4 週 |
| P0b 編輯器 | 4～6 週 |
| P1 擴充系統 | 4～6 週 |
| P2 自動化 | 3～4 週 |
| P3 擴散 | 4～6 週 |
| **合計** | **約 6～9 個月** |

上表的 P0b 是拆步之前的估計。第 5b 步（3～5 天）插隊之後，P0b 實際落在 **5～7 週**；
合計仍在 6～9 個月的區間內，因為那個區間本來就不是把每一列的下界相加。


**打包策略**：P0～P2 只做 `pip install blocky && blocky serve`（自動開瀏覽器）。Tauri/Electron 留到 P3，過早引入會吃掉大量時間在建置與簽章上。

---

## 16. 未決問題

| # | 問題 | 影響 | 建議 |
|---|---|---|---|
| Q1 | 單機工具 vs 可自架伺服器多人共用？ | 若要多人，權限模型、憑證隔離、執行佇列必須在 P0 進資料模型 | 暫定單機。但 SQLite schema 從 P0 就加 `owner_id` 欄位（單機時固定為 `local`），事後擴充成本趨近於零 |
| Q2 | ~~是否支援 Scratch 的 broadcast？~~ | — | **已決議：不做**（D14）。實作成本確實低，但語意表面成本高（要不要 broadcast-and-wait？會排隊嗎？跨專案嗎？），且它是唯一會產生「畫布上看不出誰呼叫誰」的控制流。procedure 與 trigger 已覆蓋其用途 |
| Q3 | 專案檔要不要包含 extension 原始碼？ | 影響可攜性與安全 | 建議只記錄 id + version + 來源 URL，不內嵌程式碼（避免分享專案 = 分享任意程式碼） |
| Q4 | LLM 呼叫由誰付費？ | 影響 AI 生成功能的商業模式 | v1 使用者自帶 API key |
| Q5 | 積木文字的 i18n？ | manifest 的 `text` 欄位是否要支援多語 | 建議 P1 就把 `text` 設計成可為 `{en: "...", "zh-TW": "..."}`，事後改格式代價高 |
| Q6 | 需不需要「函式區域變數」？ | §5.4 目前 `data.set` 一律寫全域，遞迴函式用同名暫存變數會互相覆蓋 | P0a 先只有「參數 + 全域」，觀察是否真的有人踩到。要加就加 `區域設定 [名稱] 為 ()` 一顆積木（寫入當前 frame），語意單純且與現有解析順序相容——但不要為了假想需求先做。§17 題庫先放一題記錄現況行為，將來改動時才看得出差異 |
| Q7 | 免宣告變數的錯字風險是否可接受？ | §4.5 用「執行期嚴格報錯 + 執行前靜態檢查」補洞，但終究不如 id 綁定可靠 | 先做，並在 P0 驗收時實測：故意打錯字看提示是否夠明確。若使用者仍常被咬，退路是把 `FieldText` 的變數名稱模式改成「只能從既有名稱選 + 新增」的 combo，IR 格式不用動 |
| Q8 | `${}` 要不要支援預設值（`${a.b ?? "無"}`）？ | §4.7 目前 key 不存在一律錯誤，容錯只能靠 `object.has` 或 `object.get` 的預設值孔 | **v1 不做，且這條線要守很硬**。開了預設值語法，下一步就是三元、就是函式呼叫，`${}` 會滑向一個迷你語言（違背 D9）。真的被咬再考慮 `${a.b?}` 這種「只加一個問號、不引入運算子」的最小形式 |
| Q10 | **目標使用者到底是誰？** | §1.1 寫「非工程師」，但 §10 的 CLI 常駐、docker、匯出服務的是工程師。兩者把 roadmap 拉向相反方向：教育路線該投資教學 UX 與中文化、少而精的積木；開發者路線該投資整合數量與 CLI，且 §11 的 AI 生成積木包從「可有可無」升格為「唯一能對抗 n8n 500+ 整合的手段」 | **這是目前最該決定的一件事，但不阻擋 P0a**——語意核心對兩條路線完全相同。最遲要在 P1 開始前決定，因為它決定手寫哪三個包 |
| Q11 | 持久化儲存要不要支援原子遞增？ | §5.4 的 `persist_set` 是 read-modify-write，兩個並發 Run 同時累加計數器會掉更新 | v1 不做。真的需要時加 `data.persist_change`，用 SQLite 的單一 UPDATE 語句實作。先在文件與 tooltip 講清楚限制 |
| Q12 | secret 遮蔽用子字串比對夠嗎？ | §12.2 擋不住編碼過或被切割的 secret | 夠用於 v1，但 UI 必須誠實標示「執行歷史可能含敏感資料」。完整方案需要污點追蹤，成本遠超 v1 預算 |
| Q13 | ~~內建積木的定義住在前端還是後端？~~ | — | **已決議：後端，與積木包同一條路**（D21）。每個內建命名空間一份 manifest，放在 handler 旁邊（`interpreter/builtins/control.yaml` 與 `control.py` 並列），由 `GET /api/extensions` 與積木包一起吐給前端。**已實作**（P0b 第 2 步，87 顆分成 9 份 YAML）；漂移由 §8.1 的兩個測試守住 |
| Q9 | `blocks[].ui` 會不會長成雜物間？ | §4.2 允許任意未知 key，長期可能塞進一堆前端狀態 | 目前只有 `multiline` 一個 key。規則是「刪掉整個 `ui` 不影響執行結果」——任何違反這條的提案一律退回。若 key 超過 5 個就該檢討是不是有語意屬性混進來了 |
| Q14 | 「點一下就跑」（§5.1）的全域變數要不要沿用上一個 Run？ | D12 說全域變數的生命週期 = 一次 Run，所以點一下跑一次就清空一次。探索時這可能很吵：想試 `取得 (count)`，卻得先點一次 `設定 count`，而那又是另一個 Run，於是永遠讀不到 | 先照 D12 不開特例——一致的規則比方便重要，而且「昨天設的值今天讀不到是報錯而不是過期資料」正是 D12 想守的東西。實測後若真的難用，退路是**探索模式共用一個 Run**（連續點擊視為同一個 Run，直到按停止或改動積木），而不是讓變數隱式跨 Run 存活 |
| Q15 | 使用者偏好存哪裡？ | 變數面板開關（§8.3）是第一個，之後還會有主題、字級、工具箱寬度。存瀏覽器 localStorage 最省事，但換一台電腦就沒了；存後端則要決定它跟著誰走 | 暫定 localStorage。真要進後端時它會跟著 Q1 的 `owner_id` 走——那時候加一張 `preferences` 表即可，不影響任何既有 schema。**不准進 `project.json`**：偏好進了專案檔，同一份專案在不同人手上就會長得不一樣 |
| Q16 | 非字串字面值（數字、布林、null）怎麼在畫布上輸入？ | `data.set` / `operator.eq` 這類參數宣告成通用 `type: string`（可放任何 IR 值）的孔，編輯器只給文字框，而文字框只產得出字串——打 `99` 拿到的是 `"99"` 不是 `99`。§4.4.1 的題庫明確要求兩者不同，所以 content-sniffing（看起來像數字就轉數字）會直接破壞那條語意，不能做 | 目前只能接一顆 `operator` 或 `type.cast` reporter 繞過去，而使用者不會想到。三個候選：(a) 影子積木依**當下的值**選型別（已經是 `deserialize.ts` 的作法），再給欄位一個切換型別的右鍵選單；(b) 新增一顆明確的「數字 (n)」字面值 reporter，與 `type.cast` 同一族；(c) manifest 讓 `type: string` 的 arg 額外宣告 `literalKinds: [string, number]`，由前端決定畫哪種影子。傾向 (a)+(c)——(b) 會讓「打一個數字」變成要拖積木，比現況更繁瑣。**時機：跟第 6 步的 `FieldText` 一起做**，因為 (a) 要的右鍵選單與欄位行為正是那一步要重寫的東西（§15） |

---

## 17. 測試策略

原稿唯一提到測試的地方是 §8.4 的序列化 round-trip。但這個專案的核心是一台**直譯器**，而直譯器最高槓桿的投資只有一件事。

### 17.1 核心：一致性題庫（conformance corpus）

一份 `IR 輸入 → 預期事件序列` 的語料庫，存在 `backend/tests/conformance/`，每一題是一個資料夾：

```
conformance/
├── control/
│   ├── repeat_basic/
│   │   ├── project.json      # 輸入 IR
│   │   ├── expected.jsonl    # 預期的正規化事件序列
│   │   └── meta.yaml         # 標題、對應章節、tags
│   └── return_inside_loop/
├── data/
├── template/
├── type/
└── errors/
```

`meta.yaml` 必須指回設計文件的章節，題庫因此同時是**規格的可執行版本**：

```yaml
title: "return 在 repeat 迴圈內應中斷整個函式，而非只跳出迴圈"
spec: "§4.6 執行語意"
tags: [procedure, control, unwind]
```

#### 為什麼是事件序列而不是「最終輸出」

只比對最終結果會漏掉本設計中一大半的語意：求值順序（§4.6）、`block.enter/exit` 的配對、變數寫入的時機、錯誤發生在哪一顆積木。這些都是「結果對了但過程錯了」的類型，而過程正是使用者在畫布上看得見的東西。

#### 正規化：讓比對穩定

原始事件含時間戳與時長，不可直接比對。跑題庫時套用正規化：

| 欄位 | 處理 |
|---|---|
| `ts` `durationMs` | 移除 |
| `runId` `threadId` | 依首次出現順序重編為 `r1` `t1` `t2` |
| `blockId` | **保留原值**——它是題目的一部分，錯了就是定位錯了 |
| `traceback` | 只保留例外型別與訊息首行 |
| 事件順序 | 同一 thread 內嚴格有序；跨 thread 則依 §17.3 處理 |

### 17.2 必須進題庫的項目

這份清單直接來自本文件中「講了會踩雷但畫面上看不出來」的每一條規則。**任何一條沒有對應題目，那條規則就等於沒寫。**

| 章節 | 題目 |
|---|---|
| §4.2 | 回報型積木接在堆疊上／指令型積木插進輸入孔／hat 夾在堆疊中間 → **載入期**錯誤 |
| §4.3 | `${items[0]}` 回專用錯誤訊息；越界是錯誤而非 `null`；`-1` / `last` 正確 |
| §4.3 / D15 | `5.0` 字串化為 `"5"`；`0.1+0.2` 的字串化；`items[1.0]` 合法、`items[1.5]` 錯誤 |
| §4.3 | `0` 是 falsy 但 `type.is_empty(0)` 為 **false** |
| §4.4.1 | `"5" = 5` 為 false；`"5" < 10` 是錯誤而非靜默轉型 |
| §4.5 | 讀取未建立的變數 → 錯誤，且訊息含編輯距離建議 |
| §4.5 | `change` 未建立的變數 → 錯誤，不是從 0 起算 |
| §4.6 | `return` 在 `repeat` 內 → 中斷整個 function，不只跳出迴圈 |
| §4.6 | `try_catch` **不可**捕捉 `ProcedureReturn`（最容易寫錯的一題） |
| §4.6 | 跑完 body 沒 `return` → 回 `null` |
| §4.6 | 遞迴深度 200 → 拋錯而非堆疊爆掉 |
| §4.6 | 輸入孔求值順序為由左而右、深度優先（用帶副作用的 reporter 驗證） |
| §4.7 | `${items}` 整格取值保留 list 型別；`第${i}筆` 走字串拼接 |
| §4.7 | `$${` 逸出 |
| §4.7 | `${a + b}` 在**存檔驗證**期就被擋，不是執行期 |
| §4.7 | `${str.foo}` 對字串取屬性 → 專用訊息「是不是需要先解析 JSON」 |
| §4.7 | `refs` 與 `value` 不一致 → 載入期報錯（§4.7 衍生欄位規則） |
| §4.8 | `type.is("123", 數字)` false 而 `type.can_cast` true |
| §4.8 | `type.is([], 物件)` 為 **false**；`type.is(null, 物件)` 為 **false** |
| §4.9 | 跨時區的 cron 與 `time.format`；跨日光節約時間的 `time.add` |
| §5.1 | `drop` / `queue` / `restart` 三種 concurrency 的行為 |
| §5.4 / D12 | 全域變數不跨 Run 存活；`persist_*` 跨 Run 存活 |
| §5.4 | procedure 參數遮蔽全域時的解析順序 |
| §5.5 | `CancelledError` 穿透 `try_catch`；`finally` 清理有 5 秒上限 |
| §5.6 | 一個 thread 出錯，其餘 thread **繼續執行** |
| §6.2 | 熱迴圈聚合成 `block.hot`；`value` 超過 4KB 標記 `truncated` |
| §6.3 | `block.enter/exit` **不**進 SQLite，`log` / `block.error` 進 |
| §7.2 | `type: json` 的字串參數被 parse；非法 JSON 有專用訊息；`object` / `list` 嚴格不轉換 |
| §7.5 | 宣告 `returns: object` 卻回字串 → 邊界就錯，訊息指名該積木包 |
| §7.5 | 其餘型別依 §4.3 轉換：數字進 `string` 參數會轉，不是報錯（D19） |
| §12.2 | secret 值不出現在任何事件與 traceback 中 |
| §13.3 | 認不得的 opcode **不是**載入期錯誤，執行到才以 `unknown_block` 呈現 |

### 17.3 併發題目怎麼比對

跨 thread 的事件交錯順序**不確定**，直接比對必然 flaky。做法：

- 預期檔可標記 `unordered: [t1, t2]`，比對時各 thread 的事件抽出來**分別**驗證順序，只對 thread 間有因果的點（`thread.start` 早於該 thread 任何事件）做全域斷言。
- 需要確定性時，題目自己用 `control.wait` 建立順序——這比讓比對器變聰明可靠得多。

### 17.4 其他層次

| 層 | 工具 | 重點 |
|---|---|---|
| IR schema | `hypothesis` property test | §8.4 的 `deserialize(serialize(ws))` 等價；隨機 IR 必須要嘛通過驗證要嘛給出**指向具體 blockId** 的錯誤 |
| 值轉換 | 參數化單元測試 | §4.3 的轉換表逐格覆蓋，含每一個錯誤情況 |
| Host 邊界 | 合約測試 | §7.5 的正規化與驗證。**同一份測試同時跑 InProcessHost 與 SubprocessHost**，這是兩者行為一致的唯一保證 |
| 內建積木宣告 | 一致性測試 | D21 的兩條：manifest 的 opcode 集合 == 註冊表且形狀相符；題庫用到的 input 名稱都宣告過（§8.1） |
| 積木包 | 每包自帶 `tests/` | 用假的 HTTP 層，不打真 API |
| 端到端 | Playwright | 只做 §15 的驗收情境，數量控制在 5 個以內——e2e 很貴且脆 |

### 17.5 題庫先於實作

**P0 的做法是：先寫題目，再寫直譯器。**

§15 的四條 P0 驗收標準直接寫成題庫的前四題。理由是本文件已經把語意想得很細（`return` 的 unwind 邊界、`${}` 的整格取值、索引 0 的專用訊息），這些決定**現在不落成可執行的形式，三個月後就會在實作中被悄悄改掉**——而且改的時候不會有人察覺，因為沒有東西會變紅。

題庫也是後續每一個大決策的安全網：D13 換 SubprocessHost、將來若真的做原始碼產生器，都是「換一套執行器、跑同一份題庫」。沒有題庫，那些事情就只能靠手動點一點。

---

## 附錄 A — 端點清單

已實作的標 ✅。其餘見 §15 的施工順序。

| Method | Path | 說明 |
|---|---|---|
| GET | `/api/projects` | 專案列表 ✅ |
| GET/PUT | `/api/projects/{id}` | 讀取 / 儲存 IR ✅。PUT 在寫入前跑 §4 的載入期驗證，不通過回 **422 + `blockId`**，且不進資料庫。存的是 body 原文，round-trip 不掉欄位 |
| DELETE | `/api/projects/{id}` | 刪除 ✅ |
| POST | `/api/projects/{id}/active` | 啟用/停用 trigger |
| POST | `/api/runs` | 手動執行，回傳 runId ✅。跑的是**已存檔**的那一份專案。收 `trigger`（綠旗）或 `blockId`（§5.1 的「點一下就跑」，第 5b 步） |
| GET | `/api/runs`、`/api/runs/{id}` | 執行清單與狀態 ✅ |
| DELETE | `/api/runs/{id}` | 停止 ✅。回 **202**：停止是請求不是完成（§5.2 要等到下一個讓出點） |
| GET | `/api/runs/{id}/events` | 執行歷史（重播用）。等 §6.3 的 SQLite 落地 |
| WS | `/ws/run/{runId}` | 即時事件流 ✅ |
| GET | `/api/extensions` | 所有 manifest，**含內建**（D21，內建標記 `builtin: true`）✅ |
| POST | `/api/extensions/install` | 安裝（含審閱確認 token） |
| POST | `/api/extensions/{id}/dropdown/{source}` | 動態下拉 |
| PUT | `/api/extensions/{id}/config` | 設定與憑證 |
| POST | `/api/ai/generate-extension` | AI 生成（P3） |
| POST | `/api/export/{mode}` | bundle / transpile |
| ANY | `/hooks/{token}/{path}` | Webhook 入口 |
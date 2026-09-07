# Blockyard 與 MCP

> 這份文件記錄「把一份 Blockyard 專案發布成 MCP server」的研究與提案。
> 它不是目前已實作的功能；截至 2026-09-05，這是設計草案，沒有 MCP runtime、
> endpoint 或積木。

## 1. MCP 是什麼

[Model Context Protocol（MCP）](https://modelcontextprotocol.io/specification/2026-07-28/architecture)
是讓 AI host（例如 Codex 或其他桌面 AI app）與外部 server 交換 context、呼叫能力的
開放協定。它以 JSON-RPC 為基礎，角色分成：

```text
AI app（Host）
  └─ MCP Client ── protocol ── MCP Server（Blockyard）
                                  └─ Blockyard project / extensions
```

一個 MCP server 可以公開三種 primitive：

| Primitive | 誰決定何時使用 | 在 Blockyard 裡可能對應到 |
|---|---|---|
| **Tools** | 模型 | 可呼叫的 workflow / procedure |
| **Prompts** | 使用者 | 可選取的文字模板 |
| **Resources** | client / application | 專案資料、文件或執行產物 |

這份提案的核心是 **Tools**。MCP tool 必須有穩定的名稱、說明與 JSON Schema
`inputSchema`；client 用 `tools/list` 發現它們，再以 `tools/call` 加上 JSON arguments
呼叫。Tool 的回覆可帶 text 或結構化 JSON。詳見
[MCP Tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)。

### 「prompt」不是 tool 的 description

最初的草圖是：

```text
do mcp (prompt) c-block {
  add to mcp (reporter block)
  ...
  command block
  ...
}
```

這裡有兩個不同概念：

- 如果 `(prompt)` 是「這個操作做什麼、模型何時該用它」，它是 **tool description**，
  不是 MCP prompt。
- MCP **prompt** 是使用者主動選擇的模板（常見呈現是 slash command）；它由
  `prompts/list` / `prompts/get` 提供，不能代替模型可自動呼叫的 tool。

因此，將 reporter／command 公開給模型的功能應命名為 **MCP tool** 或
**發布 MCP 工具**，而不是 `do mcp(prompt)`。

## 2. 目前架構能否做

**可以做，但它是新的 project-level capability，不是新增一顆 extension block 就能完成。**

現有系統已經具備重要底座：

| 已有能力 | 證據 | 對 MCP 的意義 |
|---|---|---|
| 積木有 command / reporter / boolean / hat 形狀 | `extensions/manifest.py::BlockSpec` | 可分別代表副作用與回傳值 |
| 直譯器可跑 stack 或求值 reporter | `interpreter/engine.py::Interpreter.run` / `entry_for` | 可重用既有執行語意 |
| extension handler 的參數已先在 host 端求值，且可跨 subprocess 呼叫 | `extensions/registry.py::_make_handler` | MCP invocation 不必繞過 extension 權限邊界 |
| 專案載入時會載入所需 extension、解 secret config、驗 IR、執行完卸載 | `api/validation.py::open_project` | 每個 `tools/call` 可沿用一次 Run 的資源生命週期 |
| FastAPI app 與 RunManager 已存在 | `api/app.py` | 可承接 HTTP MCP transport |

目前沒有 MCP package、協定 endpoint、`tools/list` 或 `tools/call` 實作；也沒有將
block graph 轉成 MCP schema 的資料模型。

### 不能直接把現有 reporter／command 當 tool 的原因

1. **沒有外部輸入的語意。** 現有 reporter input 是畫布上接好的值或子 reporter；
   MCP caller 傳來的 JSON arguments 尚無位置可綁。
2. **沒有可交給 caller 的結果。** reporter 雖可求值，但 `Interpreter.run()` 對外回傳
   run status 與 event list，不會將 entry reporter 的值變成 API result。
3. **command 的執行範圍不明確。** 現在從一顆 command 進入會由它所在 stack 的頂端開始
   跑，這是「點一下就跑」的正確語意；它不等於「只執行這個 tool body」。
4. **圖形的宣告不夠。** MCP tool 需要 name、description、argument schema、可選 output
   schema；一顆任意 reporter 本身無法提供這些資訊。
5. **公開能力需要另一道安全邊界。** 被 MCP 呼叫的 workflow 可能間接使用 HTTP、檔案、
   subprocess 與 project secrets。外部模型不應因為看得到 server 就自動取得所有能力。

## 3. 建議的資料模型：procedure 就是 tool

不要把「設定／註冊 MCP」做成執行時會跑一次的 C-block。MCP client 在呼叫前就必須能
`tools/list`；若工具要等某條腳本跑過才註冊，server 重啟、專案未觸發、或多個 Run
同時發生時都沒有可預期的清單。

**建議將已命名 procedure 發布為 tool。** procedure 已有名稱、參數、body，以及可選
回傳型別；它正好是 stable callable unit。

概念上的畫面可以保留 C-block，但它只宣告發布清單：

```text
MCP server [personal_automation]
  expose procedure [get_weather]
  expose procedure [send_message]
```

而實際工作仍留在 procedure：

```text
define [get_weather (city)] returns
  return (HTTP GET ... city ...)

define [send_message (channel) (text)]
  Discord send message ...
```

這比 `add to mcp (任意 reporter)` 更好，因為：

- procedure 參數可直接轉成 `inputSchema`；
- procedure 的回傳宣告可轉成 `outputSchema`；
- command body 有天然的邊界；
- 呼叫流程能重用既有的 procedure scope、return 與 validation；
- tool id 不會因為畫布 block id 改變而漂移。

### 可加入的 project-level 宣告

IR 應有明確、可序列化的 MCP 區塊，例如：

```json
{
  "mcp": {
    "server": { "name": "personal_automation" },
    "tools": [
      {
        "procedure": "get_weather",
        "name": "get_weather",
        "description": "查詢指定城市的目前天氣",
        "enabled": true,
        "confirmation": "never"
      },
      {
        "procedure": "send_message",
        "name": "send_message",
        "description": "在指定頻道傳送訊息",
        "enabled": true,
        "confirmation": "always"
      }
    ]
  }
}
```

`procedure` 是 project 內部的穩定參照；`name` 是對 MCP client 公開的名稱。兩者不必
綁死，這讓 procedure 可以有適合畫面的中文名稱，而 MCP tool 採用簡潔、唯一的
ASCII name。

## 4. 執行模型

```text
MCP client
  │ tools/list
  ▼
Blockyard MCP server ── project 的 mcp.tools + procedure signatures ──> Tool definitions

MCP client
  │ tools/call { name, arguments }
  ▼
Blockyard MCP server
  │ 1. 找出 tool → procedure
  │ 2. 驗證 arguments 符合 JSON Schema
  │ 3. 開 project、extensions、secrets（沿用 open_project 邏輯）
  │ 4. 建立一次隔離的 Blockyard Run / procedure frame
  │ 5. 將 arguments 綁入 procedure params
  │ 6. 取得 procedure return
  ▼
MCP ToolResult { content, structuredContent, isError }
```

每一次 `tools/call` 都是一次獨立 Run：它的 variable scope、cancellation、event log、
extension contexts 與 secret masking 都不跨呼叫共用。這與既有「Interpreter instance =
一次 Run」的模型一致。

## 5. 必要變更

### 5.1 IR 與編輯器

- 新增 project-level `mcp` schema、序列化與反序列化。
- 做出 MCP server C-block（或專用設定面板），只允許 `expose procedure` 條目。
- 檢查 tool name 唯一、格式合法、指定 procedure 存在。
- procedure 簽章變動時立即顯示 schema 會如何改變；刪 procedure 時阻擋或要求先移除
  MCP export。

### 5.2 Interpreter

- 新增「直接呼叫 procedure」的 public entry，而非重用 `entry_for(command)`。
- 將 procedure return 保留為 programmatic result；目前 run events 仍照常產生，
  但不作為 tool 的唯一輸出。
- 將 MCP arguments 綁入 procedure parameter scope，並保證不寫進 project globals。
- 對 command 型 procedure 回傳合法的空成功結果；有 return 的 procedure 則產生
  `structuredContent`。

### 5.3 MCP server

第一版只實作 **tools**，不要同時做 prompts、resources、sampling：

- 初始化與 capability 宣告（`tools`）。
- `tools/list`：由 project declarations 生出 deterministic tool list。
- `tools/call`：驗 schema、跑 procedure、轉成 MCP ToolResult。
- 選定一種 transport：本機整合優先選 **stdio**；若要讓其他機器或 web client 使用，
  再加 Streamable HTTP。
- 專案設定或公開工具清單變更時，對支援的 client 發 `tools/list_changed`。

應使用維護中的 MCP SDK，而不是把本專案的 extension JSON-RPC 直接偽裝為 MCP：兩者都
用了 JSON-RPC，但 method、lifecycle、capability negotiation、transport 與安全契約不同。

### 5.4 安全與權限

MCP 官方規格建議 client 明確顯示工具與呼叫，並讓使用者可拒絕敏感操作。Blockyard
還需要 server 端的保護，不能只信任 client UI：

- 預設所有 tool 為 disabled，使用者明確發布才出現在 `tools/list`。
- 每個 tool 有 `never` / `always` / `dangerous-only` confirmation policy。
- 以 tool 為單位控制可用 project；不得僅靠猜 URL 或 project id 取得別人的 workflow。
- HTTP transport 必須加 authentication；不把 secrets 放入 tool schema、tool result 或 log。
- tool description、extension 回傳的外部文字都是不可信資料，不能將它們當作授權指令。
- Run event 的既有 secret masking 要擴展到 MCP result 組裝路徑。

## 6. 分期建議

1. **語意與測試先行**：project MCP declarations、procedure export validation、參數
   schema 轉換、procedure direct invocation/result capture。
2. **本機最小 server**：stdio + `tools/list` + `tools/call`；只支援純 JSON
   arguments 和 JSON return。
3. **編輯器**：MCP server C-block／設定面板、公開工具清單、schema preview、權限警告。
4. **安全與運維**：confirmation、auth、audit logs、cancellation/timeouts、`list_changed`。
5. **後續才考慮**：MCP prompts、resources、Streamable HTTP、long-running task extensions。

## 7. 不建議的方向

- **任意 reporter 自動變 tool**：沒有穩定 name、外部參數、說明與可控 return boundary。
- **任意 command 自動變 tool**：現有 command 的起跑規則會帶出上游 stack，可能執行
  使用者沒有公開的積木。
- **執行一次才註冊工具**：`tools/list` 在 workflow 尚未運行時會不穩定，且 server 重啟後
  工具消失。
- **將 extension RPC 當 MCP server**：它是 host 與 extension subprocess 的內部協定，
  不是對 AI client 的公開協定。
- **第一版同時實作 prompts/resources**：它們是獨立語意；把 tool 的基本安全與 result
  模型做好才是最短路徑。

## 8. 結論

Blockyard 很適合成為 MCP server：其 manifest 驅動的積木系統、隔離 extension host、
project validation 與 Run lifecycle 已經覆蓋了大部分執行底座。真正要新增的不是另一個
積木 handler，而是「**一份 project 可明確、可安全地對外公布哪些 named procedures，
以及外部 JSON arguments 如何進來、結果如何出去**」這一層。

第一版應以「**發布 procedure 為 MCP tool**」完成垂直切片；它保留 C-block 的視覺語言，
但避免把 MCP server 宣告誤做成暫時性的 runtime stack。

# PROGRESS

最後更新：2026-08-27 ｜ 7 commits ｜ `cd backend && .venv/bin/python -m pytest` → 214 passed（題庫 63 題）

## 1. 本次完成

**P1 起步：Extension Host 邊界**（`backend/blocky/extensions/`，7 檔約 1330 行）

先把**假的** Host 邊界做對，真 API 進來時錯的只會是網路，不會是架構。

- `manifest.py` — §7.2 的 pydantic 模型。驗證刻意超出「型別對不對」：`text` 的 `%(x)` 要有對應參數、`command` 不能宣告 `returns`、`dropdown` 要有 `source`、包 id 不能佔用內建命名空間。§11 的 AI 生成積木包全靠這一層兜底
- `boundary.py` — §7.5 的進／出兩件事，**只實作一次**，每個 Host 實作共用。進：`json` 正規化（字串試 parse，保證 `main.py` 拿到 dict/list）、其餘型別依 §4.3 的轉換表（D19），`number` 另外檢查 manifest 的 min/max；出：`returns` 驗證 + 「可 JSON 序列化」的隱含約束
- `host.py` — `ExtensionHost`（host → extension）與 `HostChannel`（反向）兩個 Protocol、`CallContexts`（ctx_token 表）、`EventSinkChannel`
- `inprocess.py` — `InProcessHost`。載入期比對 manifest ↔ `main.py`：宣告了沒實作、實作了沒宣告、hat 沒有 `@trigger`、`source` 沒有 `@dropdown`，四種漂移都擋
- `registry.py` — 引擎面對的門面。把每顆積木包成 `(Thread, Block)` 的 handler；**求值仍在引擎這一側**，§4.6 的由左而右不因積木來自第三方而改變
- `sdk.py` + 新的 `blocky/__init__.py` — `from blocky import block, dropdown, trigger, on_load, on_unload`（PEP 562 延遲載入，不可能有環）
- `interpreter/engine.py` — 新增 extension opcode 路徑；查不到 handler 時分四種原因說明（形狀放錯／hat 位置錯／§13.3 積木包沒安裝／真的不存在）
- `extensions/demo/` — 純函式、不打網路的假積木包，11 顆積木，其中兩顆**故意壞掉**（宣告物件卻回字串、回傳 `set`）
- 題庫 46 → 63 題；新增 `tests/contract/`（24 題，依 §17.4 對 host 實作參數化）與 `tests/unit/test_manifest.py`、`test_extension_loading.py`

**設計文件 v0.4** — 三個實作撞出來的決策，程式碼與文件都已同步

- **D18**：`HostChannel` 的 `log` 與 `is_cancelled` 同步，只有 `emit` 非同步。§7.3 的 `ctx.log(...)` 沒有 await，且 log 必須當場落在 `block.enter`/`block.exit` 之間，否則黃金軌跡不是決定性的
- **D19**：邊界套用的是 **§4.3 那張轉換表本身**，不是第二套規則。積木包的參數孔與內建積木的孔在畫面上一模一樣，使用者沒辦法知道哪顆會轉。`object` / `list` 是唯一例外——§4.3 沒有「轉成物件」這一格，那只可能是 JSON parse，而 parse 必須看得見（D10）
- **D20**：積木**形狀**與位置改為載入期驗證（`ir/schema.py::_validate_shapes`，形狀從註冊表與 manifest 來）。認不得的 opcode 刻意例外，保留為 §13.3 的佔位符，執行期以新的 `unknown_block` 錯誤呈現——那是 BlockyError，發得出 `block.error`，Thread 不會再安靜死掉

## 2. 未解決問題與已知限制

- **內建的 84 顆積木還沒有 manifest**。做法已定（D21：與積木包同一條路，宣告放在 handler 旁邊），但宣告本身要補，估 2～3 天。這是 P0b 第 2 步，也是前端能畫出積木的唯一資料來源。
- **Q10 目標使用者未定**（教育 vs 開發者）。**不阻擋 P0b**；但 P1 的三個手寫包開工前必須定。
- **P1 剩下的部分刻意延後**：SubprocessHost 與跨 process 的反向通道（§7.6）、`ctx.http`（§7.4）、secret 值遮蔽（§12.2）、migrations（§13.2）。介面已經定案、合約測試已經對 host 參數化，SubprocessHost 接上去只要在 `HOSTS` 加一行——介面不能晚做，實作可以。
- **形狀驗證要接上前端。** 載入期驗證已經有了，但 §8.4 的 IR ↔ Blockly 轉換還沒寫；編輯器本身應該讓形狀錯誤根本拼不出來，載入期驗證是第二道防線（手寫 IR、AI 生成 IR、舊版專案）。
- **P0b 的後端缺口**（§15 已列表）：`blocky/api/` 不存在、`blocky/storage/` 是空目錄、Run 沒有**外部**停止 API、§6.2 的 50ms 批次與 `block.hot` 聚合沒實作。最後一項是 §6.2 標「必須做」的原因——沒有它 `forever` 迴圈會打爆 WebSocket。
- **題庫覆蓋不全**：84 顆內建積木中約半數沒有專屬題目——`data.list_insert/replace/index_of`、`operator` 的字串與 regex 系列、`object.set/delete/values`、`time.timestamp`。`list_insert` 用 `len+1` 正規化索引，**尚無測試**，可疑。
- **§17.2 有幾列還寫不出題目**：`concurrency` 的 drop/queue/restart、`CancelledError` 穿透、`block.hot` 聚合、§6.3 的 SQLite 落地——都要等 P0b/P2 的機制存在。
- **遞迴 headroom 是估的**：`PYTHON_FRAMES_PER_BLOCKY_FRAME = 24`（`interpreter/engine.py`）為經驗值，靠 `RecursionError` 保險絲兜底。
- 設計文件 §16 的 Q1、Q3–Q9、Q11、Q12 仍未決。

## 3. 下一次的第一個 TODO

**開始 P0b — 編輯器**（§15，估 4～6 週，七步施工順序寫在 §15）。順序回到設計文件原訂的 P0a → P0b → P1；P1 剩下的部分延後，理由見上。

> Q13 已決議為 **D21**：內建積木也是宣告式的，與積木包共用同一套 `BlockSpec` 與同一個端點。§14 原本把內建定義放前端的那一行已經拿掉。

### 第 1 步：後端 API 殼 + 存讀檔（估 0.5 週）

排第一是因為 IR 已經定案，這一步幾乎沒有設計風險，而且做完前端第一天就有東西可吃。

- [ ] `pyproject.toml` 加 `fastapi`、`uvicorn[standard]`
- [ ] `backend/blocky/storage/` — SQLite：專案表。依 Q1 的暫定結論，schema 從現在就加 `owner_id`（單機固定 `local`），事後擴充成本趨近於零
- [ ] `backend/blocky/api/` — FastAPI app：`GET /api/projects`、`GET/PUT /api/projects/{id}`（附錄 A）
- [ ] `blocky serve` 入口（§15 打包策略：P0～P2 只做 `pip install blocky && blocky serve`，自動開瀏覽器）

**驗收**：

1. `blocky serve` 起得來。
2. 把題庫任一份 `project.json`（例如 `tests/conformance/procedure/eval_order_left_to_right/project.json`）`PUT` 進去再 `GET` 回來，內容等價 —— round-trip 不掉欄位、不改 blockId。
3. `PUT` 一份壞的 IR（reporter 接在堆疊上）回 **422**，訊息指名 `blockId` —— 也就是存檔時就跑 §4 的載入期驗證，包含 D20 的形狀檢查。這條是重點：驗證邏輯已經寫好了，這一步只是把它接到 HTTP 上，不要在 API 層重寫一份。

> 存檔時的形狀驗證需要知道積木包的形狀（`resolve_shape`），所以 `PUT` 的處理流程是：讀專案宣告的 extensions → 載入 → `load(data, shapes=resolve_shape(registry))`。`blocky/conformance.py::run_case` 已經是這個順序，照抄即可。

### 第 2 步：補內建積木的 manifest（D21，估 2～3 天）

前端能畫出積木的唯一資料來源。純後端、可立即測試。

- [ ] 每個命名空間一份 YAML，放在 handler 旁邊：`interpreter/builtins/control.yaml` 與 `control.py` 並列，格式與 `extensions/*/manifest.yaml` 完全相同（無 `requirements`、無 `main.py`）
- [ ] 用現成的 `Manifest.model_validate` 載入——**不要**為內建另寫一套 schema，那正是 D21 要避免的第二條路
- [ ] `GET /api/extensions` 一併吐出內建（標記 `builtin: true`）
- [ ] `resolve_shape` 的內建那半改成讀宣告，而不是從「handler 註冊在 `COMMANDS` 還是 `VALUES`」反推

**驗收**（§8.1 的兩個一致性測試）：

1. 每個命名空間，manifest 宣告的 opcode 集合 == 註冊表（`COMMANDS` / `VALUES` / `HAT_OPCODES`）中該命名空間的集合，且形狀相符。抓少宣告、多宣告、形狀寫錯。
2. §17 題庫那 63 份 `project.json` 裡用到的每一個 input 名稱，都必須在該積木的 `args` 宣告過。抓「manifest 的參數名與 handler 實際讀的 key 對不上」—— 那是這個做法**唯一**真正的漂移風險（積木包靠 `_check_coverage` 比對 `@block`，內建沒有 `@block` 可比）。

> 第 2 個測試順帶把「約半數積木沒有專屬題目」那條債變成可量化的：**沒有題目的積木，它的參數名就沒有人守**。補宣告時會照出目前哪些積木的參數命名不一致，那是免費的體檢。

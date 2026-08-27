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

- **Q10 目標使用者未定**（教育 vs 開發者）。**決定 P1 手寫哪三個包**，開工前必須定。
- **形狀驗證要接上前端。** 載入期驗證已經有了，但 §8.4 的 IR ↔ Blockly 轉換還沒寫；編輯器本身應該讓形狀錯誤根本拼不出來，載入期驗證是第二道防線（手寫 IR、AI 生成 IR、舊版專案）。
- **§7 還沒做的**：SubprocessHost 與反向通道的跨 process 實作（§7.6）、`ctx.http`（§7.4）、secret 的值遮蔽（§12.2）、migrations（§13.2）、動態積木註冊到前端（§8.1）。
- **題庫覆蓋不全**：84 顆內建積木中約半數沒有專屬題目——`data.list_insert/replace/index_of`、`operator` 的字串與 regex 系列、`object.set/delete/values`、`time.timestamp`。`list_insert` 用 `len+1` 正規化索引，**尚無測試**，可疑。
- **§17.2 有幾列還寫不出題目**：`concurrency` 的 drop/queue/restart、`CancelledError` 穿透、`block.hot` 聚合、§6.3 的 SQLite 落地——都要等 P0b/P2 的機制存在。
- **遞迴 headroom 是估的**：`PYTHON_FRAMES_PER_BLOCKY_FRAME = 24`（`interpreter/engine.py`）為經驗值，靠 `RecursionError` 保險絲兜底。
- 設計文件 §16 的 Q1、Q3–Q9、Q11、Q12 仍未決。

## 3. 下一次的第一個 TODO

實作 `SubprocessHost`（§7.6、D13）：每個 extension 一個 process，stdio JSON-RPC 雙向通訊，`ExtensionHost` 與 `HostChannel` 兩個方向都要。

驗收：`tests/contract/test_host_boundary.py` 的 `HOSTS` 加上 `"subprocess"` 後，**24 題兩種實作全綠**，題目一題都不用改；`extensions/demo` 在自己的 venv 裡跑；`ctx.log` 與 trigger 的 yield 走反向通道回來後，題庫的黃金軌跡不變。

理由：反向通道正是「in-process 時看不見、跨 process 時全部要重寫」的部分，晚做等於重寫。而現在合約測試已經參數化、`boundary.py` 已經共用——SubprocessHost 有一份現成的規格可以照著長。uv venv 的依賴隔離可以晚一步，先讓 process 邊界存在。

這一步同樣不需要先決定 Q10。

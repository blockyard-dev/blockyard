# PROGRESS

最後更新：2026-08-27 ｜ 4 commits ｜ `cd backend && .venv/bin/python -m pytest` → 150 passed

## 1. 本次完成

**設計文件 v0.3**（`docs/design.md`，1029 → 1400 行）
- 補洞：全域變數生命週期定為「一次 Run」+ `persist_*` 積木（D12、§5.4）；`number` 釘死 IEEE754 double（D15、§4.3）；新增 `time` 命名空間與 cron timezone（§4.9）；事件落地策略（§6.3）；secret 傳播邊界（§12.2）；內建 hat 的 `concurrency`（§5.1）；`refs` 改為衍生欄位（§4.7）；比較語意（D17、§4.4.1）
- 砍除：Transpile 模式、broadcast、`ctx.get_var/set_var`（D14、D16）
- 提前：SubprocessHost v2 → P1（D13、§7.6）
- 新增：§17 一致性題庫策略；P0 拆成 P0a/P0b，時程改為 6–9 個月

**P0a 語意核心**（無前端、無 server、無擴充系統）
- `backend/blocky/errors.py` — 控制流訊號繼承 `BaseException`，`try_catch` 攔不到
- `backend/blocky/ir/values.py` — 值模型；數字字串化與 node 交叉驗證 15/15 一致
- `backend/blocky/ir/template.py` — `${}` 解析與求值
- `backend/blocky/ir/schema.py` — IR pydantic 模型 + 載入期驗證
- `backend/blocky/interpreter/` — 引擎 + `builtins/` 共 84 顆積木
- `backend/blocky/conformance.py`、`testing.py` — 題庫執行與 fixture builder
- `backend/tests/` — 46 題題庫 + 單元 / property test
- `backend/tools/export_schema.py` → `packages/shared-schema/project.schema.json`

## 2. 未解決問題與已知限制

- **Q10 目標使用者未定**（教育 vs 開發者）。不影響語意核心，但**決定 P1 手寫哪三個包**，開工前必須定。
- **題庫覆蓋不全**：84 顆積木中約半數沒有專屬題目——`data.list_insert/replace/index_of`、`operator` 的字串與 regex 系列、`object.set/delete/values`、`time.timestamp`。`list_insert` 用 `len+1` 正規化索引，**尚無測試**，可疑。
- **§17.2 有幾列還寫不出題目**：`concurrency` 的 drop/queue/restart、`CancelledError` 穿透、`block.hot` 聚合、§6.3 的 SQLite 落地——都要等 P0b/P2 的機制存在。
- **遞迴 headroom 是估的**：`PYTHON_FRAMES_PER_BLOCKY_FRAME = 24`（`interpreter/engine.py`）為經驗值，靠 `RecursionError` 保險絲兜底。題庫已能觸發正確錯誤，但數字本身沒有理論依據。
- 設計文件 §16 的 Q1、Q3–Q9、Q11、Q12 仍未決。

## 3. 下一次的第一個 TODO

建立 `backend/blocky/extensions/`：manifest 的 pydantic schema（§7.2）+ `ExtensionHost` Protocol（§7.5）+ `InProcessHost`，並在邊界實作 §7.5 的兩件事——進：`type: json` 參數的正規化；出：`returns` 宣告的驗證。

驗收：一個假的 `demo` 包（純函式、不打網路）放進 `extensions/`，能被載入、註冊進 registry、由直譯器透過新的 extension opcode 路徑呼叫；且當它宣告 `returns: object` 卻回字串時，**在 Host 邊界就報錯**並指名該 extension。

理由：先把假的 Host 邊界做對，真 API 進來時錯的只會是網路，不會是架構。這一步不需要先決定 Q10。

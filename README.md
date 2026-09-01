# Blocky Workflow

Scratch 風格的積木編輯器，組出會做真事的自動化流程：HTTP、Discord、LLM、檔案。

設計文件：[docs/design.md](docs/design.md)（v0.25）

---

## 現況：P0 與 P1 完成

依 §15 的施工順序——**先鎖語意，再接介面，最後接真實世界**。語意已經鎖住；編輯器
畫得出全部積木、存得了檔、按執行會真的跑；擴充系統跑在獨立的子行程與 venv 上，
三個手寫積木包都拿真憑證打過真的 API。

| 模組 | 狀態 |
|---|---|
| `blocky/ir/values.py` | 值模型與轉換（§4.3、D15 的 IEEE754 語意） |
| `blocky/ir/template.py` | `${}` 插值解析與求值（§4.7、D9） |
| `blocky/ir/expression.py` | 運算積木的算術文法（§4.7b、D23） |
| `blocky/ir/schema.py` | IR 的 pydantic 模型與載入期驗證（§4.1、§4.2、D20 的形狀） |
| `blocky/interpreter/` | tree-walking 直譯器 + 90 顆內建積木（`builtins/*.py` 實作、`builtins/*.yaml` 宣告，D21） |
| `blocky/extensions/` | Host 邊界（§7.5）、manifest schema、`InProcessHost` 與 **`SubprocessHost`**（雙向 JSON-RPC、`uv venv` 依賴隔離）、keyring |
| `blocky/runs/` | Run 生命週期、WebSocket 事件、§6.2 的批次與聚合、停止、**hat 的監聽**（§9 的前身） |
| `extensions/` | 三個手寫積木包：`http`（httpx，由 host 提供）、`openai`（官方 SDK）、`discord`（discord.py，含長連線 trigger） |
| `blocky/api/` | FastAPI：`/api/projects`、`/api/extensions`、`/api/runs`、`/ws/run/{id}`（附錄 A） |
| `blocky/storage/` | SQLite 專案表 |
| `blocky/cli.py` | `blocky serve` |
| `tests/conformance/` | §17 一致性題庫，87 題 |
| `packages/shared-schema/` | 由 pydantic 匯出的 IR 與 manifest JSON Schema |
| `packages/editor/` | Blockly zelos 工作區、manifest → 積木的動態註冊（§8.1）、IR ↔ Blockly 雙向轉換（§8.4）、`FieldText`（§8.5）、執行時的視覺回饋（§8.3） |

下一步是 §15 的 **P2（自動化）**：Trigger Manager（cron / webhook / 長連線）、專案
的 active 狀態與後端重啟恢復、§6.3 的事件落地、`try_catch`、manifest 的可重複參數
群組。詳細狀態、已知限制與未決題見 [PROGRESS.md](PROGRESS.md)。

### 跑起來看看

```bash
cd packages/editor && npm install && npm run build
cd ../../backend && .venv/bin/python -m blocky.cli serve
```

`blocky serve` 會把 `packages/editor/dist/` 掛在 `/` 上，自動開瀏覽器。

開發時分成兩個 process（前端有 HMR，dev server 把 `/api` 代理到 8787）：

```bash
cd backend && .venv/bin/python -m blocky.cli serve --no-open   # :8787
cd packages/editor && npm run dev                              # :5173
```

`http://127.0.0.1:8787/api/extensions` 是前端畫積木的唯一資料來源，內建與積木包
從同一個端點吐出（D21）——所以**新增積木不需要改前端一行程式碼**。

---

## 開發

需要 Python 3.12（3.14 上部分依賴還沒有 wheel）與 [uv](https://docs.astral.sh/uv/)。

```bash
cd backend
uv venv --python 3.12
uv pip install -e ".[dev]"
```

### 常用指令

```bash
.venv/bin/python -m pytest                    # 全部測試
.venv/bin/python tests/gen_corpus.py --check  # 只驗證題庫的 expect 斷言
.venv/bin/python tests/gen_corpus.py          # 重新產生 fixture 與黃金軌跡
.venv/bin/python tools/export_schema.py       # 重新匯出 IR 與 manifest JSON Schema
.venv/bin/python -m blocky.cli serve          # 起 API（預設 127.0.0.1:8787）
```

---

## 題庫（§17）

題庫是**規格的可執行版本**。每一題有兩層檢查：

- `meta.yaml` 的 `expect` —— **手寫**。這才是規格，人讀得懂，改動時要有意識。
- `expected.jsonl` —— **產生**。黃金事件軌跡，抓「結果對了但過程錯了」。

只有 `expect` 全部通過的題目才會寫出黃金軌跡，否則就是把 bug 鎖進題庫。

`meta.yaml` 的 `spec` 欄位指回設計文件章節。**改語意時先改題目，再改實作。**

新增題目：編輯 `tests/corpus.py`，跑 `gen_corpus.py`，檢查 diff。

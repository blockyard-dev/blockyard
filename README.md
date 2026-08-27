# Blocky Workflow

Scratch 風格的積木編輯器，組出會做真事的自動化流程：HTTP、Discord、LLM、檔案。

設計文件：[docs/design.md](docs/design.md)（v0.3）

---

## 現況：P0a 語意核心

依 §15 的施工順序——**先鎖語意，再接介面**。目前完成的是「這個語言是什麼」，
還沒有前端、沒有 HTTP server、沒有擴充系統。

| 模組 | 狀態 |
|---|---|
| `blocky/ir/values.py` | 值模型與轉換（§4.3、D15 的 IEEE754 語意） |
| `blocky/ir/template.py` | `${}` 插值解析與求值（§4.7、D9） |
| `blocky/ir/schema.py` | IR 的 pydantic 模型與載入期驗證（§4.1、§4.2） |
| `blocky/interpreter/` | tree-walking 直譯器 + 84 顆內建積木 |
| `tests/conformance/` | §17 一致性題庫，46 題 |
| `packages/shared-schema/` | 由 pydantic 匯出的 IR JSON Schema |

尚未開工：編輯器（P0b）、擴充系統（P1）、Trigger（P2）。

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
.venv/bin/python tools/export_schema.py       # 重新匯出 IR JSON Schema
```

---

## 題庫（§17）

題庫是**規格的可執行版本**。每一題有兩層檢查：

- `meta.yaml` 的 `expect` —— **手寫**。這才是規格，人讀得懂，改動時要有意識。
- `expected.jsonl` —— **產生**。黃金事件軌跡，抓「結果對了但過程錯了」。

只有 `expect` 全部通過的題目才會寫出黃金軌跡，否則就是把 bug 鎖進題庫。

`meta.yaml` 的 `spec` 欄位指回設計文件章節。**改語意時先改題目，再改實作。**

新增題目：編輯 `tests/corpus.py`，跑 `gen_corpus.py`，檢查 diff。

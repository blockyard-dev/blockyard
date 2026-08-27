# PROGRESS

最後更新：2026-08-28 ｜ 9 commits
｜ 後端 `cd backend && .venv/bin/python -m pytest` → 364 passed, 2 skipped（題庫 63 題）
｜ 前端 `cd packages/editor && npm test` → 23 passed

## 1. 本次完成

**P0b 第 3 步：Blockly zelos 工作區 + 動態註冊 + 工具箱**（§15，`packages/editor/`）

**第一次看到介面。** 10 份 manifest（9 個內建命名空間 + demo 包）→ 96 顆積木畫進工具箱，
形狀（command / reporter / boolean / hat / C 型）全部正確。內建與第三方走的是同一段
程式碼，`define.ts` 裡沒有出現任何一個 opcode 的名字（D21）。

- `blockly/define.ts` — manifest → Blockly block definition。`%(name)` → `%1`；`⋯` 是
  C 型積木的堆疊分界（`if_else` 的「否則」要落在第一個堆疊後面）。**`reporter` 一律
  `output: null` 不帶 `returns` 的 check**——§8.5 說型別提示用警告不用形狀，寫成 check
  之後型別未知的變數就插不進宣告了型別的孔；`boolean` 給 `output: 'Boolean'` 只為了讓
  孔畫成六角形，視覺文法留住、連接限制沒跟著來
- `blockly/fields/FieldText.ts` — §8.5 的那**一個**類別，能力用 options 開關。第 3 步做掉
  多行三層（宣告 / 自動 / 強制）與變數名稱的字元限制；`${}` pill、autocomplete、運算式
  紅線留給第 6 步**換實作而不是換類別**。繼承官方的 `FieldMultilineInput` 而不是
  `FieldTextInput`，因為從後者起家的話第 6 步接多行要整個換基底
- `blockly/toolbox.ts` — 一份 manifest 一個分類，顏色來自 `manifest.color`。
  `deprecated: true` 的**註冊但不上架**：舊專案載得進來，但拉不出新的一顆
- `scripts/gen-types.mjs` — 從 `manifest.schema.json` 產生 TS 型別，`--check` 擋倒退
  （與 `tools/export_schema.py` 同一個 CI 慣例）
- `blocky serve` 現在把 `packages/editor/dist/` 掛在 `/` 上，dev 則是 Vite 代理 `/api`

**新增前端測試 23 題**（`blockly/define.test.ts`）

後半直接讀**後端真正在用的那 9 份 `builtins/*.yaml`**，不複製 fixture——複製出來的
那份不會跟著 handler 一起改，於是測試會在真的漂移的那天繼續綠著。守四條不變量：
宣告過的參數都畫得出來且只畫一次、每個 `%N` 都對得到參數、每個非 boolean 的輸入孔
都有影子、每顆積木都有 `message0`。

**做的過程中撞到三個坑，都已修掉，也都有測試守著**

| 坑 | 症狀 | 為什麼會發生 |
|---|---|---|
| 「沒被 `%()` 參照到的參數補在後面」算太早 | `如果 ⬡ 那麼` 變成 `如果 那麼 ⬡ ⬡` | `consumed` 是展開 `%()` 時才填的，在那之前算等於全部都算漏網之魚 |
| `multiline` / `min` / `max` 到不了使用者打字的地方 | `debug.log` 宣告了 `multiline: true` 卻是單行 | 使用者打字的是**影子積木上的欄位**，而共用的影子帶不動 per-arg 設定。改成宣告了修飾欄位就給一顆專屬影子 |
| `FieldText` 的 options 被自己的 class field 初始化蓋掉 | `type: variable` 的名稱限制安靜失效 | Blockly 的 `Field` constructor 裡就呼叫 `configure_()`，而 TS 的 class field 初始化在 `super()` **回來之後**才跑。改用 `declare` |

## 2. 未解決問題與已知限制

- **Q10 目標使用者未定**（教育 vs 開發者）。不阻擋 P0b；P1 的三個手寫包開工前必須定。
- **P1 剩下的部分刻意延後**：SubprocessHost 與跨 process 的反向通道（§7.6）、`ctx.http`（§7.4）、secret 值遮蔽（§12.2）、migrations（§13.2）。介面已定案、合約測試已對 host 參數化，SubprocessHost 接上去只要在 `HOSTS` 加一行。
- **形狀驗證已接上前端的一半。** 編輯器的積木形狀正確了（拼不出形狀錯誤的腳本），但 §8.4 的 IR ↔ Blockly 轉換還沒寫，所以「載入期驗證是第二道防線」這句話還沒真的被測過——要等第 4 步把 63 份題庫 `project.json` 灌進工作區。
- **manifest 沒有 `cap` 宣告。** `control.forever`、`control.stop`、`procedure.return` 在 Scratch 是 cap block（下面不能接積木），YAML 裡只有註解寫著這件事，宣告本身沒有欄位表達它——於是前端替它們接上了 `nextStatement`，後端也不擋。要嘛 manifest 加一個 `cap: true`（與 D20「形狀來自宣告，不從實作反推」一致），要嘛承認它只是死碼。**不要在前端寫死一份 opcode 清單**，那正是 D21 想消滅的第二條路。
- **動態下拉（`source`）還是文字框。** `demo.color_of` 的水果下拉現在是個文字影子。要 `POST /api/extensions/{id}/dropdown/{source}`（§8.1 第 4 步）才問得到選項。形狀與 IR 表示（`inputs` 裡的字面值）與接上之後相同，屆時換掉的只有影子的型別。
- **空的變數名稱欄位很難發現。** `設定 [ ] 為 ()` 的名稱格是個空白小方塊，看不出可以打字。§8.5 的 autocomplete（第 6 步）會解決，在那之前它只是「能用但不好用」。
- **P0b 剩下的後端缺口**：Run 沒有**外部**停止 API、§6.2 的 50ms 批次與 `block.hot` 聚合沒實作。兩者都在第 5 步，沒有後者 `forever` 迴圈會打爆 WebSocket。
- **題庫覆蓋不全，而且現在是可量化的**：87 顆內建積木只有 **42 顆**（48%）在題庫裡出現過。`test_builtin_manifests.py::test_corpus_coverage_is_reported` 會把沒被覆蓋的清單印出來，並用 `BASELINE_COVERED = 42` 擋倒退。**沒有題目的積木，它的參數名就沒有人守**——補題目時記得把基準往上調。`data.list_insert` 用 `len+1` 正規化索引，仍**無測試**，可疑。
- **§17.2 有幾列還寫不出題目**：`concurrency` 的 drop/queue/restart、`CancelledError` 穿透、`block.hot` 聚合、§6.3 的 SQLite 落地——都要等 P0b 第 5 步／P2 的機制存在。
- **`blocky serve` 沒有正式打包測試**：`[project.scripts]` 加了，但只驗過 `python -m blocky.cli`，沒驗過 `pip install` 之後的 `blocky` 指令。
- **遞迴 headroom 是估的**：`PYTHON_FRAMES_PER_BLOCKY_FRAME = 24`（`interpreter/engine.py`）為經驗值，靠 `RecursionError` 保險絲兜底。
- 設計文件 §16 的 Q1、Q3–Q9、Q11、Q12 仍未決。

## 3. 下一次的第一個 TODO

**P0b 第 4 步：IR ↔ Blockly 雙向轉換（§8.4）+ property test**（估 1 週）。**做完存讀檔才閉環。**

測資是現成的：§17 題庫那 63 份 `project.json` 一份都不必另寫。

- [ ] `src/ir/deserialize.ts` — IR → Blockly。`inputs` 的四種 `kind`（`literal` / `template` /
      `block` / `stack`）分別對應影子的欄位值、`FieldText` 的字串、接上的積木、statement 接點；
      `fields` 直接設欄位
- [ ] `src/ir/serialize.ts` — 反過來。**不要直接把 Blockly 的序列化格式當 IR 存檔**（§8.4）：
      那會讓後端綁死在前端函式庫的版本上
- [ ] property test：`deserialize(serialize(ws))` 等價，用 63 份題庫跑
- [ ] 接上 `GET/PUT /api/projects/{id}`，422 的 `blockId` 要能把那顆積木標紅（`api/errors.py`
      從第 1 步就在吐這個欄位了）

轉換層已經有的著力點（第 3 步刻意留的）：

| 東西 | 在哪 | 為什麼對第 4 步重要 |
|---|---|---|
| 積木型別 = opcode，一字不差 | `define.ts` 的 `buildBlock` | `blocks[].opcode` 直接就是 Blockly 的 type，不需要對照表 |
| `SHADOW_FIELD = 'VALUE'` | `define.ts` | 所有字面值影子的欄位同名，取 `literal` 的值只有一條路 |
| `isField()` | `define.ts` | 一個參數該去 `fields` 還是 `inputs`，前後端用的是同一條規則 |
| `RegisteredBlock` | `setup.ts` 回傳 | 反查 manifest（每個孔宣告的型別、預設值）不必再打一次 API |

> **`refs` 不要在前端算**（§4.7）：存檔時由後端重新產生，前端送什麼它都不信。前端只要
> 把含 `${}` 的字串標成 `kind: template` 就好。

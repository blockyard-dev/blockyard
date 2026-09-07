"""面板積木包（§8.3、§16 Q17 的 B 路線）。

**這裡不畫任何東西。** 每顆積木只做一件事：把孔裡的值包成一則訊息，交給
`ctx.send_panel()`。畫圖的是 `ui/` 底下那幾個檔案，跑在編輯器給的 sandbox
iframe 裡——而編輯器**一個字都不解讀**那些訊息。

所以「折線圖長什麼樣子」這個問題的答案完全在這個資料夾裡。要換成 three.js
就是改 `ui/`，編輯器不必動一行。

訊息的形狀是**這個包自己定的**（見 `ui/main.js` 的說明），唯一的外部約束是：
編輯器會在面板重掛時**從頭重播**這次 Run 的全部訊息，所以每一則都要能「從空的
開始重播得出同一張畫面」。
"""

from __future__ import annotations

from typing import Any

from blockyard import BlockError, block

#: 宣告在 manifest 的 `panels`。打錯字會在 `ctx.send_panel` 當場被擋下來
#: （那條路是 fire-and-forget，host 端驗出來的錯誤傳不回來）。
PANEL = "chart"


@block("panel.line_chart")
async def line_chart(ctx, data: list) -> None:
    for i, v in enumerate(data, start=1):
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            # 指名第幾筆：一串 200 個數字裡混進一個字串，「資料裡有東西不是
            # 數字」找不到它。索引從 1 開始（§4.3）。
            raise BlockError(f"折線圖的資料要全部是數字，第 {i} 筆不是")
    ctx.send_panel(PANEL, {"type": "line", "values": list(data)})


@block("panel.add_point")
async def add_point(ctx, x: float, y: float) -> None:
    ctx.send_panel(PANEL, {"type": "point", "x": x, "y": y})


@block("panel.clear")
async def clear(ctx) -> None:
    ctx.send_panel(PANEL, {"type": "clear"})


@block("panel.stat")
async def stat(ctx, name: str, value: Any) -> None:
    ctx.send_panel(PANEL, {"type": "stat", "name": name, "value": str(value)})


@block("panel.table")
async def table(ctx, data: list) -> None:
    columns: list[str] = []
    rows: list[dict[str, str]] = []
    for i, row in enumerate(data, start=1):
        if not isinstance(row, dict):
            raise BlockError(f"表格的每一列要是物件，第 {i} 列不是")
        for key in row:
            if key not in columns:
                columns.append(key)
        # 值在這裡就轉成字串：表格畫的是文字，而轉換規則留在 Python 這側，
        # 面板那邊就不必為了 null 與數字各寫一套呈現。
        rows.append({k: "" if v is None else str(v) for k, v in row.items()})
    ctx.send_panel(PANEL, {"type": "table", "columns": columns, "rows": rows})

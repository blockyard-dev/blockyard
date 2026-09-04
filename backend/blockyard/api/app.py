"""FastAPI app 工廠（§15 P0b 第 1 步）。

用工廠而不是模組層的 `app = FastAPI()`，是為了讓測試能各自拿到一個指向 tmp
資料庫的 app。共用一個全域 app 的話，測試之間會透過 SQLite 檔案互相汙染，
而那種失敗只會在測試順序改變時出現。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from blockyard.api import extensions as extensions_routes
from blockyard.api import hooks as hooks_routes
from blockyard.api import imports as imports_routes
from blockyard.api import keys as keys_routes
from blockyard.api import projects as projects_routes
from blockyard.api import runs as runs_routes
from blockyard.api import triggers as triggers_routes
from blockyard.extensions import DEFAULT_EXTENSIONS_ROOT
from blockyard.home import blockyard_home
from blockyard.runs import RunManager
from blockyard.runs.recorder import RunRecorder
from blockyard.runs.triggers import TriggerManager
from blockyard.storage import (
    ActiveStore,
    ProjectStore,
    RunStore,
    WebhookTokenStore,
    default_db_path,
)

# P0b 的前端跑在 Vite 的 dev server 上（另一個 port），所以本機開發一定跨源。
# 打包後前端由同一個 process 提供，這串就用不到了——但留著不礙事，因為
# `blockyard serve` 本來就只綁 127.0.0.1（§12.1）。
_DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]


# 打包後的前端（§15：P0～P2 只做 `pip install blockyard && blockyard serve`）。
# 現在還不存在——第 3 步才會有東西 build 到這裡。
EDITOR_DIST = Path(__file__).resolve().parents[3] / "packages" / "editor" / "dist"


def create_app(
    *,
    db_path: Path | str | None = None,
    store: ProjectStore | None = None,
    runs_store: RunStore | None = None,
    extensions_root: Path | str | None = None,
    staging_root: Path | str | None = None,
    static_root: Path | str | None = None,
    broker_options: dict[str, Any] | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # 上次沒收尾的 Run（後端被 kill -9）在這裡標成 interrupted。不做的話
        # 執行歷史上會有一排永遠停在「執行中」的紀錄，而那比沒有紀錄更難讀。
        app.state.runs_store.reconcile_interrupted()
        app.state.recorder.start()
        # §9.2 最後一句：後端重啟時從 SQLite 恢復所有 active 專案的 trigger。
        # 這就是「關掉瀏覽器仍會準時執行」（§1.3）在程式碼裡的樣子。
        await app.state.triggers.restore()
        yield
        # trigger 先收：它手上是長連線（discord 的 gateway），而且它會**起新的
        # Run**——反過來的話，收完 Run 之後還可能有一則訊息進來又起一個。
        # 只斷連線，不動 active 那張表——那正是重啟後要恢復的東西。
        await app.state.triggers.shutdown()
        # 還在跑的 Run 是 asyncio.Task。不砍的話 uvicorn 會等它們，而
        # `forever` 迴圈永遠不會結束——Ctrl-C 之後 server 就掛在那裡。
        await app.state.runs.shutdown()

    app = FastAPI(
        title="Blockyard Workflow",
        version="0.1.0",
        description="Scratch 風格的自動化工作流 runtime（§15 P0b）",
        lifespan=lifespan,
    )

    app.state.store = store or ProjectStore(db_path or default_db_path())
    app.state.extensions_root = Path(extensions_root or DEFAULT_EXTENSIONS_ROOT)
    # 匯入 `.zip` 的暫存區（P3 第 2 步）。**不放在 `extensions/` 底下**：那裡的
    # 每一個子目錄都是 `discover()` 掃描的對象，一份還沒被使用者確認的包在那裡
    # 待著，等於它在按下「安裝」之前就已經上了工具箱。
    app.state.staging_root = Path(staging_root or blockyard_home() / "import-staging")
    # 與專案同一個 SQLite 檔案：執行歷史指向專案，刪一個就該連著刪。
    app.state.runs_store = runs_store or RunStore(db_path or default_db_path())
    app.state.recorder = RunRecorder(app.state.runs_store)
    app.state.runs = RunManager(
        store=app.state.store,
        extensions_root=app.state.extensions_root,
        runs_store=app.state.runs_store,
        recorder=app.state.recorder,
        broker_options=broker_options or {},
    )
    app.state.active_store = ActiveStore(db_path or default_db_path())
    app.state.webhook_tokens = WebhookTokenStore(db_path or default_db_path())
    app.state.triggers = TriggerManager(
        store=app.state.store,
        extensions_root=app.state.extensions_root,
        runs=app.state.runs,
        active=app.state.active_store,
        tokens=app.state.webhook_tokens,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=_DEV_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(projects_routes.router)
    # 掛在 `extensions_routes` 前面：兩者共用 `/api/extensions` 這個字首，而
    # `/import` 與 `/{ext_id}/…` 目前撞不到（段數不同）。順序寫死是為了讓那件
    # 事在未來多一條 `/{ext_id}` 路由時仍然成立。
    app.include_router(imports_routes.router)
    app.include_router(extensions_routes.router)
    app.include_router(keys_routes.router)
    app.include_router(runs_routes.router)
    app.include_router(runs_routes.ws_router)
    app.include_router(triggers_routes.router)
    # /hooks 不在 /api 底下：它不是這個編輯器的 API，是給外面打的位址。
    app.include_router(hooks_routes.router)


    @app.get("/api/health", tags=["meta"])
    async def health() -> dict[str, str]:
        return {"status": "ok", "version": app.version}

    # 掛在最後：StaticFiles 吃 "/" 底下的所有路徑，先掛會蓋掉 /api。
    root = Path(static_root) if static_root is not None else EDITOR_DIST
    if root.is_dir():
        app.mount("/", StaticFiles(directory=root, html=True), name="editor")
    else:
        @app.get("/", include_in_schema=False)
        async def placeholder() -> HTMLResponse:
            return HTMLResponse(_PLACEHOLDER, status_code=200)

    return app


_PLACEHOLDER = """<!doctype html><meta charset="utf-8">
<title>Blockyard Workflow</title>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;line-height:1.7">
<h1>Blockyard Workflow</h1>
<p>後端起來了，但編輯器還沒建置（§15 P0b 第 3 步）。</p>
<ul>
  <li><a href="/docs">/docs</a> — API 文件</li>
  <li><a href="/api/extensions">/api/extensions</a> — 所有積木宣告（含內建）</li>
  <li><a href="/api/projects">/api/projects</a> — 專案列表</li>
</ul>
</body>"""


__all__ = ["create_app"]

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

from blocky.api import extensions as extensions_routes
from blocky.api import keys as keys_routes
from blocky.api import listeners as listeners_routes
from blocky.api import projects as projects_routes
from blocky.api import runs as runs_routes
from blocky.extensions import DEFAULT_EXTENSIONS_ROOT
from blocky.runs import RunManager
from blocky.runs.listeners import ListenerManager
from blocky.storage import ProjectStore, default_db_path

# P0b 的前端跑在 Vite 的 dev server 上（另一個 port），所以本機開發一定跨源。
# 打包後前端由同一個 process 提供，這串就用不到了——但留著不礙事，因為
# `blocky serve` 本來就只綁 127.0.0.1（§12.1）。
_DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]


# 打包後的前端（§15：P0～P2 只做 `pip install blocky && blocky serve`）。
# 現在還不存在——第 3 步才會有東西 build 到這裡。
EDITOR_DIST = Path(__file__).resolve().parents[3] / "packages" / "editor" / "dist"


def create_app(
    *,
    db_path: Path | str | None = None,
    store: ProjectStore | None = None,
    extensions_root: Path | str | None = None,
    static_root: Path | str | None = None,
    broker_options: dict[str, Any] | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        yield
        # 監聽先收：它手上是長連線（discord 的 gateway），而且它會**起新的
        # Run**——反過來的話，收完 Run 之後還可能有一則訊息進來又起一個。
        await app.state.listeners.shutdown()
        # 還在跑的 Run 是 asyncio.Task。不砍的話 uvicorn 會等它們，而
        # `forever` 迴圈永遠不會結束——Ctrl-C 之後 server 就掛在那裡。
        await app.state.runs.shutdown()

    app = FastAPI(
        title="Blocky Workflow",
        version="0.1.0",
        description="Scratch 風格的自動化工作流 runtime（§15 P0b）",
        lifespan=lifespan,
    )

    app.state.store = store or ProjectStore(db_path or default_db_path())
    app.state.extensions_root = Path(extensions_root or DEFAULT_EXTENSIONS_ROOT)
    app.state.runs = RunManager(
        store=app.state.store,
        extensions_root=app.state.extensions_root,
        broker_options=broker_options or {},
    )
    app.state.listeners = ListenerManager(
        store=app.state.store,
        extensions_root=app.state.extensions_root,
        runs=app.state.runs,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=_DEV_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(projects_routes.router)
    app.include_router(extensions_routes.router)
    app.include_router(keys_routes.router)
    app.include_router(runs_routes.router)
    app.include_router(runs_routes.ws_router)
    app.include_router(listeners_routes.router)


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
<title>Blocky Workflow</title>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;line-height:1.7">
<h1>Blocky Workflow</h1>
<p>後端起來了，但編輯器還沒建置（§15 P0b 第 3 步）。</p>
<ul>
  <li><a href="/docs">/docs</a> — API 文件</li>
  <li><a href="/api/extensions">/api/extensions</a> — 所有積木宣告（含內建）</li>
  <li><a href="/api/projects">/api/projects</a> — 專案列表</li>
</ul>
</body>"""


__all__ = ["create_app"]

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

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from blockyard.api import bundle as bundle_routes
from blockyard.api import extensions as extensions_routes
from blockyard.api import files as files_routes
from blockyard.api import hooks as hooks_routes
from blockyard.api import imports as imports_routes
from blockyard.api import keys as keys_routes
from blockyard.api import projects as projects_routes
from blockyard.api import runs as runs_routes
from blockyard.api import triggers as triggers_routes
from blockyard.api.files import SaveTargets
from blockyard.api.errors import error_detail
from blockyard.api.validation import DEFAULT_PROJECT_ID
from blockyard.extensions import (
    backfill_official,
    default_extensions_root,
    discover,
    secret_store,
    seed_bundled,
)
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
    project_staging_root: Path | str | None = None,
    static_root: Path | str | None = None,
    broker_options: dict[str, Any] | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # 上次沒收尾的 Run（後端被 kill -9）在這裡標成 interrupted。不做的話
        # 執行歷史上會有一排永遠停在「執行中」的紀錄，而那比沒有紀錄更難讀。
        app.state.runs_store.reconcile_interrupted()
        # P0b 存下來的金鑰沒有專案這個維度（§16 Q23）。搬過去一次，不然使用者
        # 打開那個唯一的專案時會看到一整排「未設定」——而金鑰一把都沒掉，只是
        # 沒有人再去那個名字底下找過。**改一個 keyring 的字串就是搬一次使用者
        # 資料**，這行就是那條規則的代價。
        _migrate_legacy_keys(app)
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
    # **沒指定就是「家」，而家要先鋪好**（`extensions/bundled.py`）：官方那幾個
    # 包跟著 wheel 來，第一次啟動時複製進 `~/.blockyard/extensions/`，之後它們
    # 就是普通的包。
    #
    # 指定了就一個字都不動，連鋪都不鋪——那多半是測試的 tmp 目錄，或是開發時
    # 直接指回出貨來源（`--extensions backend/blockyard/_bundled`），兩種都不該
    # 被我們塞東西進去。
    if extensions_root is None:
        app.state.extensions_root = default_extensions_root()
        seed_bundled(app.state.extensions_root)
        # 舊版本鋪過去的那幾個沒有收據，而沒有收據 = 不准動。補發只認「跟出貨
        # 那一份逐位元組相同」，所以它補不到使用者自己寫的東西。
        backfill_official(app.state.extensions_root)
    else:
        app.state.extensions_root = Path(extensions_root)
    # 匯入 `.zip` 的暫存區（P3 第 2 步）。**不放在 `extensions/` 底下**：那裡的
    # 每一個子目錄都是 `discover()` 掃描的對象，一份還沒被使用者確認的包在那裡
    # 待著，等於它在按下「安裝」之前就已經上了工具箱。
    app.state.staging_root = Path(staging_root or blockyard_home() / "import-staging")
    # 匯入一份專案 `.blockyard` 的暫存區（`api/bundle.py`）。**與積木包那個分開**：
    # 兩邊的 token 都會被接成路徑，而共用一個目錄等於讓「這個 token 指的是一個包
    # 還是一份專案」變成一件要用內容去猜的事。
    app.state.project_staging_root = Path(
        project_staging_root or blockyard_home() / "project-import-staging"
    )
    # 「瀏覽…」選過的路徑（`api/files.py`）。**一次性、有期限**——後端寫的位置
    # 只能來自它自己剛剛開的那個對話框。
    app.state.save_targets = SaveTargets()
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

    @app.exception_handler(StarletteHTTPException)
    async def structured_http_error(
        _request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        return JSONResponse(
            {"detail": jsonable_encoder(error_detail(exc.detail, status_code=exc.status_code))},
            status_code=exc.status_code,
            headers=exc.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def structured_request_error(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        detail = {
            "code": "request.validation",
            "params": {"errors": jsonable_encoder(exc.errors())},
            "message": "請求內容不符合格式",
        }
        return JSONResponse({"detail": detail}, status_code=422)

    # **掛在 `projects_routes` 前面**：`POST /api/projects/import` 與那邊的
    # `POST /api/projects` 撞不到（段數不同），但 `import` 本身是一段合法的
    # `{project_id}`——順序寫死是為了讓那件事不必靠巧合（同下面 imports 那條）。
    app.include_router(bundle_routes.router)
    app.include_router(projects_routes.router)
    # 掛在 `extensions_routes` 前面：兩者共用 `/api/extensions` 這個字首，而
    # `/import` 與 `/{ext_id}/…` 目前撞不到（段數不同）。順序寫死是為了讓那件
    # 事在未來多一條 `/{ext_id}` 路由時仍然成立。
    app.include_router(imports_routes.router)
    app.include_router(extensions_routes.router)
    app.include_router(keys_routes.router)
    app.include_router(files_routes.router)
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
        app.mount("/", _EditorFiles(directory=root, html=True), name="editor")
    else:
        @app.get("/", include_in_schema=False)
        async def placeholder() -> HTMLResponse:
            return HTMLResponse(_PLACEHOLDER, status_code=200)

    return app


class _EditorFiles(StaticFiles):
    """打包後的前端，**加上一條 SPA fallback**。

    前端的網址是真的路徑（`/projects`、`/p/prj_ab12cd34`，見
    `packages/editor/src/project/routes.ts`），而磁碟上沒有那幾個檔案——
    `StaticFiles` 對它們回 404，症狀是**重新整理一次就白畫面**。那一頁在 dev
    是好的（Vite 自己有這條 fallback），所以它只會在打包之後才出現，而那時候
    最像「打包壞了」。

    **`/api`、`/ws`、`/hooks` 不吃這條。** 那三個字首底下的 404 是真的 404，
    而回一份 HTML 會讓前端把首頁當成 JSON 去 parse——那個錯誤訊息離原因有十萬
    八千里。`api/client.ts` 甚至靠這個 catch-all 的 405 認出「後端沒重啟」
    （見那裡的 `STALE_BACKEND`），所以這條規則要窄。

    只有 GET／HEAD 走得到這裡（`StaticFiles` 對其他 method 一律 405），所以
    fallback 不必再問一次 method。

    找不到的路徑是**丟例外**不是回一個 404 response（Starlette 的
    `StaticFiles.get_response` 就是這樣寫的），所以這裡接的是例外——只看回傳值
    的話，這條 fallback 一次都不會生效，而測試以外沒有人會發現。

    **判斷字首看的是請求本身的路徑，不是 `path` 那個參數。** 後者已經過
    `os.path.normpath`（`StaticFiles.get_path`），而那一步會把 `..` 吃掉：
    `/api/projects/../../etc` 到這裡變成 `etc`，於是它逃出了 `api` 這個字首，
    而 fallback 會給它一份 200 的 HTML。第一版就是這樣寫的，被
    `test_a_path_shaped_id_is_not_a_project` 當場抓到。

    **看起來像檔案的（最後一段有副檔名）也不吃這條。** 前端的路徑裡不會有點
    （`/projects`、`/p/prj_ab12cd34`——專案 id 的形狀不含 `.`），所以一個
    `/p/media/sprites.png` 只有一種可能：某個地方寫了相對路徑。那時候回一份
    200 的 HTML，瀏覽器會把它當圖片解，畫出來是一個**破圖圖示**——而那個症狀
    離原因（網址多了一層）非常遠。這件事已經發生過一次了：Blockly 的
    `media: 'media/'` 在編輯器搬到 `/p/<id>` 之後，右下角的垃圾桶與放大縮小
    全變成破圖。回一個誠實的 404，至少 network 面板上那一行是紅的。
    """

    _PASS_THROUGH = frozenset({"api", "ws", "hooks"})

    async def get_response(self, path: str, scope: Any) -> Response:
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as e:
            here = str(scope.get("path", "/")).lstrip("/")
            first, _, _ = here.partition("/")
            looks_like_a_file = "." in here.rsplit("/", 1)[-1]
            if e.status_code != 404 or first in self._PASS_THROUGH or looks_like_a_file:
                raise
            return await super().get_response("index.html", scope)


def _migrate_legacy_keys(app: FastAPI) -> None:
    """把沒有專案維度的舊金鑰搬進 `prj_local`（`secret_store.migrate_legacy`）。

    **收件人是寫死的，而那是刻意的。** 舊格式（`ext_id.key`，沒有專案那一格）
    只可能是 P0b 留下來的，而 P0b 的世界裡專案 id 只有一個字串：`prj_local`
    （前端那時候寫死它，`ir/schema.py` 的 `Meta.id` 到現在還是這個預設值）。
    所以「這幾把是誰的」有一個確定的答案，不需要猜。

    **第一版是猜的，而它當場就錯了**：那一版對現有的每一個專案試一輪、第一個
    沒有同名金鑰的就收下——而 `store.list()` 是照 `updated_at` 由新到舊排的，
    於是使用者剛開來測試的那個空專案先接走了它們，`prj_local` 上一整排變成
    「未設定」。**那正是 §3 那條規則要擋的事**，而它這次是被這個函式自己犯的。

    keyring 讀不到（Linux 上沒有 keyring 後端、macOS 上使用者按了拒絕）不能
    擋住啟動——沒有金鑰的編輯器仍然打得開，而積木跑到那一步才會說話。
    """
    try:
        manifests = {k: src.manifest for k, src in discover(app.state.extensions_root).items()}
        secret_store.migrate_legacy(DEFAULT_PROJECT_ID, manifests)
    except Exception:  # noqa: BLE001 — 見 docstring
        pass


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

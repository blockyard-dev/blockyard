"""`blockyard serve`（§15 的打包策略）。

P0～P2 只做一件事：`pip install blockyard && blockyard serve`，自動開瀏覽器。沒有
Docker、沒有 systemd、沒有設定檔——那些是 P3 的事，現在做只會在還沒有使用者
的時候先養出一份要維護的東西。

**只綁 127.0.0.1**（§12.1）。積木包在 P1 之後可以跑任意 Python，把它開在
0.0.0.0 上等於把 shell 開給整個區域網路。要對外必須自己打明確的旗標。
"""

from __future__ import annotations

import argparse
import sys
import threading
import webbrowser
from pathlib import Path

from blockyard.extensions import default_extensions_root
from blockyard.storage import default_db_path
from blockyard.errors import ExtensionError
from blockyard.i18n_cli import check_pack, extract_pack

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8787


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="blockyard", description="Blockyard Workflow")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="啟動編輯器與 runtime")
    serve.add_argument("--host", default=DEFAULT_HOST)
    serve.add_argument("--port", type=int, default=DEFAULT_PORT)
    serve.add_argument("--db", type=Path, default=None, help=f"預設 {default_db_path()}")
    # 指過去就整個蓋掉「家」——開發時要改官方包就是走這條
    # （`blockyard serve --extensions backend/blockyard/_bundled`）。
    serve.add_argument(
        "--extensions",
        type=Path,
        default=None,
        help=f"積木包目錄，預設 {default_extensions_root()}",
    )
    serve.add_argument("--no-open", action="store_true", help="不要自動開瀏覽器")
    serve.add_argument("--reload", action="store_true", help="改程式碼就重啟（開發用）")

    i18n = sub.add_parser("i18n", help="積木包翻譯工具")
    i18n_sub = i18n.add_subparsers(dest="i18n_command", required=True)
    extract = i18n_sub.add_parser("extract", help="產生或更新翻譯檔")
    extract.add_argument("pack", type=Path)
    extract.add_argument("--locale", required=True)
    check = i18n_sub.add_parser("check", help="嚴格驗證翻譯檔")
    check.add_argument("pack", type=Path)

    args = parser.parse_args(argv)
    if args.command == "serve":
        return _serve(args)
    if args.command == "i18n":
        try:
            if args.i18n_command == "extract":
                target, changed = extract_pack(args.pack, args.locale)
                print(f"已更新 {target}")
                for path in changed:
                    print(f"原文已改動：{path}", file=sys.stderr)
            else:
                check_pack(args.pack)
                print("翻譯檔驗證通過")
            return 0
        except ExtensionError as exc:
            print(str(exc), file=sys.stderr)
            return 1
    parser.error(f"未知的指令 {args.command}")
    return 2


def _serve(args: argparse.Namespace) -> int:
    import uvicorn

    from blockyard.api.app import create_app

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        # 不擋，但要說出口。§12.1 是「知情同意」，重點在知情。
        print(
            f"⚠️  綁在 {args.host} 上：積木包可以跑任意 Python，等於把這台機器"
            "開給網路上的任何人（§12.1）。",
            file=sys.stderr,
        )

    app = create_app(
        db_path=args.db or default_db_path(),
        # None 就是「用家裡那份，順便鋪好官方包」（`api/app.py`）。
        extensions_root=args.extensions,
    )

    url = f"http://{args.host}:{args.port}/"
    print(f"Blockyard Workflow → {url}")

    if not args.no_open and not args.reload:
        # 延遲一拍，不然瀏覽器會比 server 先到。開不起來（無頭環境）不算失敗。
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()

    uvicorn.run(
        # --reload 要 import string 才能重新載入模組；那條路徑吃不到上面建好的
        # app，所以旗標互斥地擺在這裡而不是偷偷降級。
        "blockyard.api.app:create_app" if args.reload else app,
        factory=args.reload,
        host=args.host,
        port=args.port,
        log_level="info",
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

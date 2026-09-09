from __future__ import annotations

import argparse
import json
import mimetypes
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from bill_analyzer.analytics import dashboard, transactions
from bill_analyzer.db import add_rule, connect, delete_rule, import_transactions, init_db, list_rules, recent_imports
from bill_analyzer.importers import IMPORTERS, UnsupportedBillError


PROJECT_DIR = Path(__file__).resolve().parent
STATIC_DIR = PROJECT_DIR / "static"
DEFAULT_DB = PROJECT_DIR / "data" / "bills.db"
MAX_UPLOAD_BYTES = 50 * 1024 * 1024


def import_bytes(db_path: Path, filename: str, content: bytes) -> dict:
    ranked = sorted(((item.score(filename, content), item) for item in IMPORTERS), key=lambda pair: pair[0], reverse=True)
    if not ranked or ranked[0][0] <= 0:
        raise UnsupportedBillError("仅支持支付宝 CSV 与微信 XLSX 账单")
    importer = ranked[0][1]
    records = importer.parse(filename, content)
    if not records:
        raise ValueError("文件中没有可导入的交易记录")
    return import_transactions(db_path, filename, importer.platform, content, records)


def import_path(db_path: Path, path: Path) -> dict:
    return import_bytes(db_path, path.name, path.read_bytes())


class BillRequestHandler(BaseHTTPRequestHandler):
    server_version = "LocalBillAnalyzer/1.0"

    @property
    def db_path(self) -> Path:
        return self.server.db_path  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args) -> None:
        sys.stdout.write(f"[{self.log_date_time_string()}] {fmt % args}\n")

    def send_json(self, payload: object, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, message: str, status: int = HTTPStatus.BAD_REQUEST) -> None:
        self.send_json({"error": message}, status)

    def query_params(self) -> dict[str, str]:
        parsed = urlparse(self.path)
        return {key: values[-1] for key, values in parse_qs(parsed.query).items() if values}

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 1_000_000:
            raise ValueError("请求内容过大")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8")) if raw else {}

    def serve_static(self, relative: str) -> None:
        name = "index.html" if relative in {"", "/"} else relative.lstrip("/")
        candidate = (STATIC_DIR / name).resolve()
        if STATIC_DIR.resolve() not in candidate.parents and candidate != STATIC_DIR.resolve():
            self.send_error_json("文件不存在", HTTPStatus.NOT_FOUND)
            return
        if not candidate.is_file():
            self.send_error_json("文件不存在", HTTPStatus.NOT_FOUND)
            return
        content = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8" if content_type.startswith("text/") else content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/health":
                self.send_json({"status": "ok", "database": str(self.db_path)})
            elif parsed.path == "/api/dashboard":
                self.send_json(dashboard(self.db_path, self.query_params()))
            elif parsed.path == "/api/transactions":
                self.send_json(transactions(self.db_path, self.query_params()))
            elif parsed.path == "/api/imports":
                self.send_json({"items": recent_imports(self.db_path)})
            elif parsed.path == "/api/rules":
                with connect(self.db_path) as connection:
                    self.send_json({"items": list_rules(connection)})
            elif parsed.path == "/api/meta":
                with connect(self.db_path) as connection:
                    categories = [row[0] for row in connection.execute("SELECT DISTINCT category FROM transactions ORDER BY category")]
                    count = connection.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
                self.send_json(
                    {
                        "version": "1.0.0",
                        "database": str(self.db_path),
                        "transaction_count": count,
                        "categories": categories,
                        "supported_formats": ["支付宝 CSV（GB18030/UTF-8）", "微信 XLSX"],
                    }
                )
            elif parsed.path.startswith("/api/"):
                self.send_error_json("接口不存在", HTTPStatus.NOT_FOUND)
            else:
                self.serve_static(parsed.path)
        except Exception as exc:
            self.send_error_json(str(exc), HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/import":
                filename = unquote(self.headers.get("X-Filename", "")).strip()
                if not filename:
                    raise ValueError("缺少 X-Filename 请求头")
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0:
                    raise ValueError("上传文件为空")
                if length > MAX_UPLOAD_BYTES:
                    raise ValueError("单个文件不能超过 50 MB")
                result = import_bytes(self.db_path, filename, self.rfile.read(length))
                self.send_json(result, HTTPStatus.CREATED)
            elif parsed.path == "/api/rules":
                self.send_json(add_rule(self.db_path, self.read_json()), HTTPStatus.CREATED)
            elif parsed.path == "/api/reclassify":
                from bill_analyzer.db import reclassify_all

                with connect(self.db_path) as connection:
                    changed = reclassify_all(connection)
                    connection.commit()
                self.send_json({"reclassified": changed})
            else:
                self.send_error_json("接口不存在", HTTPStatus.NOT_FOUND)
        except (ValueError, UnsupportedBillError, json.JSONDecodeError) as exc:
            self.send_error_json(str(exc))
        except Exception as exc:
            self.send_error_json(str(exc), HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path.startswith("/api/rules/"):
                rule_id = int(parsed.path.rsplit("/", 1)[-1])
                apply_existing = self.query_params().get("apply_existing", "true").lower() != "false"
                self.send_json(delete_rule(self.db_path, rule_id, apply_existing))
            else:
                self.send_error_json("接口不存在", HTTPStatus.NOT_FOUND)
        except (ValueError, KeyError) as exc:
            self.send_error_json(str(exc), HTTPStatus.NOT_FOUND if isinstance(exc, KeyError) else HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            self.send_error_json(str(exc), HTTPStatus.INTERNAL_SERVER_ERROR)


class BillServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], db_path: Path):
        self.db_path = db_path
        super().__init__(address, BillRequestHandler)


def serve(db_path: Path, host: str, port: int, open_browser: bool) -> None:
    init_db(db_path)
    server = BillServer((host, port), db_path)
    url = f"http://{host}:{port}"
    print(f"账单分析服务已启动：{url}")
    print(f"本地数据库：{db_path}")
    print("按 Ctrl+C 停止服务。")
    if open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。")
    finally:
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="本地微信/支付宝账单分析")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="SQLite 数据库路径")
    subparsers = parser.add_subparsers(dest="command")
    serve_parser = subparsers.add_parser("serve", help="启动本地网页和 API")
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=8765)
    serve_parser.add_argument("--no-browser", action="store_true")
    import_parser = subparsers.add_parser("import", help="从命令行导入账单")
    import_parser.add_argument("files", nargs="+", type=Path)
    subparsers.add_parser("stats", help="输出当前统计 JSON")

    args = parser.parse_args()
    command = args.command or "serve"
    init_db(args.db)
    if command == "serve":
        serve(args.db, args.host, args.port, not args.no_browser)
    elif command == "import":
        for file_path in args.files:
            if not file_path.is_file():
                print(json.dumps({"file": str(file_path), "error": "文件不存在"}, ensure_ascii=False))
                continue
            try:
                print(json.dumps(import_path(args.db, file_path), ensure_ascii=False))
            except Exception as exc:
                print(json.dumps({"file": str(file_path), "error": str(exc)}, ensure_ascii=False))
    elif command == "stats":
        print(json.dumps(dashboard(args.db, {}), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

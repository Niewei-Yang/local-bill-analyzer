from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import tempfile
import threading
import webbrowser
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from bill_analyzer.analytics import dashboard, transactions
from bill_analyzer.db import (
    add_rule,
    backup_database,
    connect,
    delete_rule,
    import_transactions,
    income_window_start,
    init_db,
    list_rules,
    recent_imports,
    restore_database,
)
from bill_analyzer.importers import IMPORTERS, UnsupportedBillError
from bill_analyzer import access
from bill_analyzer.postgres import is_postgres, write_lock


PROJECT_DIR = Path(__file__).resolve().parent
STATIC_DIR = PROJECT_DIR / "static"
DEFAULT_DB = PROJECT_DIR / "data" / "bills.db"
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_DATABASE_BYTES = 250 * 1024 * 1024


def import_bytes(db_path: Path, filename: str, content: bytes) -> dict:
    ranked = sorted(((item.score(filename, content), item) for item in IMPORTERS), key=lambda pair: pair[0], reverse=True)
    if not ranked or ranked[0][0] <= 0:
        raise UnsupportedBillError("仅支持支付宝 CSV、微信 XLSX 与校内收入 XLS 账单")
    importer = ranked[0][1]
    records = importer.parse(filename, content)
    excluded = 0
    window_start = income_window_start(db_path) if importer.platform == "校内收入" else None
    if window_start:
        scoped = [record for record in records if record.transaction_time[:10] >= window_start]
        excluded = len(records) - len(scoped)
        records = scoped
    if not records:
        if excluded:
            raise ValueError(f"收入记录都早于支出数据的起始月份（{window_start[:7]}），没有可导入的交易")
        raise ValueError("文件中没有可导入的交易记录")
    result = import_transactions(db_path, filename, importer.platform, content, records)
    result["excluded"] = excluded
    return result


def import_path(db_path: Path, path: Path) -> dict:
    return import_bytes(db_path, path.name, path.read_bytes())


class BillRequestHandler(BaseHTTPRequestHandler):
    server_version = "BillAnalyzer/1.0"
    cloud = False

    @property
    def db_path(self) -> Path:
        return self.server.db_path  # type: ignore[attr-defined]

    @property
    def database_label(self):
        return "PostgreSQL（云端账本）" if is_postgres(self.db_path) else str(self.db_path)

    @property
    def upload_limit(self):
        return 4 * 1024 * 1024 if self.cloud else MAX_UPLOAD_BYTES

    def check_access(self, require_cloud=False):
        if require_cloud:
            if not is_postgres(os.environ.get("DATABASE_URL", "")):
                self.send_error_json("部署尚未配置：需要 PostgreSQL 的 DATABASE_URL", 503)
                return False
            if len(os.environ.get("APP_PASSWORD", "")) < access.MIN_PASSWORD_LENGTH:
                self.send_error_json(f"登录密码未配置完成：APP_PASSWORD 至少需要 {access.MIN_PASSWORD_LENGTH} 个字符", 503)
                return False
        if access.configured() and not access.authorized(self.headers.get("Authorization", "")):
            body = b'{"error":"Please sign in"}'
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="Private Ledger", charset="UTF-8"')
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return False
        if self.command in {"POST", "DELETE"} and not access.same_origin(self.headers):
            self.send_error_json("不接受跨站修改请求", 403)
            return False
        return True

    def unexpected_error(self, exc):
        self.send_error_json("服务器处理失败，请检查服务配置" if self.cloud else str(exc), 500)

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
        if not self.check_access():
            return
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/health":
                self.send_json({"status": "ok", "database": self.database_label})
            elif parsed.path == "/api/database/export":
                filename = f"bills-{datetime.now():%Y%m%d-%H%M%S}.db"
                with tempfile.TemporaryDirectory(prefix="bill-analyzer-export-") as temp_dir:
                    snapshot = Path(temp_dir) / filename
                    backup_id = self.query_params().get("backup")
                    if backup_id and is_postgres(self.db_path):
                        with connect(self.db_path) as connection:
                            row = connection.execute("SELECT filename, content FROM database_backups WHERE id = ?", (int(backup_id),)).fetchone()
                        if not row:
                            self.send_error_json("备份不存在", 404)
                            return
                        filename = row["filename"]
                        snapshot.write_bytes(bytes(row["content"]))
                    else:
                        backup_database(self.db_path, snapshot)
                    if self.cloud and snapshot.stat().st_size > self.upload_limit:
                        self.send_error_json("云端网页导出上限为 4 MB，请使用命令行迁移工具导出完整账本", 413)
                        return
                    self.send_response(HTTPStatus.OK)
                    self.send_header("Content-Type", "application/vnd.sqlite3")
                    self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
                    self.send_header("Content-Length", str(snapshot.stat().st_size))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    with snapshot.open("rb") as stream:
                        while chunk := stream.read(1024 * 1024):
                            self.wfile.write(chunk)
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
                        "database": self.database_label,
                        "storage": "postgres" if is_postgres(self.db_path) else "sqlite",
                        "max_upload_bytes": self.upload_limit,
                        "transaction_count": count,
                        "categories": categories,
                        "supported_formats": ["支付宝 CSV（GB18030/UTF-8）", "微信 XLSX", "校内收入 XLS（学生收入查询）"],
                    }
                )
            elif parsed.path.startswith("/api/"):
                self.send_error_json("接口不存在", HTTPStatus.NOT_FOUND)
            else:
                self.serve_static(parsed.path)
        except Exception as exc:
            self.unexpected_error(exc)

    def do_POST(self) -> None:
        if not self.check_access():
            return
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/import":
                filename = unquote(self.headers.get("X-Filename", "")).strip()
                if not filename:
                    raise ValueError("缺少 X-Filename 请求头")
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0:
                    raise ValueError("上传文件为空")
                if length > self.upload_limit:
                    self.send_error_json(f"单个文件不能超过 {self.upload_limit // 1024 // 1024} MB", 413)
                    return
                result = import_bytes(self.db_path, filename, self.rfile.read(length))
                self.send_json(result, HTTPStatus.CREATED)
            elif parsed.path == "/api/database/import":
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0:
                    raise ValueError("数据库文件为空")
                limit = self.upload_limit if self.cloud else MAX_DATABASE_BYTES
                if length > limit:
                    self.send_error_json(f"数据库文件不能超过 {limit // 1024 // 1024} MB；较大账本请使用命令行迁移工具", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
                    return
                result = restore_database(self.db_path, self.rfile.read(length))
                self.send_json(result, HTTPStatus.OK)
            elif parsed.path == "/api/rules":
                self.send_json(add_rule(self.db_path, self.read_json()), HTTPStatus.CREATED)
            elif parsed.path == "/api/reclassify":
                from bill_analyzer.db import reclassify_all

                with connect(self.db_path) as connection:
                    write_lock(connection)
                    changed = reclassify_all(connection)
                    connection.commit()
                self.send_json({"reclassified": changed})
            else:
                self.send_error_json("接口不存在", HTTPStatus.NOT_FOUND)
        except (ValueError, UnsupportedBillError, json.JSONDecodeError) as exc:
            self.send_error_json(str(exc))
        except Exception as exc:
            self.unexpected_error(exc)

    def do_DELETE(self) -> None:
        if not self.check_access():
            return
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
            self.unexpected_error(exc)


class BillServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], db_path: Path):
        self.db_path = db_path
        super().__init__(address, BillRequestHandler)


def serve(db_path: Path, host: str, port: int, open_browser: bool) -> None:
    init_db(db_path)
    server = BillServer((host, port), db_path)
    url = f"http://{host}:{port}"
    print(f"账单分析服务已启动：{url}")
    print(f"数据库：{'PostgreSQL（云端账本）' if is_postgres(db_path) else db_path}")
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
    from dotenv import load_dotenv
    load_dotenv(PROJECT_DIR / ".env")
    parser = argparse.ArgumentParser(description="个人账单分析：微信、支付宝与校内收入")
    parser.add_argument("--db", default=os.environ.get("DATABASE_URL") or DEFAULT_DB, help="SQLite 路径或 PostgreSQL URL")
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

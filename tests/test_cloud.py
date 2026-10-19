from __future__ import annotations

import base64
import json
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen
from uuid import uuid4

from tests import test_core
from api.index import handler
from bill_analyzer import access
from bill_analyzer.analytics import dashboard
from bill_analyzer.db import add_rule, connect, import_transactions, init_db, restore_database, validate_database
from bill_analyzer.migration import export_sqlite, migrate_sqlite, read_snapshot
from bill_analyzer.models import Transaction

TEST_URL = os.environ.get("TEST_DATABASE_URL")


class AccessTests(unittest.TestCase):
    def test_cloud_password_length_and_login(self):
        request = object.__new__(handler)
        request.command = "GET"
        request.send_error_json = Mock()
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://localhost/ledger", "APP_USERNAME": "admin"}):
            for password in ("", "1234567", "12345678", "123456789012345"):
                with self.subTest(length=len(password)), patch.dict(os.environ, {"APP_PASSWORD": password}):
                    credentials = base64.b64encode(f"admin:{password}".encode()).decode()
                    request.headers = {"Authorization": "Basic " + credentials}
                    request.send_error_json.reset_mock()
                    accepted = request.check_access(require_cloud=True)
                    self.assertEqual(accepted, len(password) >= 8)
                    if accepted:
                        request.send_error_json.assert_not_called()
                        self.assertFalse(access.authorized("Basic " + base64.b64encode(b"admin:wrong-password").decode()))
                    else:
                        request.send_error_json.assert_called_once_with("登录密码未配置完成：APP_PASSWORD 至少需要 8 个字符", 503)
            with patch.dict(os.environ, {"DATABASE_URL": "", "APP_PASSWORD": "12345678"}):
                request.send_error_json.reset_mock()
                self.assertFalse(request.check_access(require_cloud=True))
                request.send_error_json.assert_called_once_with("部署尚未配置：需要 PostgreSQL 的 DATABASE_URL", 503)

    def test_credentials_and_cross_site_requests(self):
        with patch.dict(os.environ, {"APP_USERNAME": "admin", "APP_PASSWORD": "test-password-with-length"}):
            good = "Basic " + base64.b64encode(b"admin:test-password-with-length").decode()
            self.assertTrue(access.authorized(good))
            for bad in ("", "Bearer test", "Basic !!!", "Basic YTpi", "Basic /w=="):
                self.assertFalse(access.authorized(bad))
        self.assertTrue(access.same_origin({"Host": "ledger.example", "Origin": "https://ledger.example"}))
        self.assertFalse(access.same_origin({"Host": "ledger.example", "Origin": "https://other.example"}))
        self.assertFalse(access.same_origin({"Host": "ledger.example", "Sec-Fetch-Site": "cross-site"}))


class PgMixin:
    def setUp(self):
        import psycopg
        self.schema = "test_" + uuid4().hex
        with psycopg.connect(TEST_URL) as root:
            root.execute(f'CREATE SCHEMA "{self.schema}"')
        parts = urlsplit(TEST_URL)
        args = dict(parse_qsl(parts.query))
        args["options"] = "-csearch_path=" + self.schema
        self.db = urlunsplit(parts._replace(query=urlencode(args)))
        self.temp = tempfile.TemporaryDirectory()
        init_db(self.db)

    def tearDown(self):
        import psycopg
        with psycopg.connect(TEST_URL) as root:
            root.execute(f'DROP SCHEMA "{self.schema}" CASCADE')
        self.temp.cleanup()


@unittest.skipUnless(TEST_URL, "TEST_DATABASE_URL not set; use a disposable PostgreSQL database")
class PostgresCoreTests(PgMixin, test_core.CoreTests):
    pass


@unittest.skipUnless(TEST_URL, "TEST_DATABASE_URL not set")
class PostgresSchoolTests(PgMixin, test_core.SchoolIncomeXlsTests):
    pass


@unittest.skipUnless(TEST_URL, "TEST_DATABASE_URL not set")
class MigrationTests(PgMixin, unittest.TestCase):
    def test_migration_export_restore_backups_and_id_sequences(self):
        source = Path(self.temp.name) / "source.db"
        init_db(source)
        import_transactions(source, "seed.csv", "微信", b"seed", [Transaction("微信", "2026-01-28 20:00:00", "income", 299400, category_raw="二维码收款")])
        add_rule(source, {"pattern": "test", "category": "测试", "apply_existing": False})
        expected = dashboard(source, {})
        migrated = migrate_sqlite(source, self.db)
        self.assertEqual(migrated["transactions"], 1)
        self.assertEqual(dashboard(self.db, {}), expected)
        with self.assertRaisesRegex(ValueError, "已有数据"):
            migrate_sqlite(source, self.db)
        exported = Path(self.temp.name) / "export.db"
        export_sqlite(self.db, exported)
        self.assertEqual(validate_database(exported), validate_database(source))
        with connect(exported) as a, connect(source) as b:
            self.assertEqual(read_snapshot(a), read_snapshot(b))
        inserted = import_transactions(self.db, "next.csv", "微信", b"next", [Transaction("微信", "2026-01-29 10:00:00", "expense", 100)])
        self.assertGreater(inserted["batch_id"], 1)
        restored = restore_database(self.db, source.read_bytes())
        self.assertEqual(dashboard(self.db, {}), expected)
        self.assertTrue(restored["backup"].startswith("cloud-backup-"))
        with connect(self.db) as cloud:
            old = cloud.execute("SELECT content FROM database_backups").fetchone()[0]
        before = Path(self.temp.name) / "before.db"
        before.write_bytes(bytes(old))
        self.assertEqual(validate_database(before)["transactions"], 2)

    def test_failed_restore_rolls_back_records_and_backup(self):
        source = Path(self.temp.name) / "source.db"
        init_db(source)
        import_transactions(source, "source.csv", "微信", b"reject", [Transaction("微信", "2026-01-01", "expense", 100, description="reject")])
        for index in range(5):
            import_transactions(self.db, "keep.csv", "微信", b"keep", [Transaction("微信", "2026-01-01", "expense", 100 + index)])
        with connect(self.db) as cloud:
            before = read_snapshot(cloud)
            cloud.execute("ALTER TABLE transactions ADD CONSTRAINT reject_description CHECK (description != 'reject')")
        with self.assertRaises(Exception):
            migrate_sqlite(source, self.db, replace=True)
        with connect(self.db) as cloud:
            self.assertEqual(read_snapshot(cloud), before)
            self.assertEqual(cloud.execute("SELECT COUNT(*) FROM database_backups").fetchone()[0], 0)
        appended = import_transactions(self.db, "after.csv", "微信", b"after", [Transaction("微信", "2026-01-02", "expense", 200)])
        self.assertGreater(appended["batch_id"], 5)

    def test_vercel_handler_auth_metadata_import_and_backup(self):
        credentials = base64.b64encode(b"admin:test-password-with-length").decode()
        with patch.dict(os.environ, {"DATABASE_URL": self.db, "APP_USERNAME": "admin", "APP_PASSWORD": "test-password-with-length"}):
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            def request(path, data=None, extra=None):
                return urlopen(Request(base + path, data=data, headers={"Authorization": "Basic " + credentials, **(extra or {})}))
            try:
                with self.assertRaises(HTTPError) as anonymous:
                    urlopen(base + "/api/meta")
                self.assertEqual(anonymous.exception.code, 401)
                with request("/api/meta") as response:
                    meta = json.load(response)
                self.assertEqual(meta["storage"], "postgres")
                self.assertNotIn("postgresql://", json.dumps(meta))
                with self.assertRaises(HTTPError) as cross_site:
                    request("/api/reclassify", b"", {"Origin": "https://other.example"})
                self.assertEqual(cross_site.exception.code, 403)
                with request("/api/import", test_core.alipay_csv(), {"X-Filename": "alipay.csv"}) as response:
                    self.assertEqual(json.load(response)["inserted"], 3)
                with request("/api/dashboard") as response:
                    self.assertEqual(json.load(response)["summary"]["net_spend"], 80)
                with request("/api/database/export") as response:
                    snapshot = response.read()
                saved = Path(self.temp.name) / "http-export.db"
                saved.write_bytes(snapshot)
                self.assertEqual(validate_database(saved)["transactions"], 3)
                with request("/api/database/import", snapshot) as response:
                    backup = json.load(response)["backup"]
                backup_id = backup.removeprefix("cloud-backup-").removesuffix(".db")
                with request("/api/database/export?backup=" + backup_id) as response:
                    self.assertTrue(response.read().startswith(b"SQLite format 3"))
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

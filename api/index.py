"""Vercel Python Function: all public routes use the existing HTTP handler."""
import os
from functools import lru_cache

from app import BillRequestHandler
from bill_analyzer.db import init_db


@lru_cache(maxsize=1)
def prepare_database(url):
    init_db(url)


class handler(BillRequestHandler):
    cloud = True
    @property
    def db_path(self):
        return os.environ.get("DATABASE_URL", "")

    def prepare(self):
        if not self.check_access(require_cloud=True):
            return False
        try:
            prepare_database(self.db_path)
            return True
        except Exception:
            self.send_error_json("云数据库连接或初始化失败，请检查 Neon 连接设置", 503)
            return False

    def do_GET(self):
        if self.prepare():
            super().do_GET()

    def do_POST(self):
        if self.prepare():
            super().do_POST()

    def do_DELETE(self):
        if self.prepare():
            super().do_DELETE()

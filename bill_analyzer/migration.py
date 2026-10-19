"""Lossless SQLite <-> PostgreSQL migration and durable restore backups."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import tempfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from .db import SCHEMA, connect, init_db, validate_database
from .postgres import is_postgres, write_lock

TABLES = ("import_batches", "category_rules", "transactions")


def columns():
    with closing(sqlite3.connect(":memory:")) as schema:
        schema.executescript(SCHEMA)
        return {table: [row[1] for row in schema.execute(f"PRAGMA table_info({table})")] for table in TABLES}


def read_snapshot(connection):
    return {table: [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()] for table in TABLES}


def write_sqlite(snapshot, destination: Path):
    # Only create a new export; never overwrite an existing user file.
    if destination.exists():
        raise ValueError("导出目标已存在，请指定新文件名")
    init_db(destination)
    with connect(destination) as target:
        for table, names in columns().items():
            placeholders = ",".join("?" for _ in names)
            target.executemany(f"INSERT INTO {table}({','.join(names)}) VALUES ({placeholders})", [
                [row[name] for name in names] for row in snapshot[table]
            ])
    validate_database(destination)


def export_sqlite(url: str, destination: Path):
    with connect(url) as source:
        source.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        snapshot = read_snapshot(source)
    write_sqlite(snapshot, destination)


def migrate_sqlite(source: Path, url: str, replace: bool = False) -> dict:
    if not is_postgres(url):
        raise ValueError("目标必须为 PostgreSQL DATABASE_URL")
    counts = validate_database(source)
    with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as local:
        local.row_factory = sqlite3.Row
        snapshot = read_snapshot(local)
    for table, names in columns().items():
        if any(not set(names) <= row.keys() for row in snapshot[table]):
            raise ValueError(f"源数据库 {table} 结构不兼容")
    init_db(url)
    backup = None
    with connect(url) as target:
        write_lock(target)
        target.execute("LOCK TABLE import_batches, category_rules, transactions IN SHARE ROW EXCLUSIVE MODE")
        occupied = any(target.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in TABLES)
        if occupied and not replace:
            raise ValueError("云数据库已有数据，迁移已停止；需要替换时明确使用 --replace")
        if occupied:
            with tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / "before-restore.db"
                write_sqlite(read_snapshot(target), path)
                stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
                row = target.execute(
                    "INSERT INTO database_backups(filename, content) VALUES (?, ?) RETURNING id",
                    (f"bills-before-restore-{stamp}.db", path.read_bytes()),
                ).fetchone()
                backup = f"cloud-backup-{row[0]}.db"
        for table in reversed(TABLES):
            target.execute(f"DELETE FROM {table}")
        for table, names in columns().items():
            placeholders = ",".join("?" for _ in names)
            target.executemany(f"INSERT INTO {table}({','.join(names)}) VALUES ({placeholders})", [
                [row[name] for name in names] for row in snapshot[table]
            ])
            actual = target.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            if actual != len(snapshot[table]):
                raise ValueError(f"迁移校验失败：{table}")
            # ALTER SEQUENCE is transactional; unlike setval(), it rolls back if a
            # later table fails, so a failed restore can't break future inserts.
            from psycopg import sql
            sequence = target.execute(f"SELECT parse_ident(pg_get_serial_sequence('{table}', 'id'))").fetchone()[0]
            next_id = target.execute(f"SELECT COALESCE(MAX(id), 0) + 1 FROM {table}").fetchone()[0]
            target.raw.execute(sql.SQL("ALTER SEQUENCE {} RESTART WITH {}").format(sql.Identifier(*sequence), sql.Literal(next_id)))
    return {**counts, "backup": backup}


def main():
    from dotenv import load_dotenv
    load_dotenv()
    parser = argparse.ArgumentParser(description="在本地 SQLite 与 Neon/PostgreSQL 之间迁移账本")
    parser.add_argument("action", choices=("import", "export"))
    parser.add_argument("path", type=Path)
    parser.add_argument("--replace", action="store_true", help="替换已有云数据，替换前自动在云库保存 SQLite 备份")
    args = parser.parse_args()
    url = os.environ.get("DATABASE_URL", "")
    if not is_postgres(url):
        parser.error("请在环境变量或 .env 中设置 PostgreSQL DATABASE_URL")
    if args.action == "import":
        result = migrate_sqlite(args.path, url, args.replace)
    else:
        export_sqlite(url, args.path)
        result = validate_database(args.path)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

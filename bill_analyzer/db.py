from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime
from hashlib import sha256
from pathlib import Path
from uuid import uuid4
from typing import Iterable

from .categorize import classify
from .models import Transaction
from .postgres import PostgresConnection, is_postgres, postgres_schema, write_lock, utc_now_sql


SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    platform TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    total_rows INTEGER NOT NULL DEFAULT 0,
    inserted_rows INTEGER NOT NULL DEFAULT 0,
    updated_rows INTEGER NOT NULL DEFAULT 0,
    unchanged_rows INTEGER NOT NULL DEFAULT 0,
    errors_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS category_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    field TEXT NOT NULL,
    pattern TEXT NOT NULL,
    category TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    transaction_time TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('expense', 'income', 'neutral')),
    amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
    category_raw TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '其他',
    counterparty TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    payment_method TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    source_order_id TEXT NOT NULL DEFAULT '',
    merchant_order_id TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    is_refund INTEGER NOT NULL DEFAULT 0,
    fingerprint TEXT NOT NULL UNIQUE,
    import_batch_id INTEGER REFERENCES import_batches(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transactions_time ON transactions(transaction_time);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_transactions_platform ON transactions(platform);
CREATE INDEX IF NOT EXISTS idx_transactions_direction ON transactions(direction);
"""


class ClosingConnection(sqlite3.Connection):
    """Commit/rollback like sqlite3.Connection and close after a with block."""

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


TRANSACTION_FIELDS = [
    "platform",
    "transaction_time",
    "direction",
    "amount_cents",
    "category_raw",
    "category",
    "counterparty",
    "description",
    "payment_method",
    "status",
    "source_order_id",
    "merchant_order_id",
    "note",
    "is_refund",
]


def connect(db_path: Path | str) -> sqlite3.Connection:
    if is_postgres(db_path):
        return PostgresConnection(str(db_path))
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, factory=ClosingConnection)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


def init_db(db_path: Path | str) -> None:
    with connect(db_path) as connection:
        write_lock(connection)
        connection.executescript(postgres_schema(SCHEMA) if is_postgres(db_path) else SCHEMA)


def backup_database(source_path: Path | str, destination_path: Path | str) -> None:
    """Write a consistent SQLite snapshot, including committed WAL content."""
    if is_postgres(source_path):
        from .migration import export_sqlite
        export_sqlite(str(source_path), Path(destination_path))
        return
    source_uri = Path(source_path).resolve().as_uri() + "?mode=ro"
    source = sqlite3.connect(source_uri, uri=True)
    destination = sqlite3.connect(destination_path)
    try:
        source.backup(destination)
        destination.commit()
    finally:
        destination.close()
        source.close()


def validate_database(db_path: Path | str) -> dict[str, int]:
    """Validate that a file is a complete database from this bill analyzer."""
    path = Path(db_path).resolve()
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    try:
        integrity = connection.execute("PRAGMA integrity_check").fetchone()
        if not integrity or integrity[0] != "ok":
            raise ValueError("数据库完整性检查失败")
        tables = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        required = {
            "transactions": {"id", "platform", "transaction_time", "direction", "amount_cents", "category", "fingerprint", "import_batch_id"},
            "import_batches": {"id", "filename", "platform", "source_sha256", "imported_at", "total_rows", "inserted_rows", "updated_rows", "unchanged_rows", "errors_json"},
            "category_rules": {"id", "field", "pattern", "category", "priority", "enabled", "created_at"},
        }
        for table, required_columns in required.items():
            if table not in tables:
                raise ValueError("文件不是兼容的账本备份：缺少必要数据表")
            columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
            if not required_columns <= columns:
                raise ValueError(f"数据库结构不兼容：{table} 数据表缺少必要字段")
        if connection.execute("PRAGMA foreign_key_check").fetchone():
            raise ValueError("数据库包含无效的关联记录")
        return {
            "transactions": connection.execute("SELECT COUNT(*) FROM transactions").fetchone()[0],
            "rules": connection.execute("SELECT COUNT(*) FROM category_rules").fetchone()[0],
            "imports": connection.execute("SELECT COUNT(*) FROM import_batches").fetchone()[0],
        }
    except sqlite3.DatabaseError as exc:
        raise ValueError("无法读取数据库文件，或文件已损坏") from exc
    finally:
        connection.close()


def restore_database(db_path: Path | str, content: bytes) -> dict:
    """Replace the active database with a validated SQLite file, keeping a backup."""
    if is_postgres(db_path):
        import tempfile
        from .migration import migrate_sqlite
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "restore.db"
            source.write_bytes(content)
            return migrate_sqlite(source, str(db_path), replace=True)
    target = Path(db_path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    staged = target.with_name(f".{target.name}.{uuid4().hex}.restore")
    backup_path: Path | None = None
    try:
        staged.write_bytes(content)
        counts = validate_database(staged)
        if target.exists():
            with connect(target) as connection:
                connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            backup_path = target.with_name(f"{target.stem}.before-restore-{stamp}-{uuid4().hex[:6]}{target.suffix}")
            backup_database(target, backup_path)
            for suffix in ("-wal", "-shm"):
                Path(f"{target}{suffix}").unlink(missing_ok=True)
        os.replace(staged, target)
        try:
            init_db(target)
        except Exception:
            if backup_path and backup_path.exists():
                os.replace(backup_path, target)
            raise
        return {**counts, "backup": backup_path.name if backup_path else None}
    finally:
        staged.unlink(missing_ok=True)
        for suffix in ("-wal", "-shm"):
            Path(f"{staged}{suffix}").unlink(missing_ok=True)


def income_window_start(db_path: Path | str) -> str | None:
    """校内收入只入账与支出数据同一时间窗的记录，返回支出数据最早月份的 1 号。"""
    with connect(db_path) as connection:
        row = connection.execute(
            "SELECT MIN(transaction_time) FROM transactions WHERE platform != '校内收入'"
        ).fetchone()
    first = row[0] if row else None
    return f"{first[:7]}-01" if first else None


def list_rules(connection: sqlite3.Connection) -> list[dict]:
    rows = connection.execute(
        "SELECT id, field, pattern, category, priority, enabled, created_at "
        "FROM category_rules ORDER BY priority DESC, id ASC"
    ).fetchall()
    return [dict(row) for row in rows]


def _enabled_rules(connection: sqlite3.Connection) -> list[dict]:
    return [rule for rule in list_rules(connection) if rule["enabled"]]


def import_transactions(
    db_path: Path | str,
    filename: str,
    platform: str,
    content: bytes,
    records: Iterable[Transaction],
) -> dict:
    init_db(db_path)
    records = list(records)
    with connect(db_path) as connection:
        write_lock(connection)
        rules = _enabled_rules(connection)
        cursor = connection.execute(
            "INSERT INTO import_batches(filename, platform, source_sha256) VALUES (?, ?, ?) RETURNING id",
            (filename, platform, sha256(content).hexdigest()),
        )
        batch_id = cursor.fetchone()[0]
        inserted = updated = unchanged = 0
        fingerprints = list(dict.fromkeys(record.fingerprint for record in records))
        known = {}
        for start in range(0, len(fingerprints), 500):
            batch = fingerprints[start:start + 500]
            placeholders = ",".join("?" for _ in batch)
            for row in connection.execute(f"SELECT * FROM transactions WHERE fingerprint IN ({placeholders})", batch).fetchall():
                known[row["fingerprint"]] = dict(row)
        new = set()
        touched = {}
        for record in records:
            values = record.db_values()
            values["category"] = classify(values, rules)
            fingerprint = values["fingerprint"]
            existing = known.get(fingerprint)
            if existing is None:
                new.add(fingerprint)
                known[fingerprint] = touched[fingerprint] = values
                inserted += 1
                continue

            changed = any(existing[name] != values[name] for name in TRANSACTION_FIELDS)
            if changed:
                known[fingerprint] = touched[fingerprint] = values
                updated += 1
            else:
                unchanged += 1

        columns = TRANSACTION_FIELDS + ["fingerprint", "import_batch_id"]
        placeholders = ",".join("?" for _ in columns)
        connection.executemany(f"INSERT INTO transactions({','.join(columns)}) VALUES ({placeholders})", [
            [values[name] for name in TRANSACTION_FIELDS] + [fingerprint, batch_id]
            for fingerprint, values in touched.items() if fingerprint in new
        ])
        assignments = ",".join(f"{name} = ?" for name in TRANSACTION_FIELDS)
        connection.executemany(
            f"UPDATE transactions SET {assignments}, import_batch_id = ?, updated_at = {utc_now_sql(connection)} WHERE fingerprint = ?",
            [[values[name] for name in TRANSACTION_FIELDS] + [batch_id, fingerprint]
             for fingerprint, values in touched.items() if fingerprint not in new],
        )

        connection.execute(
            "UPDATE import_batches SET total_rows = ?, inserted_rows = ?, updated_rows = ?, unchanged_rows = ? "
            "WHERE id = ?",
            (len(records), inserted, updated, unchanged, batch_id),
        )
        connection.commit()
    return {
        "batch_id": batch_id,
        "filename": filename,
        "platform": platform,
        "total": len(records),
        "inserted": inserted,
        "updated": updated,
        "unchanged": unchanged,
    }


def reclassify_all(connection: sqlite3.Connection) -> int:
    rules = _enabled_rules(connection)
    rows = connection.execute("SELECT * FROM transactions").fetchall()
    changed = 0
    for row in rows:
        record = dict(row)
        category = classify(record, rules)
        if category != row["category"]:
            connection.execute(
                f"UPDATE transactions SET category = ?, updated_at = {utc_now_sql(connection)} WHERE id = ?",
                (category, row["id"]),
            )
            changed += 1
    return changed


def add_rule(db_path: Path | str, payload: dict) -> dict:
    field = str(payload.get("field", "all"))
    if field not in {"all", "counterparty", "description", "payment_method", "category_raw", "status"}:
        raise ValueError("不支持的匹配字段")
    pattern = str(payload.get("pattern", "")).strip()
    category = str(payload.get("category", "")).strip()
    if not pattern or not category:
        raise ValueError("匹配词和目标分类不能为空")
    priority = int(payload.get("priority", 100))
    with connect(db_path) as connection:
        write_lock(connection)
        cursor = connection.execute(
            "INSERT INTO category_rules(field, pattern, category, priority) VALUES (?, ?, ?, ?) RETURNING id",
            (field, pattern, category, priority),
        )
        rule_id = cursor.fetchone()[0]
        changed = reclassify_all(connection) if payload.get("apply_existing", True) else 0
        connection.commit()
        row = connection.execute("SELECT * FROM category_rules WHERE id = ?", (rule_id,)).fetchone()
    return {"rule": dict(row), "reclassified": changed}


def delete_rule(db_path: Path | str, rule_id: int, apply_existing: bool = True) -> dict:
    with connect(db_path) as connection:
        write_lock(connection)
        cursor = connection.execute("DELETE FROM category_rules WHERE id = ?", (rule_id,))
        if cursor.rowcount == 0:
            raise KeyError("规则不存在")
        changed = reclassify_all(connection) if apply_existing else 0
        connection.commit()
    return {"deleted": rule_id, "reclassified": changed}


def recent_imports(db_path: Path | str, limit: int = 20) -> list[dict]:
    with connect(db_path) as connection:
        rows = connection.execute(
            "SELECT id, filename, platform, imported_at, total_rows, inserted_rows, updated_rows, unchanged_rows "
            "FROM import_batches ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]

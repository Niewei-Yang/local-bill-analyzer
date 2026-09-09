from __future__ import annotations

import json
import sqlite3
from hashlib import sha256
from pathlib import Path
from typing import Iterable

from .categorize import classify
from .models import Transaction


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
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, factory=ClosingConnection)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


def init_db(db_path: Path | str) -> None:
    with connect(db_path) as connection:
        connection.executescript(SCHEMA)


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
        rules = _enabled_rules(connection)
        cursor = connection.execute(
            "INSERT INTO import_batches(filename, platform, source_sha256) VALUES (?, ?, ?)",
            (filename, platform, sha256(content).hexdigest()),
        )
        batch_id = cursor.lastrowid
        inserted = updated = unchanged = 0
        for record in records:
            values = record.db_values()
            values["category"] = classify(values, rules)
            existing = connection.execute(
                "SELECT * FROM transactions WHERE fingerprint = ?", (values["fingerprint"],)
            ).fetchone()
            if existing is None:
                columns = TRANSACTION_FIELDS + ["fingerprint", "import_batch_id"]
                placeholders = ",".join("?" for _ in columns)
                connection.execute(
                    f"INSERT INTO transactions({','.join(columns)}) VALUES ({placeholders})",
                    [values[name] for name in TRANSACTION_FIELDS] + [values["fingerprint"], batch_id],
                )
                inserted += 1
                continue

            changed = any(existing[name] != values[name] for name in TRANSACTION_FIELDS)
            if changed:
                assignments = ",".join(f"{name} = ?" for name in TRANSACTION_FIELDS)
                connection.execute(
                    f"UPDATE transactions SET {assignments}, import_batch_id = ?, updated_at = CURRENT_TIMESTAMP "
                    "WHERE fingerprint = ?",
                    [values[name] for name in TRANSACTION_FIELDS] + [batch_id, values["fingerprint"]],
                )
                updated += 1
            else:
                unchanged += 1

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
                "UPDATE transactions SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
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
        cursor = connection.execute(
            "INSERT INTO category_rules(field, pattern, category, priority) VALUES (?, ?, ?, ?)",
            (field, pattern, category, priority),
        )
        changed = reclassify_all(connection) if payload.get("apply_existing", True) else 0
        connection.commit()
        rule_id = cursor.lastrowid
        row = connection.execute("SELECT * FROM category_rules WHERE id = ?", (rule_id,)).fetchone()
    return {"rule": dict(row), "reclassified": changed}


def delete_rule(db_path: Path | str, rule_id: int, apply_existing: bool = True) -> dict:
    with connect(db_path) as connection:
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

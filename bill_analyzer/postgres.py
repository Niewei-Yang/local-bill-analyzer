"""PostgreSQL storage with the row/parameter interface used by the local app."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal


def is_postgres(target) -> bool:
    return str(target).startswith(("postgres://", "postgresql://"))


class Record(dict):
    def __getitem__(self, key):
        return list(self.values())[key] if isinstance(key, int) else super().__getitem__(key)


def record_factory(cursor):
    names = [column.name for column in cursor.description] if cursor.description else []

    def make(values):
        def normalize(value):
            if isinstance(value, (date, datetime)):
                return value.isoformat()
            if isinstance(value, Decimal):
                return int(value) if value == value.to_integral_value() else float(value)
            return value
        return Record(zip(names, map(normalize, values)))
    return make


class PostgresConnection:
    def __init__(self, url: str):
        import psycopg
        self.raw = psycopg.connect(url, row_factory=record_factory, connect_timeout=15)

    def execute(self, sql, values=None):
        return self.raw.execute(sql.replace("?", "%s"), values or None)

    def executemany(self, sql, rows):
        rows = list(rows)
        if not rows:
            return
        # One multi-row INSERT per chunk avoids a network trip for every record.
        # This path is deliberately explicit: callers only use plain VALUES inserts.
        if " VALUES (" in sql and sql.startswith("INSERT INTO "):
            prefix, values = sql.split(" VALUES ", 1)
            size = max(1, min(500, 60000 // len(rows[0])))
            for start in range(0, len(rows), size):
                batch = rows[start:start + size]
                query = prefix + " VALUES " + ",".join([values] * len(batch))
                self.execute(query, [value for row in batch for value in row])
        else:
            for row in rows:
                self.execute(sql, row)

    def executescript(self, script):
        return self.raw.execute(script)

    def commit(self):
        self.raw.commit()

    def close(self):
        self.raw.close()

    def __enter__(self):
        return self

    def __exit__(self, kind, value, traceback):
        return self.raw.__exit__(kind, value, traceback)


def postgres_schema(sqlite_schema: str) -> str:
    statements = [part for part in sqlite_schema.split(";") if not part.strip().startswith("PRAGMA")]
    schema = ";".join(statements).replace("INTEGER PRIMARY KEY AUTOINCREMENT", "BIGSERIAL PRIMARY KEY").replace(
        "import_batch_id INTEGER", "import_batch_id BIGINT"
    ).replace("amount_cents INTEGER", "amount_cents BIGINT").replace(
        "DEFAULT CURRENT_TIMESTAMP", "DEFAULT (to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))"
    )
    return schema + """
CREATE TABLE IF NOT EXISTS database_backups (
    id BIGSERIAL PRIMARY KEY,
    filename TEXT NOT NULL,
    content BYTEA NOT NULL,
    created_at TEXT NOT NULL DEFAULT (to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
"""


def write_lock(connection):
    # Imports, rule edits, and restores serialize against each other across instances.
    if isinstance(connection, PostgresConnection):
        connection.execute("SELECT pg_advisory_xact_lock(87650001)")


def utc_now_sql(connection):
    return "to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')" if isinstance(connection, PostgresConnection) else "CURRENT_TIMESTAMP"

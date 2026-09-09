from __future__ import annotations

import calendar
import sqlite3
from datetime import date, datetime
from pathlib import Path

from .db import connect


def _money(cents: int | float | None) -> float:
    return round((cents or 0) / 100, 2)


def _filters(params: dict[str, str]) -> tuple[str, list[str]]:
    clauses: list[str] = []
    values: list[str] = []
    if params.get("start"):
        clauses.append("date(transaction_time) >= date(?)")
        values.append(params["start"])
    if params.get("end"):
        clauses.append("date(transaction_time) <= date(?)")
        values.append(params["end"])
    if params.get("platform") in {"微信", "支付宝"}:
        clauses.append("platform = ?")
        values.append(params["platform"])
    if params.get("category"):
        clauses.append("category = ?")
        values.append(params["category"])
    return (" WHERE " + " AND ".join(clauses)) if clauses else "", values


def _period_days(start: str | None, end: str | None) -> int:
    if not start or not end:
        return 0
    return (date.fromisoformat(end) - date.fromisoformat(start)).days + 1


def dashboard(db_path: Path | str, params: dict[str, str]) -> dict:
    where, values = _filters(params)
    granularity = params.get("granularity", "month")
    if granularity not in {"month", "week", "day"}:
        granularity = "month"
    period_sql = {
        "month": "substr(transaction_time, 1, 7)",
        "week": "date(transaction_time, '-' || ((CAST(strftime('%w', transaction_time) AS INTEGER) + 6) % 7) || ' days')",
        "day": "date(transaction_time)",
    }[granularity]
    with connect(db_path) as connection:
        summary_row = connection.execute(
            f"""
            SELECT
              COUNT(*) AS rows_count,
              MIN(date(transaction_time)) AS start_date,
              MAX(date(transaction_time)) AS end_date,
              SUM(CASE WHEN direction = 'expense' THEN amount_cents ELSE 0 END) AS gross_expense,
              SUM(CASE WHEN is_refund = 1 THEN amount_cents ELSE 0 END) AS refunds,
              SUM(CASE WHEN direction = 'income' AND is_refund = 0 THEN amount_cents ELSE 0 END) AS income,
              SUM(CASE WHEN direction = 'expense' THEN 1 ELSE 0 END) AS expense_count,
              SUM(CASE WHEN is_refund = 1 THEN 1 ELSE 0 END) AS refund_count,
              COUNT(DISTINCT CASE WHEN direction = 'expense' THEN date(transaction_time) END) AS active_days
            FROM transactions {where}
            """,
            values,
        ).fetchone()
        start_date = params.get("start") or summary_row["start_date"]
        end_date = params.get("end") or summary_row["end_date"]
        period_days = _period_days(start_date, end_date)
        gross = summary_row["gross_expense"] or 0
        refunds = summary_row["refunds"] or 0
        net = gross - refunds
        income = summary_row["income"] or 0

        expense_amounts = [
            row[0]
            for row in connection.execute(
                f"SELECT amount_cents FROM transactions {where}{' AND' if where else ' WHERE'} direction = 'expense' ORDER BY amount_cents",
                values,
            ).fetchall()
        ]
        median = 0
        if expense_amounts:
            middle = len(expense_amounts) // 2
            median = expense_amounts[middle] if len(expense_amounts) % 2 else (expense_amounts[middle - 1] + expense_amounts[middle]) / 2

        signed = "CASE WHEN direction = 'expense' THEN amount_cents WHEN is_refund = 1 THEN -amount_cents ELSE 0 END"
        platforms = connection.execute(
            f"SELECT platform, SUM({signed}) amount FROM transactions {where} GROUP BY platform ORDER BY amount DESC",
            values,
        ).fetchall()
        categories = connection.execute(
            f"SELECT category, SUM({signed}) amount FROM transactions {where} GROUP BY category HAVING amount != 0 ORDER BY amount DESC",
            values,
        ).fetchall()
        trend_rows = connection.execute(
            f"SELECT {period_sql} period_key, category, SUM({signed}) amount "
            f"FROM transactions {where} GROUP BY period_key, category HAVING amount != 0 ORDER BY period_key, amount DESC",
            values,
        ).fetchall()
        monthly_rows = trend_rows if granularity == "month" else connection.execute(
            f"SELECT substr(transaction_time, 1, 7) period_key, category, SUM({signed}) amount "
            f"FROM transactions {where} GROUP BY period_key, category HAVING amount != 0 ORDER BY period_key, amount DESC",
            values,
        ).fetchall()
        merchants = connection.execute(
            f"SELECT platform, counterparty merchant, COUNT(*) count, SUM(amount_cents) amount "
            f"FROM transactions {where}{' AND' if where else ' WHERE'} direction = 'expense' AND counterparty NOT IN ('', '/') "
            "GROUP BY platform, counterparty ORDER BY amount DESC LIMIT 12",
            values,
        ).fetchall()
        top_days = connection.execute(
            f"SELECT date(transaction_time) day, SUM({signed}) amount FROM transactions {where} "
            "GROUP BY day HAVING amount > 0 ORDER BY amount DESC LIMIT 7",
            values,
        ).fetchall()
        heat_rows = connection.execute(
            f"SELECT CAST(strftime('%w', transaction_time) AS INTEGER) weekday, "
            "CAST(strftime('%H', transaction_time) AS INTEGER) hour, SUM(amount_cents) amount "
            f"FROM transactions {where}{' AND' if where else ' WHERE'} direction = 'expense' GROUP BY weekday, hour",
            values,
        ).fetchall()
        recent = connection.execute(
            f"SELECT id, transaction_time, platform, direction, amount_cents, category, counterparty, description, status "
            f"FROM transactions {where} ORDER BY transaction_time DESC LIMIT 30",
            values,
        ).fetchall()

    top_category_names = [row["category"] for row in categories[:7]]
    trend_category_names = top_category_names + (["其他"] if len(categories) > 7 else [])

    def group_periods(rows: list[sqlite3.Row], key_name: str) -> list[dict]:
        period_map: dict[str, dict] = {}
        for row in rows:
            period_key = row["period_key"]
            item = period_map.setdefault(period_key, {key_name: period_key, "total": 0.0, "categories": {}})
            name = row["category"] if row["category"] in top_category_names else "其他"
            item["categories"][name] = round(item["categories"].get(name, 0) + _money(row["amount"]), 2)
            item["total"] = round(item["total"] + _money(row["amount"]), 2)
        return list(period_map.values())

    trend = group_periods(trend_rows, "period")
    monthly = group_periods(monthly_rows, "month")

    weekday_names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
    period_names = ["凌晨", "上午", "午间", "下午", "晚间"]

    def period_of(hour: int) -> str:
        if hour < 6:
            return "凌晨"
        if hour < 12:
            return "上午"
        if hour < 14:
            return "午间"
        if hour < 18:
            return "下午"
        return "晚间"

    heat_values = {(weekday_names[row["weekday"]], period_of(row["hour"])): 0 for row in heat_rows}
    for row in heat_rows:
        key = (weekday_names[row["weekday"]], period_of(row["hour"]))
        heat_values[key] += row["amount"]

    return {
        "period": {"start": start_date, "end": end_date, "days": period_days},
        "summary": {
            "row_count": summary_row["rows_count"],
            "gross_expense": _money(gross),
            "refunds": _money(refunds),
            "net_spend": _money(net),
            "income": _money(income),
            "cash_gap": _money(income - net),
            "expense_count": summary_row["expense_count"] or 0,
            "refund_count": summary_row["refund_count"] or 0,
            "active_days": summary_row["active_days"] or 0,
            "daily_average": _money(net / period_days) if period_days else 0,
            "median_expense": _money(median),
        },
        "platforms": [{"platform": row["platform"], "amount": _money(row["amount"])} for row in platforms],
        "categories": [
            {"category": row["category"], "amount": _money(row["amount"]), "share": round(row["amount"] / net, 4) if net else 0}
            for row in categories
        ],
        "granularity": granularity,
        "trend_categories": trend_category_names,
        "trend": trend,
        "monthly_categories": trend_category_names,
        "monthly": monthly,
        "merchants": [
            {"platform": row["platform"], "merchant": row["merchant"], "count": row["count"], "amount": _money(row["amount"])}
            for row in merchants
        ],
        "top_days": [{"date": row["day"], "amount": _money(row["amount"])} for row in top_days],
        "heatmap": [
            {"weekday": weekday, "period": period, "amount": _money(heat_values.get((weekday, period), 0))}
            for weekday in ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
            for period in period_names
        ],
        "recent": [
            {
                **{key: row[key] for key in ("id", "transaction_time", "platform", "direction", "category", "counterparty", "description", "status")},
                "amount": _money(row["amount_cents"]),
            }
            for row in recent
        ],
    }


def transactions(db_path: Path | str, params: dict[str, str]) -> dict:
    where, values = _filters(params)
    page = max(1, int(params.get("page", "1")))
    size = min(200, max(1, int(params.get("size", "50"))))
    offset = (page - 1) * size
    with connect(db_path) as connection:
        total = connection.execute(f"SELECT COUNT(*) FROM transactions {where}", values).fetchone()[0]
        rows = connection.execute(
            f"SELECT * FROM transactions {where} ORDER BY transaction_time DESC LIMIT ? OFFSET ?",
            values + [size, offset],
        ).fetchall()
    return {
        "page": page,
        "size": size,
        "total": total,
        "items": [{**dict(row), "amount": _money(row["amount_cents"])} for row in rows],
    }

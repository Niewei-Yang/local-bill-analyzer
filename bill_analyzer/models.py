from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from hashlib import sha256
from typing import Any


@dataclass(slots=True)
class Transaction:
    platform: str
    transaction_time: str
    direction: str
    amount_cents: int
    category_raw: str = ""
    category: str = "其他"
    counterparty: str = ""
    description: str = ""
    payment_method: str = ""
    status: str = ""
    source_order_id: str = ""
    merchant_order_id: str = ""
    note: str = ""
    is_refund: int = 0

    @property
    def fingerprint(self) -> str:
        if self.source_order_id:
            value = f"{self.platform}|order|{self.source_order_id}"
        else:
            value = "|".join(
                [
                    self.platform,
                    self.transaction_time,
                    self.direction,
                    str(self.amount_cents),
                    self.counterparty,
                    self.description,
                    self.payment_method,
                ]
            )
        return sha256(value.encode("utf-8")).hexdigest()

    def db_values(self) -> dict[str, Any]:
        values = asdict(self)
        values["fingerprint"] = self.fingerprint
        return values


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).replace("\t", " ").strip()
    return "" if text.lower() == "nan" else text


def parse_amount_cents(value: Any) -> int:
    text = clean_text(value).replace(",", "").replace("¥", "").replace("￥", "")
    try:
        amount = Decimal(text)
    except InvalidOperation as exc:
        raise ValueError(f"无法解析金额：{value!r}") from exc
    return int((amount * 100).quantize(Decimal("1")))


def parse_datetime(value: Any) -> str:
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    text = clean_text(value)
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
    raise ValueError(f"无法解析交易时间：{value!r}")

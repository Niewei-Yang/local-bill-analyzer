"""Single-owner HTTP Basic authentication for the hosted private ledger."""
from __future__ import annotations

import base64
import hmac
import os
from urllib.parse import urlparse


MIN_PASSWORD_LENGTH = 8


def configured():
    return bool(os.environ.get("APP_PASSWORD"))


def authorized(header: str) -> bool:
    try:
        scheme, value = header.split(" ", 1)
        if scheme.lower() != "basic":
            return False
        credentials = base64.b64decode(value, validate=True).decode("utf-8")
        username, password = credentials.split(":", 1)
        return hmac.compare_digest(username.encode(), os.environ.get("APP_USERNAME", "admin").encode()) & hmac.compare_digest(
            password.encode(), os.environ.get("APP_PASSWORD", "").encode()
        )
    except (ValueError, UnicodeError):
        return False


def same_origin(headers) -> bool:
    if headers.get("Sec-Fetch-Site", "") == "cross-site":
        return False
    origin = headers.get("Origin")
    if origin is None:
        return True  # Authenticated CLI/backup clients don't send browser Origin.
    parsed = urlparse(origin)
    return parsed.scheme in ("http", "https") and parsed.netloc == headers.get("Host")

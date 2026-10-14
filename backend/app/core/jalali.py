"""
Jalali (Persian) calendar helpers. Storage is always UTC/Gregorian (Phase 0 decision #3); anything that must follow
the Persian calendar — the report-number year above all — is derived here, in the business timezone (Asia/Tehran),
NOT from the UTC date: 1 Farvardin starts at 00:00 Tehran = 20:30 UTC of the previous day, so the two disagree for
3.5 hours every year (and the Tehran offset was +04:30 in summer until DST was abolished in 2022; zoneinfo knows).
"""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import jdatetime

BUSINESS_TZ = ZoneInfo("Asia/Tehran")


def to_business_time(dt: datetime) -> datetime:
    """Aware datetime in Asia/Tehran. Naive values are taken as UTC (we only ever store UTC)."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(BUSINESS_TZ)


def jalali_date(dt: datetime) -> jdatetime.date:
    return jdatetime.date.fromgregorian(date=to_business_time(dt).date())


def jalali_year(dt: datetime) -> int:
    return jalali_date(dt).year


def report_year_prefix(year: int) -> str:
    """1405 -> '05' (the YY of report numbers like 05-ELV-015). Wraps at 100 years, as the format implies."""
    return f"{year % 100:02d}"


def format_jalali(dt: datetime) -> str:
    local = to_business_time(dt)
    j = jdatetime.date.fromgregorian(date=local.date())
    return f"{j.year:04d}/{j.month:02d}/{j.day:02d} {local.hour:02d}:{local.minute:02d}"

from datetime import datetime, timezone

import pytest

from app.core.jalali import format_jalali, jalali_year, report_year_prefix, to_business_time


def utc(*a):
    return datetime(*a, tzinfo=timezone.utc)


def test_new_year_boundary_follows_tehran_midnight_not_utc_midnight():
    assert jalali_year(utc(2026, 3, 20, 20, 29, 59)) == 1404   # 23:59:59 Tehran, 29 Esfand 1404
    assert jalali_year(utc(2026, 3, 20, 20, 30, 0)) == 1405    # 00:00:00 Tehran, 1 Farvardin 1405
    assert jalali_year(utc(2026, 3, 21, 0, 0, 0)) == 1405
    assert format_jalali(utc(2026, 3, 20, 20, 29, 59)) == "1404/12/29 23:59"
    assert format_jalali(utc(2026, 3, 20, 20, 30, 0)) == "1405/01/01 00:00"


def test_utc_date_alone_would_be_wrong_in_the_boundary_window():
    just_after = utc(2026, 3, 20, 21, 0, 0)  # still 20 March in UTC, already 1405 in Tehran
    assert just_after.date().day == 20 and jalali_year(just_after) == 1405


def test_end_of_year_is_not_shifted_forward():
    assert jalali_year(utc(2026, 9, 22, 12, 0)) == 1405 and jalali_year(utc(2027, 3, 20, 12, 0)) == 1405
    assert jalali_year(utc(2027, 3, 21, 12, 0)) == 1406


def test_dst_era_and_post_dst_offsets():
    assert to_business_time(utc(2021, 7, 1, 12, 0)).utcoffset().total_seconds() == 4.5 * 3600   # DST in force in 2021
    assert to_business_time(utc(2026, 7, 1, 12, 0)).utcoffset().total_seconds() == 3.5 * 3600   # abolished since 2022


def test_naive_datetimes_are_treated_as_utc():
    assert jalali_year(datetime(2026, 3, 20, 20, 30)) == 1405
    assert format_jalali(datetime(2026, 3, 20, 20, 30)) == "1405/01/01 00:00"


@pytest.mark.parametrize("year,prefix", [(1405, "05"), (1399, "99"), (1400, "00"), (1404, "04")])
def test_report_year_prefix(year, prefix):
    assert report_year_prefix(year) == prefix

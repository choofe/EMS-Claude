import pytest

from app.core.errors import DomainError
from app.core.normalize import (
    canonical_equipment_code, canonical_group_code, canonical_report_type_code, canonical_username, clean_text,
    login_username,
)


@pytest.mark.parametrize("raw,expected", [("Ali", "ali"), ("  ALI.Reza-1 ", "ali.reza-1"), ("a_b", "a_b"), ("abc", "abc")])
def test_username_ok(raw, expected):
    assert canonical_username(raw) == expected


@pytest.mark.parametrize("raw", ["ab", "", "علی‌رضا", "has space", "-lead", ".lead", "a" * 65, "a@b", "ali!"])
def test_username_bad(raw):
    with pytest.raises(DomainError) as e:
        canonical_username(raw)
    assert e.value.code == "invalid_username" and e.value.status_code == 422


@pytest.mark.parametrize("raw,expected", [("elv-001", "ELV-001"), (" A.12/3 ", "A.12/3"), ("x_1", "X_1"), ("7", "7")])
def test_equipment_code_ok(raw, expected):
    assert canonical_equipment_code(raw) == expected


@pytest.mark.parametrize("raw", ["", "has space", "ELV 001", "-X", ".X", "فارسی", "A" * 65, "A#1", "A\tB"])
def test_equipment_code_bad(raw):
    with pytest.raises(DomainError):
        canonical_equipment_code(raw)


def test_group_and_type_codes():
    assert canonical_group_code("elv") == "ELV" and canonical_group_code("Door2") == "DOOR2"
    for bad in ("A", "1AB", "A-B", "A" * 17, "", "A B"):
        with pytest.raises(DomainError):
            canonical_group_code(bad)
    assert canonical_report_type_code("minor_failure") == "MINOR_FAILURE"
    for bad in ("1X", "A-B", "A B", "A"):
        with pytest.raises(DomainError):
            canonical_report_type_code(bad)


def test_clean_text_and_login_key():
    assert clean_text("  بازدید   دوره‌ای ", max_length=50, code="x") == "بازدید دوره‌ای"
    with pytest.raises(DomainError):
        clean_text("   ", max_length=5, code="x")
    with pytest.raises(DomainError):
        clean_text("abcdef", max_length=5, code="x")
    assert login_username("  ALI ") == "ali" and len(login_username("A" * 100)) == 64

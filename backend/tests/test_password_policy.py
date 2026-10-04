import pytest

from app.core.password_policy import validate_password


def v(pw, username="ali", min_length=8):
    return validate_password(pw, username=username, min_length=min_length)


def test_good_password_passes_without_composition_rules():
    assert v("correct horse battery") == []
    assert v("alllowercaseletters") == []  # no composition rules by design


def test_too_short():
    assert "too_short" in v("abc1234")
    assert v("abcd1234x") == []  # 9 chars
    assert "too_short" in v("abcdefghi", min_length=12)


def test_too_long():
    assert "too_long" in v("a1" * 65)


@pytest.mark.parametrize("pw", ["password123", "PASSWORD123", "12345678", "qwertyuiop", "Admin123"])
def test_common_passwords_rejected_case_insensitively(pw):
    assert any(e in v(pw) for e in ("too_common", "too_simple"))


@pytest.mark.parametrize("pw", ["aaaaaaaa", "11111111", "abcdefgh", "87654321"])
def test_trivial_patterns_rejected(pw):
    assert "too_simple" in v(pw)


def test_same_as_username():
    assert "same_as_username" in v("mohammad.reza", username="Mohammad.Reza")


def test_unicode_persian_password_ok():
    assert v("گذرواژه‌ی-خیلی-طولانی") == []


def test_fullwidth_and_compat_forms_do_not_bypass_the_deny_list():
    assert "too_common" in v("ｐａｓｓｗｏｒｄ１２３")          # full-width "password123"
    assert "same_as_username" in v("ＭＯＨＡＭＭＡＤ１２３", username="mohammad123")

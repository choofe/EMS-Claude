"""
Password policy: length and deny-list only — deliberately NO composition
rules ("one uppercase, one symbol...") since those mostly produce predictable
substitutions and support calls without adding real strength.

Returns machine-readable error codes (the frontend maps them to Persian
messages), never free text:
  too_short | too_long | too_common | same_as_username | too_simple
"""
import unicodedata

from app.core.common_passwords import COMMON_PASSWORDS

MAX_PASSWORD_LENGTH = 128  # also caps the cost of hashing attacker-supplied input


def _is_too_simple(password: str) -> bool:
    """All-identical characters, or a straight ascending/descending run (12345678, abcdefgh)."""
    if len(set(password)) == 1:
        return True
    diffs = {ord(b) - ord(a) for a, b in zip(password, password[1:])}
    return diffs in ({1}, {-1})


def validate_password(password: str, *, username: str, min_length: int) -> list[str]:
    errors: list[str] = []
    if len(password) < min_length:
        errors.append("too_short")
    if len(password) > MAX_PASSWORD_LENGTH:
        errors.append("too_long")
    # Compatibility-normalise only for the *comparisons* (full-width "ｐａｓｓｗｏｒｄ１２３" must
    # not slip past the deny-list). The stored/hashed password is never altered.
    lowered = unicodedata.normalize("NFKC", password).lower()
    if lowered in COMMON_PASSWORDS:
        errors.append("too_common")
    if username and lowered == unicodedata.normalize("NFKC", username).lower():
        errors.append("same_as_username")
    if password and _is_too_simple(password):
        errors.append("too_simple")
    return errors

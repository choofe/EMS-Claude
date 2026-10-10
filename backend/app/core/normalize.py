"""
Canonical forms for identifiers. One place, used by every write path (API, CLI, later the Excel
import) so the same input can never produce two different "unique" values:

  username          lower-case,  a-z 0-9 . _ -   (3-64)
  equipment code    UPPER-case,  A-Z 0-9 . _ / - (1-64), no spaces
  group code        UPPER-case,  A-Z 0-9, starts with a letter (2-16)  — it sits inside report numbers
  report type code  UPPER-case,  A-Z 0-9 _, starts with a letter (2-32)

Surrounding whitespace is trimmed; inner whitespace is rejected. The database also carries CHECK
constraints (value = lower/upper(value)) as a last line of defence.
"""
import re

from app.core.errors import DomainError

_USERNAME = re.compile(r"^[a-z0-9][a-z0-9._-]{2,63}$")
_EQUIPMENT = re.compile(r"^[A-Z0-9][A-Z0-9._/-]{0,63}$")
_GROUP = re.compile(r"^[A-Z][A-Z0-9]{1,15}$")
_REPORT_TYPE = re.compile(r"^[A-Z][A-Z0-9_]{1,31}$")


def login_username(raw: str) -> str:
    """Lookup/lockout key for a typed username: lenient (no format check), same case folding as storage."""
    return raw.strip().lower()[:64]


def canonical_username(raw: str) -> str:
    value = raw.strip().lower()
    if not _USERNAME.fullmatch(value):
        raise DomainError("invalid_username", 422)
    return value


def canonical_equipment_code(raw: str) -> str:
    value = raw.strip().upper()
    if not _EQUIPMENT.fullmatch(value):
        raise DomainError("invalid_equipment_code", 422)
    return value


def canonical_group_code(raw: str) -> str:
    value = raw.strip().upper()
    if not _GROUP.fullmatch(value):
        raise DomainError("invalid_group_code", 422)
    return value


def canonical_report_type_code(raw: str) -> str:
    value = raw.strip().upper()
    if not _REPORT_TYPE.fullmatch(value):
        raise DomainError("invalid_report_type_code", 422)
    return value


def clean_text(raw: str | None, *, max_length: int, code: str) -> str:
    if raw is None:  # explicit JSON null for a non-nullable field
        raise DomainError(code, 422)
    value = " ".join(raw.split())  # trims and collapses runs of whitespace
    if not value or len(value) > max_length:
        raise DomainError(code, 422)
    return value

"""
Excel/CSV personnel import — parsing and validation only (sub-phase Pc). The preview/confirm/undo workflow
and the transactional insert are sub-phase Pd; this module answers "which rows of this file describe a
person we could create, and what is wrong with the others?".

Standard format (one sheet, header in row 1): first_name, last_name, personnel_code, mobile, groups (optional).
`groups` holds group CODES separated by ";" (e.g. ELV;ESC). The import creates NEW persons only; there is
never a profile (username/password/role) in the file.

Row rules (the same canonical forms as the management API, app.core.normalize):
- first/last name: required, cleaned; composed full name at most 128 characters.
- personnel code: required, integer 1-9999 without a leading zero; unique in the file and in the database.
- mobile: required, stored as 09xxxxxxxxx; unique in the file and in the database. It is NEVER echoed in the
  report (it is personal data); a row number is enough to find the row.
- groups: every code must name an existing ACTIVE group. A bad code is never stored and does NOT reject the
  row: the row is reported in `group_issues` so the preview (Pd) can let the manager fix or remove the code.
  A row with no group at all is valid. Repeated codes in one cell collapse to one.
- formulas and date-typed cells are rejected (Excel silently turns some values into dates).

Duplicates: a code or mobile already in the database rejects the row (`personnel_code_taken` / `mobile_taken`)
without naming the owner (existing people are never updated); among the remaining rows the first one with a code
(or mobile) wins and later ones are `duplicate_*_in_file`. A rejected row never claims a code or mobile.
"""
import asyncio
import hashlib
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from app.core.normalize import (
    canonical_group_code, canonical_mobile, canonical_personnel_code, clean_text, compose_full_name,
)
from app.models.group import Group
from app.models.user import User
from app.services.equipment_import import safe_file_name
from app.services.import_parser import PERSONNEL_COLUMNS, RawRow, parse_upload

_DB_CHUNK = 500
_SAMPLE = 10
_GROUP_SEPARATORS = str.maketrans({"؛": ";", "\n": ";"})  # Arabic semicolon; a line break inside the cell
_MAX_GROUP_TOKENS = 20


@dataclass
class PersonRow:
    row: int
    first_name: str
    last_name: str
    personnel_code: int
    mobile: str
    group_codes: list[str] = field(default_factory=list)       # valid, active, de-duplicated, in file order
    invalid_groups: list[dict] = field(default_factory=list)   # [{"token", "reason": malformed|unknown|inactive}]


def _error(row: int, personnel_code: str, code: str, **extra) -> dict:
    return {"row": row, "personnel_code": personnel_code.strip()[:16], "code": code, **extra}


def _split_groups(text: str) -> list[str]:
    return [t.strip() for t in text.translate(_GROUP_SEPARATORS).split(";") if t.strip()]


def _resolve_groups(tokens: list[str], groups: dict[str, bool]) -> tuple[list[str], list[dict]]:
    """groups: every group code -> is_active."""
    valid: list[str] = []
    invalid: list[dict] = []
    for token in tokens:
        shown = token[:32]
        try:
            code = canonical_group_code(token)
        except DomainError:
            invalid.append({"token": shown, "reason": "malformed"})
            continue
        if code not in groups:
            invalid.append({"token": shown, "reason": "unknown"})
        elif not groups[code]:
            invalid.append({"token": shown, "reason": "inactive"})
        elif code not in valid:
            valid.append(code)
    return valid, invalid


def _validate_row(raw: RawRow, groups: dict[str, bool]) -> PersonRow | dict:
    cells = raw.cells
    code_text = cells["personnel_code"].text
    for name in ("first_name", "last_name", "personnel_code", "mobile", "groups"):
        cell = cells.get(name)
        if cell is not None and cell.issue == "formula":
            return _error(raw.row, code_text, "formula_not_allowed", column=name)
    for name in ("first_name", "last_name", "personnel_code", "mobile", "groups"):
        cell = cells.get(name)
        if cell is not None and cell.issue == "date":
            return _error(raw.row, code_text, "date_cell", column=name)
    for name in ("first_name", "last_name", "personnel_code", "mobile"):
        if not cells[name].text.strip():
            return _error(raw.row, code_text, f"missing_{name}")
    try:
        first = clean_text(cells["first_name"].text, max_length=64, code="invalid_first_name")
        last = clean_text(cells["last_name"].text, max_length=64, code="invalid_last_name")
        compose_full_name(first, last)
    except DomainError as exc:
        return _error(raw.row, code_text, exc.code)
    try:
        code = canonical_personnel_code(code_text)
    except DomainError:
        return _error(raw.row, code_text, "invalid_personnel_code")
    try:
        mobile = canonical_mobile(cells["mobile"].text)
    except DomainError:
        return _error(raw.row, code_text, "invalid_mobile")
    group_cell = cells.get("groups")
    tokens = _split_groups(group_cell.text) if group_cell is not None else []
    if len(tokens) > _MAX_GROUP_TOKENS:
        return _error(raw.row, code_text, "too_many_groups", max_groups=_MAX_GROUP_TOKENS)
    valid, invalid = _resolve_groups(tokens, groups)
    return PersonRow(raw.row, first, last, code, mobile, valid, invalid)


async def _existing(db: AsyncSession, column, values: list) -> set:
    found: set = set()
    for i in range(0, len(values), _DB_CHUNK):
        chunk = values[i:i + _DB_CHUNK]
        found.update((await db.execute(select(column).where(column.in_(chunk)))).scalars().all())
    return found


async def analyse_personnel(db: AsyncSession, filename: str, data: bytes) -> tuple[dict, list[PersonRow]]:
    """Returns (report, rows). `rows` are every row that passed the row rules (some may still carry
    `invalid_groups`); the report never contains a mobile number."""
    # CPU-bound (zip + XML): keep it off the event loop so one big upload cannot stall other requests.
    parsed = await asyncio.to_thread(parse_upload, filename, data, PERSONNEL_COLUMNS)
    groups = {c: a for c, a in (await db.execute(select(Group.code, Group.is_active))).all()}
    candidates: list[PersonRow] = []
    errors: list[dict] = []
    for raw in parsed.rows:
        result = _validate_row(raw, groups)
        if isinstance(result, dict):
            errors.append(result)
        else:
            candidates.append(result)
    # Database conflicts first, so that a row rejected for any reason claims no code or mobile in the file.
    taken_codes = await _existing(db, User.personnel_code, [r.personnel_code for r in candidates])
    taken_mobiles = await _existing(db, User.mobile, [r.mobile for r in candidates])
    kept: list[PersonRow] = []
    code_rows: dict[int, int] = {}
    mobile_rows: dict[str, int] = {}
    for r in candidates:
        if r.personnel_code in taken_codes:
            errors.append(_error(r.row, str(r.personnel_code), "personnel_code_taken"))
        elif r.mobile in taken_mobiles:
            errors.append(_error(r.row, str(r.personnel_code), "mobile_taken"))
        elif r.personnel_code in code_rows:
            errors.append(_error(r.row, str(r.personnel_code), "duplicate_personnel_code_in_file",
                                 first_row=code_rows[r.personnel_code]))
        elif r.mobile in mobile_rows:
            errors.append(_error(r.row, str(r.personnel_code), "duplicate_mobile_in_file",
                                 first_row=mobile_rows[r.mobile]))
        else:
            code_rows[r.personnel_code] = r.row
            mobile_rows[r.mobile] = r.row
            kept.append(r)
    errors.sort(key=lambda e: e["row"])
    issues = [{"row": r.row, "personnel_code": r.personnel_code, "invalid_groups": r.invalid_groups}
              for r in kept if r.invalid_groups]
    report = {
        "file_name": safe_file_name(filename),
        "file_sha256": hashlib.sha256(data).hexdigest(),
        "rows_total": len(parsed.rows),
        "valid_count": len(kept),
        "error_count": len(errors),
        "group_issue_count": len(issues),
        "ignored_columns": parsed.ignored_columns,
        "errors": errors,
        "group_issues": issues,
        "sample": [{"row": r.row, "personnel_code": r.personnel_code, "full_name": f"{r.first_name} {r.last_name}",
                    "group_codes": r.group_codes} for r in kept[:_SAMPLE]],
    }
    return report, kept

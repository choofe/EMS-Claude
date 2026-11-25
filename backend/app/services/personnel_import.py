"""
Excel/CSV personnel import. Sub-phase Pc: parsing and validation ("which rows of this file describe a person
we could create, and what is wrong with the others?"). Sub-phase Pd: the manager's corrections of invalid group
codes, the preview and the transactional commit (the undo and the CSV problem report come in Pg).

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
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import DomainError
from app.core.normalize import (
    fold_text,
    canonical_group_code, canonical_mobile, canonical_personnel_code, clean_text, compose_full_name,
)
from app.models.group import Group
from app.models.import_batch import PersonnelImportBatch
from app.models.user import User
from app.models.user_group import UserGroup
from app.schemas.personnel_import import PersonnelCorrection
from app.services.audit import add_audit
from app.services.equipment_import import safe_file_name
from app.services.import_parser import PERSONNEL_COLUMNS, RawRow, parse_upload
from app.services.personnel_same_names import find_same_names

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

    @property
    def names(self) -> tuple[str, str]:
        return self.first_name, self.last_name


def _error(row: int, personnel_code: str, code: str, names: tuple[str | None, str | None] = (None, None), **extra) -> dict:
    """`names` = (first, last) cleaned, so the manager can recognise the person; both None when the name itself is
    the problem (or the cell is a formula/date). Never the mobile number."""
    return {"row": row, "first_name": names[0], "last_name": names[1], "personnel_code": personnel_code.strip()[:16],
            "code": code, **extra}


def _names(cells: dict) -> tuple[str | None, str | None]:
    first, last = cells["first_name"], cells["last_name"]
    if first.issue or last.issue:
        return None, None
    try:
        first_name = clean_text(first.text, max_length=64, code="invalid_first_name")
        last_name = clean_text(last.text, max_length=64, code="invalid_last_name")
        compose_full_name(first_name, last_name)
    except DomainError:
        return None, None
    return first_name, last_name


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
    names = _names(cells)
    for name in ("first_name", "last_name", "personnel_code", "mobile", "groups"):
        cell = cells.get(name)
        if cell is not None and cell.issue == "formula":
            return _error(raw.row, code_text, "formula_not_allowed", names, column=name)
    for name in ("first_name", "last_name", "personnel_code", "mobile", "groups"):
        cell = cells.get(name)
        if cell is not None and cell.issue == "date":
            return _error(raw.row, code_text, "date_cell", names, column=name)
    for name in ("first_name", "last_name", "personnel_code", "mobile"):
        if not cells[name].text.strip():
            return _error(raw.row, code_text, f"missing_{name}", names)
    try:
        first = clean_text(cells["first_name"].text, max_length=64, code="invalid_first_name")
        last = clean_text(cells["last_name"].text, max_length=64, code="invalid_last_name")
        compose_full_name(first, last)
    except DomainError as exc:
        return _error(raw.row, code_text, exc.code)
    names = (first, last)
    try:
        code = canonical_personnel_code(code_text)
    except DomainError:
        return _error(raw.row, code_text, "invalid_personnel_code", names)
    try:
        mobile = canonical_mobile(cells["mobile"].text)
    except DomainError:
        return _error(raw.row, code_text, "invalid_mobile", names)
    group_cell = cells.get("groups")
    tokens = _split_groups(group_cell.text) if group_cell is not None else []
    if len(tokens) > _MAX_GROUP_TOKENS:
        return _error(raw.row, code_text, "too_many_groups", names, max_groups=_MAX_GROUP_TOKENS)
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
    report, rows, _ = await _analyse(db, filename, data, frozenset())
    return report, rows


async def _analyse(db: AsyncSession, filename: str, data: bytes,
                   dropped: frozenset[int]) -> tuple[dict, list[PersonRow], list[list[PersonRow]]]:
    """`dropped` = rows the manager dropped: they stay in the result (the correction removes them) but CLAIM nothing,
    so the other row of an in-file duplicate pair becomes valid. Third result: the conflict clusters (rows that
    share a code or a mobile); their rows are NOT in the second result."""
    # CPU-bound (zip + XML): keep it off the event loop so one big upload cannot stall other requests.
    parsed = await asyncio.to_thread(parse_upload, filename, data, PERSONNEL_COLUMNS, get_settings().personnel_import_max_rows)
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
    free: list[PersonRow] = []
    for r in candidates:
        if r.personnel_code in taken_codes:
            errors.append(_error(r.row, str(r.personnel_code), "personnel_code_taken", r.names))
        elif r.mobile in taken_mobiles:
            errors.append(_error(r.row, str(r.personnel_code), "mobile_taken", r.names))
        else:
            free.append(r)
    # Rows that share a code or a mobile form clusters that NOBODY wins by default: the manager keeps one row of a
    # cluster (the others are dropped) or drops them all. Dropped rows claim nothing, so they never form a cluster.
    clusters = _conflict_clusters([r for r in free if r.row not in dropped])
    clustered = {r.row for c in clusters for r in c}
    kept = [r for r in free if r.row not in clustered]
    errors.sort(key=lambda e: e["row"])
    report = {
        "file_name": safe_file_name(filename),
        "file_sha256": hashlib.sha256(data).hexdigest(),
        "rows_total": len(parsed.rows),
        "error_count": len(errors),
        "ignored_columns": parsed.ignored_columns,
        "errors": errors,
        "file_conflict_count": len(clusters),
        "file_conflicts": _file_conflicts(clusters, with_mobile=False),
        **_summary(kept),
    }
    return report, kept, clusters


def _same_name(first: PersonRow, later: PersonRow) -> bool:
    return fold_text(compose_full_name(first.first_name, first.last_name)) == fold_text(
        compose_full_name(later.first_name, later.last_name))


def _conflict_clusters(rows: list[PersonRow]) -> list[list[PersonRow]]:
    """Connected components (size >= 2) of the rows linked by a shared personnel code or mobile, each in file order,
    the clusters ordered by their first row."""
    parent = {r.row: r.row for r in rows}

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    seen: dict[tuple, int] = {}
    for r in rows:
        for key in (("code", r.personnel_code), ("mobile", r.mobile)):
            if key in seen:
                parent[find(r.row)] = find(seen[key])
            else:
                seen[key] = r.row
    groups: dict[int, list[PersonRow]] = {}
    for r in rows:
        groups.setdefault(find(r.row), []).append(r)
    return sorted((g for g in groups.values() if len(g) > 1), key=lambda g: g[0].row)


def _file_row(r: PersonRow, with_mobile: bool) -> dict:
    d = {"row": r.row, "first_name": r.first_name, "last_name": r.last_name, "personnel_code": r.personnel_code,
         "group_codes": r.group_codes}
    if with_mobile:
        d["mobile"] = r.mobile
    return d


def _file_conflicts(clusters: list[list[PersonRow]], with_mobile: bool) -> list[dict]:
    out = []
    for c in clusters:
        shared = [k for k, vals in (("personnel_code", [r.personnel_code for r in c]), ("mobile", [r.mobile for r in c]))
                  if len(set(vals)) < len(vals)]
        out.append({"shared": shared, "same_name": all(_same_name(c[0], r) for r in c[1:]),
                    "rows": [_file_row(r, with_mobile) for r in c]})
    return out


def _same_names_in_file(rows: list[PersonRow], with_mobile: bool) -> list[dict]:
    """Importable rows that carry the same name (their codes and mobiles differ, or they would be a conflict): a plain
    warning, the manager decides nothing."""
    by_name: dict[str, list[PersonRow]] = {}
    for r in rows:
        by_name.setdefault(fold_text(compose_full_name(r.first_name, r.last_name)), []).append(r)
    return [{"rows": [_file_row(r, with_mobile) for r in g]} for g in by_name.values() if len(g) > 1]


def _summary(rows: list[PersonRow]) -> dict:
    """The parts of the report that depend on which rows are kept (also recomputed after corrections)."""
    issues = [{"row": r.row, "first_name": r.first_name, "last_name": r.last_name,
               "personnel_code": r.personnel_code, "invalid_groups": r.invalid_groups}
              for r in rows if r.invalid_groups]
    return {
        "valid_count": len(rows),
        "group_issue_count": len(issues),
        "group_issues": issues,
        "sample": [{"row": r.row, "personnel_code": r.personnel_code, "full_name": f"{r.first_name} {r.last_name}",
                    "group_codes": r.group_codes} for r in rows[:_SAMPLE]],
    }


# ------------------------------------------------------------------ corrections (Pd)
def apply_corrections(rows: list[PersonRow], corrections: list[PersonnelCorrection],
                      groups: dict[str, bool]) -> tuple[list[PersonRow], int]:
    """Applies the manager's corrections to freshly analysed rows (they are changed in place) and returns
    (remaining rows, number of dropped rows). Everything is re-validated here, never trusted: a target row or
    token that does not exist, a repeated correction, or a replacement that is not an ACTIVE group is a 422."""
    by_row = {r.row: r for r in rows}
    seen: set[tuple] = set()
    dropped: set[int] = set()
    for c in corrections:
        key = (c.row, c.op == "drop", c.token)
        if key in seen:
            raise DomainError("duplicate_correction", 422, row=c.row)
        seen.add(key)
        person = by_row.get(c.row)
        if person is None:
            raise DomainError("correction_row_not_found", 422, row=c.row)
        if c.op == "drop":
            dropped.add(c.row)
            continue
        if not any(i["token"] == c.token for i in person.invalid_groups):
            raise DomainError("correction_token_not_found", 422, row=c.row, token=c.token)
        if c.op == "replace":
            try:
                target = canonical_group_code(c.to or "")
            except DomainError:
                raise DomainError("correction_group_invalid", 422, row=c.row, token=c.token) from None
            if not groups.get(target):  # unknown (None) or inactive (False)
                raise DomainError("correction_group_invalid", 422, row=c.row, token=c.token)
            if target not in person.group_codes:
                person.group_codes.append(target)
        person.invalid_groups = [i for i in person.invalid_groups if i["token"] != c.token]
    return [r for r in rows if r.row not in dropped], len(dropped)


async def analyse_with_corrections(db: AsyncSession, filename: str, data: bytes,
                                   corrections: list[PersonnelCorrection]) -> tuple[dict, list[PersonRow]]:
    report, rows, _ = await _analyse_corrected(db, filename, data, corrections)
    return report, rows


async def _analyse_corrected(db: AsyncSession, filename: str, data: bytes,
                             corrections: list[PersonnelCorrection]) -> tuple[dict, list[PersonRow], list[list[PersonRow]]]:
    # Dropped rows are known BEFORE the analysis: they must not claim a code or mobile (a duplicate's other row wins).
    dropped_rows = frozenset(c.row for c in corrections if c.op == "drop")
    report, rows, clusters = await _analyse(db, filename, data, dropped_rows)
    groups = {c: a for c, a in (await db.execute(select(Group.code, Group.is_active))).all()}
    rows, dropped = apply_corrections(rows, corrections, groups)
    report.update(_summary(rows), dropped_count=dropped)
    return report, rows, clusters


async def preview_import(db: AsyncSession, *, filename: str, data: bytes, corrections: list[PersonnelCorrection],
                         include_mobile: bool = False) -> dict:
    """The preview adds the non-blocking same-name notice (rows left after the corrections) and the in-file duplicate
    pairs the manager may decide between; the commit does not. Mobile numbers appear only there, and only when
    `include_mobile` (capability personnel.mobile.view, decided by the caller)."""
    report, rows, clusters = await _analyse_corrected(db, filename, data, corrections)
    report.update(await find_same_names(db, rows, include_mobile=include_mobile))
    report["file_conflicts"] = _file_conflicts(clusters, include_mobile)
    report["same_name_in_file"] = _same_names_in_file(rows, include_mobile)
    return report


# ------------------------------------------------------------------ commit (Pd)
async def commit_import(db: AsyncSession, *, actor_id: int, filename: str, data: bytes, expected_sha256: str,
                        corrections: list[PersonnelCorrection]) -> dict:
    """Creates the remaining rows as NEW people (no profile, sign-in off), all in one transaction. The file is
    re-read and re-validated here; nothing from the preview is trusted except the file hash, which proves it is
    the file that was previewed. Refused while any invalid group code is left."""
    if hashlib.sha256(data).hexdigest() != (expected_sha256 or "").strip().lower():
        raise DomainError("file_changed", 409)
    report, rows = await analyse_with_corrections(db, filename, data, corrections)
    if report["group_issue_count"]:
        raise DomainError("group_issues_unresolved", 422, group_issue_count=report["group_issue_count"])
    if report["file_conflict_count"]:
        raise DomainError("file_conflicts_unresolved", 422, file_conflict_count=report["file_conflict_count"])
    if not rows:
        raise DomainError("nothing_to_import", 422, error_count=report["error_count"])
    # Shared lock on the active groups: deactivating a group takes FOR UPDATE, so it either finishes first (the group
    # drops out of the re-evaluated predicate and we answer import_conflict) or waits for this transaction.
    ids = {c: i for c, i in (await db.execute(select(Group.code, Group.id).where(Group.is_active.is_(True))
                                              .order_by(Group.id).with_for_update(read=True))).all()}
    batch = PersonnelImportBatch(file_name=report["file_name"], file_sha256=report["file_sha256"], created_by=actor_id,
                                 created_count=len(rows), rejected_count=report["error_count"] + report["dropped_count"])
    db.add(batch)
    await db.flush()
    people = [User(full_name=compose_full_name(r.first_name, r.last_name), first_name=r.first_name,
                   last_name=r.last_name, personnel_code=r.personnel_code, mobile=r.mobile, login_enabled=False,
                   import_batch_id=batch.id) for r in rows]
    db.add_all(people)
    try:
        await db.flush()
        db.add_all(UserGroup(user_id=u.id, group_id=ids[code]) for u, r in zip(people, rows) for code in r.group_codes)
        await db.flush()
    except (IntegrityError, KeyError):  # a code/mobile taken (or a group deactivated) since our check
        await db.rollback()
        raise DomainError("import_conflict", 409) from None
    add_audit(db, actor_id=actor_id, action="personnel.import", entity_type="personnel_import_batch",
              entity_id=batch.id, metadata={"file_name": report["file_name"], "file_sha256": report["file_sha256"],
                                            "rows_total": report["rows_total"], "created": len(rows),
                                            "rejected": report["error_count"], "dropped": report["dropped_count"]})
    await db.commit()
    return {**report, "batch_id": batch.id, "created_count": len(rows)}

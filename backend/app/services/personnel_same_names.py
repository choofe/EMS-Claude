"""Same-name notice of the personnel import preview (phase-personnel, Pi).

Purpose: a wrong personnel code must not silently create a second record of a person who already exists. Name plus
code is unique, so a same name never blocks an import; it is only a notice. A row of the file (after the manager's
corrections, rows with no error only) is compared with EVERY existing person by the folded full name (spaces, ZWNJ,
Arabic yeh/kaf, diacritics and digits unified; exact match only, no fuzzy matching). Rows of the file are never
compared with each other (those rows already get duplicate-code or duplicate-mobile errors).

Privacy: only name, personnel code, group codes, active flag and «has a profile» of the existing person are
returned; never a mobile number, username or role.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.normalize import compose_full_name, fold_text
from app.models.group import Group
from app.models.user import User
from app.models.user_group import UserGroup

MAX_SAME_NAME_ROWS = 200
MAX_MATCHES = 5
_CHUNK = 400


async def find_same_names(db: AsyncSession, rows: list) -> dict:
    """rows: PersonRow objects. Returns {"same_name_count", "same_names"} (the list is capped at 200 rows)."""
    empty = {"same_name_count": 0, "same_names": []}
    if not rows:
        return empty
    by_name: dict[str, list[tuple]] = {}
    for uid, full_name, code, active, username in (await db.execute(
            select(User.id, User.full_name, User.personnel_code, User.is_active, User.username))).all():
        by_name.setdefault(fold_text(full_name), []).append((uid, full_name, code, active, username is not None))
    hits = []
    for r in sorted(rows, key=lambda r: r.row):
        found = by_name.get(fold_text(compose_full_name(r.first_name, r.last_name)))
        if found:
            # ascending personnel code (a typo in a code is easiest to see that way), people without a code last
            hits.append((r, sorted(found, key=lambda m: (m[2] is None, m[2] or 0, m[0]))))
    listed = hits[:MAX_SAME_NAME_ROWS]
    shown_ids = sorted({m[0] for _, found in listed for m in found[:MAX_MATCHES]})
    groups: dict[int, list[str]] = {i: [] for i in shown_ids}
    for start in range(0, len(shown_ids), _CHUNK):
        part = shown_ids[start:start + _CHUNK]
        for uid, code in (await db.execute(select(UserGroup.user_id, Group.code).join(Group, Group.id == UserGroup.group_id)
                                           .where(UserGroup.user_id.in_(part)).order_by(Group.code))).all():
            groups[uid].append(code)
    return {
        "same_name_count": len(hits),
        "same_names": [{
            "row": r.row, "first_name": r.first_name, "last_name": r.last_name, "personnel_code": r.personnel_code,
            "matches_total": len(found),
            "matches": [{"full_name": m[1], "personnel_code": m[2], "group_codes": groups[m[0]], "is_active": m[3],
                         "has_profile": m[4]} for m in found[:MAX_MATCHES]],
        } for r, found in listed],
    }

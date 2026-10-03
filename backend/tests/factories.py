"""Seeding helpers that work on BOTH engines (SQLite fixture seeds roles itself; Postgres gets them from the migration)."""
from datetime import datetime, timezone

from sqlalchemy import select

import app.models as m
from app.core.security import hash_password

PASSWORD = "correct-horse-battery"
_HASH = hash_password(PASSWORD)  # hashed once; Argon2 is deliberately slow


async def role(db, code):
    return (await db.execute(select(m.Role).where(m.Role.code == code))).scalar_one()


async def group(db, code, name=None):
    g = m.Group(code=code, name=name or code)
    db.add(g)
    await db.flush()
    return g


async def user(db, username, role_code="USER", groups=(), active=True, must_change=False):
    r = await role(db, role_code)
    u = m.User(username=username, hashed_password=_HASH, full_name=username.title(),
               role_id=r.id, is_active=active, must_change_password=must_change)
    db.add(u)
    await db.flush()
    for g in groups:
        db.add(m.UserGroup(user_id=u.id, group_id=g.id))
    await db.flush()
    return u


async def equipment(db, code, grp):
    e = m.Equipment(equipment_code=code, group_id=grp.id)
    db.add(e)
    await db.flush()
    return e


async def report_type(db, code="INSPECTION_VISIT"):
    existing = (await db.execute(select(m.ReportType).where(m.ReportType.code == code))).scalar_one_or_none()
    if existing:
        return existing
    rt = m.ReportType(code=code, name_fa=code, is_failure=False)
    db.add(rt)
    await db.flush()
    return rt


async def report(db, number, equip, grp, creator, participants=()):
    """participants: iterable of (user, minutes). grp is the SNAPSHOT group."""
    rt = await report_type(db)
    r = m.Report(report_number=number, equipment_id=equip.id, group_id=grp.id, report_type_id=rt.id,
                 event_datetime=datetime(2026, 1, 1, tzinfo=timezone.utc), report_jalali_year=1404,
                 created_by=creator.id, description="t")
    db.add(r)
    await db.flush()
    for u, minutes in participants:
        db.add(m.ReportParticipant(report_id=r.id, user_id=u.id, minutes=minutes))
    await db.flush()
    return r

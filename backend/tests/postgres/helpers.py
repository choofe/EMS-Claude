"""Small seeding helpers shared by the Postgres tests (and later phases)."""
from datetime import datetime, timezone

from sqlalchemy import select

import app.models as m


async def get_role(session, code: str) -> m.Role:
    return (await session.execute(select(m.Role).where(m.Role.code == code))).scalar_one()


async def get_report_type(session, code: str = "INSPECTION_VISIT") -> m.ReportType:
    return (
        await session.execute(select(m.ReportType).where(m.ReportType.code == code))
    ).scalar_one()


async def make_group(session, code: str = "ELV", name: str = "Elevator") -> m.Group:
    group = m.Group(code=code, name=name)
    session.add(group)
    await session.flush()
    return group


async def make_user(session, username: str = "ali", role_code: str = "EXPERT") -> m.User:
    role = await get_role(session, role_code)
    user = m.User(username=username, hashed_password="x", full_name=username, role_id=role.id)
    session.add(user)
    await session.flush()
    return user


async def make_equipment(session, group: m.Group, code: str = "ELV-001") -> m.Equipment:
    equip = m.Equipment(equipment_code=code, group_id=group.id)
    session.add(equip)
    await session.flush()
    return equip


def report_kwargs(equip, group, rtype, user, **overrides) -> dict:
    data = dict(
        equipment_id=equip.id,
        group_id=group.id,
        report_type_id=rtype.id,
        event_datetime=datetime(2026, 1, 1, tzinfo=timezone.utc),
        report_jalali_year=1404,
        created_by=user.id,
        description="test",
    )
    data.update(overrides)
    return data

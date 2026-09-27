# path: backend/tests/test_schema.py
"""
Phase 2 schema tests (spec section 28 / Phase Gate Rule): constraints,
relationships, uniqueness, and referential integrity must actually be
tested, not assumed. Uses a dedicated in-memory SQLite engine (not the
health-check fixture in conftest.py) with foreign_keys pragma turned on,
since SQLite otherwise silently ignores FK constraints.
"""
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from sqlalchemy import event
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.base import Base
import app.models as m


@pytest_asyncio.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")

    @event.listens_for(engine.sync_engine, "connect")
    def _enable_fk(dbapi_conn, _):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    Session = async_sessionmaker(bind=engine, expire_on_commit=False)
    async with Session() as session:
        yield session
    await engine.dispose()


async def _seed_group_and_role(db):
    role = m.Role(code="EXPERT", label_fa="کارشناس")
    group = m.Group(name="Elevator", code="ELV")
    db.add_all([role, group])
    await db.flush()
    return role, group


@pytest.mark.asyncio
async def test_equipment_code_globally_unique(db):
    _, group = await _seed_group_and_role(db)
    db.add(m.Equipment(equipment_code="ELV-001", group_id=group.id))
    await db.flush()
    db.add(m.Equipment(equipment_code="ELV-001", group_id=group.id))
    with pytest.raises(IntegrityError):
        await db.flush()


@pytest.mark.asyncio
async def test_report_number_unique(db):
    role, group = await _seed_group_and_role(db)
    rtype = m.ReportType(code="INSPECTION_VISIT", name_fa="بازدید", is_failure=False)
    equip = m.Equipment(equipment_code="ELV-002", group_id=group.id)
    user = m.User(username="ali", hashed_password="x", full_name="Ali", role_id=role.id)
    db.add_all([rtype, equip, user])
    await db.flush()

    common = dict(
        equipment_id=equip.id,
        group_id=group.id,
        report_type_id=rtype.id,
        event_datetime=datetime(2026, 1, 1, tzinfo=timezone.utc),
        report_jalali_year=1404,
        created_by=user.id,
        description="test",
    )
    db.add(m.Report(report_number="05-ELV-001", **common))
    await db.flush()
    db.add(m.Report(report_number="05-ELV-001", **common))
    with pytest.raises(IntegrityError):
        await db.flush()


@pytest.mark.asyncio
async def test_report_sequence_unique_per_group_year(db):
    _, group = await _seed_group_and_role(db)
    db.add(m.ReportSequence(group_id=group.id, jalali_year=1404, last_number=5))
    await db.flush()
    db.add(m.ReportSequence(group_id=group.id, jalali_year=1404, last_number=0))
    with pytest.raises(IntegrityError):
        await db.flush()


@pytest.mark.asyncio
async def test_user_group_membership_unique(db):
    role, group = await _seed_group_and_role(db)
    user = m.User(username="saeed", hashed_password="x", full_name="Saeed", role_id=role.id)
    db.add(user)
    await db.flush()
    db.add(m.UserGroup(user_id=user.id, group_id=group.id))
    await db.flush()
    db.add(m.UserGroup(user_id=user.id, group_id=group.id))
    with pytest.raises(IntegrityError):
        await db.flush()


@pytest.mark.asyncio
async def test_equipment_group_fk_restrict(db):
    """A group referenced by equipment cannot be deleted (ON DELETE RESTRICT)."""
    _, group = await _seed_group_and_role(db)
    db.add(m.Equipment(equipment_code="ELV-003", group_id=group.id))
    await db.flush()

    await db.delete(group)
    with pytest.raises(IntegrityError):
        await db.flush()


@pytest.mark.asyncio
async def test_report_group_id_independent_of_equipment_group_id(db):
    """
    Core 2026-09-27 design guarantee: reports.group_id is a frozen
    snapshot, NOT a live reflection of equipment.group_id. Moving the
    equipment to a different group must not change already-created
    reports' group_id.
    """
    role, group_elv = await _seed_group_and_role(db)
    group_door = m.Group(name="Door", code="DOOR")
    rtype = m.ReportType(code="INSPECTION_VISIT", name_fa="بازدید", is_failure=False)
    equip = m.Equipment(equipment_code="ELV-023", group_id=group_elv.id)
    user = m.User(username="ali", hashed_password="x", full_name="Ali", role_id=role.id)
    db.add_all([group_door, rtype, equip, user])
    await db.flush()

    report = m.Report(
        report_number="05-ELV-999",
        equipment_id=equip.id,
        group_id=group_elv.id,  # snapshot at creation time
        report_type_id=rtype.id,
        event_datetime=datetime(2026, 1, 1, tzinfo=timezone.utc),
        report_jalali_year=1404,
        created_by=user.id,
        description="before move",
    )
    db.add(report)
    await db.flush()

    # Equipment moves to a different group.
    equip.group_id = group_door.id
    await db.flush()
    await db.refresh(report)

    assert report.group_id == group_elv.id  # unchanged
    assert equip.group_id == group_door.id  # changed

"""
Phase 2 schema guarantees, proven on real PostgreSQL (the SQLite twin of
these lives in tests/test_schema.py). Every test runs inside a rolled-back
transaction, so nothing leaks between tests.
"""
import pytest
from sqlalchemy import delete, inspect, select, text
from sqlalchemy.exc import IntegrityError

import app.models as m
from app.db.base import Base

from .helpers import (
    get_report_type,
    make_equipment,
    make_group,
    make_user,
    report_kwargs,
)


# ---------- structure & seed data ------------------------------------------

async def test_every_model_has_a_table(db):
    conn = await db.connection()
    tables = await conn.run_sync(lambda sc: set(inspect(sc).get_table_names()))
    assert set(Base.metadata.tables) <= tables
    assert len(Base.metadata.tables) == 11


async def test_seed_roles(db):
    codes = (await db.execute(select(m.Role.code))).scalars().all()
    assert set(codes) == {"USER", "EXPERT", "MANAGEMENT", "AUDITOR"}
    auditor = (await db.execute(select(m.Role).where(m.Role.code == "AUDITOR"))).scalar_one()
    assert auditor.label_fa == "بازرس ارشد"


async def test_seed_report_types_and_failure_flags(db):
    rows = (await db.execute(select(m.ReportType.code, m.ReportType.is_failure))).all()
    assert dict(rows) == {
        "MINOR_FAILURE_REPAIR": True,
        "MAJOR_FAILURE_REPAIR": True,
        "PERIODIC_SERVICE": False,
        "INSPECTION_VISIT": False,
    }


async def test_seed_edit_window_setting(db):
    value = (
        await db.execute(
            select(m.SystemSetting.value).where(m.SystemSetting.key == "REPORT_EDIT_WINDOW_HOURS")
        )
    ).scalar_one()
    assert value == "24"


# ---------- uniqueness ------------------------------------------------------

async def test_group_code_unique(db):
    await make_group(db, "ELV")
    db.add(m.Group(code="ELV", name="Duplicate"))
    with pytest.raises(IntegrityError):
        await db.flush()


async def test_equipment_code_globally_unique(db):
    elv = await make_group(db, "ELV", "Elevator")
    esc = await make_group(db, "ESC", "Escalator")
    await make_equipment(db, elv, "X-001")
    # Same code in a DIFFERENT group must still be rejected (Phase 0 #1).
    db.add(m.Equipment(equipment_code="X-001", group_id=esc.id))
    with pytest.raises(IntegrityError):
        await db.flush()


async def test_report_number_unique(db):
    group = await make_group(db)
    user = await make_user(db)
    equip = await make_equipment(db, group)
    rtype = await get_report_type(db)
    db.add(m.Report(report_number="05-ELV-001", **report_kwargs(equip, group, rtype, user)))
    await db.flush()
    db.add(m.Report(report_number="05-ELV-001", **report_kwargs(equip, group, rtype, user)))
    with pytest.raises(IntegrityError):
        await db.flush()


async def test_report_sequence_unique_per_group_year(db):
    group = await make_group(db)
    db.add(m.ReportSequence(group_id=group.id, jalali_year=1404, last_number=5))
    await db.flush()
    db.add(m.ReportSequence(group_id=group.id, jalali_year=1404, last_number=0))
    with pytest.raises(IntegrityError):
        await db.flush()


async def test_report_sequence_allows_other_year_and_group(db):
    elv = await make_group(db, "ELV")
    esc = await make_group(db, "ESC", "Escalator")
    db.add_all(
        [
            m.ReportSequence(group_id=elv.id, jalali_year=1404, last_number=1),
            m.ReportSequence(group_id=elv.id, jalali_year=1405, last_number=1),
            m.ReportSequence(group_id=esc.id, jalali_year=1404, last_number=1),
        ]
    )
    await db.flush()  # no IntegrityError


async def test_user_group_membership_unique(db):
    group = await make_group(db)
    user = await make_user(db)
    db.add(m.UserGroup(user_id=user.id, group_id=group.id))
    await db.flush()
    db.add(m.UserGroup(user_id=user.id, group_id=group.id))
    with pytest.raises(IntegrityError):
        await db.flush()


# ---------- referential integrity (ON DELETE RESTRICT) ---------------------

async def test_group_with_equipment_cannot_be_deleted(db):
    group = await make_group(db)
    await make_equipment(db, group)
    with pytest.raises(IntegrityError, match="fk_equipment_group_id_groups"):
        await db.execute(delete(m.Group).where(m.Group.id == group.id))


async def test_equipment_with_reports_cannot_be_deleted(db):
    group = await make_group(db)
    user = await make_user(db)
    equip = await make_equipment(db, group)
    rtype = await get_report_type(db)
    db.add(m.Report(report_number="05-ELV-001", **report_kwargs(equip, group, rtype, user)))
    await db.flush()
    with pytest.raises(IntegrityError, match="fk_reports_equipment_id_equipment"):
        await db.execute(delete(m.Equipment).where(m.Equipment.id == equip.id))


async def test_user_with_reports_cannot_be_deleted(db):
    group = await make_group(db)
    user = await make_user(db)
    equip = await make_equipment(db, group)
    rtype = await get_report_type(db)
    db.add(m.Report(report_number="05-ELV-001", **report_kwargs(equip, group, rtype, user)))
    await db.flush()
    with pytest.raises(IntegrityError, match="fk_reports_created_by_users"):
        await db.execute(delete(m.User).where(m.User.id == user.id))


async def test_report_with_participants_cannot_be_deleted(db):
    group = await make_group(db)
    user = await make_user(db)
    equip = await make_equipment(db, group)
    rtype = await get_report_type(db)
    report = m.Report(report_number="05-ELV-001", **report_kwargs(equip, group, rtype, user))
    db.add(report)
    await db.flush()
    db.add(m.ReportParticipant(report_id=report.id, user_id=user.id, minutes=90))
    await db.flush()
    with pytest.raises(IntegrityError, match="fk_report_participants_report_id_reports"):
        await db.execute(delete(m.Report).where(m.Report.id == report.id))


# ---------- 2026-09-27 design guarantee ------------------------------------

async def test_report_group_id_independent_of_equipment_group_id(db):
    elv = await make_group(db, "ELV", "Elevator")
    door = await make_group(db, "DOOR", "Door")
    user = await make_user(db)
    equip = await make_equipment(db, elv, "ELV-023")
    rtype = await get_report_type(db)
    report = m.Report(report_number="05-ELV-999", **report_kwargs(equip, elv, rtype, user))
    db.add(report)
    await db.flush()

    equip.group_id = door.id  # equipment is reassigned to another group
    await db.flush()
    await db.refresh(report)

    assert report.group_id == elv.id
    assert equip.group_id == door.id


# ---------- DB-level server defaults (migration a3f1c9d47b20) --------------

async def test_raw_insert_without_is_active_gets_default_true(db):
    """A bulk/raw INSERT that omits is_active must succeed and default to true."""
    row = (
        await db.execute(
            text("INSERT INTO groups (code, name) VALUES ('RAW', 'Raw') RETURNING is_active")
        )
    ).scalar_one()
    assert row is True


async def test_raw_report_insert_gets_default_flags(db):
    group = await make_group(db)
    user = await make_user(db)
    equip = await make_equipment(db, group)
    rtype = await get_report_type(db)
    row = (
        await db.execute(
            text(
                """
                INSERT INTO reports
                  (report_number, equipment_id, group_id, report_type_id,
                   event_datetime, report_jalali_year, created_by, description)
                VALUES ('05-ELV-123', :e, :g, :t, now(), 1404, :u, 'raw')
                RETURNING is_active, is_locked, locked_at, locked_by, created_at
                """
            ),
            {"e": equip.id, "g": group.id, "t": rtype.id, "u": user.id},
        )
    ).one()
    assert row.is_active is True
    assert row.is_locked is False
    assert row.locked_at is None and row.locked_by is None
    assert row.created_at is not None  # DB-supplied creation timestamp

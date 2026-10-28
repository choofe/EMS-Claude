"""Phase 6 on real PostgreSQL: the actual create-report service under true concurrency (separate committed
transactions), plus the migration's new constraints. Replaces the raw-SQL stand-in in
test_report_sequence_concurrency_pg.py as the proof for report numbering."""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import app.models as m
from app.core.errors import DomainError
from app.core.permissions import Principal
from app.schemas.reports import DraftPayload, ParticipantIn, ReportCreate
from app.services import report_creation, report_drafts
from tests.postgres import helpers as h


def principal_of(user: m.User, role: str, group_ids=()) -> Principal:
    return Principal(user_id=user.id, username=user.username, full_name=user.full_name, role_code=role,
                     role_label_fa=role, group_ids=frozenset(group_ids), must_change_password=False)


async def seed(engine, n_users=1):
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as s:
        group = await h.make_group(s, "CON", "Concurrency")
        equip = await h.make_equipment(s, group, "CON-1")
        rtype = await h.get_report_type(s)
        users = [await h.make_user(s, f"u{i}", "USER") for i in range(n_users)]
        for u in users:
            s.add(m.UserGroup(user_id=u.id, group_id=group.id))
        await s.commit()
        return maker, group.id, equip.id, rtype.id, [(u.id, u.username, u.full_name) for u in users]


def req(equip_id, type_id, uid, draft_id=None):
    return ReportCreate(equipment_id=equip_id, report_type_id=type_id,
                        event_datetime=datetime.now(timezone.utc) - timedelta(hours=1),
                        description="concurrent", participants=[ParticipantIn(user_id=uid, minutes=15)],
                        draft_id=draft_id)


async def create_as(maker, user_tuple, group_id, equip_id, type_id, draft_id=None):
    uid, uname, fname = user_tuple
    p = Principal(user_id=uid, username=uname, full_name=fname, role_code="USER", role_label_fa="USER",
                  group_ids=frozenset({group_id}), must_change_password=False)
    async with maker() as s:  # each call: own connection, own transaction
        return await report_creation.create_report(s, p, req(equip_id, type_id, uid, draft_id))


async def test_concurrent_creation_numbers_unique_and_gapless(committed_engine):
    maker, gid, eid, tid, users = await seed(committed_engine, n_users=5)
    n = 40
    results = await asyncio.gather(*[create_as(maker, users[i % 5], gid, eid, tid) for i in range(n)])
    numbers = sorted(int(r["report_number"].rsplit("-", 1)[1]) for r in results)
    assert numbers == list(range(1, n + 1))
    assert len({r["report_number"] for r in results}) == n
    async with maker() as s:
        assert (await s.execute(select(func.count()).select_from(m.Report))).scalar_one() == n
        assert (await s.execute(select(func.sum(m.ReportParticipant.minutes)))).scalar_one() == 15 * n
        last = (await s.execute(select(m.ReportSequence.last_number))).scalar_one()
        assert last == n  # counter == number of reports: nothing burned, nothing duplicated


async def test_failed_creations_burn_no_numbers_under_concurrency(committed_engine):
    maker, gid, eid, tid, users = await seed(committed_engine, n_users=1)
    good = [create_as(maker, users[0], gid, eid, tid) for _ in range(10)]
    bad = [create_as(maker, users[0], gid, eid, 99999) for _ in range(10)]  # unknown report type -> rolled back
    results = await asyncio.gather(*good, *bad, return_exceptions=True)
    ok = [r for r in results if isinstance(r, dict)]
    assert len(ok) == 10 and sum(isinstance(r, DomainError) for r in results) == 10
    assert sorted(int(r["report_number"].rsplit("-", 1)[1]) for r in ok) == list(range(1, 11))


async def test_simultaneous_double_submit_of_one_draft_creates_exactly_one_report(committed_engine):
    maker, gid, eid, tid, users = await seed(committed_engine, n_users=1)
    uid, uname, fname = users[0]
    p = Principal(user_id=uid, username=uname, full_name=fname, role_code="USER", role_label_fa="USER",
                  group_ids=frozenset({gid}), must_change_password=False)
    async with maker() as s:
        draft = await report_drafts.create_draft(s, p, DraftPayload(description="x"))
    results = await asyncio.gather(*[create_as(maker, users[0], gid, eid, tid, draft["id"]) for _ in range(8)],
                                   return_exceptions=True)
    assert sum(isinstance(r, dict) for r in results) == 1
    assert all(isinstance(r, DomainError) and r.code == "draft_not_found" for r in results if not isinstance(r, dict))
    async with maker() as s:
        assert (await s.execute(select(func.count()).select_from(m.Report))).scalar_one() == 1
        assert (await s.execute(select(func.count()).select_from(m.ReportDraft))).scalar_one() == 0


async def test_simultaneous_draft_creates_respect_the_limit(committed_engine):
    maker, gid, eid, tid, users = await seed(committed_engine, n_users=1)
    uid, uname, fname = users[0]
    p = Principal(user_id=uid, username=uname, full_name=fname, role_code="USER", role_label_fa="USER",
                  group_ids=frozenset({gid}), must_change_password=False)

    async def one():
        async with maker() as s:
            return await report_drafts.create_draft(s, p, DraftPayload())

    results = await asyncio.gather(*[one() for _ in range(10)], return_exceptions=True)
    assert sum(isinstance(r, dict) for r in results) == 1  # default limit 1
    assert sum(isinstance(r, DomainError) and r.code == "draft_limit_reached" for r in results) == 9


async def test_stale_draft_save_never_overwrites(committed_engine):
    maker, gid, eid, tid, users = await seed(committed_engine, n_users=1)
    uid, uname, fname = users[0]
    p = Principal(user_id=uid, username=uname, full_name=fname, role_code="USER", role_label_fa="USER",
                  group_ids=frozenset({gid}), must_change_password=False)
    async with maker() as s:
        d = await report_drafts.create_draft(s, p, DraftPayload(description="v1"))

    async def save(text_):
        async with maker() as s:
            return await report_drafts.update_draft(s, p, d["id"], DraftPayload(description=text_), 1)

    results = await asyncio.gather(save("tab A"), save("tab B"), return_exceptions=True)
    assert sum(isinstance(r, dict) for r in results) == 1
    assert sum(isinstance(r, DomainError) and r.code == "draft_version_conflict" for r in results) == 1
    async with maker() as s:
        assert (await report_drafts.get_draft(s, p, d["id"]))["version"] == 2


async def test_equipment_move_during_creation_never_mixes_group_and_number(committed_engine):
    """A report's group_id (snapshot) and its number's group code must always agree, even when the equipment
    is moved to another group while reports are being created."""
    maker, gid, eid, tid, users = await seed(committed_engine, n_users=1)
    async with maker() as s:
        other = await h.make_group(s, "OTH", "Other")
        await s.commit()
        other_id = other.id

    async def mover():
        for i in range(10):
            async with maker() as s:
                await s.execute(text("UPDATE equipment SET group_id = :g WHERE id = :e"),
                                {"g": other_id if i % 2 == 0 else gid, "e": eid})
                await s.commit()
            await asyncio.sleep(0)

    async def creator():
        uid, uname, fname = users[0]
        p = Principal(user_id=uid, username=uname, full_name=fname, role_code="MANAGEMENT",
                      role_label_fa="M", group_ids=frozenset(), must_change_password=False)
        out = []
        for _ in range(10):
            async with maker() as s:
                out.append(await report_creation.create_report(s, p, req(eid, tid, uid)))
        return out

    created, _ = await asyncio.gather(creator(), mover())
    async with maker() as s:
        rows = (await s.execute(select(m.Report.report_number, m.Report.group_id, m.Group.code)
                                .join(m.Group, m.Group.id == m.Report.group_id))).all()
    assert len(rows) == 10
    for number, group_id, code in rows:
        assert number.split("-")[1] == code  # number prefix always matches the frozen group snapshot


async def test_participants_constraints_exist_in_migrated_schema(db):
    """Migration (not just the models) carries the labor-integrity rules."""
    group = await h.make_group(db, "MIG", "Mig")
    equip = await h.make_equipment(db, group, "MIG-1")
    user = await h.make_user(db, "mig", "USER")
    rtype = await h.get_report_type(db)
    rep = m.Report(report_number="05-MIG-001", equipment_id=equip.id, group_id=group.id, report_type_id=rtype.id,
                   event_datetime=datetime.now(timezone.utc), report_jalali_year=1405, created_by=user.id,
                   description="d")
    db.add(rep)
    await db.flush()
    for minutes in (0, 1441):
        with pytest.raises(IntegrityError):
            async with db.begin_nested():
                db.add(m.ReportParticipant(report_id=rep.id, user_id=user.id, minutes=minutes))
                await db.flush()
    db.add(m.ReportParticipant(report_id=rep.id, user_id=user.id, minutes=60))
    await db.flush()
    with pytest.raises(IntegrityError):
        async with db.begin_nested():
            db.add(m.ReportParticipant(report_id=rep.id, user_id=user.id, minutes=5))
            await db.flush()


async def test_creation_waits_for_an_in_flight_equipment_move_and_uses_the_new_group(committed_engine):
    """Deterministic version of the race: while a move is uncommitted, creation must block (FOR SHARE) and then
    snapshot the NEW group — never commit a report carrying the group the equipment just left."""
    maker, gid, eid, tid, users = await seed(committed_engine, n_users=1)
    async with maker() as s:
        other = await h.make_group(s, "NEW", "New")
        await s.commit()
        other_id = other.id
    uid, uname, fname = users[0]
    boss = Principal(user_id=uid, username=uname, full_name=fname, role_code="MANAGEMENT", role_label_fa="M",
                     group_ids=frozenset(), must_change_password=False)
    mover = maker()
    await mover.execute(text("UPDATE equipment SET group_id = :g WHERE id = :e"), {"g": other_id, "e": eid})  # open txn
    async def create():
        async with maker() as s:
            return await report_creation.create_report(s, boss, req(eid, tid, uid))
    task = asyncio.create_task(create())
    try:
        await asyncio.sleep(0.7)
        blocked = not task.done()
    finally:
        await mover.commit()  # always release the row lock, even when the assertion below fails
        await mover.close()
    result = await asyncio.wait_for(task, 10)
    assert blocked, "creation must wait for the uncommitted move"
    assert result["group_code"] == "NEW" and "-NEW-" in result["report_number"]


async def test_mixed_general_and_equipment_reports_share_gapless_numbering(committed_engine):
    maker, gid, eid, tid, users = await seed(committed_engine, n_users=1)
    async with maker() as s:
        gen = m.ReportType(code="GEN_PG", name_fa="g", is_failure=False, labor_mode="NONE", equipment_mode="OPTIONAL")
        s.add(gen)
        await s.commit()
        gen_id = gen.id
    uid, uname, fname = users[0]
    p = Principal(user_id=uid, username=uname, full_name=fname, role_code="USER", role_label_fa="USER",
                  group_ids=frozenset({gid}), must_change_password=False)

    async def general():
        async with maker() as s:
            return await report_creation.create_report(s, p, ReportCreate(
                group_id=gid, report_type_id=gen_id, event_datetime=datetime.now(timezone.utc) - timedelta(hours=1),
                description="general", participants=[]))

    results = await asyncio.gather(*[general() if i % 2 else create_as(maker, users[0], gid, eid, tid)
                                     for i in range(30)])
    assert sorted(int(r["report_number"].rsplit("-", 1)[1]) for r in results) == list(range(1, 31))
    assert sum(r["is_general"] for r in results) == 15 and sum(r["equipment_id"] is None for r in results) == 15


async def test_group_deactivation_vs_general_report_creation(committed_engine):
    """A general report takes FOR SHARE on its group: it either commits before a deactivation or sees it inactive."""
    maker, gid, eid, tid, users = await seed(committed_engine, n_users=1)
    async with maker() as s:
        gen = m.ReportType(code="GEN_PG2", name_fa="g", is_failure=False, labor_mode="NONE", equipment_mode="OPTIONAL")
        s.add(gen)
        await s.commit()
        gen_id = gen.id
    uid, uname, fname = users[0]
    boss = Principal(user_id=uid, username=uname, full_name=fname, role_code="MANAGEMENT", role_label_fa="M",
                     group_ids=frozenset(), must_change_password=False)
    locker = maker()
    await locker.execute(text("UPDATE groups SET is_active = false WHERE id = :g"), {"g": gid})  # uncommitted

    async def create():
        async with maker() as s:
            return await report_creation.create_report(s, boss, ReportCreate(
                group_id=gid, report_type_id=gen_id, event_datetime=datetime.now(timezone.utc) - timedelta(hours=1),
                description="x", participants=[]))

    task = asyncio.create_task(create())
    try:
        await asyncio.sleep(0.7)
        blocked = not task.done()
    finally:
        await locker.commit()
        await locker.close()
    result = await asyncio.gather(task, return_exceptions=True)
    assert blocked, "creation must wait for the uncommitted group deactivation"
    assert isinstance(result[0], DomainError) and result[0].code == "group_inactive"


async def test_parallel_submissions_with_one_key_create_exactly_one_report(committed_engine):
    maker, gid, eid, tid, users = await seed(committed_engine, n_users=1)
    uid, uname, fname = users[0]
    p = Principal(user_id=uid, username=uname, full_name=fname, role_code="USER", role_label_fa="USER",
                  group_ids=frozenset({gid}), must_change_password=False)

    async def attempt():
        async with maker() as s:
            body = req(eid, tid, uid)
            body.client_request_id = "parallel-key-0001"
            return await report_creation.create_report(s, p, body)

    results = await asyncio.gather(*[attempt() for _ in range(10)])
    assert len({r["id"] for r in results}) == 1 and len({r["report_number"] for r in results}) == 1
    assert sum(1 for r in results if not r["already_created"]) == 1  # exactly one real creation, nine echoes
    async with maker() as s:
        assert (await s.execute(select(func.count()).select_from(m.Report))).scalar_one() == 1
        assert (await s.execute(select(func.sum(m.ReportParticipant.minutes)))).scalar_one() == 15  # hours never doubled
        assert (await s.execute(select(m.ReportSequence.last_number))).scalar_one() == 1  # losers burned no number


async def test_parallel_submissions_with_one_key_AND_one_draft_all_get_the_report_never_draft_not_found(committed_engine):
    """The losers wait on the draft row lock, the winner consumes the draft and commits: for them the draft is gone, but this
    is a retry of a successful submission (same key), so they must receive the report, not a 404."""
    maker, gid, eid, tid, users = await seed(committed_engine, n_users=1)
    uid, uname, fname = users[0]
    p = Principal(user_id=uid, username=uname, full_name=fname, role_code="USER", role_label_fa="USER",
                  group_ids=frozenset({gid}), must_change_password=False)
    async with maker() as s:
        draft = await report_drafts.create_draft(s, p, DraftPayload(description="x"))

    async def attempt():
        async with maker() as s:
            body = req(eid, tid, uid, draft_id=draft["id"])
            body.client_request_id = "race-key-and-draft-01"
            return await report_creation.create_report(s, p, body)

    results = await asyncio.gather(*[attempt() for _ in range(8)], return_exceptions=True)
    assert all(isinstance(r, dict) for r in results), [r for r in results if not isinstance(r, dict)]
    assert len({r["id"] for r in results}) == 1 and sum(1 for r in results if not r["already_created"]) == 1
    async with maker() as s:
        assert (await s.execute(select(func.count()).select_from(m.Report))).scalar_one() == 1
        assert (await s.execute(select(func.count()).select_from(m.ReportDraft))).scalar_one() == 0

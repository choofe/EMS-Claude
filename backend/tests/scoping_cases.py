"""
Authorization-boundary tests, written once and run on BOTH engines
(tests/test_scoping.py -> SQLite, tests/postgres/test_scoping_pg.py -> real
PostgreSQL). They cover the explicit Phase 3 requirements:

  USER cannot access unauthorized group.
  USER cannot access another user's labor analytics.
  EXPERT cannot access another group's reports.
  EXPERT can access authorized group reports.
  MANAGEMENT can access everything.
"""
import pytest
from sqlalchemy import func, select

import app.models as m
from app.core.permissions import Capability as C
from app.core.scoping import apply_equipment_scope, apply_participant_scope, apply_report_scope
from app.services.auth_service import load_principal
from tests import factories as f


async def build_world(db):
    """
    Groups ELV, DOOR. Equipment: ELV-1, ELV-2 (ELV), DOOR-1 (DOOR).
    Users: ali(USER elv), saeed(USER elv), omid(USER door), exp_elv(EXPERT elv),
           exp_both(EXPERT elv+door), boss(MANAGEMENT), aud(AUDITOR), loner(USER no groups).
    Reports:
      R1 ELV created by ali    participants ali 60, saeed 120
      R2 ELV created by saeed  participants ali 30, saeed 45
      R3 DOOR created by omid  participants omid 90
    Plus MOVED equipment: ELV-3 reports snapshot ELV (R4 by ali, 15 min ali); then ELV-3 moves to DOOR.
    """
    elv, door = await f.group(db, "ELV"), await f.group(db, "DOOR")
    e1, e2, d1 = await f.equipment(db, "ELV-1", elv), await f.equipment(db, "ELV-2", elv), await f.equipment(db, "DOOR-1", door)
    e3 = await f.equipment(db, "ELV-3", elv)

    ali = await f.user(db, "ali", "USER", [elv])
    saeed = await f.user(db, "saeed", "USER", [elv])
    omid = await f.user(db, "omid", "USER", [door])
    exp_elv = await f.user(db, "exp_elv", "EXPERT", [elv])
    exp_both = await f.user(db, "exp_both", "EXPERT", [elv, door])
    boss = await f.user(db, "boss", "MANAGEMENT")
    aud = await f.user(db, "aud", "AUDITOR")
    loner = await f.user(db, "loner", "USER")

    r1 = await f.report(db, "05-ELV-001", e1, elv, ali, [(ali, 60), (saeed, 120)])
    r2 = await f.report(db, "05-ELV-002", e2, elv, saeed, [(ali, 30), (saeed, 45)])
    r3 = await f.report(db, "05-DOOR-001", d1, door, omid, [(omid, 90)])
    r4 = await f.report(db, "05-ELV-003", e3, elv, ali, [(ali, 15)])
    e3.group_id = door.id  # equipment moves AFTER r4 was filed under ELV
    await db.flush()
    await db.commit()

    names = dict(ali=ali, saeed=saeed, omid=omid, exp_elv=exp_elv, exp_both=exp_both, boss=boss, aud=aud, loner=loner)
    principals = {k: await load_principal(db, u.id) for k, u in names.items()}
    return principals, dict(r1=r1, r2=r2, r3=r3, r4=r4), dict(e1=e1, e2=e2, e3=e3, d1=d1)


async def _numbers(db, principal, cap):
    stmt = apply_report_scope(select(m.Report.report_number), principal, cap)
    return set((await db.execute(stmt)).scalars())


async def test_user_sees_group_reports_but_not_other_groups(db):
    p, *_ = await build_world(db)
    assert await _numbers(db, p["ali"], C.REPORT_VIEW) == {"05-ELV-001", "05-ELV-002", "05-ELV-003"}
    assert "05-DOOR-001" not in await _numbers(db, p["ali"], C.REPORT_VIEW)  # unauthorized group
    assert await _numbers(db, p["omid"], C.REPORT_VIEW) == {"05-DOOR-001"}


async def test_user_analytics_are_own_reports_only(db):
    p, *_ = await build_world(db)
    assert await _numbers(db, p["ali"], C.REPORT_ANALYTICS) == {"05-ELV-001", "05-ELV-003"}
    assert await _numbers(db, p["saeed"], C.REPORT_ANALYTICS) == {"05-ELV-002"}
    assert await _numbers(db, p["ali"], C.REPORT_EXPORT) == {"05-ELV-001", "05-ELV-003"}


async def _hours_by_user(db, principal):
    stmt = apply_participant_scope(
        select(m.ReportParticipant.user_id, func.sum(m.ReportParticipant.minutes)).group_by(m.ReportParticipant.user_id),
        principal,
    )
    return {uid: total for uid, total in (await db.execute(stmt)).all()}


async def test_user_cannot_see_labor_logged_on_colleagues_reports(db):
    """Phase 0 #4: Ali sees participant rows ONLY of reports Ali created (R1, R4) — including
    Saeed's 120 min on R1, but NOT Ali's own 30 min that sits on Saeed's R2, and nothing of Saeed's R2."""
    p, *_ = await build_world(db)
    ali, saeed = p["ali"].user_id, p["saeed"].user_id
    assert await _hours_by_user(db, p["ali"]) == {ali: 60 + 15, saeed: 120}
    # Saeed's view is the mirror image: only R2.
    assert await _hours_by_user(db, p["saeed"]) == {ali: 30, saeed: 45}


async def test_user_in_no_group_sees_nothing(db):
    p, *_ = await build_world(db)
    assert await _numbers(db, p["loner"], C.REPORT_VIEW) == set()
    eq = (await db.execute(apply_equipment_scope(select(m.Equipment.equipment_code), p["loner"]))).scalars().all()
    assert eq == []
    assert await _hours_by_user(db, p["loner"]) == {}


async def test_expert_cannot_access_another_groups_reports(db):
    p, *_ = await build_world(db)
    assert "05-DOOR-001" not in await _numbers(db, p["exp_elv"], C.REPORT_VIEW)
    assert "05-DOOR-001" not in await _numbers(db, p["exp_elv"], C.REPORT_ANALYTICS)
    assert "05-DOOR-001" not in await _numbers(db, p["exp_elv"], C.REPORT_EXPORT)
    assert 90 not in (await _hours_by_user(db, p["exp_elv"])).values()  # DOOR labor invisible too


async def test_expert_can_access_authorized_group_reports_and_all_labor(db):
    p, *_ = await build_world(db)
    elv_all = {"05-ELV-001", "05-ELV-002", "05-ELV-003"}
    for cap in (C.REPORT_VIEW, C.REPORT_ANALYTICS, C.REPORT_EXPORT, C.REPORT_EDIT):
        assert await _numbers(db, p["exp_elv"], cap) == elv_all
    hours = await _hours_by_user(db, p["exp_elv"])
    assert hours == {p["ali"].user_id: 60 + 30 + 15, p["saeed"].user_id: 120 + 45}  # a person's total across creators
    assert await _numbers(db, p["exp_both"], C.REPORT_VIEW) == elv_all | {"05-DOOR-001"}


async def test_management_and_auditor_access_everything(db):
    p, *_ = await build_world(db)
    everything = {"05-ELV-001", "05-ELV-002", "05-ELV-003", "05-DOOR-001"}
    for who in ("boss", "aud"):
        for cap in (C.REPORT_VIEW, C.REPORT_ANALYTICS, C.REPORT_EXPORT, C.LABOR_VIEW):
            assert await _numbers(db, p[who], cap) == everything
        assert sum((await _hours_by_user(db, p[who])).values()) == 60 + 120 + 30 + 45 + 90 + 15
    assert await _numbers(db, p["boss"], C.REPORT_EDIT) == everything
    assert await _numbers(db, p["aud"], C.REPORT_EDIT) == set()  # AUDITOR can read, never edit


async def test_group_scope_follows_report_snapshot_not_current_equipment_group(db):
    """ELV-3 moved to DOOR after R4 was filed under ELV: the DOOR expert must NOT see R4
    (filter is reports.group_id), the ELV expert still does."""
    p, reports, equip = await build_world(db)
    assert equip["e3"].group_id != reports["r4"].group_id
    assert "05-ELV-003" in await _numbers(db, p["exp_elv"], C.REPORT_VIEW)
    door_only = await f.user(db, "door_expert", "EXPERT", [(await db.get(m.Group, equip["d1"].group_id))])
    await db.commit()
    dp = await load_principal(db, door_only.id)
    assert await _numbers(db, dp, C.REPORT_VIEW) == {"05-DOOR-001"}
    # ...while equipment listing uses the CURRENT group, so the moved unit is now in DOOR's list.
    codes = set((await db.execute(apply_equipment_scope(select(m.Equipment.equipment_code), dp))).scalars())
    assert codes == {"DOOR-1", "ELV-3"}


async def test_equipment_scope(db):
    p, *_ = await build_world(db)
    async def codes(who):
        return set((await db.execute(apply_equipment_scope(select(m.Equipment.equipment_code), p[who]))).scalars())
    assert await codes("ali") == {"ELV-1", "ELV-2"}
    assert await codes("exp_both") == {"ELV-1", "ELV-2", "DOOR-1", "ELV-3"}
    assert await codes("boss") == await codes("aud") == {"ELV-1", "ELV-2", "ELV-3", "DOOR-1"}


async def test_deactivated_user_has_no_principal(db):
    p, *_ = await build_world(db)
    user = await db.get(m.User, p["ali"].user_id)
    user.is_active = False
    await db.commit()
    assert await load_principal(db, user.id) is None


async def test_role_change_takes_effect_immediately(db):
    p, *_ = await build_world(db)
    user = await db.get(m.User, p["ali"].user_id)
    user.role_id = (await f.role(db, "EXPERT")).id
    await db.commit()
    fresh = await load_principal(db, user.id)
    assert fresh.role_code == "EXPERT"
    assert await _numbers(db, fresh, C.REPORT_ANALYTICS) == {"05-ELV-001", "05-ELV-002", "05-ELV-003"}


async def test_report_scope_works_on_an_aliased_entity(db):
    """Fragile-API fix: pass the alias so the filter attaches to the aliased rows, not a stray FROM."""
    from sqlalchemy.orm import aliased
    p, *_ = await build_world(db)
    r = aliased(m.Report)
    stmt = apply_report_scope(select(r.report_number), p["ali"], C.REPORT_VIEW, entity=r)
    assert set((await db.execute(stmt)).scalars()) == {"05-ELV-001", "05-ELV-002", "05-ELV-003"}
    sql = str(stmt)
    assert sql.count("reports") == 2 or "FROM reports AS" in sql  # single aliased FROM, no cross join
    assert "05-DOOR-001" not in set((await db.execute(stmt)).scalars())

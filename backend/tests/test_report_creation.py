"""Phase 6 — report creation, drafts, participant rules (SQLite, through the real routers + real login)."""
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import func, select

import app.models as m
from app.core.jalali import jalali_year, report_year_prefix
from tests import factories as f

pytestmark = pytest.mark.asyncio

NOW = lambda: datetime.now(timezone.utc)  # noqa: E731


def body(world, rtype, participants=None, **over):
    data = {
        "equipment_id": world.e1.id, "report_type_id": rtype.id,
        "event_datetime": (NOW() - timedelta(hours=1)).isoformat(),
        "description": "تعویض بلبرینگ", "participants": [{"user_id": world.ali.id, "minutes": 90}] if participants is None else participants,
    }
    data.update(over)
    return data




@pytest_asyncio.fixture
async def rtype(db, world):
    rt = await f.report_type(db)
    await db.commit()
    return rt


async def set_setting(db, key, value):
    db.add(m.SystemSetting(key=key, value=str(value)))
    await db.commit()


async def count(db, model):
    return (await db.execute(select(func.count()).select_from(model))).scalar_one()


# ------------------------------------------------------------------ happy path & numbering
async def test_create_report_and_sequential_numbers(api, db, world, rtype):
    prefix = report_year_prefix(jalali_year(NOW()))
    r1 = await api.post("/reports", "ali", json=body(world, rtype))
    r2 = await api.post("/reports", "ali", json=body(world, rtype))
    assert r1.status_code == r2.status_code == 201, r1.text
    assert r1.json()["report_number"] == f"{prefix}-ELV-001"
    assert r2.json()["report_number"] == f"{prefix}-ELV-002"
    rep = (await db.execute(select(m.Report).where(m.Report.id == r1.json()["id"]))).scalar_one()
    assert rep.group_id == world.elv.id and rep.created_by == world.ali.id
    assert rep.report_jalali_year == jalali_year(NOW())
    parts = (await db.execute(select(m.ReportParticipant).where(m.ReportParticipant.report_id == rep.id))).scalars().all()
    assert [(p.user_id, p.minutes) for p in parts] == [(world.ali.id, 90)]


async def test_numbers_are_per_group(api, db, world, rtype):
    await api.post("/reports", "ali", json=body(world, rtype))
    r = await api.post("/reports", "omid", json=body(world, rtype, equipment_id=world.d1.id,
                                                      participants=[{"user_id": world.omid.id, "minutes": 30}]))
    assert r.json()["report_number"].endswith("-DOOR-001")


async def test_group_id_is_snapshot_of_equipment_group_at_creation(api, db, world, rtype):
    r1 = await api.post("/reports", "boss", json=body(world, rtype, participants=[{"user_id": world.ali.id, "minutes": 5}]))
    eq = (await db.execute(select(m.Equipment).where(m.Equipment.id == world.e1.id))).scalar_one()
    eq.group_id = world.door.id
    await db.commit()
    r2 = await api.post("/reports", "boss", json=body(world, rtype, participants=[{"user_id": world.ali.id, "minutes": 5}]))
    assert r1.json()["group_code"] == "ELV" and r2.json()["group_code"] == "DOOR"
    first = (await db.execute(select(m.Report).where(m.Report.id == r1.json()["id"]))).scalar_one()
    assert first.group_id == world.elv.id  # earlier report untouched by the move


async def test_audit_row_written_without_text_or_participant_ids(api, db, world, rtype):
    r = await api.post("/reports", "ali", json=body(world, rtype, participants=[
        {"user_id": world.ali.id, "minutes": 60}, {"user_id": world.exp.id, "minutes": 30}]))
    log = (await db.execute(select(m.AuditLog).where(m.AuditLog.action == "report.create"))).scalar_one()
    assert log.entity_id == r.json()["id"] and log.actor_id == world.ali.id
    meta = log.metadata_json
    assert meta["participant_count"] == 2 and meta["total_minutes"] == 90 and meta["from_draft"] is False
    assert "description" not in meta and "participants" not in meta


# ------------------------------------------------------------------ authorization
async def test_unauthenticated_is_401(api, world, rtype):
    assert (await api.post("/reports", json=body(world, rtype))).status_code == 401


async def test_auditor_cannot_create(api, world, rtype):
    assert (await api.post("/reports", "aud", json=body(world, rtype))).status_code == 403


async def test_user_cannot_use_other_groups_equipment_and_gets_404(api, db, world, rtype):
    r = await api.post("/reports", "ali", json=body(world, rtype, equipment_id=world.d1.id))
    assert r.status_code == 404 and r.json()["detail"] == "equipment_not_found"
    assert await count(db, m.Report) == 0 and await count(db, m.ReportSequence) == 0
    missing = await api.post("/reports", "ali", json=body(world, rtype, equipment_id=99999))
    assert missing.json() == r.json()  # identical answer: no existence oracle


async def test_expert_scoped_to_own_groups_management_everywhere(api, world, rtype):
    other = body(world, rtype, equipment_id=world.d1.id, participants=[{"user_id": world.omid.id, "minutes": 10}])
    assert (await api.post("/reports", "exp", json=other)).status_code == 404
    assert (await api.post("/reports", "boss", json=other)).status_code == 201


async def test_inactive_equipment_and_type(api, db, world, rtype):
    eq = (await db.execute(select(m.Equipment).where(m.Equipment.id == world.e1.id))).scalar_one()
    eq.is_active = False
    await db.commit()
    r = await api.post("/reports", "boss", json=body(world, rtype))
    assert r.status_code == 409 and r.json()["detail"] == "equipment_inactive"
    eq.is_active = True
    rtype_row = (await db.execute(select(m.ReportType).where(m.ReportType.id == rtype.id))).scalar_one()
    rtype_row.is_active = False
    await db.commit()
    r = await api.post("/reports", "ali", json=body(world, rtype))
    assert r.status_code == 409 and r.json()["detail"] == "report_type_inactive"
    assert (await api.post("/reports", "ali", json=body(world, rtype, report_type_id=99999))).status_code == 404


# ------------------------------------------------------------------ validation
@pytest.mark.parametrize("minutes", [0, -5, 1441])
async def test_minutes_bounds(api, world, rtype, minutes):
    r = await api.post("/reports", "ali", json=body(world, rtype, participants=[{"user_id": world.ali.id, "minutes": minutes}]))
    assert r.status_code == 422


async def test_participants_required_and_no_duplicates(api, world, rtype):
    assert (await api.post("/reports", "ali", json=body(world, rtype, participants=[]))).status_code == 422
    dup = [{"user_id": world.ali.id, "minutes": 10}, {"user_id": world.ali.id, "minutes": 20}]
    r = await api.post("/reports", "ali", json=body(world, rtype, participants=dup))
    assert r.status_code == 422 and r.json()["detail"] == "participant_duplicate"


async def test_user_participants_limited_to_report_group_members(api, db, world, rtype):
    r = await api.post("/reports", "ali", json=body(world, rtype, participants=[{"user_id": world.omid.id, "minutes": 10}]))
    assert r.status_code == 422 and r.json()["detail"]["user_ids"] == [world.omid.id]
    await f.user(db, "gone", "USER", [world.elv], active=False)
    gone = (await db.execute(select(m.User).where(m.User.username == "gone"))).scalar_one()
    await db.commit()
    r = await api.post("/reports", "ali", json=body(world, rtype, participants=[{"user_id": gone.id, "minutes": 10}]))
    assert r.status_code == 422  # inactive users can never be listed
    r = await api.post("/reports", "ali", json=body(world, rtype, participants=[{"user_id": 424242, "minutes": 10}]))
    assert r.status_code == 422


async def test_expert_participant_scope_is_a_setting(api, db, world, rtype):
    outsider = [{"user_id": world.omid.id, "minutes": 10}]
    assert (await api.post("/reports", "exp", json=body(world, rtype, participants=outsider))).status_code == 201  # default: all users
    await set_setting(db, "REPORT_EXPERT_PARTICIPANTS_ALL_USERS", 0)
    r = await api.post("/reports", "exp", json=body(world, rtype, participants=outsider))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "participant_not_allowed"
    # MANAGEMENT is never restricted by the setting
    assert (await api.post("/reports", "boss", json=body(world, rtype, participants=outsider))).status_code == 201


async def test_event_time_rules(api, world, rtype):
    soon = (NOW() + timedelta(minutes=4)).isoformat()
    assert (await api.post("/reports", "ali", json=body(world, rtype, event_datetime=soon))).status_code == 201
    later = (NOW() + timedelta(minutes=10)).isoformat()
    r = await api.post("/reports", "ali", json=body(world, rtype, event_datetime=later))
    assert r.status_code == 422 and r.json()["detail"] == "event_in_future"
    naive = (NOW() - timedelta(hours=1)).replace(tzinfo=None).isoformat()
    assert (await api.post("/reports", "ali", json=body(world, rtype, event_datetime=naive))).status_code == 422
    tehran = (NOW() - timedelta(hours=2)).astimezone(timezone(timedelta(hours=3, minutes=30))).isoformat()
    assert (await api.post("/reports", "ali", json=body(world, rtype, event_datetime=tehran))).status_code == 201


async def test_description_rules(api, world, rtype):
    for bad in ("", "   \n  ", "x" * 5001):
        r = await api.post("/reports", "ali", json=body(world, rtype, description=bad))
        assert r.status_code == 422, bad[:10]
    ok = await api.post("/reports", "ali", json=body(world, rtype, description="  خط اول \r\nخط دوم  "))
    assert ok.json()["description"] == "خط اول\nخط دوم"


async def test_unknown_fields_rejected_creator_not_settable(api, world, rtype):
    r = await api.post("/reports", "ali", json=body(world, rtype, created_by=world.boss.id))
    assert r.status_code == 422
    r = await api.post("/reports", "ali", json=body(world, rtype, group_id=world.door.id))
    assert r.status_code == 422


# ------------------------------------------------------------------ drafts
DRAFT = {"payload": {"description": "نیمه‌کاره", "participants": [{"user_id": None, "minutes": 0}]}}


async def test_draft_lifecycle_and_limit(api, db, world):
    d = await api.post("/reports/drafts", "ali", json=DRAFT)
    assert d.status_code == 201 and d.json()["version"] == 1
    second = await api.post("/reports/drafts", "ali", json=DRAFT)
    assert second.status_code == 409 and second.json()["detail"] == {"code": "draft_limit_reached", "limit": 1}
    did = d.json()["id"]
    up = await api.put(f"/reports/drafts/{did}", "ali", json={"payload": {"description": "v2"}, "version": 1})
    assert up.status_code == 200 and up.json()["version"] == 2 and up.json()["payload"]["description"] == "v2"
    stale = await api.put(f"/reports/drafts/{did}", "ali", json={"payload": {"description": "old tab"}, "version": 1})
    assert stale.status_code == 409 and stale.json()["detail"] == {"code": "draft_version_conflict", "current_version": 2}
    assert (await api.get(f"/reports/drafts/{did}", "ali")).json()["payload"]["description"] == "v2"
    assert (await api.call("DELETE", f"/reports/drafts/{did}", "ali")).status_code == 204
    assert (await api.get("/reports/drafts", "ali")).json() == []


async def test_draft_limit_is_a_setting(api, db, world):
    await set_setting(db, "MAX_DRAFTS_PER_USER", 2)
    assert (await api.post("/reports/drafts", "ali", json=DRAFT)).status_code == 201
    assert (await api.post("/reports/drafts", "ali", json=DRAFT)).status_code == 201
    assert (await api.post("/reports/drafts", "ali", json=DRAFT)).status_code == 409
    assert (await api.post("/reports/drafts", "exp", json=DRAFT)).status_code == 201  # limit is per user


async def test_drafts_are_private(api, world):
    did = (await api.post("/reports/drafts", "ali", json=DRAFT)).json()["id"]
    for who in ("exp", "boss", "omid"):
        assert (await api.get(f"/reports/drafts/{did}", who)).status_code == 404, who
        assert (await api.put(f"/reports/drafts/{did}", who, json={"payload": {}, "version": 1})).status_code == 404
        assert (await api.call("DELETE", f"/reports/drafts/{did}", who)).status_code == 404
        assert (await api.get("/reports/drafts", who)).json() == []
    assert (await api.get("/reports/drafts", "aud")).status_code == 403
    assert (await api.get(f"/reports/drafts/{did}", "ali")).status_code == 200  # still there


async def test_submit_from_draft_consumes_it_and_double_submit_is_rejected(api, db, world, rtype):
    did = (await api.post("/reports/drafts", "ali", json=DRAFT)).json()["id"]
    ok = await api.post("/reports", "ali", json=body(world, rtype, draft_id=did))
    assert ok.status_code == 201
    again = await api.post("/reports", "ali", json=body(world, rtype, draft_id=did))
    assert again.status_code == 404 and again.json()["detail"] == "draft_not_found"
    assert await count(db, m.Report) == 1 and await count(db, m.ReportDraft) == 0
    log = (await db.execute(select(m.AuditLog).where(m.AuditLog.action == "report.create"))).scalar_one()
    assert log.metadata_json["from_draft"] is True


async def test_failed_submit_keeps_draft_and_burns_no_number(api, db, world, rtype):
    did = (await api.post("/reports/drafts", "ali", json=DRAFT)).json()["id"]
    bad = await api.post("/reports", "ali", json=body(world, rtype, equipment_id=world.d1.id, draft_id=did))
    assert bad.status_code == 404
    assert await count(db, m.ReportDraft) == 1
    ok = await api.post("/reports", "ali", json=body(world, rtype, draft_id=did))
    assert ok.json()["report_number"].endswith("-ELV-001")  # failed attempt consumed no number


async def test_someone_elses_draft_id_cannot_be_used(api, db, world, rtype):
    did = (await api.post("/reports/drafts", "exp", json=DRAFT)).json()["id"]
    r = await api.post("/reports", "ali", json=body(world, rtype, draft_id=did))
    assert r.status_code == 404
    assert await count(db, m.ReportDraft) == 1 and await count(db, m.Report) == 0


# ------------------------------------------------------------------ helpers for the form
async def test_participant_candidates_follow_same_rules(api, db, world):
    names = lambda r: sorted(x["full_name"] for x in r.json())  # noqa: E731
    r = await api.get(f"/reports/participant-candidates?equipment_id={world.e1.id}", "ali")
    assert names(r) == ["Ali", "Exp"]  # members of ELV only; no Omid, no managers
    assert set(r.json()[0]) == {"id", "full_name"}  # nothing else about people is exposed
    r = await api.get(f"/reports/participant-candidates?equipment_id={world.e1.id}&q=ex", "ali")
    assert names(r) == ["Exp"]
    assert (await api.get(f"/reports/participant-candidates?equipment_id={world.d1.id}", "ali")).status_code == 404
    everyone = await api.get(f"/reports/participant-candidates?equipment_id={world.e1.id}", "exp")
    assert "Omid" in names(everyone) and "Boss" in names(everyone)
    await set_setting(db, "REPORT_EXPERT_PARTICIPANTS_ALL_USERS", 0)
    assert names(await api.get(f"/reports/participant-candidates?equipment_id={world.e1.id}", "exp")) == ["Ali", "Exp"]


async def test_quick_pick_is_own_reports_only(api, db, world, rtype):
    e2 = await f.equipment(db, "ELV-2", world.elv)
    await db.commit()
    for eid in (world.e1.id, e2.id, e2.id):
        await api.post("/reports", "ali", json=body(world, rtype, equipment_id=eid))
    await api.post("/reports", "exp", json=body(world, rtype, equipment_id=world.e1.id))
    r = (await api.get("/reports/equipment-quick-pick", "ali")).json()
    assert [e["equipment_code"] for e in r["frequent"]] == ["ELV-2", "ELV-1"]
    assert r["recent"][0]["equipment_code"] == "ELV-2"
    assert (await api.get("/reports/equipment-quick-pick", "omid")).json() == {"recent": [], "frequent": []}
    eq = (await db.execute(select(m.Equipment).where(m.Equipment.id == e2.id))).scalar_one()
    eq.is_active = False
    await db.commit()
    assert [e["equipment_code"] for e in (await api.get("/reports/equipment-quick-pick", "ali")).json()["recent"]] == ["ELV-1"]


async def test_heartbeat(api, world):
    assert (await api.post("/reports/heartbeat")).status_code == 401
    r = await api.post("/reports/heartbeat", "aud")
    assert r.status_code == 200 and r.json()["ok"] is True


# ------------------------------------------------------------------ DB-level labor integrity
async def test_db_rejects_duplicate_labor_row_and_bad_minutes(db, world):
    from sqlalchemy.exc import IntegrityError
    ali_id, omid_id = world.ali.id, world.omid.id
    rep = await f.report(db, "05-ELV-900", world.e1, world.elv, world.ali, [(world.ali, 60)])
    rep_id = rep.id
    await db.commit()
    for uid, minutes in ((ali_id, 5), (omid_id, 0), (omid_id, 1441)):  # duplicate pair, then out-of-range minutes
        db.add(m.ReportParticipant(report_id=rep_id, user_id=uid, minutes=minutes))
        with pytest.raises(IntegrityError):
            await db.flush()
        await db.rollback()

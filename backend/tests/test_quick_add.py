"""Phase 6c — quick-add people (participant-suggestions). Own-created reports only; same eligibility rule as the candidate list."""
from datetime import datetime, timedelta, timezone

import pytest

import app.models as m
from tests import factories as f

pytestmark = pytest.mark.asyncio
NOW = lambda: datetime.now(timezone.utc)  # noqa: E731
_n = 0


async def mk(db, world, creator, people, days_ago=1, grp=None, active=True, minutes=30):
    """An own-created report `days_ago` days old with participants `people` (users)."""
    global _n
    _n += 1
    rt = await f.report_type(db)
    r = m.Report(report_number=f"26-ELV-{_n:03d}", equipment_id=world.e1.id, group_id=(grp or world.elv).id,
                 report_type_id=rt.id, event_datetime=NOW() - timedelta(days=days_ago), report_jalali_year=1405,
                 created_by=creator.id, description="t", is_active=active, created_at=NOW() - timedelta(days=days_ago))
    db.add(r)
    await db.flush()
    for u in people:
        db.add(m.ReportParticipant(report_id=r.id, user_id=u.id, minutes=minutes))
    await db.commit()
    return r


def url(world, **q):
    return "/reports/participant-suggestions?" + ("equipment_id=%d" % world.e1.id if not q else "&".join(f"{k}={v}" for k, v in q.items()))


def ids(rows):
    return [x["id"] for x in rows]


@pytest.fixture
async def crew(db, world):
    c = [await f.user(db, f"c{i}", "USER", [world.elv]) for i in range(7)]
    await db.commit()
    return c


async def test_previous_is_people_of_last_own_report_even_if_old(api, db, world, crew):
    await mk(db, world, world.ali, [crew[0]], days_ago=90)
    await mk(db, world, world.ali, [crew[1], world.ali], days_ago=60)
    r = await api.get(url(world), "ali")
    assert r.status_code == 200
    assert ids(r.json()["previous"]) == [crew[1].id]  # the latest report only; the author is never suggested
    assert set(r.json()["previous"][0]) == {"id", "full_name"}  # no minutes, nothing else


async def test_reports_where_caller_was_only_a_participant_are_never_used(api, db, world, crew):
    await mk(db, world, world.exp, [world.ali, crew[0]], days_ago=1)
    await mk(db, world, world.exp, [world.ali, crew[0]], days_ago=2)
    r = await api.get(url(world), "ali")
    assert r.json() == {"previous": [], "frequent": []}


async def test_other_users_reports_do_not_leak(api, db, world, crew):
    await mk(db, world, world.exp, [crew[0], crew[1]], days_ago=1)
    await mk(db, world, world.ali, [crew[2]], days_ago=3)
    r = await api.get(url(world), "ali")
    assert ids(r.json()["previous"]) == [crew[2].id]


async def test_soft_deleted_reports_are_ignored(api, db, world, crew):
    await mk(db, world, world.ali, [crew[0]], days_ago=2)
    await mk(db, world, world.ali, [crew[1]], days_ago=1, active=False)
    assert ids((await api.get(url(world), "ali")).json()["previous"]) == [crew[0].id]


async def test_frequent_needs_two_reports_in_30_days(api, db, world, crew):
    await mk(db, world, world.ali, [crew[0], crew[1]], days_ago=2)
    await mk(db, world, world.ali, [crew[0]], days_ago=10)
    await mk(db, world, world.ali, [crew[1]], days_ago=40)  # outside the window: does not count
    await mk(db, world, world.ali, [crew[2]], days_ago=1)   # previous report
    j = (await api.get(url(world), "ali")).json()
    assert ids(j["previous"]) == [crew[2].id]
    assert ids(j["frequent"]) == [crew[0].id]  # crew[1] has only ONE report in the window


async def test_frequent_is_capped_at_five_ordered_and_skips_previous(api, db, world, crew):
    for _ in range(3):
        await mk(db, world, world.ali, [crew[0]], days_ago=5)
    for i in range(1, 7):
        await mk(db, world, world.ali, [crew[i]], days_ago=4)
        await mk(db, world, world.ali, [crew[i]], days_ago=6)
    await mk(db, world, world.ali, [crew[6]], days_ago=0)  # previous = crew[6]
    j = (await api.get(url(world), "ali")).json()
    assert ids(j["previous"]) == [crew[6].id]
    assert len(j["frequent"]) == 5 and j["frequent"][0]["id"] == crew[0].id  # most reports first
    assert crew[6].id not in ids(j["frequent"])


async def test_suggestions_are_revalidated_for_the_forms_group(api, db, world, crew):
    far = await f.user(db, "far", "USER", [world.door])
    await db.commit()
    await mk(db, world, world.ali, [crew[0], far], days_ago=1)
    j = (await api.get(url(world), "ali")).json()
    assert ids(j["previous"]) == [crew[0].id]  # DOOR member is not eligible in ELV for a USER (default setting)
    db.add(m.SystemSetting(key="REPORT_USER_PARTICIPANTS_ALL_USERS", value="1"))
    await db.commit()
    assert set(ids((await api.get(url(world), "ali")).json()["previous"])) == {crew[0].id, far.id}


async def test_inactive_people_are_not_suggested(api, db, world, crew):
    await mk(db, world, world.ali, [crew[0], crew[1]], days_ago=1)
    crew[1].is_active = False
    await db.commit()
    assert ids((await api.get(url(world), "ali")).json()["previous"]) == [crew[0].id]


async def test_scope_and_params_and_roles(api, db, world):
    assert (await api.get(f"/reports/participant-suggestions?equipment_id={world.d1.id}", "ali")).status_code == 404
    assert (await api.get("/reports/participant-suggestions", "ali")).status_code == 422
    assert (await api.get(f"/reports/participant-suggestions?equipment_id={world.e1.id}&group_id={world.elv.id}", "ali")).status_code == 422
    assert (await api.get(url(world), "aud")).status_code == 403
    r = await api.get(f"/reports/participant-suggestions?group_id={world.elv.id}", "ali")
    assert r.status_code == 200
    assert (await api.get(f"/reports/participant-suggestions?group_id={world.door.id}", "ali")).status_code == 404


async def test_expert_and_management_follow_their_own_eligibility(api, db, world, crew):
    far = await f.user(db, "far", "USER", [world.door])
    await db.commit()
    await mk(db, world, world.exp, [crew[0], far], days_ago=1)
    assert set(ids((await api.get(url(world), "exp")).json()["previous"])) == {crew[0].id, far.id}  # EXPERT: any user (default 1)
    await mk(db, world, world.boss, [far], days_ago=1)
    assert ids((await api.get(url(world), "boss")).json()["previous"]) == [far.id]
